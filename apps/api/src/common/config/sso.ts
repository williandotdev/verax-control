import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { SSO_CLIENT_ID, SSO_PATHS, ssoThumbprintInput } from '@verax/shared';
import { z } from 'zod';

/**
 * Entrada única no SIEM da Verax pelo console do responsável (decisão de 15/11/2026; `docs/ARQUITETURA.md`, "Entrada
 * única"). Só onde a equipe da Verax entra: na célula (`NODE_MODE=cell`), no endereço da equipe
 * (`api-<CELL_STAFF_SLUG>`); e no nó dedicado da própria Verax (`NODE_MODE=dedicated` com `PLAN=interno`, decisão de
 * 16/11/2026), o nó inteiro. Nunca num nó dedicado de cliente (qualquer outro plano). O console (`cp-admin`) é o
 * provedor de identidade, e a API só confere o que ele assinou.
 *
 * A chave pública do console fica FIXADA aqui (`SSO_PUBLIC_KEY`, o `x` da chave Ed25519, 32 bytes em base64url), e
 * nunca é baixada: um console falso, um DNS desviado ou um JWKS trocado não fazem a API aceitar outra chave. Nada aqui é
 * segredo, e a configuração recusa qualquer coisa que não seja uma chave pública (a privada não chega nem perto do nó).
 */
export interface SsoConfig {
  /** A origem do console (o `iss` exigido e o endereço do `authorize` e do `token`). */
  issuer: string;
  clientId: typeof SSO_CLIENT_ID;
  publicKey: KeyObject;
  /** A impressão digital RFC 7638 da chave fixada: o `kid` exigido no cabeçalho do token. */
  keyId: string;
  authorizeUrl: string;
  tokenUrl: string;
}

/** Uma origem https sem nada além dela (`https://host`, sem porta, caminho, consulta nem usuário). */
export function isHttpsOrigin(value: string): boolean {
  if (value.length > 200) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.port === '' && url.origin === value;
  } catch {
    return false;
  }
}

/** O `x` de uma chave pública Ed25519: 32 bytes em base64url, sem preenchimento (43 caracteres). */
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A chave pública Ed25519 do `x`, ou `undefined` se não for uma. */
export function ed25519PublicKey(x: string): KeyObject | undefined {
  if (!PUBLIC_KEY_PATTERN.test(x) || Buffer.from(x, 'base64url').length !== 32) return undefined;
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : undefined;
  } catch {
    return undefined;
  }
}

/** O `kid` de uma chave: SHA-256 do JSON da impressão digital (RFC 7638), em base64url. */
export function ssoKeyId(x: string): string {
  return createHash('sha256').update(ssoThumbprintInput(x), 'utf8').digest('base64url');
}

const enabledFlag = z
  .enum(['true', 'false'], { error: 'deve ser true ou false' })
  .default('false')
  .transform((value) => value === 'true');

/** As variáveis da entrada única, como o `start.sh` as escreve no `api.env` (da célula ou do nó da Verax). */
export const ssoEnvShape = {
  SSO_ISSUER: z
    .string()
    .refine(isHttpsOrigin, {
      error: 'deve ser só a origem https do console, sem caminho (ex.: https://admin.exemplo.com.br)',
    })
    .optional(),
  SSO_CLIENT_ID: z.literal(SSO_CLIENT_ID, { error: `deve ser ${SSO_CLIENT_ID}` }).optional(),
  SSO_PUBLIC_KEY: z
    .string()
    .refine((value) => ed25519PublicKey(value) !== undefined, {
      error: 'deve ser a chave PÚBLICA Ed25519 do console: o x do JWKS, 43 caracteres em base64url',
    })
    .optional(),
  // Desliga o login com senha do painel para o `admin_verax` onde a entrada única existe (o endereço da equipe, na
  // célula; o nó inteiro, no da Verax): só a entrada única. Desligado por padrão; ligado, exige a entrada única
  // configurada (senão a equipe ficaria do lado de fora).
  STAFF_PASSWORD_LOGIN_DISABLED: enabledFlag,
};

const SSO_KEYS = ['SSO_ISSUER', 'SSO_CLIENT_ID', 'SSO_PUBLIC_KEY'] as const;

interface SsoEnv {
  NODE_MODE: string;
  /** O `PLAN` como veio do ambiente, sem o padrão `interno` de fora de produção: o nó da Verax o declara. */
  PLAN?: string | undefined;
  SSO_ISSUER?: string | undefined;
  SSO_CLIENT_ID?: string | undefined;
  SSO_PUBLIC_KEY?: string | undefined;
  STAFF_PASSWORD_LOGIN_DISABLED: boolean;
}

/**
 * Onde a entrada única pode existir: na célula, ou no nó dedicado da Verax (`PLAN=interno` escrito no ambiente, como o
 * `start.sh` o escreve; o padrão `interno` de fora de produção não conta). Num nó dedicado de cliente, nunca.
 */
export function ssoAllowed(env: Pick<SsoEnv, 'NODE_MODE' | 'PLAN'>): boolean {
  return env.NODE_MODE === 'cell' || (env.NODE_MODE === 'dedicated' && env.PLAN === 'interno');
}

/** As três juntas ou nenhuma, só na célula ou no nó da Verax; o login só pela entrada única exige a entrada única. */
export function checkSsoEnv(env: SsoEnv, ctx: z.RefinementCtx): void {
  const present = SSO_KEYS.filter((key) => env[key] !== undefined);
  if (present.length > 0 && present.length < SSO_KEYS.length) {
    for (const key of SSO_KEYS) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: `obrigatória junto com ${present.join(', ')}` });
      }
    }
  }
  if (present.length > 0 && !ssoAllowed(env)) {
    for (const key of present) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'só existe com NODE_MODE=cell ou no nó dedicado da Verax (PLAN=interno)',
      });
    }
  }
  if (env.STAFF_PASSWORD_LOGIN_DISABLED && present.length < SSO_KEYS.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['STAFF_PASSWORD_LOGIN_DISABLED'],
      message: 'exige a entrada única configurada (SSO_ISSUER, SSO_CLIENT_ID e SSO_PUBLIC_KEY)',
    });
  }
}

/** A entrada única num objeto só (`null` sem ela); a configuração já conferiu as variáveis. */
export function ssoConfigOf(env: SsoEnv): SsoConfig | null {
  if (!ssoAllowed(env) || env.SSO_ISSUER === undefined || env.SSO_PUBLIC_KEY === undefined) return null;
  if (env.SSO_CLIENT_ID !== SSO_CLIENT_ID) return null;
  const publicKey = ed25519PublicKey(env.SSO_PUBLIC_KEY);
  if (publicKey === undefined) return null;
  return {
    issuer: env.SSO_ISSUER,
    clientId: SSO_CLIENT_ID,
    publicKey,
    keyId: ssoKeyId(env.SSO_PUBLIC_KEY),
    authorizeUrl: `${env.SSO_ISSUER}${SSO_PATHS.authorize}`,
    tokenUrl: `${env.SSO_ISSUER}${SSO_PATHS.token}`,
  };
}

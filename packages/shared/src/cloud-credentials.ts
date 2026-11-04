import { z } from 'zod';
import type { CloudProvider } from './cloud-accounts.js';

/**
 * Credencial de leitura colada no painel e guardada cifrada no cofre do nó (fase 2; `docs/ARQUITETURA.md`, "Cofre de
 * credenciais"). A rota é `PUT /v1/cloud-accounts/:id/credential`, com o corpo discriminado por `kind`: hoje só o token
 * do Cloudflare (PR-11'). Outro tipo entra como outra opção da mesma união, sem mudar a rota nem a resposta. A AWS não
 * passa por aqui: o papel de leitura dela não tem chave (`aws-reader.ts`).
 *
 * O segredo vai num sentido só: a API confere, cifra e grava. Nada dele volta (a resposta é a conta, com os metadados
 * em `keyStatus`), e nem a auditoria nem o log o recebem.
 */

/**
 * Tipos guardados no cofre (o enum `CloudCredentialKind` do banco). A chave de acesso da AWS (`aws_access_key`, do
 * PR-V1) saiu no PR-V3', sem nunca ter tido linha em produção: a AWS é lida pelo papel sem chave.
 */
export const CLOUD_CREDENTIAL_KINDS = ['cloudflare_api_token'] as const;
export type CloudCredentialKind = (typeof CLOUD_CREDENTIAL_KINDS)[number];

/** Tipos que o painel aceita colar. Um tipo novo é mais um item aqui e mais uma opção em `cloudCredentialInputSchema`. */
export const ACCEPTED_CREDENTIAL_KINDS = [
  'cloudflare_api_token',
] as const satisfies readonly CloudCredentialKind[];
export type AcceptedCredentialKind = (typeof ACCEPTED_CREDENTIAL_KINDS)[number];

/** Provedor de cada tipo: a credencial só vale numa conta do provedor dela. */
export const CREDENTIAL_KIND_PROVIDERS = {
  cloudflare_api_token: 'cloudflare',
} as const satisfies Record<CloudCredentialKind, CloudProvider>;

/** Tamanho aceito do token: os antigos têm 40 caracteres; os novos, prefixo (`cfat_`, `cfut_`), 40 e o checksum. */
export const CLOUDFLARE_TOKEN_MIN_LENGTH = 40;
export const CLOUDFLARE_TOKEN_MAX_LENGTH = 255;

/** Símbolos do alfabeto do Bearer (RFC 6750) além de letras e números; o `=` de preenchimento não aparece em token. */
const BEARER_SYMBOLS = '-._~+/';

function isAsciiLetterOrDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isLowerHex(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102);
}

/**
 * A Global API Key dá acesso total à conta e nunca é aceita: no formato novo, começa com `cfk_`; no antigo, são de 37
 * a 45 caracteres hexadecimais minúsculos (o token antigo tem 40 caracteres de letras maiúsculas e minúsculas, números,
 * `-` e `_`). Conferido caractere a caractere, em tempo linear e sem expressão regular.
 */
export function isCloudflareGlobalApiKey(value: string): boolean {
  if (value.startsWith('cfk_')) return true;
  if (value.length < 37 || value.length > 45) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!isLowerHex(value.charCodeAt(index))) return false;
  }
  return true;
}

/** Formato de um token de API do Cloudflare: o alfabeto do Bearer, com tamanho limitado, sem espaço nem quebra de linha. */
export function isCloudflareApiTokenShape(value: string): boolean {
  if (value.length < CLOUDFLARE_TOKEN_MIN_LENGTH || value.length > CLOUDFLARE_TOKEN_MAX_LENGTH) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiLetterOrDigit(code) && !BEARER_SYMBOLS.includes(value.charAt(index))) return false;
  }
  return true;
}

export const GLOBAL_KEY_REFUSED_MESSAGE =
  'Esta é a Global API Key, que dá acesso total à conta. Crie um token de API só de leitura.';
export const CLOUDFLARE_TOKEN_FORMAT_MESSAGE =
  'Token do Cloudflare inválido: cole o valor completo do token de API, sem espaços.';

/** O token colado. As mensagens nunca repetem o valor. */
export const cloudflareApiTokenSchema = z.string().superRefine((value, ctx) => {
  if (isCloudflareGlobalApiKey(value)) {
    ctx.addIssue({ code: 'custom', message: GLOBAL_KEY_REFUSED_MESSAGE });
    return;
  }
  if (!isCloudflareApiTokenShape(value))
    ctx.addIssue({ code: 'custom', message: CLOUDFLARE_TOKEN_FORMAT_MESSAGE });
});

/** Corpo do `PUT /v1/cloud-accounts/:id/credential`: uma opção por tipo aceito, estrita. */
export const cloudCredentialInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('cloudflare_api_token'), token: cloudflareApiTokenSchema }),
]);
export type CloudCredentialInput = z.infer<typeof cloudCredentialInputSchema>;

/** Dias antes do vencimento em que o painel avisa que o token precisa ser trocado. */
export const CREDENTIAL_EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

/** Situação da credencial pela validade: em dia, vencendo (nos próximos 14 dias) ou vencida. */
export const CREDENTIAL_STATUSES = ['active', 'expiring', 'expired'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

export function credentialStatus(expiresAt: Date | string | null, now: Date = new Date()): CredentialStatus {
  if (expiresAt === null) return 'active';
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (remaining <= 0) return 'expired';
  return remaining <= CREDENTIAL_EXPIRY_WARNING_DAYS * DAY_MS ? 'expiring' : 'active';
}

/** Dias inteiros até o vencimento, arredondados para cima (vence hoje à noite: 1); null sem validade. */
export function daysUntilExpiry(expiresAt: Date | string | null, now: Date = new Date()): number | null {
  if (expiresAt === null) return null;
  return Math.max(0, Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS));
}

/**
 * Metadados da credencial guardada, o que a conta mostra (`CloudAccount.keyStatus`). Nunca o segredo, o texto cifrado
 * ou a versão da chave do nó.
 */
export const cloudCredentialStatusSchema = z.strictObject({
  kind: z.enum(CLOUD_CREDENTIAL_KINDS),
  /** Os 4 últimos caracteres do ID do token do Cloudflare: o painel mostra `…abcd`. */
  keyIdSuffix: z.string().regex(/^[A-Za-z0-9]{4}$/),
  /** Criação da credencial na origem, quando ela informa (o `verify` do Cloudflare não informa). */
  issuedAt: z.iso.datetime().nullable(),
  /** Validade do token; null quando não vence. */
  expiresAt: z.iso.datetime().nullable(),
  /** Última conferência bem-sucedida na origem. */
  verifiedAt: z.iso.datetime(),
  /** Pela validade, na hora da resposta. */
  status: z.enum(CREDENTIAL_STATUSES),
});
export type CloudCredentialStatus = z.infer<typeof cloudCredentialStatusSchema>;

/**
 * Permissões do token de conta do Cloudflare, todas só de leitura (o nome é o do painel do Cloudflare, e `key` é a
 * chave do grupo de permissão no link de criação):
 * - Account Settings: Read: a auditoria da conta (audit logs v2);
 * - Zone: Read: a lista de zonas da conta;
 * - Analytics: Read (zona): os eventos de segurança do WAF pela API GraphQL.
 */
export const CLOUDFLARE_TOKEN_PERMISSIONS = [
  { key: 'account_settings', type: 'read', scope: 'Conta', name: 'Account Settings' },
  { key: 'zone', type: 'read', scope: 'Zona', name: 'Zone' },
  { key: 'analytics', type: 'read', scope: 'Zona', name: 'Analytics' },
] as const;

/** Nome sugerido para o token no Cloudflare. */
export const CLOUDFLARE_TOKEN_NAME = 'Verax Control (somente leitura)';

/**
 * Link que abre a criação de um token de conta (account-owned) no painel do Cloudflare com as permissões de leitura já
 * marcadas. O `:account` faz o Cloudflare perguntar a conta. Formato documentado em
 * https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/.
 */
export function cloudflareTokenTemplateUrl(): string {
  const keys = JSON.stringify(CLOUDFLARE_TOKEN_PERMISSIONS.map(({ key, type }) => ({ key, type })));
  return (
    'https://dash.cloudflare.com/?to=/:account/api-tokens' +
    `&permissionGroupKeys=${encodeURIComponent(keys)}&name=${encodeURIComponent(CLOUDFLARE_TOKEN_NAME)}`
  );
}

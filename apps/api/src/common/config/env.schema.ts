import {
  PLAN_LIMIT_BOUNDS,
  PLAN_LIMIT_KEYS,
  type PlanId,
  planIdSchema,
  type PlanLimitKey,
  planLimitRangeMessage,
  planOverrideProblems,
  type PlanOverrides,
  type ResolvedPlan,
  resolvePlan,
} from '@verax/shared';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  CredentialKeyError,
  MAX_KEY_VERSION,
  parsePrivateKeys,
  parsePublicKey,
  type VaultKeyring,
  type VaultPublicKey,
} from '../../credentials/credential-keys.js';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Endpoint oficial de validação do token do Turnstile. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/**
 * Chave do site do Turnstile: um dígito, `x` e de 20 a 40 caracteres (as reais começam com `0x`; as de teste da
 * Cloudflare, como `1x00000000000000000000AA`, com `1x`, `2x` ou `3x`). A mesma expressão do `install.sh` do nó.
 */
export const TURNSTILE_SITE_KEY_PATTERN = /^[0-9]x[0-9A-Za-z_-]{20,40}$/;

/**
 * Cofre de credenciais do nó (fase 2, PR-V1; `credentials/credential-keys.ts`). As variáveis são opcionais: sem elas,
 * a API e o worker sobem sem o cofre (o nó da Verax, que não guarda credencial, e o ambiente local). Com elas, vêm
 * sempre em par:
 * - a API recebe só a chave pública e a versão dela (`CREDENTIALS_PUBLIC_KEY` e `CREDENTIALS_KEY_VERSION`);
 * - o worker recebe o caminho do arquivo das privadas e a versão corrente (`CREDENTIALS_PRIVATE_KEYS_FILE` e
 *   `CREDENTIALS_KEY_CURRENT`). O arquivo fica no tmpfs do nó, montado só leitura no worker; as chaves nunca vêm pelo
 *   ambiente, que o Docker grava no disco na configuração do contêiner.
 */
const keyVersionFromEnv = z.coerce
  .number({ error: 'deve ser um inteiro positivo' })
  .int({ error: 'deve ser um inteiro positivo' })
  .min(1, { error: 'deve ser um inteiro positivo' })
  .max(MAX_KEY_VERSION, { error: 'deve ser um inteiro positivo' });

/** As duas variáveis do cofre que a API aceita. */
const API_VAULT_KEYS = new Set(['CREDENTIALS_PUBLIC_KEY', 'CREDENTIALS_KEY_VERSION']);

/**
 * A API nunca recebe chave privada do cofre: ela fica exposta pelo túnel e só cifra. Qualquer outra variável
 * `CREDENTIALS_*` (as do worker) e qualquer nome com `PRIVATE_KEY` impedem a partida, antes de qualquer outra
 * checagem. A mensagem cita só o nome da variável.
 */
function refusePrivateKeyVariables(source: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof source !== 'object' || source === null) return source;
  for (const key of Object.keys(source)) {
    if ((key.startsWith('CREDENTIALS_') && !API_VAULT_KEYS.has(key)) || /PRIVATE_?KEY/i.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: 'a API recebe só a chave pública do cofre de credenciais; a privada fica só no worker',
      });
    }
  }
  return source;
}

/** As duas variáveis de um par vêm juntas ou não vêm. */
function checkPair(
  env: Record<string, unknown>,
  keys: readonly [string, string],
  ctx: z.RefinementCtx,
): void {
  const [first, second] = keys;
  if ((env[first] === undefined) === (env[second] === undefined)) return;
  const missing = env[first] === undefined ? first : second;
  const present = missing === first ? second : first;
  ctx.addIssue({ code: 'custom', path: [missing], message: `obrigatória junto com ${present}` });
}

/** A chave do cofre lida do ambiente; o erro vira um problema da configuração, sem o valor. */
function vaultKey<T>(build: () => T, path: string, ctx: z.RefinementCtx): T | null {
  try {
    return build();
  } catch (error) {
    if (!(error instanceof CredentialKeyError)) throw error;
    ctx.addIssue({ code: 'custom', path: [path], message: error.message });
    return null;
  }
}

/** A única variável do worker com `PRIVATE_KEY` no nome: o caminho do arquivo das privadas. */
const WORKER_KEYS_FILE_VARIABLE = 'CREDENTIALS_PRIVATE_KEYS_FILE';

/**
 * As chaves privadas do worker vêm só pelo arquivo (`CREDENTIALS_PRIVATE_KEYS_FILE`): qualquer outra variável com
 * `PRIVATE_KEY` no nome (a mesma régua da API) é recusada antes de qualquer outra checagem, porque o ambiente do
 * contêiner fica gravado no disco do nó. A mensagem cita só o nome da variável.
 */
function refuseKeysInEnvironment(source: unknown, ctx: z.RefinementCtx): unknown {
  if (typeof source !== 'object' || source === null) return source;
  for (const key of Object.keys(source)) {
    if (key !== WORKER_KEYS_FILE_VARIABLE && /PRIVATE_?KEY/i.test(key)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `as chaves privadas do cofre vêm por arquivo (${WORKER_KEYS_FILE_VARIABLE}), nunca pelo ambiente`,
      });
    }
  }
  return source;
}

/** O conteúdo do arquivo das chaves privadas; a falha de leitura cita a variável, não o caminho nem o conteúdo. */
function readPrivateKeysFile(path: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho da configuração, não do request
    return readFileSync(path, 'utf8');
  } catch {
    throw new CredentialKeyError('não foi possível ler o arquivo das chaves privadas');
  }
}

/** Um octeto do IPv4: 0 a 255, sem zero à esquerda. Caractere a caractere, sem expressão regular. */
function isOctet(octet: string): boolean {
  if (octet.length < 1 || octet.length > 3 || (octet.length > 1 && octet.startsWith('0'))) return false;
  for (let index = 0; index < octet.length; index += 1) {
    const code = octet.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return Number(octet) <= 255;
}

/** IPv4 com /32, conferido por partes: `203.0.113.10/32`. */
function isEgressIp(value: string): boolean {
  const [address = '', prefix, ...rest] = value.split('/');
  if (prefix !== '32' || rest.length > 0) return false;
  const octets = address.split('.');
  return octets.length === 4 && octets.every(isOctet);
}

/**
 * IPs de saída do nó (o IP fixo do Cloud NAT, `NODE_EGRESS_IPS` no `node.conf`), separados por vírgula. Contas cloud
 * os mostra como o filtro de IP recomendado para o token do Cloudflare. Não é segredo.
 */
const egressIpsFromEnv = z
  .string()
  .max(400)
  .transform((value) => value.split(',').map((ip) => ip.trim()))
  .pipe(
    z
      .array(z.string().refine(isEgressIp, { error: 'use IPv4 com /32, separados por vírgula' }))
      .min(1)
      .max(16),
  );

/** Plano e ajustes, como ficam depois da validação do ambiente. */
interface PlanEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  PLAN?: PlanId | undefined;
  PLAN_MAX_CLOUD_ACCOUNTS?: number | undefined;
  PLAN_MAX_USERS?: number | undefined;
  PLAN_MONTHLY_GIB?: number | undefined;
  PLAN_HISTORY_DAYS?: number | undefined;
}

/** Variável de ambiente de cada ajuste do plano. */
export const PLAN_LIMIT_ENV = {
  maxCloudAccounts: 'PLAN_MAX_CLOUD_ACCOUNTS',
  maxUsers: 'PLAN_MAX_USERS',
  monthlyGib: 'PLAN_MONTHLY_GIB',
  historyDays: 'PLAN_HISTORY_DAYS',
} as const satisfies Record<PlanLimitKey, keyof PlanEnv>;

const planLimitFromEnv = (key: PlanLimitKey) => {
  const { min, max } = PLAN_LIMIT_BOUNDS[key];
  const error = planLimitRangeMessage(key);
  return z.coerce.number({ error }).int({ error }).min(min, { error }).max(max, { error }).optional();
};

/**
 * Plano do nó (fase 2), parte comum à API e ao worker. Vem do `node.conf`, escrito pelo `start.sh`. Em produção, o
 * `PLAN` é obrigatório; fora dela, o padrão é `interno` (sem limite). Os ajustes são opcionais, menos no `enterprise`,
 * que exige os quatro; o `interno` não aceita nenhum (ver `packages/shared/src/plans.ts`).
 */
const planEnvShape = {
  PLAN: planIdSchema.optional(),
  PLAN_MAX_CLOUD_ACCOUNTS: planLimitFromEnv('maxCloudAccounts'),
  PLAN_MAX_USERS: planLimitFromEnv('maxUsers'),
  PLAN_MONTHLY_GIB: planLimitFromEnv('monthlyGib'),
  PLAN_HISTORY_DAYS: planLimitFromEnv('historyDays'),
};

function planOverridesOf(env: Omit<PlanEnv, 'NODE_ENV'>): PlanOverrides {
  const overrides: PlanOverrides = {};
  for (const key of PLAN_LIMIT_KEYS) {
    const value = env[PLAN_LIMIT_ENV[key]];
    if (value !== undefined) overrides[key] = value;
  }
  return overrides;
}

function checkPlanEnv(env: PlanEnv, ctx: z.RefinementCtx): void {
  if (env.NODE_ENV === 'production' && env.PLAN === undefined) {
    ctx.addIssue({ code: 'custom', path: ['PLAN'], message: 'obrigatória em produção' });
  }
  for (const { key, message } of planOverrideProblems(env.PLAN ?? 'interno', planOverridesOf(env))) {
    ctx.addIssue({ code: 'custom', path: [PLAN_LIMIT_ENV[key]], message });
  }
}

/** Sem `PLAN` (só fora de produção), o plano é o `interno`. */
function withDefaultPlan<T extends { PLAN?: PlanId | undefined }>(env: T): T & { PLAN: PlanId } {
  return { ...env, PLAN: env.PLAN ?? 'interno' };
}

/** Plano em vigor no nó, com os ajustes do ambiente (a carga da configuração já validou a combinação). */
export function nodePlan(env: Omit<PlanEnv, 'NODE_ENV'> & { PLAN: PlanId }): ResolvedPlan {
  return resolvePlan(env.PLAN, planOverridesOf(env));
}

/** TLS com verificação de certificado e de hostname até o banco (regra 5: nada de TLS sem validação). */
function requiresVerifiedTls(databaseUrl: string): boolean {
  try {
    return new URL(databaseUrl).searchParams.get('sslmode') === 'verify-full';
  } catch {
    return false;
  }
}

/**
 * Variáveis de ambiente da API. A API não sobe se alguma obrigatória faltar ou for inválida.
 * Cada task que precisar de configuração nova acrescenta o campo aqui e no .env.example.
 */
const apiEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Quantos proxies confiáveis ficam na frente da API (o ALB conta 1). Define de onde sai o IP do cliente
    // na auditoria e no limite de tentativas: com 0, o X-Forwarded-For é ignorado e não pode ser forjado.
    // Em produção, atrás do ALB, precisa ser pelo menos 1 (com 0, todo mundo teria o IP do ALB e dividiria o
    // mesmo limite de tentativas). Mais que o número real de proxies deixaria o cliente forjar o próprio IP.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    WEB_ORIGIN: z.url({ protocol: /^https?$/, error: 'deve ser uma URL http(s) válida' }),
    API_ORIGIN: z.url({ protocol: /^https?$/, error: 'deve ser uma URL http(s) válida' }),
    // Assina os cookies de sessão e cifra o segredo do TOTP. Gerado por `pnpm setup:env` (256 bits).
    BETTER_AUTH_SECRET: z
      .string({ error: 'obrigatória' })
      .min(32, { error: 'deve ter pelo menos 32 caracteres' }),
    // Chave HMAC dos tokens CSRF (T2.3), separada da chave de sessão.
    CSRF_SECRET: z.string({ error: 'obrigatória' }).min(32, { error: 'deve ter pelo menos 32 caracteres' }),
    // Limite de tentativas por IP nas rotas de autenticação. Só os testes desligam; produção exige ligado.
    AUTH_RATE_LIMIT_ENABLED: z
      .enum(['true', 'false'], { error: 'deve ser true ou false' })
      .default('true')
      .transform((value) => value === 'true'),
    // Checagem de senha vazada no Have I Been Pwned (k-anonimato). Só os testes desligam; produção exige.
    PASSWORD_BREACH_CHECK_ENABLED: z
      .enum(['true', 'false'], { error: 'deve ser true ou false' })
      .default('true')
      .transform((value) => value === 'true'),
    // E-mail (T2.6): só a redefinição de senha pelo link usa (contas novas nascem com senha temporária). SES ou SMTP
    // autenticado em produção, ou `none` no nó sem e-mail (quem esquece a senha pede uma temporária ao administrador);
    // caixa local em desenvolvimento (links nunca vão para o log).
    MAIL_TRANSPORT: z.enum(['ses', 'smtp', 'none', 'dev-mailbox']).default('dev-mailbox'),
    MAIL_FROM: z.email({ error: 'deve ser um e-mail válido' }),
    AWS_REGION: z
      .string()
      .regex(/^[a-z]{2}-[a-z]+-[0-9]$/, { error: 'região AWS inválida' })
      .default('sa-east-1'),
    // SMTP (só com MAIL_TRANSPORT=smtp): sempre com TLS. A senha é de aplicativo e vem do cofre de segredos do nó.
    SMTP_HOST: z
      .string()
      .regex(/^[a-z0-9.-]+$/i, { error: 'nome de servidor inválido' })
      .optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    // Pasta da caixa local. Vazio: `.dev-mailbox` na raiz do monorepo.
    DEV_MAILBOX_DIR: z.string().optional(),
    DATABASE_URL: z
      .string({ error: 'obrigatória' })
      .regex(/^postgres(ql)?:\/\/.+/, { error: 'deve ser uma URL postgresql://' }),
    // Cloudflare Turnstile nos formulários públicos do painel (login e "esqueci minha senha"). Com a chave secreta
    // definida, o token do widget passa a ser obrigatório nessas rotas; sem ela, nada é conferido (em produção, a API
    // avisa na partida). A chave do site é pública (vai ao painel por `GET /v1/auth/client-config`); as duas andam
    // juntas, porque uma sem a outra deixaria o painel sem login. A URL do siteverify só muda fora de produção, para
    // o servidor falso dos testes.
    TURNSTILE_SECRET_KEY: z.string().min(1).optional(),
    TURNSTILE_SITE_KEY: z
      .string()
      .regex(TURNSTILE_SITE_KEY_PATTERN, { error: 'chave do site do Turnstile em formato inválido' })
      .optional(),
    TURNSTILE_SITEVERIFY_URL: z
      .url({ protocol: /^https?$/, error: 'deve ser uma URL http(s) válida' })
      .default(TURNSTILE_SITEVERIFY_URL),
    // Tópico do nó para o sink de um projeto GCP de cliente, sem o projeto do cliente no fim:
    // `projects/<projeto-do-nó>/topics/<prefixo>-security-`, o nome que o módulo do Terraform dá (logs.tf). O start.sh
    // escreve no nó; sem ele (ambiente local), Contas cloud mostra o comando do sink com o tópico a preencher. Não é
    // segredo.
    GCP_SINK_TOPIC_PREFIX: z
      .string()
      .regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[a-z][a-z0-9-]{3,18}-security-$/, {
        error: 'deve ser projects/<projeto>/topics/<prefixo>-security-',
      })
      .optional(),
    ...planEnvShape,
    // IPs de saída do nó (o IP fixo do NAT, no perfil standard): o filtro de IP recomendado para o token do
    // Cloudflare. O start.sh escreve quando o node.conf tem a linha; sem ela, a tela recomenda o filtro sem o IP.
    NODE_EGRESS_IPS: egressIpsFromEnv.optional(),
    // Cofre de credenciais (fase 2): só a chave pública corrente, para cifrar o que o admin cola.
    CREDENTIALS_PUBLIC_KEY: z.string().optional(),
    CREDENTIALS_KEY_VERSION: keyVersionFromEnv.optional(),
  })
  .superRefine((env, ctx) => {
    checkPlanEnv(env, ctx);
    checkPair(env, ['CREDENTIALS_PUBLIC_KEY', 'CREDENTIALS_KEY_VERSION'], ctx);
    // O problema é apontado na chave presente: a que falta sairia só como "não definida".
    if (env.TURNSTILE_SECRET_KEY !== undefined && env.TURNSTILE_SITE_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SECRET_KEY'],
        message: 'exige TURNSTILE_SITE_KEY (as duas chaves andam juntas, ou nenhuma)',
      });
    }
    if (env.TURNSTILE_SITE_KEY !== undefined && env.TURNSTILE_SECRET_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SITE_KEY'],
        message: 'exige TURNSTILE_SECRET_KEY (as duas chaves andam juntas, ou nenhuma)',
      });
    }
    if (env.NODE_ENV === 'production' && env.TURNSTILE_SITEVERIFY_URL !== TURNSTILE_SITEVERIFY_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['TURNSTILE_SITEVERIFY_URL'],
        message: 'só muda fora de produção (servidor falso dos testes)',
      });
    }
    for (const key of ['WEB_ORIGIN', 'API_ORIGIN'] as const) {
      if (env.NODE_ENV === 'production' && !env[key].startsWith('https://')) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'deve usar https em produção' });
      }
    }
    if (env.NODE_ENV === 'production' && !env.PASSWORD_BREACH_CHECK_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['PASSWORD_BREACH_CHECK_ENABLED'],
        message: 'deve ficar ligado em produção',
      });
    }
    if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'dev-mailbox') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'deve ser ses, smtp ou none em produção',
      });
    }
    if (env.MAIL_TRANSPORT === 'smtp') {
      for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD'] as const) {
        if (!env[key])
          ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com MAIL_TRANSPORT=smtp' });
      }
    }
    if (env.NODE_ENV === 'production' && env.TRUST_PROXY_HOPS === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY_HOPS'],
        message: 'deve contar o ALB (1) em produção',
      });
    }
    if (env.NODE_ENV === 'production' && !env.AUTH_RATE_LIMIT_ENABLED) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_RATE_LIMIT_ENABLED'],
        message: 'deve ficar ligado em produção',
      });
    }
    if (env.NODE_ENV === 'production' && !requiresVerifiedTls(env.DATABASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'deve usar sslmode=verify-full em produção (TLS com certificado conferido)',
      });
    }
  })
  .transform(({ CREDENTIALS_PUBLIC_KEY, CREDENTIALS_KEY_VERSION, ...env }, ctx) => {
    // A chave pública já validada no lugar do texto em base64; sem o par, a API sobe sem o cofre.
    let credentialsPublicKey: VaultPublicKey | null = null;
    if (CREDENTIALS_PUBLIC_KEY !== undefined && CREDENTIALS_KEY_VERSION !== undefined) {
      credentialsPublicKey = vaultKey(
        () => parsePublicKey(CREDENTIALS_PUBLIC_KEY, CREDENTIALS_KEY_VERSION),
        'CREDENTIALS_PUBLIC_KEY',
        ctx,
      );
    }
    return { ...withDefaultPlan(env), credentialsPublicKey };
  });

export const envSchema = z.preprocess(refusePrivateKeyVariables, apiEnvSchema);

export type Env = z.infer<typeof envSchema>;

/**
 * Variáveis do worker do sync de alertas (T5.3): só o banco, o log, o intervalo, o plano e o arquivo das chaves
 * privadas do cofre de credenciais. Nada de autenticação, e-mail nem origens, porque o worker não atende requisição. O
 * indexer tem configuração própria (`loadIndexerConfig`).
 */
const workerEnvObjectSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    DATABASE_URL: z
      .string({ error: 'obrigatória' })
      .regex(/^postgres(ql)?:\/\/.+/, { error: 'deve ser uma URL postgresql://' }),
    /** Intervalo entre execuções do sync. */
    SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
    /**
     * De onde o worker lê, separado por vírgula: `wazuh` (alertas das contas AWS, pelo indexer) e `gcp` (auditoria da
     * GCP, pelas assinaturas do Pub/Sub cadastradas nas contas). O nó da Verax (perfil `lean`, sem Wazuh) usa só `gcp`;
     * o nó de cliente (perfil `standard`) usa `gcp,wazuh`, com o indexer do próprio nó (`INDEXER_AUTH=node`).
     */
    SYNC_SOURCES: z
      .string()
      .default('wazuh')
      .transform((value) => [...new Set(value.split(',').map((source) => source.trim()))])
      .pipe(z.array(z.enum(['wazuh', 'gcp'], { error: 'fontes aceitas: wazuh e gcp' })).min(1)),
    ...planEnvShape,
    // Cofre de credenciais (fase 2): o arquivo com as chaves privadas de todas as versões ativas (uma por linha,
    // `<versão>:<PEM em base64>`), montado só leitura no worker, e a versão corrente. Só o worker decifra.
    CREDENTIALS_PRIVATE_KEYS_FILE: z.string().min(1, { error: 'deve ser o caminho do arquivo' }).optional(),
    CREDENTIALS_KEY_CURRENT: keyVersionFromEnv.optional(),
  })
  .superRefine((env, ctx) => {
    checkPlanEnv(env, ctx);
    checkPair(env, ['CREDENTIALS_PRIVATE_KEYS_FILE', 'CREDENTIALS_KEY_CURRENT'], ctx);
    if (env.NODE_ENV === 'production' && !requiresVerifiedTls(env.DATABASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'deve usar sslmode=verify-full em produção (TLS com certificado conferido)',
      });
    }
  })
  .transform(({ CREDENTIALS_PRIVATE_KEYS_FILE, CREDENTIALS_KEY_CURRENT, ...env }, ctx) => {
    // As chaves já lidas do arquivo (um objeto que não vira JSON nem texto de log); o caminho não fica na configuração.
    let credentialsKeyring: VaultKeyring | null = null;
    if (CREDENTIALS_PRIVATE_KEYS_FILE !== undefined && CREDENTIALS_KEY_CURRENT !== undefined) {
      credentialsKeyring = vaultKey(
        () => parsePrivateKeys(readPrivateKeysFile(CREDENTIALS_PRIVATE_KEYS_FILE), CREDENTIALS_KEY_CURRENT),
        'CREDENTIALS_PRIVATE_KEYS_FILE',
        ctx,
      );
    }
    return { ...withDefaultPlan(env), credentialsKeyring };
  });

export const workerEnvSchema = z.preprocess(refuseKeysInEnvironment, workerEnvObjectSchema);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

import {
  isNodeEgressIp,
  isNodeServiceAccountId,
  isWebIdentityAudience,
  MAX_AUDIENCE_LENGTH,
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
  apiAgentsEnvShape,
  wazuhAgentsConfigOf,
  wazuhAgentsFeedOf,
  workerAgentsEnvShape,
} from '../../agents/agents-config.js';
import {
  CredentialKeyError,
  MAX_KEY_VERSION,
  parsePrivateKeys,
  parsePublicKey,
  type VaultKeyring,
  type VaultPublicKey,
} from '../../credentials/credential-keys.js';
import {
  type CellConfig,
  cellApiHost,
  cellPanelOrigin,
  isCellDomain,
  isTenantSlug,
  NODE_MODES,
  type NodeMode,
} from './cell.js';

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

/** As variáveis de um grupo vêm todas juntas ou nenhuma: cada uma que falta é dita pelo nome. */
function checkTogether(env: Record<string, unknown>, keys: readonly string[], ctx: z.RefinementCtx): void {
  const present = keys.filter((key) => env[key] !== undefined);
  if (present.length === 0 || present.length === keys.length) return;
  for (const key of keys) {
    if (env[key] === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: `obrigatória junto com ${present.join(', ')}` });
    }
  }
}

/**
 * A API do manager do Wazuh do nó (perfil standard, PR-V6), como o worker a recebe do `start.sh`: o endereço (https,
 * pelo nome do serviço na rede `wazuh`), a CA do volume público dos certificados (a mesma do indexer) e a senha do
 * usuário `verax_stats`, que só tem `manager:read`. Os três juntos; com eles, entra a tarefa `wazuh-usage`.
 */
const wazuhApiEnvShape = {
  WAZUH_API_URL: z
    .url({ protocol: /^https$/, error: 'deve ser uma URL https:// (TLS obrigatório)' })
    .optional(),
  WAZUH_API_CA_FILE: z
    .string()
    .regex(/^\/[\w./-]+$/, { error: 'deve ser o caminho absoluto da CA do Wazuh' })
    .optional(),
  // A política de senha da API do Wazuh: de 8 a 64 caracteres (o install.sh gera 40).
  WAZUH_STATS_PASSWORD: z
    .string()
    .min(8, { error: 'deve ter de 8 a 64 caracteres' })
    .max(64, { error: 'deve ter de 8 a 64 caracteres' })
    .optional(),
};
const WAZUH_API_KEYS = Object.keys(wazuhApiEnvShape);

/**
 * O acesso do worker à API do manager (a tarefa `wazuh-usage`). A senha fica num campo privado: não vira JSON (o que o
 * logger serializa) nem aparece ao inspecionar o objeto; o worker ainda a registra como segredo vivo do logger.
 */
export class WazuhApiConfig {
  readonly #password: string;

  constructor(
    readonly url: string,
    readonly caFile: string,
    password: string,
  ) {
    this.#password = password;
  }

  password(): string {
    return this.#password;
  }

  toJSON(): { url: string; caFile: string } {
    return { url: this.url, caFile: this.caFile };
  }
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

/**
 * IPs de saída do nó (o IP fixo do Cloud NAT, `NODE_EGRESS_IPS` no `node.conf`), separados por vírgula, cada um IPv4
 * com /32 conferido por partes (`isNodeEgressIp`). Contas cloud os mostra como o `NodeEgressIps` da pilha da AWS e o
 * filtro de IP recomendado para o token do Cloudflare. Não é segredo.
 */
const egressIpsFromEnv = z
  .string()
  .max(400)
  .transform((value) => value.split(',').map((ip) => ip.trim()))
  .pipe(
    z
      .array(z.string().refine(isNodeEgressIp, { error: 'use IPv4 com /32, separados por vírgula' }))
      .min(1)
      .max(16),
  );

/**
 * Papel de leitura sem chave da AWS (fase 2), na API e no worker. Nenhum é segredo, e o start.sh escreve cada um só
 * quando o node.conf tem a linha (e só no formato):
 * - `NODE_EGRESS_IPS`, os IPs de saída do nó (o IP fixo do NAT, no perfil standard): o `NodeEgressIps` da pilha da
 *   AWS e o filtro de IP recomendado para o token do Cloudflare; sem ele, a tela pede o IP à Verax. No worker, o
 *   `aws:SourceIp` da simulação da permissão demais (PR-V5'), que fica de fora sem ele;
 * - `NODE_SA_UNIQUE_ID`, o ID único da conta de serviço do nó no Google (21 dígitos, `terraform output`): o
 *   `NodeServiceAccountId` que Contas cloud mostra (PR-V3'; sem ele, a tela o pede à Verax). No worker, liga a
 *   conferência real da conexão (PR-V5'), e o `sub` do token do nó é conferido com ele na partida;
 * - `AWS_WEB_IDENTITY_AUDIENCE`, o audience do token; sem ele, vale o padrão do template (`AWS_READER_AUDIENCE`).
 */
const awsReaderEnvShape = {
  NODE_EGRESS_IPS: egressIpsFromEnv.optional(),
  NODE_SA_UNIQUE_ID: z
    .string()
    .refine(isNodeServiceAccountId, { error: 'deve ser o ID único da conta de serviço do nó (21 dígitos)' })
    .optional(),
  AWS_WEB_IDENTITY_AUDIENCE: z
    .string()
    .max(MAX_AUDIENCE_LENGTH)
    .refine(isWebIdentityAudience, {
      error:
        'deve ser https://<host>[/<caminho>], só com minúsculas no host e sem porta, consulta ou curinga',
    })
    .optional(),
};

/**
 * Modo do nó (CE-02): `dedicated`, o nó de um cliente só (Dedicado, vCISO e o nó da Verax), e `cell`, a célula
 * compartilhada da Plataforma. Sem a linha no `node.conf`, `dedicated`: nada muda nos nós de hoje. Na célula, o plano
 * é de cada cliente (`TenantPlan`, gravado pelo plano de controle), e o `PLAN` do ambiente não vale.
 */
// A lista em si fica em `./cell.ts` (CE-01); daqui ela segue exportada para quem já a importava (CE-02).
export { NODE_MODES, type NodeMode };

/** Plano e ajustes, como ficam depois da validação do ambiente. */
interface PlanEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  NODE_MODE?: NodeMode | undefined;
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
 * Plano do nó (fase 2) e modo do nó (CE-02), parte comum à API e ao worker. Vêm do `node.conf`, escrito pelo
 * `start.sh`. No nó dedicado, em produção, o `PLAN` é obrigatório; fora dela, o padrão é `interno` (sem limite). Os
 * ajustes são opcionais, menos no `enterprise`, que exige os quatro; o `interno` não aceita nenhum (ver
 * `packages/shared/src/plans.ts`). Na célula (`NODE_MODE=cell`), o `PLAN` e os ajustes são recusados: o plano é de cada
 * cliente.
 */
const planEnvShape = {
  NODE_MODE: z.enum(NODE_MODES, { error: 'use dedicated ou cell' }).default('dedicated'),
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
  if (env.NODE_MODE === 'cell') {
    for (const key of ['PLAN', ...Object.values(PLAN_LIMIT_ENV)] as const) {
      if (env[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            'não se aplica com NODE_MODE=cell: o plano é de cada cliente, gravado pelo plano de controle',
        });
      }
    }
    return;
  }
  if (env.NODE_ENV === 'production' && env.PLAN === undefined) {
    ctx.addIssue({ code: 'custom', path: ['PLAN'], message: 'obrigatória em produção' });
  }
  for (const { key, message } of planOverrideProblems(env.PLAN ?? 'interno', planOverridesOf(env))) {
    ctx.addIssue({ code: 'custom', path: [PLAN_LIMIT_ENV[key]], message });
  }
}

/** Sem `PLAN` (só fora de produção, ou na célula, onde ele não vale), o plano do ambiente é o `interno`. */
function withDefaultPlan<T extends { PLAN?: PlanId | undefined }>(env: T): T & { PLAN: PlanId } {
  return { ...env, PLAN: env.PLAN ?? 'interno' };
}

/** Plano em vigor no nó, com os ajustes do ambiente (a carga da configuração já validou a combinação). */
export function nodePlan(env: Omit<PlanEnv, 'NODE_ENV'> & { PLAN: PlanId }): ResolvedPlan {
  return resolvePlan(env.PLAN, planOverridesOf(env));
}

/**
 * Modo do nó (CE-01). `dedicated`, o padrão, é o nó de um cliente só, como sempre. `cell` é a célula compartilhada do
 * Plataforma: a API amarra cada requisição ao cliente do endereço (`Host`) e exige o domínio da célula e o subdomínio da
 * equipe da Verax. As duas variáveis da célula só existem nela.
 */
const nodeModeEnvShape = {
  // O NODE_MODE em si vem do planEnvShape (CE-02), que a API e o worker já incluem.
  CELL_DOMAIN: z
    .string()
    .refine(isCellDomain, {
      error: 'deve ser um domínio em minúsculas, sem ponto no fim (ex.: exemplo.com.br)',
    })
    .optional(),
  CELL_STAFF_SLUG: z.string().refine(isTenantSlug, { error: 'subdomínio inválido' }).optional(),
};

interface NodeModeEnv {
  NODE_MODE: NodeMode;
  CELL_DOMAIN?: string | undefined;
  CELL_STAFF_SLUG?: string | undefined;
}

/** As variáveis da célula: as duas com `NODE_MODE=cell`, nenhuma fora dele. */
function checkNodeModeEnv(env: NodeModeEnv, ctx: z.RefinementCtx): void {
  for (const key of ['CELL_DOMAIN', 'CELL_STAFF_SLUG'] as const) {
    if (env.NODE_MODE === 'cell' && env[key] === undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com NODE_MODE=cell' });
    }
    if (env.NODE_MODE !== 'cell' && env[key] !== undefined) {
      ctx.addIssue({ code: 'custom', path: [key], message: 'só existe com NODE_MODE=cell' });
    }
  }
}

/** A célula num objeto só (null no nó dedicado); a configuração já conferiu as duas variáveis. */
function cellConfigOf(env: NodeModeEnv): CellConfig | null {
  if (env.NODE_MODE !== 'cell' || env.CELL_DOMAIN === undefined || env.CELL_STAFF_SLUG === undefined)
    return null;
  return { domain: env.CELL_DOMAIN, staffSlug: env.CELL_STAFF_SLUG };
}

/** Transportes de e-mail: SES ou SMTP autenticado em produção, `none` no nó sem e-mail, caixa local em desenvolvimento. */
const MAIL_TRANSPORTS = ['ses', 'smtp', 'none', 'dev-mailbox'] as const;

/** A origem do painel (`WEB_ORIGIN`): o endereço dos links da API e dos avisos por e-mail do worker. */
const webOriginFromEnv = z.url({ protocol: /^https?$/, error: 'deve ser uma URL http(s) válida' });

/** O e-mail de envio (`MAIL_FROM`). */
const mailFromEnv = z.email({ error: 'deve ser um e-mail válido' });

/**
 * O servidor de envio, parte comum à API e ao worker (o mesmo transporte, `mail/mail.module.ts`): a região do SES e o
 * SMTP (só com MAIL_TRANSPORT=smtp), sempre com TLS. A senha é de aplicativo e vem do cofre de segredos do nó.
 */
const mailServerEnvShape = {
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-[0-9]$/, { error: 'região AWS inválida' })
    .default('sa-east-1'),
  SMTP_HOST: z
    .string()
    .regex(/^[a-z0-9.-]+$/i, { error: 'nome de servidor inválido' })
    .optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  // Pasta da caixa local. Vazio: `.dev-mailbox` na raiz do monorepo.
  DEV_MAILBOX_DIR: z.string().optional(),
};

interface MailEnv {
  NODE_ENV: 'development' | 'test' | 'production';
  MAIL_TRANSPORT: (typeof MAIL_TRANSPORTS)[number];
  SMTP_HOST?: string | undefined;
  SMTP_USER?: string | undefined;
  SMTP_PASSWORD?: string | undefined;
}

/** Regras do e-mail comuns à API e ao worker: a caixa local nunca em produção; o SMTP com servidor, usuário e senha. */
function checkMailEnv(env: MailEnv, ctx: z.RefinementCtx): void {
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
}

/** TLS com verificação de certificado e de hostname até o banco (regra 5: nada de TLS sem validação). */
export function requiresVerifiedTls(databaseUrl: string): boolean {
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
    WEB_ORIGIN: webOriginFromEnv,
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
    MAIL_TRANSPORT: z.enum(MAIL_TRANSPORTS).default('dev-mailbox'),
    MAIL_FROM: mailFromEnv,
    ...mailServerEnvShape,
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
    ...awsReaderEnvShape,
    // Cofre de credenciais (fase 2): só a chave pública corrente, para cifrar o que o admin cola.
    CREDENTIALS_PUBLIC_KEY: z.string().optional(),
    CREDENTIALS_KEY_VERSION: keyVersionFromEnv.optional(),
    // Agentes do Wazuh nas instâncias do cliente (WAZUH_AGENTS=true no node.conf; desligado por padrão): o endereço,
    // o cliente do nó, as faixas liberadas, o limite, a CA e a senha de registro (agents/agents-config.ts).
    ...apiAgentsEnvShape,
    // Célula compartilhada (CE-01): o domínio e o subdomínio da equipe, só com NODE_MODE=cell (do planEnvShape).
    ...nodeModeEnvShape,
  })
  .superRefine((env, ctx) => {
    checkPlanEnv(env, ctx);
    checkNodeModeEnv(env, ctx);
    // Na célula, o WEB_ORIGIN e o API_ORIGIN são os endereços da equipe da Verax (o Better Auth usa o API_ORIGIN como
    // base). Iguais aos derivados do domínio, para nenhum valor solto apontar para outro lugar; os de cada cliente saem
    // do `Host` de cada requisição.
    const cell = cellConfigOf(env);
    if (cell !== null && env.WEB_ORIGIN !== cellPanelOrigin(cell, cell.staffSlug)) {
      ctx.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'na célula, deve ser o painel da equipe: https://<CELL_STAFF_SLUG>.control.<CELL_DOMAIN>',
      });
    }
    if (cell !== null && env.API_ORIGIN !== `https://${cellApiHost(cell, cell.staffSlug)}`) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_ORIGIN'],
        message: 'na célula, deve ser a API da equipe: https://api-<CELL_STAFF_SLUG>.<CELL_DOMAIN>',
      });
    }
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
    checkMailEnv(env, ctx);
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
  .transform(
    (
      {
        CREDENTIALS_PUBLIC_KEY,
        CREDENTIALS_KEY_VERSION,
        WAZUH_AGENTS,
        WAZUH_AGENTS_ADDRESS,
        WAZUH_AGENTS_TENANT,
        WAZUH_AGENTS_SOURCES,
        WAZUH_AGENTS_MAX,
        WAZUH_AGENTS_CA,
        WAZUH_AGENTS_ENROLLMENT_PASSWORD,
        CELL_DOMAIN,
        CELL_STAFF_SLUG,
        ...env
      },
      ctx,
    ) => {
      const cell = cellConfigOf({ NODE_MODE: env.NODE_MODE, CELL_DOMAIN, CELL_STAFF_SLUG });
      // A chave pública já validada no lugar do texto em base64; sem o par, a API sobe sem o cofre.
      let credentialsPublicKey: VaultPublicKey | null = null;
      if (CREDENTIALS_PUBLIC_KEY !== undefined && CREDENTIALS_KEY_VERSION !== undefined) {
        credentialsPublicKey = vaultKey(
          () => parsePublicKey(CREDENTIALS_PUBLIC_KEY, CREDENTIALS_KEY_VERSION),
          'CREDENTIALS_PUBLIC_KEY',
          ctx,
        );
      }
      // Os agentes num objeto só (null, desligados); o texto das variáveis não fica na configuração.
      const wazuhAgents = wazuhAgentsConfigOf(
        {
          WAZUH_AGENTS,
          WAZUH_AGENTS_ADDRESS,
          WAZUH_AGENTS_TENANT,
          WAZUH_AGENTS_SOURCES,
          WAZUH_AGENTS_MAX,
          WAZUH_AGENTS_CA,
          WAZUH_AGENTS_ENROLLMENT_PASSWORD,
        },
        ctx,
      );
      return { ...withDefaultPlan(env), credentialsPublicKey, wazuhAgents, cell };
    },
  );

export const envSchema = z.preprocess(refusePrivateKeyVariables, apiEnvSchema);

export type Env = z.infer<typeof envSchema>;

/**
 * Variáveis do worker do sync de alertas (T5.3): o banco, o log, o intervalo, o plano, o arquivo das chaves privadas do
 * cofre de credenciais e o e-mail dos avisos (fase 2, PR-16). Nada de autenticação, porque o worker não atende
 * requisição. O indexer tem configuração própria (`loadIndexerConfig`).
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
     * `cloudflare` (auditoria das contas do Cloudflare, com o token guardado no cofre) exige o cofre de credenciais.
     */
    SYNC_SOURCES: z
      .string()
      .default('wazuh')
      .transform((value) => [...new Set(value.split(',').map((source) => source.trim()))])
      .pipe(
        z
          .array(z.enum(['wazuh', 'gcp', 'cloudflare'], { error: 'fontes aceitas: wazuh, gcp e cloudflare' }))
          .min(1),
      ),
    /**
     * Intervalo da auditoria de cada conta do Cloudflare (o laço da tarefa segue o `SYNC_INTERVAL_SECONDS`; a conta
     * lida há menos que isso fica para a volta seguinte).
     */
    CLOUDFLARE_AUDIT_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
    ...planEnvShape,
    // Conexão da AWS pelo papel de leitura sem chave (PR-V5'): com o ID da conta de serviço do nó, a tarefa aws-check
    // confere de verdade (token do Google, STS e S3); sem ele, responde `check_unavailable`.
    ...awsReaderEnvShape,
    // Cofre de credenciais (fase 2): o arquivo com as chaves privadas de todas as versões ativas (uma por linha,
    // `<versão>:<PEM em base64>`), montado só leitura no worker, e a versão corrente. Só o worker decifra.
    CREDENTIALS_PRIVATE_KEYS_FILE: z.string().min(1, { error: 'deve ser o caminho do arquivo' }).optional(),
    CREDENTIALS_KEY_CURRENT: keyVersionFromEnv.optional(),
    // Agentes do Wazuh (WAZUH_AGENTS=true no node.conf): o arquivo da lista que o host exporta do manager e o cliente
    // do nó, a quem os agentes pertencem. Sempre juntos.
    ...workerAgentsEnvShape,
    // Avisos por e-mail (fase 2, PR-16): o mesmo transporte da API, mais a origem do painel para os links. Sem
    // MAIL_TRANSPORT (o nó sem e-mail, que o start.sh deixa sem nenhuma dessas linhas), `none`: os avisos ficam na fila
    // como `skipped`. Com o e-mail ligado, o remetente e a origem do painel são obrigatórios.
    MAIL_TRANSPORT: z.enum(MAIL_TRANSPORTS).default('none'),
    MAIL_FROM: mailFromEnv.optional(),
    ...mailServerEnvShape,
    WEB_ORIGIN: webOriginFromEnv.optional(),
    // Wazuh no nó (perfil standard, PR-V4'): a pasta dos sinais sem segredo entre o worker e o host (a geração das
    // contas AWS, a aplicação no manager e o token do Google). Com ela, entra a tarefa `wazuh-config`.
    WAZUH_SIGNAL_DIR: z
      .string()
      .regex(/^\/[\w./-]+$/, { error: 'deve ser o caminho absoluto da pasta dos sinais do Wazuh' })
      .optional(),
    // API do manager do Wazuh do nó (perfil standard, PR-V6): o endereço, a CA e a senha do verax_stats, os três juntos.
    // Com eles, entra a tarefa `wazuh-usage` (o medidor da AWS e a saúde da ingestão).
    ...wazuhApiEnvShape,
    // Estado do nó nos guest attributes da VM (nó de cliente, CUSTOMER_MODE=true no node.conf): a tarefa `node-status`
    // publica a versão, as contas conectadas, o último evento e o disco livre. VERAX_NODE_COMMIT é o commit instalado (o de
    // /etc/verax/images.env), obrigatório com NODE_STATUS=true. Sem as duas, nada muda (o nó da Verax).
    NODE_STATUS: z
      .enum(['true', 'false'], { error: 'use true ou false' })
      .default('false')
      .transform((value) => value === 'true'),
    VERAX_NODE_COMMIT: z
      .string()
      .regex(/^[0-9a-f]{40}$/, { error: 'deve ser o commit instalado (40 caracteres hexadecimais)' })
      .optional(),
  })
  .superRefine((env, ctx) => {
    checkPlanEnv(env, ctx);
    checkMailEnv(env, ctx);
    // Os avisos ainda montam os links com um WEB_ORIGIN só: na célula, levariam o cliente ao painel de outro. Até os
    // links serem por cliente, a célula não manda aviso (ficam na fila como `skipped`, como no nó sem e-mail).
    if (env.NODE_MODE === 'cell' && env.MAIL_TRANSPORT !== 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_TRANSPORT'],
        message: 'deve ser none com NODE_MODE=cell (os links dos avisos ainda não são por cliente)',
      });
    }
    if (env.MAIL_TRANSPORT !== 'none') {
      for (const key of ['MAIL_FROM', 'WEB_ORIGIN'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'obrigatória com o e-mail ligado (MAIL_TRANSPORT)',
          });
        }
      }
    }
    if (
      env.NODE_ENV === 'production' &&
      env.WEB_ORIGIN !== undefined &&
      !env.WEB_ORIGIN.startsWith('https://')
    ) {
      ctx.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'deve usar https em produção' });
    }
    checkPair(env, ['CREDENTIALS_PRIVATE_KEYS_FILE', 'CREDENTIALS_KEY_CURRENT'], ctx);
    checkPair(env, ['WAZUH_AGENTS_FILE', 'WAZUH_AGENTS_TENANT'], ctx);
    checkTogether(env, WAZUH_API_KEYS, ctx);
    if (env.NODE_STATUS && env.VERAX_NODE_COMMIT === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['VERAX_NODE_COMMIT'],
        message: 'obrigatória com NODE_STATUS=true (a versão publicada nos guest attributes)',
      });
    }
    if (env.SYNC_SOURCES.includes('cloudflare') && env.CREDENTIALS_PRIVATE_KEYS_FILE === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SYNC_SOURCES'],
        message:
          'a fonte cloudflare lê o token do cofre de credenciais: exige CREDENTIALS_PRIVATE_KEYS_FILE e CREDENTIALS_KEY_CURRENT',
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
  .transform(
    (
      {
        CREDENTIALS_PRIVATE_KEYS_FILE,
        CREDENTIALS_KEY_CURRENT,
        WAZUH_AGENTS_FILE,
        WAZUH_AGENTS_TENANT,
        NODE_STATUS,
        VERAX_NODE_COMMIT,
        WAZUH_API_URL,
        WAZUH_API_CA_FILE,
        WAZUH_STATS_PASSWORD,
        ...env
      },
      ctx,
    ) => {
      // As chaves já lidas do arquivo (um objeto que não vira JSON nem texto de log); o caminho não fica na configuração.
      let credentialsKeyring: VaultKeyring | null = null;
      if (CREDENTIALS_PRIVATE_KEYS_FILE !== undefined && CREDENTIALS_KEY_CURRENT !== undefined) {
        credentialsKeyring = vaultKey(
          () => parsePrivateKeys(readPrivateKeysFile(CREDENTIALS_PRIVATE_KEYS_FILE), CREDENTIALS_KEY_CURRENT),
          'CREDENTIALS_PRIVATE_KEYS_FILE',
          ctx,
        );
      }
      const wazuhAgents = wazuhAgentsFeedOf({ WAZUH_AGENTS_FILE, WAZUH_AGENTS_TENANT });
      // A tarefa `node-status` só existe com o interruptor (e a versão, que o superRefine exige com ele).
      const nodeStatus =
        NODE_STATUS && VERAX_NODE_COMMIT !== undefined ? { version: VERAX_NODE_COMMIT } : null;
      // A tarefa `wazuh-usage` só existe com os três (o superRefine exige todos ou nenhum); a senha não fica solta.
      const wazuhApi =
        WAZUH_API_URL !== undefined && WAZUH_API_CA_FILE !== undefined && WAZUH_STATS_PASSWORD !== undefined
          ? new WazuhApiConfig(WAZUH_API_URL, WAZUH_API_CA_FILE, WAZUH_STATS_PASSWORD)
          : null;
      return { ...withDefaultPlan(env), credentialsKeyring, wazuhAgents, nodeStatus, wazuhApi };
    },
  );

export const workerEnvSchema = z.preprocess(refuseKeysInEnvironment, workerEnvObjectSchema);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

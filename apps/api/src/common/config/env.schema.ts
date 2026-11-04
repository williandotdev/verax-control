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
import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

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
export const envSchema = z
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
  })
  .superRefine((env, ctx) => {
    checkPlanEnv(env, ctx);
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
  .transform(withDefaultPlan);

export type Env = z.infer<typeof envSchema>;

/**
 * Variáveis do worker do sync de alertas (T5.3): só o banco, o log, o intervalo e o plano. Nada de autenticação,
 * e-mail nem origens, porque o worker não atende requisição. O indexer tem configuração própria (`loadIndexerConfig`).
 */
export const workerEnvSchema = z
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
  })
  .superRefine((env, ctx) => {
    checkPlanEnv(env, ctx);
    if (env.NODE_ENV === 'production' && !requiresVerifiedTls(env.DATABASE_URL)) {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message: 'deve usar sslmode=verify-full em produção (TLS com certificado conferido)',
      });
    }
  })
  .transform(withDefaultPlan);

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

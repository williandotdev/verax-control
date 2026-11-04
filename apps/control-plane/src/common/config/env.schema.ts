import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/** Papel do processo: a mesma imagem sobe como `cp-public` (rotas públicas) ou `cp-worker` (passos internos). */
export const ROLES = ['public', 'worker'] as const;
export type Role = (typeof ROLES)[number];

/** `true`/`false` com padrão. O `.default()` vem antes do `.transform()`: depois dele, o padrão sairia sem converter. */
const boolean = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'], { error: 'deve ser true ou false' })
    .default(fallback)
    .transform((value) => value === 'true');

const httpsUrl = z.url({ protocol: /^https$/, error: 'deve ser uma URL https válida' });

/** Lista separada por vírgula; itens repetidos contam uma vez. */
const list = <T extends z.ZodType<string, string>>(item: T, min = 1) =>
  z
    .string()
    .transform((value) => [...new Set(value.split(',').map((part) => part.trim()))].filter(Boolean))
    .pipe(z.array(item).min(min, { error: 'deve ter ao menos um item' }));

const email = z.email({ error: 'deve ser um e-mail válido' });
const serviceAccountEmail = z.string().regex(/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/, {
  error: 'deve ser o e-mail de uma conta de serviço',
});

/** Identificadores da GCP e do Cloudflare, no formato exigido por cada serviço. */
const gcpProjectId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, { error: 'ID de projeto GCP inválido' });
const gcpRegion = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/, { error: 'região GCP inválida' });
const gcpZone = z.string().regex(/^[a-z]+-[a-z]+[0-9]-[a-z]$/, { error: 'zona GCP inválida' });
const gcsBucket = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/, { error: 'nome de bucket inválido' });
const gcpResourceName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, { error: 'nome de recurso inválido' });
const cloudflareId = z.string().regex(/^[0-9a-f]{32}$/, { error: 'deve ter 32 dígitos hexadecimais' });
// Classe única e tamanho limitado: tempo linear, sem backtracking (o DNS valida o resto).
const hostname = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/i, { error: 'nome de domínio inválido' });
const hostPort = z.string().regex(/^[a-z0-9.-]+:[0-9]{1,5}$/i, { error: 'deve ter o formato host:porta' });
/** Versão de um texto legal publicado no site, como `2026-11-04` ou `v3`. */
const documentVersion = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, { error: 'versão inválida (letras, números, ponto, traço)' });
const releaseVersion = documentVersion;

/**
 * Chaves da Stripe: a chave restrita (`rk_`) é a esperada; a completa (`sk_`) passa no formato, mas o responsável
 * foi orientado a não usá-la (plano §9). O trecho `test`/`live` decide o modo e é conferido com `STRIPE_LIVE`.
 */
const stripeSecretKey = z
  .string()
  .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/, { error: 'chave da Stripe em formato inválido' });
const stripeWebhookSecret = z
  .string()
  .regex(/^whsec_[A-Za-z0-9]{8,}$/, { error: 'segredo de webhook da Stripe em formato inválido' });
const stripeLookupKey = z.string().regex(/^[a-z0-9_]{3,64}$/, { error: 'lookup_key inválido' });

/** Variáveis que passam a ser obrigatórias com `PROVISIONING_ENABLED=true` (plano §2.5). */
export const PROVISIONING_REQUIRED = [
  'NODES_PROJECT_ID',
  'NODES_REGION',
  'NODES_ZONE',
  'TFSTATE_BUCKET',
  'TERRAFORM_JOB_NAME',
  'IMAGES_PROJECT_ID',
  'RELEASE_BUCKET',
  'NODE_RELEASE',
  'MAIL_FROM_NODES',
] as const;

/**
 * Variáveis de ambiente do plano de controle (plano §2.5), validadas na partida: o processo não sobe se alguma
 * obrigatória faltar ou for inválida. Os grupos que só os PRs seguintes usam (site, Stripe, filas, provisionamento,
 * Cloudflare e Firebase, acesso e e-mail) já entram aqui como opcionais com o formato conferido, para que uma
 * configuração errada apareça na partida, e não no meio de um checkout. Cada PR que passar a depender de um grupo
 * o torna obrigatório no papel certo.
 */
export const envSchema = z
  .object({
    // Papel
    ROLE: z.enum(ROLES, { error: 'deve ser public ou worker' }),
    NODE_ENV: z.enum(['development', 'test', 'production']),
    LOG_LEVEL: z.enum(logLevels).default('info'),
    // O Cloud Run define PORT (8080 por padrão); o valor precisa bater com a porta do contêiner.
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    // Quantos proxies confiáveis ficam na frente do serviço: o Hosting/Cloud Run conta 1. Define de onde sai o IP
    // do cliente nos limites por IP; com 0, o X-Forwarded-For é ignorado e não pode ser forjado.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    // Site (CP-03): origens aceitas no CORS, páginas de retorno do Checkout e versões dos textos aceitos.
    SITE_ORIGINS: list(httpsUrl).optional(),
    SITE_SUCCESS_URL: httpsUrl.optional(),
    SITE_CANCEL_URL: httpsUrl.optional(),
    TERMS_VERSION: documentVersion.optional(),
    PRIVACY_VERSION: documentVersion.optional(),
    DPA_VERSION: documentVersion.optional(),

    // Stripe (CP-03 e CP-04). Chaves de teste e de produção são segredos distintos; STRIPE_LIVE diz qual vale.
    STRIPE_SECRET_KEY: stripeSecretKey.optional(),
    STRIPE_WEBHOOK_SECRET: stripeWebhookSecret.optional(),
    STRIPE_LIVE: boolean('false'),
    STRIPE_PRICE_LOOKUP_ESSENCIAL: stripeLookupKey.optional(),
    STRIPE_PRICE_LOOKUP_PROFISSIONAL: stripeLookupKey.optional(),
    STRIPE_PORTAL_LOGIN_URL: httpsUrl.optional(),

    // Estado e filas. O banco gratuito do Firestore é o `(default)`; o projeto vem do ambiente do Cloud Run, e só
    // precisa ser informado com o emulador (testes e desenvolvimento), que não tem metadados de projeto.
    FIRESTORE_DATABASE: z
      .string()
      .regex(/^(\(default\)|[a-z0-9-]{4,63})$/, { error: 'nome de banco do Firestore inválido' })
      .default('(default)'),
    FIRESTORE_PROJECT_ID: gcpProjectId.optional(),
    FIRESTORE_EMULATOR_HOST: hostPort.optional(),
    TASKS_LOCATION: gcpRegion.optional(),
    TASKS_QUEUE_PROVISIONING: gcpResourceName.optional(),
    TASKS_QUEUE_LIFECYCLE: gcpResourceName.optional(),
    WORKER_URL: httpsUrl.optional(),
    WORKER_SA_EMAIL: serviceAccountEmail.optional(),
    SCHEDULER_SA_EMAIL: serviceAccountEmail.optional(),
    OWNER_PRINCIPALS: list(email).optional(),

    // Provisionamento (CP-07): desligado até existir o projeto dos nós; ligado, exige o grupo inteiro na partida.
    PROVISIONING_ENABLED: boolean('false'),
    NODES_PROJECT_ID: gcpProjectId.optional(),
    NODES_REGION: gcpRegion.optional(),
    NODES_ZONE: gcpZone.optional(),
    TFSTATE_BUCKET: gcsBucket.optional(),
    TERRAFORM_JOB_NAME: gcpResourceName.optional(),
    IMAGES_PROJECT_ID: gcpProjectId.optional(),
    RELEASE_BUCKET: gcsBucket.optional(),
    NODE_RELEASE: releaseVersion.optional(),
    MAIL_FROM_NODES: email.optional(),

    // Cloudflare e Firebase (CP-07).
    CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
    CLOUDFLARE_ACCOUNT_ID: cloudflareId.optional(),
    CLOUDFLARE_ZONE_ID: cloudflareId.optional(),
    CLOUDFLARE_ZONE_NAME: hostname.default('veraxsistemas.com.br'),
    PANEL_DOMAIN_SUFFIX: hostname.default('control.veraxsistemas.com.br'),
    API_DOMAIN_PREFIX: z
      .string()
      .regex(/^[a-z0-9]([a-z0-9-]{0,30})$/, { error: 'prefixo de subdomínio inválido' })
      .default('api-'),
    FIREBASE_PANEL_PROJECTS: list(gcpProjectId).optional(),

    // Acesso e e-mail (CP-05). COOKIE_KEY assina o cookie da página de status: 32 bytes ou mais.
    COOKIE_KEY: z.string().min(32, { error: 'deve ter pelo menos 32 caracteres' }).optional(),
    SMTP_HOST: hostname.optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    MAIL_FROM: email.optional(),
    // Nunca vai a log: só a métrica de alerta cita "owner".
    OWNER_ALERT_EMAIL: email.optional(),
  })
  .superRefine((env, ctx) => {
    const production = env.NODE_ENV === 'production';
    if (production && env.TRUST_PROXY_HOPS === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['TRUST_PROXY_HOPS'],
        message: 'deve contar o Hosting e o Cloud Run (1) em produção',
      });
    }
    if (production && env.FIRESTORE_EMULATOR_HOST !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIRESTORE_EMULATOR_HOST'],
        message: 'não pode apontar para o emulador em produção',
      });
    }
    if (env.FIRESTORE_EMULATOR_HOST !== undefined && env.FIRESTORE_PROJECT_ID === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['FIRESTORE_PROJECT_ID'],
        message: 'obrigatória com FIRESTORE_EMULATOR_HOST',
      });
    }
    if (env.STRIPE_SECRET_KEY !== undefined) {
      const liveKey = env.STRIPE_SECRET_KEY.includes('_live_');
      if (env.STRIPE_LIVE && !liveKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_SECRET_KEY'],
          message: 'chave de teste com STRIPE_LIVE=true',
        });
      }
      if (!env.STRIPE_LIVE && liveKey) {
        ctx.addIssue({
          code: 'custom',
          path: ['STRIPE_SECRET_KEY'],
          message: 'chave de produção com STRIPE_LIVE=false',
        });
      }
    }
    if (env.PROVISIONING_ENABLED) {
      for (const key of PROVISIONING_REQUIRED) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com PROVISIONING_ENABLED=true' });
        }
      }
    }
    if (env.SMTP_HOST !== undefined) {
      for (const key of ['SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const) {
        if (env[key] === undefined) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com SMTP_HOST' });
        }
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

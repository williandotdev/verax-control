import { z } from 'zod';
import { withPagination } from './pagination.js';

/** AWS, GCP (o SOC da própria Verax) e Cloudflare (WAF e DNS de quem usa). */
export const CLOUD_PROVIDERS = ['aws', 'gcp', 'cloudflare'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export const CLOUD_ACCOUNT_STATUSES = ['active', 'inactive'] as const;
export const CLOUD_ACCOUNT_CONNECTIONS = ['ok', 'error', 'pending'] as const;
export type CloudAccountConnection = (typeof CLOUD_ACCOUNT_CONNECTIONS)[number];
/** Fontes de log que o Wazuh lê de buckets S3 da conta do cliente (T4.4 a T4.6). */
export const LOG_SOURCES = ['cloudtrail', 'guardduty', 'waf'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** Papel criado pelo template do conector (T4.3) em toda conta: o cadastro não escolhe papel. */
export const READ_ONLY_ROLE_NAME = 'VeraxControlReadOnly';

export const awsAccountIdSchema = z.string().regex(/^\d{12}$/, { error: 'ID de conta AWS tem 12 dígitos' });

/** ID do projeto da GCP: 6 a 30 caracteres, minúsculas, números e hífen; começa com letra e não termina em hífen. */
export const gcpProjectIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, { error: 'ID de projeto da GCP inválido' });

/** ID da conta do Cloudflare: 32 caracteres hexadecimais (aparece na URL e na página inicial da conta). */
export const cloudflareAccountIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, { error: 'ID de conta do Cloudflare tem 32 caracteres hexadecimais' });

/**
 * Conta de qualquer provedor, onde achados, incidentes e postura citam a conta. Os três formatos não se
 * sobrepõem: 12 dígitos, projeto que começa com letra (até 30 caracteres) e 32 hexadecimais.
 */
export const cloudAccountRefSchema = z.union(
  [awsAccountIdSchema, gcpProjectIdSchema, cloudflareAccountIdSchema],
  {
    error: 'conta inválida',
  },
);
const PARTITION_QUALIFIERS = new Set(['gov', 'iso', 'isob', 'isoe', 'isof']);

/** Código de região da AWS: `sa-east-1`, `us-gov-west-1`, `us-isob-east-1`. Conferido por partes, sem regex aninhada. */
export function isAwsRegion(name: string): boolean {
  const parts = name.split('-');
  if (parts.length !== 3 && parts.length !== 4) return false;
  const [country = '', ...rest] = parts;
  const [area = '', number = ''] = rest.slice(-2);
  const qualifierOk = parts.length === 3 || PARTITION_QUALIFIERS.has(rest[0] ?? '');
  return /^[a-z]{2}$/.test(country) && qualifierOk && /^[a-z]{1,16}$/.test(area) && /^\d$/.test(number);
}

const regionSchema = z.string().max(32).refine(isAwsRegion, { error: 'região AWS inválida' });

/** Regras de nome de bucket do S3: 3 a 63 caracteres, minúsculas, números, ponto e hífen, sem formato de IP. */
const bucketSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, { error: 'nome de bucket S3 inválido' })
  .refine((name) => !/^\d+\.\d+\.\d+\.\d+$/.test(name) && !name.includes('..'), {
    error: 'nome de bucket S3 inválido',
  });

/**
 * Assinatura do Pub/Sub de onde o nó lê os logs do projeto (o coletor do Cloud Logging publica no tópico dela).
 * Subconjunto das regras da GCP: começa com letra, 3 a 255 caracteres, sem o prefixo reservado `goog`.
 */
const pubsubSubscriptionSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9._-]{2,254}$/, { error: 'nome de assinatura do Pub/Sub inválido' })
  .refine((name) => !name.toLowerCase().startsWith('goog'), {
    error: 'nome de assinatura do Pub/Sub inválido',
  });

/** Nome de domínio (zona do Cloudflare), conferido rótulo a rótulo, sem regex aninhada. */
export function isDomainName(name: string): boolean {
  if (name.length > 253) return false;
  const labels = name.split('.');
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9-]+$/.test(label) &&
        !label.startsWith('-') &&
        !label.endsWith('-'),
    )
  );
}

const zonesSchema = z
  .array(
    z.string().max(253).refine(isDomainName, { error: 'zona inválida: use o domínio, como exemplo.com.br' }),
  )
  .max(50)
  .refine((zones) => new Set(zones).size === zones.length, { error: 'zona repetida' });

const regionsSchema = z
  .array(regionSchema)
  .min(1)
  .max(40)
  .refine((regions) => new Set(regions).size === regions.length, { error: 'região repetida' });

const bucketsSchema = z.strictObject({
  cloudtrail: bucketSchema.nullable().optional(),
  guardduty: bucketSchema.nullable().optional(),
  // O logging do WAF só grava em bucket com este prefixo (exigência da AWS).
  waf: bucketSchema
    .refine((name) => name.startsWith('aws-waf-logs-'), { error: 'o bucket do WAF começa com aws-waf-logs-' })
    .nullable()
    .optional(),
});

/**
 * Conta cloud do cliente (T3.3), com os campos do provedor. Não há campo de credencial em nenhum deles:
 * - AWS: a Verax só assume o papel de leitura com o ExternalId, gerado pelo servidor e nunca aceito do request;
 * - GCP: o nó lê a assinatura com a identidade dele, sem chave de conta de serviço;
 * - Cloudflare: o token somente leitura fica no cofre de segredos do nó, nunca no cadastro.
 */
export const cloudAccountCreateSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('aws'),
    accountId: awsAccountIdSchema,
    regions: regionsSchema,
    /** Buckets de onde o Wazuh lê os logs desta conta; vinculam cada alerta ao cliente (T5.2). */
    buckets: bucketsSchema.optional(),
  }),
  z.strictObject({
    provider: z.literal('gcp'),
    accountId: gcpProjectIdSchema,
    pubsubSubscription: pubsubSubscriptionSchema.nullable().optional(),
  }),
  z.strictObject({
    provider: z.literal('cloudflare'),
    accountId: cloudflareAccountIdSchema,
    zones: zonesSchema.optional(),
  }),
]);
export type CloudAccountCreate = z.infer<typeof cloudAccountCreateSchema>;

/** O provedor e o ID não mudam: outra conta é outro cadastro. Cada campo só vale para o provedor dele. */
export const cloudAccountUpdateSchema = z
  .strictObject({
    regions: regionsSchema.optional(),
    buckets: bucketsSchema.optional(),
    pubsubSubscription: pubsubSubscriptionSchema.nullable().optional(),
    zones: zonesSchema.optional(),
    status: z.enum(CLOUD_ACCOUNT_STATUSES).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, { error: 'informe ao menos um campo' });
export type CloudAccountUpdate = z.infer<typeof cloudAccountUpdateSchema>;

const PROVIDER_FIELDS: Record<CloudProvider, readonly string[]> = {
  aws: ['regions', 'buckets', 'status'],
  gcp: ['pubsubSubscription', 'status'],
  cloudflare: ['zones', 'status'],
};

/** Campos de uma alteração que não existem no provedor da conta (a API recusa, em vez de ignorar). */
export function fieldsOutsideProvider(provider: CloudProvider, update: CloudAccountUpdate): string[] {
  return Object.keys(update).filter((field) => !PROVIDER_FIELDS[provider].includes(field));
}

export const cloudAccountListQuerySchema = withPagination({
  status: z.enum(CLOUD_ACCOUNT_STATUSES).optional(),
});
export type CloudAccountListQuery = z.infer<typeof cloudAccountListQuerySchema>;

export const cloudAccountSchema = z.strictObject({
  id: z.uuid(),
  provider: z.enum(CLOUD_PROVIDERS),
  accountId: cloudAccountRefSchema,
  /** AWS: regiões monitoradas. Vazio nos demais provedores. */
  regions: z.array(z.string()),
  /** AWS: papel de leitura do conector. Null nos demais. */
  roleArn: z.string().nullable(),
  /** AWS, só para quem configura o conector (`cloud_accounts:write`); para os demais e fora da AWS, null. */
  externalId: z.string().nullable(),
  /** AWS: buckets de log por fonte. Todos null nos demais. */
  buckets: z.strictObject({
    cloudtrail: z.string().nullable(),
    guardduty: z.string().nullable(),
    waf: z.string().nullable(),
  }),
  /** GCP: assinatura do Pub/Sub lida pelo nó; null antes de configurada e nos demais. */
  pubsubSubscription: z.string().nullable(),
  /** Cloudflare: zonas (domínios) monitoradas. Vazio nos demais. */
  zones: z.array(z.string()),
  status: z.enum(CLOUD_ACCOUNT_STATUSES),
  /**
   * Situação da conexão (T7.3): `ok` quando o papel de leitura foi assumido na última tentativa, `error` quando
   * falhou, `pending` antes da primeira. Opcional até a persistência do E5 gravar.
   */
  connection: z.enum(CLOUD_ACCOUNT_CONNECTIONS).optional(),
  /** Horário do último alerta recebido desta conta (T5.3); null se nunca chegou nada. */
  lastEventAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CloudAccount = z.infer<typeof cloudAccountSchema>;

export function readOnlyRoleArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${READ_ONLY_ROLE_NAME}`;
}

import { z } from 'zod';
import { withPagination } from './pagination.js';

export const CLOUD_PROVIDERS = ['aws'] as const;
export const CLOUD_ACCOUNT_STATUSES = ['active', 'inactive'] as const;
export const CLOUD_ACCOUNT_CONNECTIONS = ['ok', 'error', 'pending'] as const;
export type CloudAccountConnection = (typeof CLOUD_ACCOUNT_CONNECTIONS)[number];
/** Fontes de log que o Wazuh lê de buckets S3 da conta do cliente (T4.4 a T4.6). */
export const LOG_SOURCES = ['cloudtrail', 'guardduty', 'waf'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** Papel criado pelo template do conector (T4.3) em toda conta: o cadastro não escolhe papel. */
export const READ_ONLY_ROLE_NAME = 'VeraxControlReadOnly';

export const awsAccountIdSchema = z.string().regex(/^\d{12}$/, { error: 'ID de conta AWS tem 12 dígitos' });
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
 * Conta AWS do cliente (T3.3). Não há campo de credencial: a Verax só assume o papel de leitura com o
 * ExternalId, que é gerado pelo servidor e nunca aceito do request.
 */
export const cloudAccountCreateSchema = z.strictObject({
  provider: z.enum(CLOUD_PROVIDERS),
  accountId: awsAccountIdSchema,
  regions: z
    .array(regionSchema)
    .min(1)
    .max(40)
    .refine((regions) => new Set(regions).size === regions.length, { error: 'região repetida' }),
  /** Buckets de onde o Wazuh lê os logs desta conta; vinculam cada alerta ao cliente (T5.2). */
  buckets: bucketsSchema.optional(),
});
export type CloudAccountCreate = z.infer<typeof cloudAccountCreateSchema>;

/** O ID da conta não muda: outra conta é outro cadastro. */
export const cloudAccountUpdateSchema = z
  .strictObject({
    regions: cloudAccountCreateSchema.shape.regions.optional(),
    buckets: bucketsSchema.optional(),
    status: z.enum(CLOUD_ACCOUNT_STATUSES).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, { error: 'informe ao menos um campo' });
export type CloudAccountUpdate = z.infer<typeof cloudAccountUpdateSchema>;

export const cloudAccountListQuerySchema = withPagination({
  status: z.enum(CLOUD_ACCOUNT_STATUSES).optional(),
});
export type CloudAccountListQuery = z.infer<typeof cloudAccountListQuerySchema>;

export const cloudAccountSchema = z.strictObject({
  id: z.uuid(),
  provider: z.enum(CLOUD_PROVIDERS),
  accountId: awsAccountIdSchema,
  regions: z.array(z.string()),
  roleArn: z.string(),
  /** Só para quem configura o conector (`cloud_accounts:write`); para os demais, null. */
  externalId: z.string().nullable(),
  buckets: z.strictObject({
    cloudtrail: z.string().nullable(),
    guardduty: z.string().nullable(),
    waf: z.string().nullable(),
  }),
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

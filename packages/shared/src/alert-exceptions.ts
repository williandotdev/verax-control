import { z } from 'zod';
import { withPagination } from './pagination.js';
import { authorSchema, plainText } from './protected-resources.js';

/** Campo do alerta comparado pela exceção (T3.5). */
export const ALERT_EXCEPTION_FIELDS = ['user', 'ip', 'resource'] as const;
export type AlertExceptionField = (typeof ALERT_EXCEPTION_FIELDS)[number];

/** Validade máxima de uma exceção: um ano. Sem validade, ela vale até ser removida. */
export const ALERT_EXCEPTION_MAX_DAYS = 365;

const isIpOrCidr = (value: string): boolean =>
  [z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()].some((schema) => schema.safeParse(value).success);

const expiresAtSchema = z.iso.datetime({ offset: true }).refine(
  (value) => {
    const at = Date.parse(value);
    return at > Date.now() && at <= Date.now() + ALERT_EXCEPTION_MAX_DAYS * 24 * 60 * 60 * 1000;
  },
  { error: `a validade precisa estar no futuro e em até ${ALERT_EXCEPTION_MAX_DAYS} dias` },
);

/**
 * Exceção de alerta: o sync (T5.3) marca como esperado o achado da regra do Wazuh cujo usuário, IP ou
 * recurso bate com o valor. Escopo do cliente da sessão.
 */
export const alertExceptionCreateSchema = z
  .strictObject({
    ruleId: z.string().regex(/^\d{1,6}$/, { error: 'ID de regra tem até 6 dígitos' }),
    field: z.enum(ALERT_EXCEPTION_FIELDS),
    value: plainText(256),
    reason: plainText(500),
    expiresAt: expiresAtSchema.nullable().optional(),
  })
  .refine((input) => input.field !== 'ip' || isIpOrCidr(input.value), {
    error: 'IP ou faixa CIDR inválida',
    path: ['value'],
  });
export type AlertExceptionCreate = z.infer<typeof alertExceptionCreateSchema>;

/** Motivo e validade mudam; regra, campo e valor definem a exceção (outra combinação é outra exceção). */
export const alertExceptionUpdateSchema = z
  .strictObject({ reason: plainText(500).optional(), expiresAt: expiresAtSchema.nullable().optional() })
  .refine((update) => Object.keys(update).length > 0, { error: 'informe ao menos um campo' });
export type AlertExceptionUpdate = z.infer<typeof alertExceptionUpdateSchema>;

export const alertExceptionListQuerySchema = withPagination({
  ruleId: z
    .string()
    .regex(/^\d{1,6}$/)
    .optional(),
  active: z.enum(['true', 'false']).optional(),
});
export type AlertExceptionListQuery = z.infer<typeof alertExceptionListQuerySchema>;

export const alertExceptionSchema = z.strictObject({
  id: z.uuid(),
  ruleId: z.string(),
  field: z.enum(ALERT_EXCEPTION_FIELDS),
  value: z.string(),
  reason: z.string(),
  expiresAt: z.iso.datetime().nullable(),
  /** Vencida a validade, a exceção para de valer, mas continua listada. */
  active: z.boolean(),
  matchedCount: z.number().int().min(0),
  lastMatchedAt: z.iso.datetime().nullable(),
  createdBy: authorSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AlertException = z.infer<typeof alertExceptionSchema>;

import { z } from 'zod';
import { withPagination } from './pagination.js';

export const TENANT_STATUSES = ['active', 'inactive'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

const CNPJ_FORMAT = /^[0-9A-Z]{12}[0-9]{2}$/;
const FIRST_WEIGHTS = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const SECOND_WEIGHTS = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

function checkDigit(base: string, weights: readonly number[]): number {
  // Cada caractere vale o código ASCII menos 48: "0" a "9" valem 0 a 9, e "A" a "Z" valem 17 a 42.
  const sum = weights.reduce((total, weight, index) => total + (base.charCodeAt(index) - 48) * weight, 0);
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/**
 * CNPJ no formato alfanumérico da Receita (emitido desde julho de 2026), que inclui o numérico antigo: 12
 * caracteres de A a Z ou 0 a 9 e dois dígitos verificadores, calculados pelo módulo 11. Recebe o valor já sem
 * máscara e em maiúsculas.
 */
export function isValidCnpj(value: string): boolean {
  if (!CNPJ_FORMAT.test(value) || /^(.)\1+$/.test(value)) return false;
  const first = checkDigit(value.slice(0, 12), FIRST_WEIGHTS);
  const second = checkDigit(value.slice(0, 12) + String(first), SECOND_WEIGHTS);
  return value.endsWith(`${first}${second}`);
}

/** Aceita com ou sem máscara (`12.ABC.345/01DE-35`); guarda só os 14 caracteres, em maiúsculas. */
export const cnpjSchema = z
  .string()
  .max(18)
  .transform((value) => value.replace(/[.\-/\s]/g, '').toUpperCase())
  .refine(isValidCnpj, { error: 'CNPJ inválido' });

const escalationContactSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  // No máximo 20 caracteres, o tamanho da coluna no banco.
  phone: z
    .string()
    .trim()
    .max(20)
    .regex(/^\+?[0-9][0-9 ()-]{7,19}$/, { error: 'telefone inválido' })
    .nullable()
    .optional(),
});

/** Cadastro de cliente (T3.1). Só `admin_verax` cria e altera. */
export const tenantCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  cnpj: cnpjSchema,
  /** Texto livre (premissa aprovada: o plano não define valores). */
  plan: z.string().trim().min(1).max(60),
  /** Quem a Verax aciona num incidente grave. */
  escalationContact: escalationContactSchema,
});
export type TenantCreate = z.infer<typeof tenantCreateSchema>;

export const tenantUpdateSchema = tenantCreateSchema
  .partial()
  .extend({ status: z.enum(TENANT_STATUSES).optional() })
  .refine((update) => Object.keys(update).length > 0, { error: 'informe ao menos um campo' });
export type TenantUpdate = z.infer<typeof tenantUpdateSchema>;

export const tenantListQuerySchema = withPagination({ status: z.enum(TENANT_STATUSES).optional() });
export type TenantListQuery = z.infer<typeof tenantListQuerySchema>;

/** Resumo de cliente para seletores e listagens. */
export const tenantSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  status: z.enum(TENANT_STATUSES),
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;

/** Cadastro completo. Clientes anteriores à T3.1 podem não ter CNPJ, plano nem contato. */
export const tenantSchema = tenantSummarySchema.extend({
  cnpj: z.string().nullable(),
  plan: z.string().nullable(),
  escalationContact: z
    .strictObject({ name: z.string(), email: z.string(), phone: z.string().nullable() })
    .nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type Tenant = z.infer<typeof tenantSchema>;

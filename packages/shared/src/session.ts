import { z } from 'zod';
import { PERMISSIONS, type Permission, ROLES } from './permissions.js';

const permissionNames = Object.keys(PERMISSIONS) as [Permission, ...Permission[]];

/** Resposta de `GET /v1/me`: a identidade da sessão, validada pelo painel antes de usar. */
export const meSchema = z.strictObject({
  userId: z.string().min(1),
  email: z.email(),
  role: z.enum(ROLES),
  /** Cliente ao qual o usuário pertence (null para admin_verax). */
  tenantId: z.uuid().nullable(),
  /** Cliente selecionado na sessão por um admin_verax. */
  activeTenantId: z.uuid().nullable(),
  /** Cliente cujos dados a sessão enxerga. */
  scopeTenantId: z.uuid().nullable(),
  mfaEnabled: z.boolean(),
  permissions: z.array(z.enum(permissionNames)),
});
export type Me = z.infer<typeof meSchema>;

/** Resumo de cliente para seletores e cabeçalho. O cadastro completo entra na T3.1. */
export const tenantSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  status: z.enum(['active', 'inactive']),
});
export type TenantSummary = z.infer<typeof tenantSummarySchema>;

export const switchTenantResponseSchema = z.strictObject({ activeTenantId: z.uuid() });

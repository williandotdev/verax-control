import type { TenantState } from '../tenants/tenant.schema.js';

/**
 * Estados em que o nó gerenciado sincroniza: com a VM no ar (o provisionamento, a espera da conexão, o ambiente pronto
 * e a carência da cobrança). Suspenso, cancelado ou excluído: 404 (a VM do suspenso está parada). Na VM do cliente,
 * valem os estados do registro (`nodeKeyValid`, sem `past_due`: o contrato direto não tem cobrança pela Stripe).
 */
export const NODE_SYNC_ACTIVE_STATES: ReadonlySet<TenantState> = new Set([
  'provisioning',
  'waiting_customer_connection',
  'active',
  'past_due',
]);

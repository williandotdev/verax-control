import type { TenantState } from './tenant.schema.js';

/**
 * Transições permitidas entre estados (plano §4b e §4d). Esqueleto: o webhook (CP-04), o `tick` e a exclusão
 * (CP-11) usam esta tabela e acrescentam as transições que faltarem, sempre com teste. Tudo o que não está aqui é
 * recusado com `InvalidTransitionError`, inclusive repetir o estado atual.
 *
 * - `pending`: criado no `checkout.session.completed`; cartão pago ou boleto compensado leva a `provisioning`;
 *   boleto do 1.º ciclo vencido cancela;
 * - `provisioning`: termina em `waiting_customer_connection` (`access.ready`) ou `provisioning_failed`;
 *   cancelamento no meio usa os passos idempotentes da exclusão;
 * - `provisioning_failed`: `resume` pelo responsável volta a `provisioning`;
 * - `waiting_customer_connection`: `active` quando o nó vê a 1.ª conta conectada; cobrança e disputa valem igual;
 * - `active` ↔ `past_due` ↔ `suspended`: inadimplência, carência e reativação por `invoice.paid`;
 * - `suspended` volta a `waiting_customer_connection` quando o cliente nunca chegou a conectar;
 * - `canceled` → `deleted` em D+30 (exclusão em dois tempos: a cripto-destruição em D+97 não muda o estado).
 */
export const TENANT_TRANSITIONS: Readonly<Record<TenantState, readonly TenantState[]>> = {
  pending: ['provisioning', 'canceled'],
  provisioning: ['waiting_customer_connection', 'provisioning_failed', 'canceled'],
  provisioning_failed: ['provisioning', 'canceled'],
  waiting_customer_connection: ['active', 'past_due', 'suspended', 'canceled'],
  active: ['past_due', 'suspended', 'canceled'],
  past_due: ['active', 'waiting_customer_connection', 'suspended', 'canceled'],
  suspended: ['active', 'waiting_customer_connection', 'canceled'],
  canceled: ['deleted'],
  deleted: [],
};

export function canTransition(from: TenantState, to: TenantState): boolean {
  return TENANT_TRANSITIONS[from].includes(to);
}

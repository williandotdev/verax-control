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
 * - `waiting_customer_install`: o contrato direto com o ambiente na infraestrutura do cliente nasce nele (o cadastro
 *   no console, `TenantStore.create` com `initialState`) e só sai cancelado: nunca vai a `provisioning` (nada é criado
 *   na infraestrutura da Verax), e a Verax não vê a instalação do cliente para ir sozinha a `active`;
 * - `waiting_customer_connection`: `active` quando o nó vê a 1.ª conta conectada; cobrança e disputa valem igual;
 * - `active` ↔ `past_due` ↔ `suspended`: inadimplência, carência e reativação por `invoice.paid`;
 * - `suspended` volta a `waiting_customer_connection` quando o cliente nunca chegou a conectar;
 * - `canceled` → `deleted` em D+30 (exclusão em dois tempos: a cripto-destruição em D+97 não muda o estado). É a
 *   única entrada de `deleted`, e só por dois caminhos (CP-11, `lifecycle/`): o `tick` com `deleteAfter` vencido e o
 *   `delete-now` do responsável. Um cliente em qualquer outro estado nunca é excluído; o `tick` só cancela (D+37)
 *   quem está suspenso por falta de pagamento há 30 dias.
 *
 * Disputa ou alerta de fraude durante o provisionamento (CP-04, plano §4b): `provisioning` e `provisioning_failed`
 * → `suspended` (motivo `fraud_review`, decisão humana). Regra para os passos (CP-07): um passo que relê o cliente
 * fora de `provisioning` termina sem fazer nada e sem enfileirar o seguinte; a volta de um `fraud_review` que nunca
 * terminou de provisionar é operação do responsável (CP-11), que acrescenta a transição dela. `provisioning` →
 * `past_due` não entra: a renovação só vence um mês depois da compra, e uma falha de pagamento nesses estados vira
 * aviso ao responsável (webhook), não transição.
 */
export const TENANT_TRANSITIONS: Readonly<Record<TenantState, readonly TenantState[]>> = {
  pending: ['provisioning', 'canceled'],
  provisioning: ['waiting_customer_connection', 'provisioning_failed', 'suspended', 'canceled'],
  provisioning_failed: ['provisioning', 'suspended', 'canceled'],
  waiting_customer_install: ['canceled'],
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

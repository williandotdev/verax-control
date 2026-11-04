/**
 * Coleções do plano de controle (plano da fase 3, §3). Os índices compostos e os campos de TTL definidos aqui
 * são espelhados em `firestore.indexes.json` e `firestore.ttl.json` (o teste `collections.test.ts` garante), que o
 * workflow de implantação aplica com o gcloud (`scripts/firestore-apply.sh`).
 */
export const COLLECTIONS = {
  tenants: 'tenants',
  /** Histórico de estados do cliente; mesma vida do tenant. */
  transitions: (tenantId: string): string => `tenants/${tenantId}/transitions`,
  /** Faturas (5 anos, obrigação fiscal). */
  invoices: (tenantId: string): string => `tenants/${tenantId}/invoices`,
  slugs: 'slugs',
  stripeEvents: 'stripeEvents',
  statusTokens: 'statusTokens',
  provisioningRuns: 'provisioningRuns',
  steps: (runId: string): string => `provisioningRuns/${runId}/steps`,
  auditLog: 'auditLog',
  rateLimits: 'rateLimits',
  counters: 'counters',
} as const;

export interface CompositeIndex {
  collectionGroup: string;
  fields: readonly { fieldPath: string; order: 'ASCENDING' | 'DESCENDING' }[];
}

/** Consultas do `tick` e do `reconcile` sobre `tenants`: estado mais um prazo (plano §3). */
export const COMPOSITE_INDEXES: readonly CompositeIndex[] = [
  {
    collectionGroup: COLLECTIONS.tenants,
    fields: [
      { fieldPath: 'state', order: 'ASCENDING' },
      { fieldPath: 'billing.graceUntil', order: 'ASCENDING' },
    ],
  },
  {
    collectionGroup: COLLECTIONS.tenants,
    fields: [
      { fieldPath: 'state', order: 'ASCENDING' },
      { fieldPath: 'lifecycle.deleteAfter', order: 'ASCENDING' },
    ],
  },
  {
    collectionGroup: COLLECTIONS.tenants,
    fields: [
      { fieldPath: 'state', order: 'ASCENDING' },
      { fieldPath: 'lifecycle.cryptoDestroyAfter', order: 'ASCENDING' },
    ],
  },
  {
    collectionGroup: COLLECTIONS.tenants,
    fields: [
      { fieldPath: 'state', order: 'ASCENDING' },
      { fieldPath: 'stateUpdatedAt', order: 'ASCENDING' },
    ],
  },
];

export interface TtlField {
  collectionGroup: string;
  field: string;
  /** Quem escreve o documento preenche o campo com este prazo; o Firestore apaga depois dele (até 24 h de atraso). */
  retention: string;
}

/** Nome do campo de expiração, o mesmo em todas as coleções com TTL. */
export const TTL_FIELD = 'expiresAt';

export const TTL_FIELDS: readonly TtlField[] = [
  {
    collectionGroup: COLLECTIONS.slugs,
    field: TTL_FIELD,
    retention: 'reserva de 2 h 30; `taken` não tem o campo',
  },
  { collectionGroup: COLLECTIONS.stripeEvents, field: TTL_FIELD, retention: '90 dias' },
  {
    collectionGroup: COLLECTIONS.statusTokens,
    field: TTL_FIELD,
    retention: '7 dias (cookie) ou 24 h (e-mail)',
  },
  { collectionGroup: COLLECTIONS.provisioningRuns, field: TTL_FIELD, retention: '180 dias' },
  {
    collectionGroup: 'steps',
    field: TTL_FIELD,
    retention: '180 dias (o TTL do run não alcança a subcoleção)',
  },
  { collectionGroup: COLLECTIONS.auditLog, field: TTL_FIELD, retention: '24 meses' },
  { collectionGroup: COLLECTIONS.rateLimits, field: TTL_FIELD, retention: 'janela do limite' },
];

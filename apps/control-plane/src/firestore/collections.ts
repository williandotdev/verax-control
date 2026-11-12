import { isUlid } from '../common/ulid.js';
import { isLegalKind, type LegalKind } from '../legal/legal.schema.js';
import { assertDocumentId } from './document-store.js';

const TENANTS = 'tenants';
const PROVISIONING_RUNS = 'provisioningRuns';
const LEGAL_TEXTS = 'legalTexts';

/** Id de cliente: sempre um ULID (`TenantStore.create`). Qualquer outra coisa (inclusive com barra) não monta caminho. */
function tenantSubcollection(tenantId: string, name: string): string {
  if (!isUlid(tenantId)) throw new TypeError('id de cliente inválido');
  return `${TENANTS}/${tenantId}/${name}`;
}

/**
 * Coleções do plano de controle (plano da fase 3, §3).
 *
 * Os índices compostos e os campos de TTL declarados aqui são criados no projeto pelo Terraform, e só por ele
 * (`infra/gcp/envs/control-plane/firestore.tf`: `google_firestore_index.tenants` e `google_firestore_field.ttl`).
 * `firestore.indexes.json` e `firestore.ttl.json` são o espelho legível (formato do Firebase CLI, e um próprio para
 * o TTL). O teste `collections.test.ts` garante que código e JSON batem e, quando o `firestore.tf` está na árvore,
 * que ele cita os mesmos campos. Mudou aqui, mude lá.
 */
export const COLLECTIONS = {
  tenants: TENANTS,
  /** Histórico de estados do cliente; mesma vida do tenant. */
  transitions: (tenantId: string): string => tenantSubcollection(tenantId, 'transitions'),
  /** Faturas (5 anos, obrigação fiscal). */
  invoices: (tenantId: string): string => tenantSubcollection(tenantId, 'invoices'),
  slugs: 'slugs',
  stripeEvents: 'stripeEvents',
  statusTokens: 'statusTokens',
  provisioningRuns: PROVISIONING_RUNS,
  steps: (runId: string): string => {
    assertDocumentId(runId);
    return `${PROVISIONING_RUNS}/${runId}/steps`;
  },
  auditLog: 'auditLog',
  rateLimits: 'rateLimits',
  counters: 'counters',
  /** Tabelas de preços versionadas (preço configurável): rascunho, publicada e aposentada. */
  pricingTables: 'pricingTables',
  /** Modelos de custo versionados (confidenciais: só o console do responsável os lê). */
  costModels: 'costModels',
  /** Cotações do site, válidas por 24 h; o checkout só aceita uma cotação gravada aqui. */
  quotes: 'quotes',
  /**
   * Textos legais versionados (Termos de uso, Política de privacidade e DPA): rascunho e publicada, uma subcoleção por
   * texto (`legalTexts/terms/versions/{versão}`). A vigente sai de uma consulta de um campo só (`publishedAt`): sem
   * índice composto. O documento `legalTexts/{tipo}` em si não existe.
   */
  legalVersions: (kind: LegalKind): string => {
    if (!isLegalKind(kind)) throw new TypeError('texto legal inválido');
    return `${LEGAL_TEXTS}/${kind}/versions`;
  },
  /**
   * Login próprio do console do responsável (cp-admin): a conta de cada responsável (e-mail, hash da senha, segredo do
   * TOTP cifrado e os códigos de recuperação assinados), as sessões (pelo SHA-256 do id), as falhas de login por
   * e-mail (o bloqueio) e as trocas do aplicativo pendentes. Só o cp-admin lê (e o cadastro pela linha de comando,
   * `cli/cadastro-responsavel.ts`, grava a conta).
   */
  adminAccounts: 'adminAccounts',
  adminSessions: 'adminSessions',
  adminLoginThrottle: 'adminLoginThrottle',
  adminEnrollments: 'adminEnrollments',
  /**
   * Célula compartilhada (CE-06): o registro das células (`cells/{id}`, gravado pelo responsável) e os relatórios que
   * cada uma mandou (`cellReports/{célula}_{reportId}`: a idempotência da entrega push e o que fica para os PRs
   * seguintes tratarem). Só o cp-worker lê e grava os relatórios.
   */
  cells: 'cells',
  cellReports: 'cellReports',
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
  { collectionGroup: COLLECTIONS.quotes, field: TTL_FIELD, retention: '24 h (validade da cotação)' },
  {
    collectionGroup: COLLECTIONS.adminSessions,
    field: TTL_FIELD,
    retention: '12 h (prazo absoluto da sessão)',
  },
  {
    collectionGroup: COLLECTIONS.adminLoginThrottle,
    field: TTL_FIELD,
    retention: 'fim da janela de 15 min ou do bloqueio',
  },
  { collectionGroup: COLLECTIONS.adminEnrollments, field: TTL_FIELD, retention: '10 min (cadastro do TOTP)' },
  { collectionGroup: COLLECTIONS.cellReports, field: TTL_FIELD, retention: '90 dias' },
];

/**
 * Achados (T5.3 a T5.5): alertas do Wazuh já vinculados a um cliente e gravados no PostgreSQL, onde ficam os estados
 * humanos (status e comentários). A severidade vem das regras da T5.3; os status, da T5.5.
 */

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Novo, em análise, legítimo (comportamento esperado; pode virar exceção) e resolvido. */
export const FINDING_STATUSES = ['new', 'investigating', 'legitimate', 'resolved'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

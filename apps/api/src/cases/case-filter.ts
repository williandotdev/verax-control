import { type CaseFilterFields, type CaseState, filterWindow } from '@verax/shared';
import { escapeLike } from '../findings/finding-filters.js';
import type { CaseSetFilter } from './case-read-store.js';
import { caseSourceFilter } from './case-sources.js';

/** Os filtros da lista de casos, já validados, no formato do banco. O mesmo para a lista e para a triagem em massa. */
export function caseSetFilter(query: CaseFilterFields & { state: CaseState }, now: Date): CaseSetFilter {
  const window = filterWindow(query, now);
  return {
    queue: query.queue ?? null,
    state: query.state,
    severity: query.severity ?? null,
    source: query.source === undefined ? null : caseSourceFilter(query.source),
    accountId: query.accountId ?? null,
    tactic: query.tactic ?? null,
    technique: query.technique ?? null,
    from: window.from,
    to: window.to,
    pattern: query.q === undefined ? null : `%${escapeLike(query.q)}%`,
    groupBy: query.groupBy ?? null,
    group: query.group ?? null,
  };
}

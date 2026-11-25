import {
  CASE_SORTS,
  CASE_STATES,
  type CaseState,
  FINDING_PERIODS,
  FINDING_SEVERITIES,
  FINDING_SOURCES,
  type FindingPeriod,
  MITRE_TACTICS,
} from '@verax/shared';
import { SlidersHorizontal } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { SEVERITY_STYLES } from '@/design/severity';
import { CustomRange, SearchField, TechniqueField } from '@/features/detections/filter-bar';
import {
  CASE_FILTER_KEYS,
  caseQueueSlug,
  type CasesQueue,
  caseSortSlug,
  caseStateSlug,
  type CaseUrlState,
  CUSTOM_PERIOD,
  DETECTION_PARAMS,
  type DetectionState,
  groupingSlug,
  PERIOD_CHOICE_LABELS,
  VULNERABILITY_GROUPINGS,
  type VulnerabilityGrouping,
} from '@/features/detections/url-state';
import { useCloudAccounts } from '@/features/findings/findings-api';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { TACTIC_LABELS } from '@/features/reports/labels';
import {
  CASE_SORT_LABELS,
  CASE_STATE_LABELS,
  GROUPING_LABELS,
  QUEUE_LABELS,
  severityApplies,
} from './labels';

type Changes = Partial<Record<keyof typeof DETECTION_PARAMS, string | null>>;

const CASE_QUEUES_SHOWN: readonly CasesQueue[] = ['detection', 'posture'];
/** A fila agrupada só tem os casos com pendência: é o que a API conta. */
const GROUPED_STATES: readonly CaseState[] = ['pending', 'investigating'];

/**
 * Os filtros dos casos e da fila de vulnerabilidades, na mesma URL das outras listas. Agrupada, a fila de vulnerabilidades
 * só tem a busca (no valor do grupo), o estado, a severidade e a conta, que é o que a API agrupa.
 */
export function CaseFilterBar({
  view,
  state,
  cases,
  params,
  periodOptions,
  onChange,
}: {
  view: 'cases' | 'vulnerabilities';
  state: DetectionState;
  cases: CaseUrlState;
  params: URLSearchParams;
  /** Os períodos que cabem no histórico do plano. */
  periodOptions: readonly FindingPeriod[];
  onChange: (changes: Changes) => void;
}) {
  const accounts = useCloudAccounts(true);
  const moreId = useId();
  const { filters } = state;
  const grouped = view === 'vulnerabilities' && cases.grouping !== 'none';
  const moreActive = Boolean(
    filters.source ?? filters.accountId ?? filters.tactic ?? filters.technique ?? state.periodChoice,
  );
  const [moreOpen, setMoreOpen] = useState(moreActive);
  const hasFilters = CASE_FILTER_KEYS.some((key) => params.get(DETECTION_PARAMS[key]));
  const shownState = grouped && !GROUPED_STATES.includes(cases.state) ? 'pending' : cases.state;

  const account = (
    <SelectField
      label="Conta"
      value={filters.accountId ?? ''}
      onChange={(value) => onChange({ accountId: value || null })}
      options={[
        { value: '', label: 'Todas' },
        ...(accounts.data ?? []).map((entry) => ({ value: entry.accountId, label: entry.accountId })),
        // A conta da URL aparece mesmo antes de a lista chegar (ou se ela não estiver mais cadastrada).
        ...(filters.accountId && !(accounts.data ?? []).some((entry) => entry.accountId === filters.accountId)
          ? [{ value: filters.accountId, label: filters.accountId }]
          : []),
      ]}
    />
  );

  return (
    <div data-tour="filtros" className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <SearchField
          key={filters.q ?? ''}
          value={filters.q ?? ''}
          placeholder={
            grouped ? `Nome do grupo (${GROUPING_LABELS[cases.grouping].toLowerCase()})` : undefined
          }
          onSearch={(q) => onChange({ q })}
        />
        {view === 'cases' && (
          <SelectField
            label="Fila"
            value={cases.queue}
            onChange={(value) => onChange({ queue: caseQueueSlug(value as CasesQueue) })}
            options={CASE_QUEUES_SHOWN.map((value) => ({ value, label: QUEUE_LABELS[value] }))}
          />
        )}
        {view === 'vulnerabilities' && (
          <SelectField
            label="Agrupar por"
            value={cases.grouping}
            onChange={(value) => onChange({ groupBy: groupingSlug(value as VulnerabilityGrouping), q: null })}
            options={VULNERABILITY_GROUPINGS.map((value) => ({ value, label: GROUPING_LABELS[value] }))}
          />
        )}
        <SelectField
          label="Situação"
          value={shownState}
          onChange={(value) => {
            const next = value as CaseState;
            onChange({ caseState: caseStateSlug(next), ...(!severityApplies(next) && { severity: null }) });
          }}
          options={(grouped ? GROUPED_STATES : CASE_STATES).map((value) => ({
            value,
            label: CASE_STATE_LABELS[value],
          }))}
        />
        {severityApplies(shownState) && (
          <SelectField
            label="Severidade"
            value={filters.severity ?? ''}
            onChange={(value) => onChange({ severity: value || null })}
            options={[
              { value: '', label: 'Todas' },
              ...FINDING_SEVERITIES.map((value) => ({ value, label: SEVERITY_STYLES[value].label })),
            ]}
          />
        )}
        {grouped ? (
          account
        ) : (
          <>
            <SelectField
              label="Ordem"
              value={cases.sort}
              onChange={(value) =>
                onChange({ sort: caseSortSlug(CASE_SORTS.find((sort) => sort === value) ?? 'priority') })
              }
              options={CASE_SORTS.map((value) => ({ value, label: CASE_SORT_LABELS[value] }))}
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-9"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              onClick={() => setMoreOpen(!moreOpen)}
            >
              <SlidersHorizontal aria-hidden />
              Mais filtros
            </Button>
          </>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9"
            onClick={() => onChange(Object.fromEntries(CASE_FILTER_KEYS.map((key) => [key, null])))}
          >
            Limpar filtros
          </Button>
        )}
      </div>
      {!grouped && (
        <div id={moreId} hidden={!moreOpen} className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Período"
            value={state.periodChoice === 'custom' ? CUSTOM_PERIOD : (state.periodChoice ?? '')}
            onChange={(value) =>
              onChange(
                value === CUSTOM_PERIOD
                  ? {
                      period: CUSTOM_PERIOD,
                      from: state.customDates.from || null,
                      to: state.customDates.to || null,
                    }
                  : { period: value || null, from: null, to: null },
              )
            }
            options={[
              { value: '', label: 'Todo o histórico' },
              ...FINDING_PERIODS.filter((period) => periodOptions.includes(period)).map((period) => ({
                value: period,
                label: PERIOD_CHOICE_LABELS[period],
              })),
              { value: CUSTOM_PERIOD, label: PERIOD_CHOICE_LABELS.custom },
            ]}
          />
          {state.periodChoice === 'custom' && (
            <CustomRange from={state.customDates.from} to={state.customDates.to} onChange={onChange} />
          )}
          <SelectField
            label="Fonte"
            value={filters.source ?? ''}
            onChange={(value) => onChange({ source: value || null })}
            options={[
              { value: '', label: 'Todas' },
              ...FINDING_SOURCES.map((value) => ({ value, label: FINDING_SOURCE_LABELS[value] })),
            ]}
          />
          {account}
          <SelectField
            label="Tática do MITRE"
            value={filters.tactic ?? ''}
            onChange={(value) => onChange({ tactic: value || null })}
            options={[
              { value: '', label: 'Todas' },
              ...MITRE_TACTICS.map((tactic) => ({
                value: tactic.name,
                label: `${TACTIC_LABELS[tactic.name] ?? tactic.name} (${tactic.id})`,
              })),
            ]}
          />
          <TechniqueField
            key={filters.technique ?? ''}
            value={filters.technique ?? ''}
            onSubmit={(technique) => onChange({ technique })}
          />
        </div>
      )}
    </div>
  );
}

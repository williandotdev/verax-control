import {
  FINDING_PERIODS,
  FINDING_SEVERITIES,
  FINDING_SOURCES,
  FINDING_STATUSES,
  FINDING_TYPES,
  type FindingPeriod,
  MITRE_TACTICS,
} from '@verax/shared';
import { Search, SlidersHorizontal } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { SelectField } from '@/components/ui/select-field';
import { SEVERITY_STYLES } from '@/design/severity';
import { useCloudAccounts } from '@/features/findings/findings-api';
import {
  FINDING_SOURCE_LABELS,
  FINDING_STATUS_LABELS,
  FINDING_TYPE_LABELS,
} from '@/features/findings/labels';
import { TACTIC_LABELS } from '@/features/reports/labels';
import {
  CUSTOM_PERIOD,
  type DetectionState,
  DETECTION_PARAMS,
  FILTER_KEYS,
  findingTypeSlug,
  NO_ASSIGNEE,
  PERIOD_CHOICE_LABELS,
} from './url-state';

type Changes = Partial<Record<keyof typeof DETECTION_PARAMS, string | null>>;

/** O status na visão de incidentes: "novo" é o aberto, e "legítimo" é só de alerta (não aparece). */
const STATUS_LABELS_INCIDENTS: Readonly<Partial<Record<(typeof FINDING_STATUSES)[number], string>>> = {
  new: 'Aberto',
  investigating: 'Em análise',
  resolved: 'Resolvido',
};

/**
 * Uma barra de filtros só, para a lista e as análises: a busca, o período (com o intervalo personalizado), a
 * severidade e o status sempre à vista; a fonte, a conta, o MITRE, o responsável e a ordem em "Mais filtros". Tudo
 * fica na URL. Nas análises (MITRE e cobertura), só o período vale.
 */
export function FilterBar({
  state,
  params,
  periodOptions,
  onChange,
  analysis,
  types = false,
}: {
  state: DetectionState;
  /** Com os casos (ligados ou em medição), o filtro "Tipo" (E-06): o tipo vem do caso do alerta. */
  types?: boolean;
  params: URLSearchParams;
  /** Os períodos que cabem no histórico do plano. */
  periodOptions: readonly FindingPeriod[];
  onChange: (changes: Changes) => void;
  analysis: boolean;
}) {
  const accounts = useCloudAccounts(true);
  const moreId = useId();
  const { filters, view } = state;
  const moreActive = Boolean(
    filters.source ??
    filters.accountId ??
    filters.tactic ??
    filters.technique ??
    filters.unassigned ??
    state.findingType,
  );
  const [moreOpen, setMoreOpen] = useState(moreActive || state.sort !== 'recent');
  const hasFilters = FILTER_KEYS.some((key) => params.get(DETECTION_PARAMS[key]));
  const periodValue =
    state.periodChoice === 'custom' ? CUSTOM_PERIOD : (state.periodChoice ?? (analysis ? '30d' : ''));

  return (
    <div data-tour="filtros" className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        {!analysis && (
          <SearchField key={filters.q ?? ''} value={filters.q ?? ''} onSearch={(q) => onChange({ q })} />
        )}
        <SelectField
          label="Período"
          value={periodValue}
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
            ...(analysis ? [] : [{ value: '', label: 'Todo o histórico' }]),
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
        {!analysis && (
          <>
            <SelectField
              label="Severidade"
              value={filters.severity ?? ''}
              onChange={(value) => onChange({ severity: value || null })}
              options={[
                { value: '', label: 'Todas' },
                ...FINDING_SEVERITIES.map((value) => ({ value, label: SEVERITY_STYLES[value].label })),
              ]}
            />
            <SelectField
              label="Status"
              value={filters.status ?? ''}
              onChange={(value) => onChange({ status: value || null })}
              options={[
                { value: '', label: 'Todos' },
                ...FINDING_STATUSES.flatMap((value) => {
                  const label =
                    view === 'incidents'
                      ? STATUS_LABELS_INCIDENTS[value]
                      : FINDING_STATUS_LABELS[value].label;
                  return label ? [{ value, label }] : [];
                }),
              ]}
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
            onClick={() => onChange(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}
          >
            Limpar filtros
          </Button>
        )}
      </div>
      {!analysis && (
        <div id={moreId} hidden={!moreOpen} className="flex flex-wrap items-end gap-2">
          <SelectField
            label="Fonte"
            value={filters.source ?? ''}
            onChange={(value) => onChange({ source: value || null })}
            options={[
              { value: '', label: 'Todas' },
              ...FINDING_SOURCES.map((value) => ({ value, label: FINDING_SOURCE_LABELS[value] })),
            ]}
          />
          <SelectField
            label="Conta"
            value={filters.accountId ?? ''}
            onChange={(value) => onChange({ accountId: value || null })}
            options={[
              { value: '', label: 'Todas' },
              ...(accounts.data ?? []).map((account) => ({
                value: account.accountId,
                label: account.accountId,
              })),
              // A conta da URL aparece mesmo antes de a lista chegar (ou se ela não estiver mais cadastrada).
              ...(filters.accountId && !(accounts.data ?? []).some((a) => a.accountId === filters.accountId)
                ? [{ value: filters.accountId, label: filters.accountId }]
                : []),
            ]}
          />
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
          {view === 'alerts' && (
            <>
              {/* E-06: a lista de alertas também ordena pela gravidade, como a de incidentes. */}
              <SelectField
                label="Ordem"
                value={state.sort === 'severity' ? 'severidade' : ''}
                onChange={(value) => onChange({ sort: value || null })}
                options={[
                  { value: '', label: 'Mais recentes primeiro' },
                  { value: 'severidade', label: 'Mais graves primeiro' },
                ]}
              />
              {types && (
                <SelectField
                  label="Tipo"
                  value={state.findingType ? findingTypeSlug(state.findingType) : ''}
                  onChange={(value) => onChange({ type: value || null })}
                  hint="Pelo caso do alerta: o que ainda não entrou em caso não aparece com o tipo escolhido."
                  options={[
                    { value: '', label: 'Todos' },
                    ...FINDING_TYPES.map((type) => ({
                      value: findingTypeSlug(type),
                      label: FINDING_TYPE_LABELS[type],
                    })),
                  ]}
                />
              )}
            </>
          )}
          {view === 'incidents' && (
            <>
              <SelectField
                label="Responsável"
                value={filters.unassigned ? NO_ASSIGNEE : ''}
                onChange={(value) => onChange({ unassigned: value || null })}
                options={[
                  { value: '', label: 'Todos' },
                  { value: NO_ASSIGNEE, label: 'Incidentes sem responsável' },
                ]}
              />
              <SelectField
                label="Ordem"
                value={state.sort === 'severity' ? 'severidade' : ''}
                onChange={(value) => onChange({ sort: value || null })}
                options={[
                  { value: '', label: 'Mais recentes primeiro' },
                  { value: 'severidade', label: 'Mais graves primeiro' },
                ]}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** A busca de texto: vale ao confirmar (Enter ou o botão), para não pedir à API a cada letra. */
export function SearchField({
  value,
  onSearch,
  placeholder = 'Título, usuário, IP, recurso ou conta',
}: {
  value: string;
  onSearch: (q: string | null) => void;
  placeholder?: string | undefined;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(text.trim() || null);
  };
  return (
    <form role="search" onSubmit={submit} className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Buscar
      </label>
      <div className="flex gap-1">
        <Input
          id={id}
          type="search"
          className="h-9"
          value={text}
          maxLength={200}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="secondary" size="icon" aria-label="Buscar">
          <Search aria-hidden />
        </Button>
      </div>
    </form>
  );
}

/** A técnica do MITRE (T1078 ou T1078.004), confirmada como a busca. */
export function TechniqueField({
  value,
  onSubmit,
}: {
  value: string;
  onSubmit: (technique: string | null) => void;
}) {
  const id = useId();
  const hintId = useId();
  const [text, setText] = useState(value);
  const normalized = text.trim().toUpperCase();
  const invalid = normalized !== '' && !/^T\d{4}$|^T\d{4}\.\d{3}$/.test(normalized);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!invalid) onSubmit(normalized || null);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-muted-foreground">
        Técnica do MITRE
      </label>
      <div className="flex gap-1">
        <Input
          id={id}
          className="h-9 w-32"
          value={text}
          maxLength={9}
          placeholder="T1078"
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? hintId : undefined}
          onChange={(event) => setText(event.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm" className="h-9">
          Aplicar
        </Button>
      </div>
      {invalid && (
        <p id={hintId} className="text-xs text-critical-text">
          Use o formato T1078 ou T1078.004.
        </p>
      )}
    </form>
  );
}

/** As datas do intervalo personalizado (de e até, inclusive). */
export function CustomRange({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (changes: Changes) => void;
}) {
  const fromId = useId();
  const toId = useId();
  const errorId = useId();
  const inverted = from !== '' && to !== '' && from > to;
  const today = new Date();
  const max = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return (
    <fieldset className="flex flex-wrap items-end gap-2">
      <legend className="sr-only">Intervalo personalizado</legend>
      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-xs text-muted-foreground">
          De
        </label>
        <Input
          id={fromId}
          type="date"
          className="h-9 w-40"
          value={from}
          max={max}
          aria-invalid={inverted || undefined}
          aria-describedby={inverted ? errorId : undefined}
          onChange={(event) => onChange({ from: event.target.value || null })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className="text-xs text-muted-foreground">
          Até
        </label>
        <Input
          id={toId}
          type="date"
          className="h-9 w-40"
          value={to}
          max={max}
          onChange={(event) => onChange({ to: event.target.value || null })}
        />
      </div>
      {inverted && (
        <p id={errorId} role="alert" className="basis-full text-xs text-critical-text">
          A data inicial vem depois da final.
        </p>
      )}
      {(from === '' || to === '') && (
        <p className="basis-full text-xs text-muted-foreground">Escolha as duas datas para filtrar.</p>
      )}
    </fieldset>
  );
}

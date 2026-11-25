import {
  type CaseDetail,
  type CaseFinding,
  type Finding,
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  MAX_SPLIT_FINDINGS,
} from '@verax/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SeverityBadge } from '@/components/security/severity-badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select-field';
import { SEVERITY_STYLES } from '@/design/severity';
import { selectionSearch } from '@/features/detections/url-state';
import { FindingStatusBadge } from '@/features/findings/finding-status-badge';
import { FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { isActionable, scopeOfFindings, selectionNote } from './bulk';
import { type CaseFindingFilters, isInvalidCursor, useCaseFindings } from './cases-api';
import { useCasesContext } from './cases-context';
import { alertCount } from './labels';
import { SelectBox } from './select-cells';
import type { SplitTarget } from './split-dialog';
import { useListSelection } from './use-list-selection';

/**
 * Os alertas do caso, do mais recente para trás, por cursor ("Carregar mais"). Cada um abre no mesmo painel, e "Voltar ao
 * caso" traz de volta, com o foco nele. Os marcados podem ser tratados ou separados em outro caso.
 */
export function CaseAlerts({
  detail,
  mayTreat,
  onSplit,
}: {
  detail: CaseDetail;
  mayTreat: boolean;
  onSplit: (target: SplitTarget) => void;
}) {
  const { memoryOf, remember, openBulk } = useCasesContext();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<CaseFindingFilters>(() => memoryOf(detail.id).filters);
  const [restarted, setRestarted] = useState(false);
  const alerts = useCaseFindings(detail.id, filters);
  const items = alerts.data?.pages.flatMap((page) => page.items) ?? [];
  const findings = items.map((item) => item.finding);
  const selected = useListSelection<Finding>({
    limit: MAX_SPLIT_FINDINGS,
    resetKey: JSON.stringify([detail.id, filters]),
    blocked: () => null,
  });
  const chosen = selected.items(findings);
  const actionable = chosen.filter(isActionable);

  // O cursor guardado não é mais desta lista (o nó mudou de versão no meio): recomeça, uma vez, e avisa.
  const invalid = isInvalidCursor(alerts.error);
  const key = JSON.stringify(['case-findings', detail.id, filters]);
  const restartedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!invalid || restartedFor.current === key) return;
    restartedFor.current = key;
    setRestarted(true);
    void queryClient.resetQueries({ queryKey: ['case-findings', detail.id, filters] });
  }, [invalid, key, queryClient, detail.id, filters]);

  // De volta de um alerta: o foco vai para ele, depois de o painel pôr o seu no título.
  const list = useRef<HTMLUListElement>(null);
  const ready = items.length > 0;
  useEffect(() => {
    if (!ready) return;
    const { opened } = memoryOf(detail.id);
    if (opened === null) return;
    const frame = requestAnimationFrame(() => {
      const link = [...(list.current?.querySelectorAll<HTMLElement>('a[data-alerta]') ?? [])].find(
        (candidate) => candidate.dataset['alerta'] === opened,
      );
      link?.focus();
      remember(detail.id, { opened: null });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready, detail.id, memoryOf, remember]);

  const change = (next: CaseFindingFilters) => {
    setFilters(next);
    remember(detail.id, { filters: next });
  };
  const groups = detail.analysis?.groups.values ?? [];

  return (
    <section aria-label="Alertas do caso" className="space-y-2">
      <h3 className="text-sm font-semibold">
        Alertas do caso ({detail.counts.total.toLocaleString('pt-BR')})
      </h3>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField
          label="Status do alerta"
          value={filters.status ?? ''}
          onChange={(value) =>
            change({ ...filters, status: FINDING_STATUSES.find((status) => status === value) })
          }
          options={[
            { value: '', label: 'Todos' },
            ...FINDING_STATUSES.map((value) => ({ value, label: FINDING_STATUS_LABELS[value].label })),
          ]}
        />
        <SelectField
          label="Severidade do alerta"
          value={filters.severity ?? ''}
          onChange={(value) =>
            change({ ...filters, severity: FINDING_SEVERITIES.find((severity) => severity === value) })
          }
          options={[
            { value: '', label: 'Todas' },
            ...FINDING_SEVERITIES.map((value) => ({ value, label: SEVERITY_STYLES[value].label })),
          ]}
        />
        {groups.length > 1 && (
          <SelectField
            label="Grupo do alerta"
            className="min-w-0 [&_select]:max-w-64"
            value={filters.group ?? ''}
            onChange={(value) => change({ ...filters, group: value || undefined })}
            options={[
              { value: '', label: 'Todos' },
              ...groups.map((group) => ({ value: group.value, label: group.value })),
            ]}
          />
        )}
      </div>
      {restarted && (
        <p role="status" className="text-xs text-muted-foreground">
          A lista mudou no servidor e recomeçou do mais recente.
        </p>
      )}
      {alerts.isError && !invalid && items.length === 0 ? (
        <ErrorState error={alerts.error} onRetry={() => void alerts.refetch()} />
      ) : !alerts.data ? (
        <LoadingState rows={3} label="Carregando os alertas do caso" />
      ) : items.length === 0 ? (
        <EmptyState title="Nenhum alerta com esses filtros" />
      ) : (
        <ul ref={list} className="divide-y rounded-md border">
          {items.map((item) => (
            <AlertRow
              key={item.finding.id}
              item={item}
              to={selectionSearch(params, { kind: 'finding', id: item.finding.id })}
              onOpen={() => remember(detail.id, { opened: item.finding.id })}
              box={
                mayTreat && (
                  <SelectBox
                    select={selected.select}
                    rows={findings}
                    row={item.finding}
                    label={`${item.finding.title}, ${formatTimestamp(item.finding.occurredAt)}`}
                  />
                )
              }
            />
          ))}
        </ul>
      )}
      {alerts.hasNextPage && !invalid && (
        <Button
          variant="secondary"
          size="sm"
          className="max-md:h-11"
          disabled={alerts.isFetchingNextPage}
          onClick={() => void alerts.fetchNextPage()}
        >
          {alerts.isFetchingNextPage ? 'Carregando…' : 'Carregar mais alertas'}
        </Button>
      )}
      {alerts.isFetchNextPageError && !invalid && (
        <p role="alert" className="text-sm text-critical-text">
          Não foi possível carregar mais. Tente de novo.
        </p>
      )}
      {mayTreat && chosen.length > 0 && (
        <div
          role="region"
          aria-label="Ações nos alertas marcados"
          className="sticky bottom-0 flex flex-wrap items-center gap-2 rounded-md border bg-surface-raised p-2 shadow-sm"
        >
          <p role="status" className="min-w-0 flex-1 basis-32 text-sm">
            <strong>{alertCount(chosen.length)}</strong> {chosen.length === 1 ? 'marcado' : 'marcados'}
          </p>
          <Button
            size="sm"
            className="max-md:h-11"
            disabled={actionable.length === 0}
            onClick={() =>
              openBulk({ kind: 'scope', scope: scopeOfFindings(actionable), onAccepted: selected.clear })
            }
          >
            Tratar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="max-md:h-11"
            onClick={() =>
              onSplit({
                kind: 'findings',
                findingIds: chosen.map((finding) => finding.id),
                count: chosen.length,
                onDone: selected.clear,
              })
            }
          >
            Separar em outro caso
          </Button>
          <Button variant="ghost" size="sm" className="max-md:h-11" onClick={selected.clear}>
            Limpar<span className="sr-only"> os marcados</span>
          </Button>
          {selectionNote(selected.refused, MAX_SPLIT_FINDINGS, 'alertas') && (
            <p className="basis-full text-xs text-muted-foreground">
              {selectionNote(selected.refused, MAX_SPLIT_FINDINGS, 'alertas')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function AlertRow({
  item,
  to,
  onOpen,
  box,
}: {
  item: CaseFinding;
  to: string;
  onOpen: () => void;
  box: ReactNode;
}) {
  const { finding } = item;
  return (
    <li className="flex items-start gap-1 py-1 pr-3">
      {box || <span aria-hidden className="w-2 shrink-0" />}
      <span className="min-w-0 flex-1 space-y-1 py-1">
        <Link
          to={{ search: to }}
          data-alerta={finding.id}
          className="block text-sm font-medium wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          onClick={onOpen}
        >
          {finding.title}
        </Link>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <SeverityBadge severity={finding.severity} />
          {finding.incidentId === null ? (
            <FindingStatusBadge status={finding.status} />
          ) : (
            <span className="rounded-full border px-2 py-0.5 font-medium">Em incidente</span>
          )}
          {item.stillActive && (
            <span className="rounded-full border border-medium/70 bg-medium/15 px-2 py-0.5 font-medium text-foreground">
              Ainda ativo na origem
            </span>
          )}
          <time dateTime={finding.occurredAt} title={formatTimestamp(finding.occurredAt)}>
            {formatRelative(finding.occurredAt)}
          </time>
        </span>
        <span className="line-clamp-2 text-xs wrap-anywhere text-muted-foreground">
          {[finding.actor.user, finding.actor.ip, item.group ?? finding.resource].filter(Boolean).join(' · ')}
        </span>
      </span>
    </li>
  );
}

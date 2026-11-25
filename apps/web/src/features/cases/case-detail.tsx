import { type CaseAnalysis, type CaseDetail, type CaseTimeline, isMassTriageRole } from '@verax/shared';
import { type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { MiniBars } from '@/components/charts/mini-bars';
import { SeverityBadge } from '@/components/security/severity-badge';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { selectionSearch, withChanges } from '@/features/detections/url-state';
import { findingOriginId } from '@/features/findings/labels';
import { IncidentStatusBadge } from '@/features/incidents/incident-status-badge';
import { TACTIC_LABELS } from '@/features/reports/labels';
import { formatCount, formatRelative, formatTimestamp, plural } from '@/lib/format';
import {
  BULK_ACTION_LABELS,
  BULK_ACTIONS,
  INCIDENT_ACTIONS,
  scopeOfCaseGroup,
  scopeOfCases,
  sumPending,
} from './bulk';
import { CaseAlerts } from './case-alerts';
import { CaseBadges, SeverityCounts } from './case-badges';
import { useCaseTimeline } from './cases-api';
import { useCasesContext } from './cases-context';
import { alertCount, groupingText, keyPartRows, QUEUE_LABELS, sealLabel } from './labels';
import { OPERATION_STATE_LABELS, operationTitle } from './operation-text';
import { SplitDialog, type SplitTarget } from './split-dialog';

const ALERT_UNIT = { one: 'alerta', many: 'alertas' } as const;

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </section>
  );
}

/**
 * O detalhe de um caso, no painel ao lado da lista: o resumo, o que os alertas têm em comum, o que foge do padrão, a linha do
 * tempo, os grupos, os alertas (cada um abre no mesmo painel e volta para cá), os casos anteriores, os incidentes e as
 * operações. Tudo o que veio do evento é texto, quebrado na largura do painel.
 */
export function CaseDetailView({ detail }: { detail: CaseDetail }) {
  const { canTriage, canPromote, openBulk } = useCasesContext();
  const [split, setSplit] = useState<SplitTarget | null>(null);
  const pending = sumPending(detail.pending);
  const mayTreat = canTriage && detail.can.triage;
  const actions = BULK_ACTIONS.filter(
    (action) => !INCIDENT_ACTIONS.includes(action) || (canPromote && detail.can.promote),
  );
  const treatedBefore = detail.previous.filter((before) => before.sealReason === 'treated').length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {detail.severity ? (
          <SeverityBadge severity={detail.severity} />
        ) : (
          <span className="rounded-full border px-2 py-0.5 text-xs font-medium">Nada pendente</span>
        )}
        <CaseBadges row={detail} treatedBefore={treatedBefore} />
      </div>

      <Summary detail={detail} />

      {mayTreat && pending > 0 && (
        <Section title="Tratar o caso">
          <div className="flex flex-wrap gap-2">
            {actions.map((action) => (
              <Button
                key={action}
                variant="secondary"
                size="sm"
                className="max-md:h-11"
                onClick={() => openBulk({ kind: 'scope', scope: scopeOfCases([detail]), action })}
              >
                {BULK_ACTION_LABELS[action].label}
              </Button>
            ))}
          </div>
        </Section>
      )}

      <Section title="O que os alertas têm em comum">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          {detail.preview.accounts.length === 1 && (
            <Row label="Conta" value={findingOriginId(detail.preview.accounts[0] ?? '')} />
          )}
          {keyPartRows(detail.keyParts).map((part) => (
            <Row key={part.label} label={part.label} value={part.value} />
          ))}
        </dl>
        {groupingText(detail).map((sentence) => (
          <p key={sentence} className="text-xs text-muted-foreground">
            {sentence}
          </p>
        ))}
      </Section>

      <Rare analysis={detail.analysis} total={detail.counts.total} />
      <Timeline caseId={detail.id} />
      <Groups detail={detail} mayTreat={mayTreat} onSplit={setSplit} />
      <CaseAlerts detail={detail} mayTreat={mayTreat} onSplit={setSplit} />
      <Previous detail={detail} />
      <Incidents detail={detail} />
      <Operations detail={detail} />
      {split !== null && <SplitDialog detail={detail} target={split} onClose={() => setSplit(null)} />}
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium wrap-anywhere">{value}</dd>
    </>
  );
}

const SAMPLES_SHOWN = 3;

/** Valores de uma amostra: os primeiros à vista e o resto sob demanda. */
function Samples({ label, values }: { label: string; values: readonly string[] }) {
  if (values.length === 0) return null;
  const [head, rest] = [values.slice(0, SAMPLES_SHOWN), values.slice(SAMPLES_SHOWN)];
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xs">
        <ul>
          {head.map((value) => (
            <li key={value} className="wrap-anywhere">
              {value}
            </li>
          ))}
        </ul>
        {rest.length > 0 && (
          <details>
            <summary className="inline-flex min-h-6 cursor-pointer items-center font-sans underline max-md:min-h-11">
              Mais {rest.length}
              <span className="sr-only"> em {label.toLowerCase()}</span>
            </summary>
            <ul>
              {rest.map((value) => (
                <li key={value} className="wrap-anywhere">
                  {value}
                </li>
              ))}
            </ul>
          </details>
        )}
      </dd>
    </div>
  );
}

function Summary({ detail }: { detail: CaseDetail }) {
  const { counts, samples } = detail;
  const treated = [
    [counts.new, 'Novos'],
    [counts.investigating, 'Em análise'],
    [counts.legitimate, 'Legítimos'],
    [counts.resolved, 'Resolvidos'],
    [counts.incident, 'Em incidente'],
  ] as const;
  return (
    <Section title="Resumo">
      <p className="text-sm">
        <strong>{alertCount(sumPending(detail.pending))}</strong> para tratar, de{' '}
        {plural(counts.total, 'guardado', 'guardados')}. <SeverityCounts counts={detail.pending} />
      </p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {treated
          .filter(([count]) => count > 0)
          .map(([count, label]) => (
            <div key={label} className="flex gap-1.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium tabular-nums">{formatCount(count)}</dd>
            </div>
          ))}
      </dl>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
        <Row label="Fila" value={QUEUE_LABELS[detail.queue]} />
        <Row
          label="Primeiro alerta"
          value={`${formatTimestamp(detail.firstSeenAt)} (${formatRelative(detail.firstSeenAt)})`}
        />
        <Row
          label="Último alerta"
          value={`${formatTimestamp(detail.lastSeenAt)} (${formatRelative(detail.lastSeenAt)})`}
        />
        {detail.sealedAt !== null && (
          <Row
            label="Fechado para novos"
            value={`${formatTimestamp(detail.sealedAt)} (${sealLabel(detail.sealReason)})`}
          />
        )}
      </dl>
      {(detail.analysis?.stillActive ?? 0) > 0 && (
        <p className="rounded-md border border-medium/70 bg-medium/15 p-2 text-sm">
          {plural(
            detail.analysis?.stillActive ?? 0,
            'alerta marcado como resolvido continua ativo na origem',
            'alertas marcados como resolvidos continuam ativos na origem',
          )}
          .
        </p>
      )}
      <dl className="grid gap-2 sm:grid-cols-2">
        <Samples label="Usuários" values={samples.actors} />
        <Samples label="IPs de origem" values={samples.ips} />
        <Samples label="Recursos" values={samples.resources} />
        <Samples label="Contas e agentes" values={samples.accounts.map(findingOriginId)} />
        <Samples label="Regras" values={samples.ruleIds} />
      </dl>
      {detail.mitreTactics.length + samples.mitreTechniques.length > 0 && (
        <ul aria-label="MITRE ATT&CK" className="flex flex-wrap gap-1.5">
          {[
            ...detail.mitreTactics.map((tactic) => TACTIC_LABELS[tactic] ?? tactic),
            ...samples.mitreTechniques,
          ].map((item) => (
            <li key={item} className="rounded border px-2 py-0.5 text-xs wrap-anywhere">
              {item}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Rare({ analysis, total }: { analysis: CaseAnalysis | null; total: number }) {
  if (analysis === null) {
    return (
      <Section title="O que foge do padrão">
        <p className="text-sm text-muted-foreground">
          Este caso é grande demais para esta conta agora. O resto do detalhe vale; tente abrir de novo em
          instantes.
        </p>
      </Section>
    );
  }
  const lists = [
    ['IPs de origem', analysis.rare.ips],
    ['Usuários', analysis.rare.users],
  ] as const;
  // Um valor só não tem do que fugir.
  const shown = lists.filter(([, list]) => list.distinct > 1);
  if (shown.length === 0) return null;
  return (
    <Section
      title="O que foge do padrão"
      hint={
        analysis.complete
          ? 'Os valores menos frequentes do caso, o menos frequente primeiro.'
          : `Os valores menos frequentes entre os ${formatCount(analysis.alerts)} alertas mais recentes, de ${formatCount(total)}.`
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map(([label, list]) => (
          <div key={label} className="min-w-0">
            <h4 className="text-xs text-muted-foreground">
              {label} ({formatCount(list.distinct)} diferentes)
            </h4>
            <ul className="space-y-1 text-xs">
              {list.values.map((entry) => (
                <li key={entry.value}>
                  <span className="font-mono wrap-anywhere">{entry.value}</span>
                  <span className="block text-muted-foreground">
                    {plural(entry.count, 'vez', 'vezes')}, última {formatRelative(entry.lastSeenAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  );
}

const hourLabel = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
/** O dia é o do calendário de Brasília, como a API conta. */
const dayLabel = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'America/Sao_Paulo',
});

function bucketLabel(timeline: CaseTimeline, at: string): string {
  return (timeline.granularity === 'day' ? dayLabel : hourLabel).format(new Date(at));
}

function Timeline({ caseId }: { caseId: string }) {
  const timeline = useCaseTimeline(caseId);
  if (timeline.isError) {
    return (
      <Section title="Linha do tempo">
        <ErrorState error={timeline.error} onRetry={() => void timeline.refetch()} />
      </Section>
    );
  }
  if (!timeline.data) {
    return (
      <Section title="Linha do tempo">
        <LoadingState rows={1} label="Carregando a linha do tempo" />
      </Section>
    );
  }
  const { data } = timeline;
  if (data.buckets.length === 0) return null;
  const daily = data.granularity === 'day';
  return (
    <Section
      title="Linha do tempo"
      hint={`Alertas por ${daily ? 'dia' : 'hora'}, pelo horário do evento.${data.truncated ? ' Há alertas fora desta janela: mais antigos, ou com data no futuro.' : ''}`}
    >
      <MiniBars
        title={`Alertas do caso por ${daily ? 'dia' : 'hora'}`}
        values={data.buckets.map(sumPending)}
        labels={data.buckets.map((bucket) => bucketLabel(data, bucket.at))}
        unit={ALERT_UNIT}
        granularity={data.granularity}
      />
    </Section>
  );
}

function Groups({
  detail,
  mayTreat,
  onSplit,
}: {
  detail: CaseDetail;
  mayTreat: boolean;
  onSplit: (target: SplitTarget) => void;
}) {
  const { openBulk } = useCasesContext();
  const groups = detail.analysis?.groups;
  if (!groups || groups.distinct < 2) return null;
  return (
    <Section
      title={detail.queue === 'posture' ? 'Recursos' : 'Grupos'}
      hint={
        groups.distinct > groups.values.length
          ? `Os ${groups.values.length} mais graves, de ${formatCount(groups.distinct)}.`
          : undefined
      }
    >
      <ul className="divide-y rounded-md border">
        {groups.values.map((group) => {
          const pending = sumPending(group.pending);
          return (
            <li key={group.value} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 basis-40">
                <span className="line-clamp-3 font-mono text-xs wrap-anywhere">{group.value}</span>
                <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  {pending > 0
                    ? `${alertCount(pending)} de ${formatCount(group.total)}`
                    : `Nada pendente de ${formatCount(group.total)}`}
                  <SeverityCounts counts={group.pending} />
                </span>
              </span>
              {mayTreat && (
                <span className="flex flex-wrap gap-2">
                  {pending > 0 && (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="max-md:h-11"
                      onClick={() => openBulk({ kind: 'scope', scope: scopeOfCaseGroup(detail, group) })}
                    >
                      Tratar este grupo<span className="sr-only">: {group.value}</span>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="max-md:h-11"
                    onClick={() => onSplit({ kind: 'group', group: group.value, count: group.total })}
                  >
                    Separar<span className="sr-only"> em outro caso: {group.value}</span>
                  </Button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function Previous({ detail }: { detail: CaseDetail }) {
  const [params] = useSearchParams();
  if (detail.previous.length === 0) return null;
  return (
    <Section title="Casos anteriores" hint="A mesma chave, do mais recente para o mais antigo.">
      <ul className="divide-y rounded-md border text-sm">
        {detail.previous.map((before) => (
          <li key={before.id} className="px-3 py-2">
            <Link
              className="font-medium underline"
              to={{ search: selectionSearch(params, { kind: 'case', id: before.id }) }}
            >
              Aberto {formatRelative(before.openedAt)}
            </Link>
            <span className="block text-xs text-muted-foreground">
              {sealLabel(before.sealReason)} · {alertCount(before.counts.total)} ·{' '}
              {before.pending > 0 ? `${formatCount(before.pending)} ainda pendentes` : 'nada pendente'} ·
              último alerta {formatRelative(before.lastAlertAt)}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Incidents({ detail }: { detail: CaseDetail }) {
  const [params] = useSearchParams();
  if (detail.incidents.length === 0) return null;
  return (
    <Section title="Incidentes">
      <ul className="divide-y rounded-md border text-sm">
        {detail.incidents.map((incident) => (
          <li key={incident.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
            <SeverityBadge severity={incident.severity} />
            <IncidentStatusBadge status={incident.status} />
            <Link
              className="font-medium underline"
              to={{
                search: withChanges(
                  params,
                  { incident: incident.id, finding: null },
                  { keepPage: true },
                ).toString(),
              }}
            >
              {incident.promoted ? 'Incidente aberto deste caso' : 'Ver o incidente'}
            </Link>
            <span className="text-xs text-muted-foreground">{alertCount(incident.alerts)} deste caso</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Operations({ detail }: { detail: CaseDetail }) {
  const { openUndo, canTriage, canPromote, role, userId } = useCasesContext();
  // O render não lê o relógio: o prazo é conferido pela API, e o botão só some quando o caso é relido.
  const [openedAt] = useState(() => Date.now());
  if (detail.operations.length === 0) return null;
  return (
    <Section title="Operações em massa" hint="As que valem nos alertas deste caso, e as que elas desfizeram.">
      <ul className="divide-y rounded-md border text-sm">
        {detail.operations.map((operation) => {
          const incident = operation.action === 'promote' || operation.action === 'attach';
          const manages =
            canTriage &&
            (canPromote || !incident) &&
            ((role !== null && isMassTriageRole(role)) || operation.author?.id === userId);
          const undoable =
            manages &&
            (operation.action === 'status' || incident) &&
            (operation.state === 'done' || operation.state === 'partial' || operation.state === 'canceled') &&
            operation.changed > 0 &&
            operation.undoUntil !== null &&
            Date.parse(operation.undoUntil) > openedAt;
          return (
            <li key={operation.id} className="space-y-1 px-3 py-2">
              <p>
                <strong>{operationTitle(operation)}</strong>{' '}
                <span className="text-muted-foreground">
                  · {OPERATION_STATE_LABELS[operation.state].toLowerCase()} · {alertCount(operation.changed)}{' '}
                  · {operation.author?.name ?? 'pessoa excluída'} · {formatRelative(operation.createdAt)}
                </span>
              </p>
              {operation.reason !== null && (
                <p className="wrap-anywhere whitespace-pre-wrap">{operation.reason}</p>
              )}
              {undoable && (
                <p className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="max-md:h-11"
                    onClick={() => openUndo(operation)}
                  >
                    Desfazer<span className="sr-only">: {operationTitle(operation)}</span>
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    até {formatTimestamp(operation.undoUntil ?? '')}
                  </span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

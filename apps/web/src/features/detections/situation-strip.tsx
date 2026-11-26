import { useQuery } from '@tanstack/react-query';
import {
  type CaseQueueName,
  type CollectionSourceHealth,
  type PendingDecisionKind,
  type TowerPulse,
  type TowerSummary,
  towerSummarySchema,
} from '@verax/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, type To, useSearchParams } from 'react-router';
import { formatCompact, formatHour } from '@/components/charts/chart-utils';
import { MiniBars } from '@/components/charts/mini-bars';
import { StatTile } from '@/components/charts/stat-tile';
import { DetectionRadar, type RadarLinks } from '@/components/security/detection-radar';
import { SourceHealthRow } from '@/components/security/source-health';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { Sheet } from '@/components/ui/sheet';
import { scoreSeverity } from '@/design/score';
import { type Severity, SEVERITY_STYLES } from '@/design/severity';
import { getWithCases } from '@/features/cases/cases-api';
import { useCasesContext } from '@/features/cases/cases-context';
import { useMe } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { formatDuration, formatList, formatRelative, plural } from '@/lib/format';
import {
  allCollecting,
  COLLECTION_SOURCE_LABELS,
  collectionProof,
  proofSentence,
  stalledPhrase,
} from './tower-collection';
import {
  casePhrase,
  countsByCase,
  pendingCasesNote,
  situationHeadline,
  towerReason,
  uncoveredPhrase,
  validationPhrase,
  vulnerabilityPhrase,
} from './tower-reason';
import { compactParts } from './compact-situation';
import { ALERTS_VIEW, casesSearch, selectionSearch, VULNERABILITIES_VIEW, withChanges } from './url-state';

/**
 * O resumo da situação no topo da tela Detecções (o que era a Torre, enxuto): o radar das últimas 24 horas em
 * destaque, o motivo numa linha de texto, as decisões pendentes e a saúde da coleta num indicador (o detalhe numa
 * gaveta). Sem o semáforo (descontinuado em 17/11/2026): o radar e as decisões dizem a situação. Recolhível, para a
 * lista subir; a escolha fica neste navegador, por pessoa. No celular, começa recolhido: só as contagens.
 * No computador, fica numa coluna, com a lista ao lado (`stacked`).
 */
export function SituationStrip({
  scope,
  expanded,
  onExpandedChange,
  stacked = false,
}: {
  scope: string;
  /** Aberto ou recolhido (`useStripPreference`). */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Numa coluna só, ao lado da lista: o radar em cima e as decisões embaixo. */
  stacked?: boolean;
}) {
  const { mode, loading } = useCasesContext();
  const cases = mode !== 'off';
  const tower = useQuery({
    queryKey: ['tower', scope, cases],
    queryFn: () => getWithCases('/v1/tower', towerSummarySchema, cases),
    refetchInterval: 60_000,
    // Sem saber ainda se há casos, espera: a resposta é outra com eles.
    enabled: !loading,
  });
  const contentId = useId();
  const titleId = useId();
  const summary = tower.data;

  return (
    <section
      aria-labelledby={titleId}
      data-tour="deteccoes-situacao"
      className="rounded-xl border bg-surface shadow-xs"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 id={titleId} className="text-base font-semibold">
            Situação agora
          </h2>
          {summary && !expanded && <CompactSituation summary={summary} />}
          {summary && expanded && (
            <p className="text-xs text-muted-foreground">Atualizada {formatRelative(summary.generatedAt)}</p>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
          {expanded ? 'Recolher' : 'Mostrar'}
          <span className="sr-only"> o resumo da situação</span>
        </Button>
      </header>
      <div id={contentId} hidden={!expanded} className="border-t p-4">
        {tower.isError ? (
          <ErrorState error={tower.error} onRetry={() => void tower.refetch()} />
        ) : !summary ? (
          <LoadingState rows={3} label="Carregando a situação" />
        ) : (
          expanded && <ExpandedSituation summary={summary} stacked={stacked} />
        )}
      </div>
    </section>
  );
}

/** Recolhido: as contagens, numa linha, o que pede atenção primeiro. */
function CompactSituation({ summary }: { summary: TowerSummary }) {
  const parts = compactParts(summary);
  return (
    <p
      role="status"
      aria-label={`Situação: ${towerReason(summary)} ${parts
        .filter((part) => !part.inReason)
        .map((part) => part.text)
        .join(', ')}.`}
      className="min-w-0 text-sm text-muted-foreground"
    >
      <span aria-hidden className="inline">
        {parts.map((part, index) => {
          const style = part.severity ? SEVERITY_STYLES[part.severity] : null;
          const Icon = style?.icon;
          return (
            <span
              key={part.text}
              data-compact-part
              className={cn(part.optional && 'max-sm:hidden', part.severity && 'font-medium text-foreground')}
            >
              {index > 0 && <span className="text-muted-foreground"> · </span>}
              {Icon && style && <Icon className={cn('mr-1 inline size-4 align-[-3px]', style.tone)} />}
              {part.text}
            </span>
          );
        })}
      </span>
    </p>
  );
}

function ExpandedSituation({ summary, stacked }: { summary: TowerSummary; stacked: boolean }) {
  const [params] = useSearchParams();
  // Com a lista ao lado, a análise de baixo fica como está. Sem ela, o detalhe só existe na aba Lista: um ponto do radar
  // aberto numa aba de análise volta para a lista.
  const listParams = withChanges(
    params,
    { case: null, ...(!stacked && { analysis: null }) },
    { keepPage: true },
  );
  const { mode } = useCasesContext();
  const links: RadarLinks = {
    finding: (id) => ({ search: selectionSearch(listParams, { kind: 'finding', id }) }),
    incident: (id) => ({ search: selectionSearch(listParams, { kind: 'incident', id }) }),
    // O radar conta alertas: com os casos ligados, a lista padrão é outra.
    all: mode === 'off' ? '/?periodo=24h' : `/?visao=${ALERTS_VIEW}&periodo=24h`,
    case: (id) => ({ search: selectionSearch(listParams, { kind: 'case', id }) }),
    allCases: { pathname: '/', search: casesSearch(mode, { state: 'all', period: '24h' }) },
  };
  return (
    <div className="space-y-4">
      {/* R-01: a resposta em destaque, depois a coleta e a postura, as decisões e só então o radar. */}
      <Headline summary={summary} />
      <div className="flex flex-wrap gap-2">
        <CollectionIndicator summary={summary} />
        <PostureChip posture={summary.posture} />
      </div>
      {/* Contêiner: as decisões ficam em duas colunas só quando há largura para isso. */}
      <div className="@container min-w-0">
        <PendingDecisions summary={summary} />
      </div>
      {summary.radar && (
        <section
          data-tour="deteccoes-radar"
          aria-labelledby="deteccoes-radar"
          className={cn('min-w-0 space-y-2', !stacked && 'max-w-md')}
        >
          <h3 id="deteccoes-radar" className="text-sm font-semibold">
            Radar das últimas {summary.radar.windowHours} horas
          </h3>
          <DetectionRadar radar={summary.radar} generatedAt={summary.generatedAt} links={links} compact />
        </section>
      )}
    </div>
  );
}

/**
 * A manchete da situação: o mais grave, com o ícone da severidade, na letra maior da tela depois do título. O que ela não
 * repete (a coleta parada, a postura, os alertas para validar) está logo abaixo, nos botões e nas decisões; o leitor de
 * tela ouve a frase completa, como antes.
 */
function Headline({ summary }: { summary: TowerSummary }) {
  const headline = situationHeadline(summary);
  const { icon: Icon, tone } = SEVERITY_STYLES[headline.severity];
  return (
    <p
      role="status"
      aria-label={`Situação: ${towerReason(summary)}`}
      data-headline-severity={headline.severity}
      className="flex items-start gap-2.5"
    >
      <Icon aria-hidden className={cn('mt-0.5 size-5 shrink-0', tone)} />
      <span className="min-w-0">
        <span className="block text-lg leading-snug font-semibold text-foreground">{headline.title}</span>
        {headline.detail && (
          <span className="mt-0.5 block text-sm text-muted-foreground"> {headline.detail}</span>
        )}
      </span>
    </p>
  );
}

interface DecisionLink {
  action: string;
  to: To;
}

/** Um cartão de decisão. Com os casos, o texto e os destinos dependem do resumo. */
interface DecisionCard {
  severity: Severity;
  title: (count: number, summary: TowerSummary) => string;
  links: (summary: TowerSummary) => readonly DecisionLink[];
}

/** Há caso alto ou crítico pendente nesta fila. */
const serious = (summary: TowerSummary, queue: CaseQueueName): boolean =>
  (summary.cases?.[queue].critical ?? 0) + (summary.cases?.[queue].high ?? 0) > 0;

// As decisões dos casos só vêm com eles ligados: o destino é a lista de casos, os mais graves primeiro.
const DETECTION_CASES: DecisionLink = {
  action: 'Ver os casos',
  to: { pathname: '/', search: casesSearch('on') },
};
const POSTURE_CASES: DecisionLink = {
  action: 'Ver a postura',
  to: { pathname: '/', search: casesSearch('on', { queue: 'posture' }) },
};

const DECISIONS: Readonly<Record<PendingDecisionKind, DecisionCard>> = {
  unassigned_incident: {
    severity: 'high',
    title: (count) => `${plural(count, 'incidente', 'incidentes')} sem responsável`,
    links: () => [{ action: 'Ver os incidentes', to: '/?visao=incidentes&responsavel=nenhum' }],
  },
  untriaged_case: {
    severity: 'high',
    title: casePhrase,
    // A lista de casos mostra uma fila por vez, e a decisão conta as duas.
    links: (summary) => {
      if (!serious(summary, 'posture')) return [DETECTION_CASES];
      return serious(summary, 'detection') ? [DETECTION_CASES, POSTURE_CASES] : [POSTURE_CASES];
    },
  },
  untriaged_vulnerability_case: {
    severity: 'high',
    title: vulnerabilityPhrase,
    links: () => [{ action: 'Ver as vulnerabilidades', to: `/?visao=${VULNERABILITIES_VIEW}` }],
  },
  untriaged_finding: {
    severity: 'high',
    title: (count, summary) => (countsByCase(summary) ? uncoveredPhrase(count) : validationPhrase(count)),
    links: () => [{ action: 'Ver os alertas', to: '/?status=new' }],
  },
  unowned_alert: {
    severity: 'medium',
    title: (count) => `${plural(count, 'alerta', 'alertas')} de conta não cadastrada`,
    // A mesma janela que a API conta para esta decisão (os últimos 7 dias): o total da fila bate com o cartão.
    links: () => [{ action: 'Ver a fila', to: '/alertas-sem-dono?periodo=7d' }],
  },
};

/** As decisões pendentes, uma por linha, com o atalho para a lista já filtrada. */
function PendingDecisions({ summary }: { summary: TowerSummary }) {
  const proof = collectionProof(summary);
  return (
    <section data-tour="deteccoes-decisoes" aria-labelledby="deteccoes-decisoes" className="space-y-2">
      <h3 id="deteccoes-decisoes" className="text-sm font-semibold">
        Decisões pendentes
      </h3>
      {summary.pendingDecisions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {summary.light === 'green' && allCollecting(proof)
            ? 'Tudo calmo: nada para decidir agora.'
            : 'Nenhuma decisão pendente: tudo o que pedia uma decisão já foi tratado.'}
          {proof && proof.stalled.length > 0 && ` Mas há ${stalledPhrase(proof)}: veja a saúde da coleta.`}
        </p>
      ) : (
        <ul className="grid gap-2 @xl:grid-cols-2">
          {summary.pendingDecisions.map((decision) => {
            const content = DECISIONS[decision.kind];
            const links = content.links(summary);
            const { icon: Icon, tone, surface } = SEVERITY_STYLES[content.severity];
            return (
              <li
                key={decision.kind}
                className={cn(
                  'flex items-center justify-between gap-3 rounded-md border px-3 py-2',
                  // Os textos e os botões dos casos são mais longos: na tela estreita, o botão vai para baixo.
                  summary.cases && 'flex-wrap gap-y-2',
                  surface,
                )}
              >
                <span
                  className={cn(
                    'flex min-w-0 items-center gap-2 text-sm font-medium',
                    summary.cases && 'flex-1 basis-32',
                  )}
                >
                  <Icon aria-hidden className={cn('size-4 shrink-0', tone)} />
                  <span className="sr-only">{SEVERITY_STYLES[content.severity].label}: </span>
                  {content.title(decision.count, summary)}
                </span>
                {links.length === 1 ? (
                  <DecisionButton link={links[0]} />
                ) : (
                  <span className="flex shrink-0 flex-col items-stretch gap-1.5">
                    {links.map((link) => (
                      <DecisionButton key={link.action} link={link} />
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {summary.cases && (
        <p className="text-xs text-muted-foreground">
          {pendingCasesNote(summary.cases, new Date(summary.generatedAt))}
        </p>
      )}
    </section>
  );
}

function DecisionButton({ link }: { link: DecisionLink | undefined }) {
  if (!link) return null;
  return (
    <Link to={link.to} className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'shrink-0')}>
      {link.action}
    </Link>
  );
}

/** A nota de postura num selo pequeno, com o link para a Postura cloud. */
function PostureChip({ posture }: { posture: TowerSummary['posture'] }) {
  const { data: me } = useMe();
  if (posture.score === null || !me?.permissions.includes('posture:read')) return null;
  const severity = scoreSeverity(posture.score, { warning: posture.warningBelow, critical: 40 });
  const { icon: Icon, tone } = SEVERITY_STYLES[severity];
  return (
    <Link to="/postura" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
      <Icon aria-hidden className={tone} />
      Postura {posture.score} de 100
      {posture.score < posture.warningBelow && (
        <span className="sr-only">, abaixo de {posture.warningBelow}</span>
      )}
    </Link>
  );
}

/** O que a saúde da coleta pede de atenção: fonte parada, conta silenciosa, AWS parada ou o medidor bloqueado. */
function collectionWarnings(summary: TowerSummary): number {
  const proof = collectionProof(summary);
  return (
    (proof?.stalled.length ?? 0) +
    summary.coverage.silentAccounts.length +
    (summary.coverage.awsLogsStalledSince ? 1 : 0) +
    (summary.coverage.awsMeterBlocked ? 1 : 0)
  );
}

/** A saúde da coleta num botão: o estado em uma linha; o detalhe (cada fonte e o pulso) abre numa gaveta. */
function CollectionIndicator({ summary }: { summary: TowerSummary }) {
  const [open, setOpen] = useState(false);
  const proof = collectionProof(summary);
  const warnings = collectionWarnings(summary);
  const severity: Severity = proof && proof.stalled.length > 0 ? 'high' : warnings > 0 ? 'medium' : 'ok';
  const { icon: Icon, tone } = SEVERITY_STYLES[severity];
  const text =
    proof === null
      ? `Coleta: ${plural(summary.coverage.connectedAccounts, 'conta conectada', 'contas conectadas')}`
      : proof.configured === 0
        ? 'Nenhuma fonte conectada'
        : proof.stalled.length > 0
          ? `Coleta parada: ${formatList(proof.stalled)}`
          : `Coleta ativa em ${proof.active} de ${proof.configured} ${proof.configured === 1 ? 'fonte' : 'fontes'}`;
  return (
    <>
      <Button
        variant="secondary"
        size="sm"
        data-tour="deteccoes-coleta"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon aria-hidden className={tone} />
        {text}
        {warnings > 0 && severity === 'medium' && ` (${plural(warnings, 'aviso', 'avisos')})`}
      </Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="Saúde da coleta"
        description={proof ? proofSentence(proof) : undefined}
      >
        <CollectionHealth summary={summary} />
        {summary.pulse && <Pulse pulse={summary.pulse} />}
      </Sheet>
    </>
  );
}

/**
 * O último evento de uma fonte de contas cloud, à parte do último dado: na AWS, o último alerta; na GCP e no
 * Cloudflare, a última entrada. Nas outras fontes e nas não configuradas, nada.
 */
function lastEventNote(source: CollectionSourceHealth): string | undefined {
  if (source.lastEventAt === undefined || source.state === 'not_configured') return undefined;
  const what = source.source === 'aws' ? 'último alerta' : 'último evento';
  return `${what} ${source.lastEventAt ? formatRelative(source.lastEventAt) : 'nenhum ainda'}`;
}

function Warning({ children }: { children: ReactNode }) {
  const { icon: WarningIcon, tone, surface } = SEVERITY_STYLES.medium;
  return (
    <p className={`flex items-start gap-2 rounded-md border p-2 text-sm ${surface}`}>
      <WarningIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </p>
  );
}

/**
 * "Saúde da coleta" (OP-02): uma linha por fonte, com o estado e o último dado que prova a coleta, as não configuradas
 * por último. Num nó de antes do OP-02 (sem as fontes), as datas de antes. Os avisos vêm da API (contas silenciosas,
 * AWS parada no Wazuh do nó e, só para a equipe da Verax, o medidor bloqueado).
 */
function CollectionHealth({ summary }: { summary: TowerSummary }) {
  const { coverage } = summary;
  const sources = coverage.sources
    ? [
        ...coverage.sources.filter((source) => source.state !== 'not_configured'),
        ...coverage.sources.filter((source) => source.state === 'not_configured'),
      ]
    : null;
  return (
    <section aria-labelledby="coleta-fontes" className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="coleta-fontes" className="text-sm font-semibold">
          Fontes
        </h3>
        <Link to="/cadastros/contas" className="text-sm underline">
          Ver contas
        </Link>
      </div>
      {sources ? (
        <ul className="divide-y">
          {sources.map((source) => {
            const label = COLLECTION_SOURCE_LABELS[source.source];
            return (
              <li key={source.source}>
                <SourceHealthRow
                  name={label.name}
                  description={label.description}
                  state={source.state}
                  lastDataAt={source.lastDataAt}
                  note={lastEventNote(source)}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Última coleta</dt>
            <dd className="font-medium">
              {coverage.lastCollectedAt ? formatRelative(coverage.lastCollectedAt) : 'nenhuma ainda'}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Último evento recebido</dt>
            <dd className="font-medium">
              {coverage.lastEventAt ? formatRelative(coverage.lastEventAt) : 'nenhum ainda'}
            </dd>
          </div>
        </dl>
      )}
      <p className="text-xs text-muted-foreground">
        {plural(coverage.connectedAccounts, 'conta conectada', 'contas conectadas')}
      </p>
      {coverage.silentAccounts.length > 0 && (
        <Warning>
          {plural(coverage.silentAccounts.length, 'conta', 'contas')} sem eventos há mais de{' '}
          {coverage.silentAfterHours} horas: {formatList(coverage.silentAccounts)}.
        </Warning>
      )}
      {coverage.awsLogsStalledSince && (
        <Warning>
          <strong>Sem logs novos da AWS:</strong> a coleta das contas AWS conectadas está parada{' '}
          {formatRelative(coverage.awsLogsStalledSince)}. Confira a conexão e a coleta em{' '}
          <Link className="underline underline-offset-2" to="/cadastros/contas">
            Contas cloud
          </Link>
          .
        </Warning>
      )}
      {coverage.awsMeterBlocked && (
        <Warning>
          Medidor da AWS parado neste nó: há mais de um cliente no Wazuh dele, e o nó atende um cliente só. O
          volume não é medido para ninguém até sobrar um.
        </Warning>
      )}
    </section>
  );
}

const HOUR_MS = 3_600_000;

/**
 * "Pulso da operação" (OP-02), na gaveta da coleta: o que a operação fez nas últimas 24 horas. Uma fonte que o cliente
 * não tem (nenhum agente, nenhum volume no mês) some, em vez de aparecer como zero.
 */
function Pulse({ pulse }: { pulse: TowerPulse }) {
  const since = Date.parse(pulse.since);
  const hours = pulse.findings.hourly.map((_, index) => formatHour(new Date(since + index * HOUR_MS)));
  const { total, expected } = pulse.findings;
  const events = pulse.monthEvents.sources;
  const totalEvents = events.reduce((sum, source) => sum + source.events, 0);
  return (
    <section aria-labelledby="coleta-pulso" className="space-y-3">
      <h3 id="coleta-pulso" className="text-sm font-semibold">
        Pulso da operação, últimas 24 horas
      </h3>
      <div className="grid grid-cols-1 gap-3">
        <StatTile
          label="Alertas nas últimas 24 h"
          value={formatCompact(total)}
          detail={
            expected === 0
              ? 'Nenhum esperado por exceção'
              : `${plural(expected, 'esperado', 'esperados')} por exceção`
          }
        >
          <MiniBars
            title="Alertas por hora nas últimas 24 horas"
            values={pulse.findings.hourly}
            labels={hours}
            unit={{ one: 'alerta', many: 'alertas' }}
          />
        </StatTile>
        <StatTile
          label="Tempo até detectar"
          value={pulse.timeToDetectSeconds === null ? '—' : formatDuration(pulse.timeToDetectSeconds)}
          detail={
            pulse.timeToDetectSeconds === null
              ? 'Nenhum alerta nas últimas 24 horas.'
              : 'Mediana de 24 h, da hora do evento ao alerta. Inclui o atraso de entrega da fonte.'
          }
        />
        {pulse.agents && (
          <StatTile
            label="Agentes online"
            value={`${pulse.agents.online} de ${pulse.agents.total}`}
            detail={
              pulse.agents.online === pulse.agents.total
                ? 'Todos conectados ao Wazuh do nó'
                : plural(
                    pulse.agents.total - pulse.agents.online,
                    'agente sem conexão agora',
                    'agentes sem conexão agora',
                  )
            }
            link={{ to: '/cadastros/agentes', label: 'Ver agentes' }}
          />
        )}
        {events.length > 0 && (
          <StatTile
            label="Eventos lidos no mês"
            value={formatCompact(totalEvents)}
            detail={events
              .map(
                (source) => `${COLLECTION_SOURCE_LABELS[source.source].name} ${formatCompact(source.events)}`,
              )
              .join(' · ')}
          />
        )}
      </div>
    </section>
  );
}

import { useQuery } from '@tanstack/react-query';
import {
  FINDING_SEVERITIES,
  type CollectionSourceHealth,
  type PendingDecisionKind,
  type TowerPulse,
  type TowerSummary,
  towerSummarySchema,
} from '@verax/shared';
import { CircleCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { formatCompact, formatHour } from '@/components/charts/chart-utils';
import { MiniBars } from '@/components/charts/mini-bars';
import { StatTile } from '@/components/charts/stat-tile';
import { DecisionCard } from '@/components/security/decision-card';
import { ScoreMeter } from '@/components/security/score-meter';
import { Semaphore } from '@/components/security/semaphore';
import { SeverityBadge } from '@/components/security/severity-badge';
import { SourceHealthRow } from '@/components/security/source-health';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { DEFAULT_THRESHOLDS } from '@/design/score';
import { MitreGrid } from '@/features/reports/mitre-grid';
import { type Severity, SEVERITY_STYLES } from '@/design/severity';
import { useMe } from '@/features/session/session';
import { api } from '@/lib/api';
import { formatDuration, formatList, formatRelative, plural } from '@/lib/format';
import {
  allCollecting,
  COLLECTION_SOURCE_LABELS,
  collectionProof,
  proofSentence,
  stalledPhrase,
} from './tower-collection';
import { towerReason } from './tower-reason';

/** A Torre responde, em segundos, "está tudo bem?" e "o que preciso decidir agora?" (T7.6). */
export function TowerPage() {
  const me = useMe();
  const scope = me.data?.scopeTenantId ?? null;
  const tower = useQuery({
    queryKey: ['tower', scope],
    queryFn: () => api.get('/v1/tower', towerSummarySchema),
    enabled: scope !== null,
    refetchInterval: 60_000,
  });

  if (me.data && scope === null) {
    return (
      <TowerShell>
        <EmptyState
          title="Escolha um cliente"
          description="A Torre mostra a situação de um cliente por vez. Escolha um no seletor do topo da tela."
        />
      </TowerShell>
    );
  }
  if (tower.isError) {
    return (
      <TowerShell>
        <ErrorState error={tower.error} onRetry={() => void tower.refetch()} />
      </TowerShell>
    );
  }
  if (!tower.data) {
    return (
      <TowerShell>
        <LoadingState rows={6} label="Carregando a Torre" />
      </TowerShell>
    );
  }
  return <TowerContent summary={tower.data} />;
}

function TowerShell({ children, updatedAt }: { children: ReactNode; updatedAt?: string }) {
  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Torre</h1>
        {updatedAt && <p className="text-sm text-muted-foreground">Atualizada {formatRelative(updatedAt)}</p>}
      </header>
      {children}
    </section>
  );
}

function TowerContent({ summary }: { summary: TowerSummary }) {
  return (
    <TowerShell updatedAt={summary.generatedAt}>
      <Card data-tour="torre-semaforo">
        <Semaphore state={summary.light} reason={towerReason(summary)} />
      </Card>
      {summary.pulse && <Pulse pulse={summary.pulse} />}
      <div className="grid gap-6 lg:grid-cols-3">
        <PendingDecisions summary={summary} />
        <div className="space-y-6">
          <OpenIncidents counts={summary.openIncidents} />
          <Posture posture={summary.posture} />
          <CollectionHealth summary={summary} />
        </div>
      </div>
      <Mitre mitre={summary.mitre} />
    </TowerShell>
  );
}

const DECISIONS: Record<
  PendingDecisionKind,
  { severity: Severity; title: (count: number) => string; description: string; action: string; to: string }
> = {
  unassigned_incident: {
    severity: 'high',
    title: (count) => `${plural(count, 'incidente', 'incidentes')} sem responsável`,
    description: 'Defina quem investiga cada um, para nenhum ficar parado.',
    action: 'Ver incidentes',
    to: '/incidentes?responsavel=nenhum',
  },
  untriaged_finding: {
    severity: 'high',
    title: (count) => `${plural(count, 'achado alto ou crítico', 'achados altos ou críticos')} sem triagem`,
    description:
      'Ainda não entraram em nenhum incidente. Coloque em análise, marque como legítimo ou dê como resolvido.',
    action: 'Ver achados',
    to: '/achados?status=new',
  },
  unowned_alert: {
    severity: 'medium',
    title: (count) => `${plural(count, 'alerta', 'alertas')} de conta não cadastrada`,
    description:
      'Chegaram de contas que não pertencem a nenhum cliente. Veja na fila qual conta falta cadastrar ou investigue a origem.',
    action: 'Ver a fila',
    // A mesma janela que a API conta para esta decisão (os últimos 7 dias): o total da fila bate com o cartão.
    to: '/alertas-sem-dono?periodo=7d',
  },
};

function PendingDecisions({ summary }: { summary: TowerSummary }) {
  const navigate = useNavigate();
  return (
    <section data-tour="torre-decisoes" aria-labelledby="torre-decisoes" className="space-y-3 lg:col-span-2">
      <h2 id="torre-decisoes" className="text-lg font-semibold">
        Decisões pendentes
      </h2>
      {summary.pendingDecisions.length === 0 ? (
        <NothingToDecide summary={summary} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {summary.pendingDecisions.map((decision) => {
            const content = DECISIONS[decision.kind];
            return (
              <DecisionCard
                key={decision.kind}
                severity={content.severity}
                title={content.title(decision.count)}
                description={content.description}
                actionLabel={content.action}
                onAction={() => void navigate(content.to)}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function OpenIncidents({ counts }: { counts: TowerSummary['openIncidents'] }) {
  return (
    <Card aria-labelledby="torre-incidentes">
      <CardHeader>
        <CardTitle id="torre-incidentes">Incidentes abertos</CardTitle>
        <Link to="/incidentes" className="text-sm underline">
          Ver todos
        </Link>
      </CardHeader>
      <ul className="grid grid-cols-2 gap-2">
        {FINDING_SEVERITIES.map((severity) => (
          <li key={severity}>
            <Link
              to={`/incidentes?severidade=${severity}`}
              aria-label={`${SEVERITY_STYLES[severity].label}: ${plural(counts[severity], 'incidente aberto', 'incidentes abertos')}`}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 hover:bg-foreground/5"
            >
              <SeverityBadge severity={severity} />
              <span className="text-2xl font-semibold tabular-nums">{counts[severity]}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Posture({ posture }: { posture: TowerSummary['posture'] }) {
  return (
    <Card aria-labelledby="torre-postura">
      <CardHeader>
        <CardTitle id="torre-postura">Postura cloud</CardTitle>
        <Link to="/postura" className="text-sm underline">
          Ver postura
        </Link>
      </CardHeader>
      {posture.score === null ? (
        <p className="text-sm text-muted-foreground">Ainda sem varredura de postura das contas AWS.</p>
      ) : (
        <div className="space-y-2">
          <ScoreMeter
            score={posture.score}
            thresholds={{ ...DEFAULT_THRESHOLDS, warning: posture.warningBelow }}
          />
          {posture.scannedAt && (
            <p className="text-xs text-muted-foreground">
              Última varredura {formatRelative(posture.scannedAt)}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

/** Onde estão os sinais na cadeia de ataque: as 14 táticas do MITRE ATT&CK, com o detalhe no relatório. */
function Mitre({ mitre }: { mitre: TowerSummary['mitre'] }) {
  const observed = mitre.tactics.filter((tactic) => tactic.findings > 0).length;
  return (
    <Card data-tour="torre-mitre" aria-labelledby="torre-mitre" className="space-y-3">
      <CardHeader>
        <div>
          <CardTitle id="torre-mitre">MITRE ATT&CK</CardTitle>
          <p className="text-sm text-muted-foreground">
            {observed === 0
              ? `Nenhuma tática observada nos últimos ${mitre.periodDays} dias.`
              : `${plural(observed, 'tática observada', 'táticas observadas')} nos últimos ${mitre.periodDays} dias, na ordem da cadeia de ataque.`}
          </p>
        </div>
        <Link to="/relatorios?aba=mitre" className="text-sm underline">
          Ver relatório
        </Link>
      </CardHeader>
      <MitreGrid tactics={mitre.tactics} to="/relatorios?aba=mitre" />
    </Card>
  );
}

const HOUR_MS = 3_600_000;

/**
 * "Pulso da operação" (OP-02): o que a operação fez nas últimas 24 horas, com os dados que já existem. Uma fonte que o
 * cliente não tem (nenhum agente, nenhum volume no mês) some, em vez de aparecer como zero.
 */
function Pulse({ pulse }: { pulse: TowerPulse }) {
  const since = Date.parse(pulse.since);
  const hours = pulse.findings.hourly.map((_, index) => formatHour(new Date(since + index * HOUR_MS)));
  const { total, expected } = pulse.findings;
  const events = pulse.monthEvents.sources;
  const totalEvents = events.reduce((sum, source) => sum + source.events, 0);
  return (
    <section data-tour="torre-pulso" aria-labelledby="torre-pulso" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="torre-pulso" className="text-lg font-semibold">
          Pulso da operação
        </h2>
        <p className="text-sm text-muted-foreground">Últimas 24 horas, a cada hora cheia</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Achados nas últimas 24 h"
          value={formatCompact(total)}
          detail={
            expected === 0
              ? 'Nenhum esperado por exceção'
              : `${plural(expected, 'esperado', 'esperados')} por exceção`
          }
          link={{ to: '/achados?periodo=24h', label: 'Ver achados' }}
        >
          <MiniBars
            title="Achados por hora nas últimas 24 horas"
            values={pulse.findings.hourly}
            labels={hours}
            unit={{ one: 'achado', many: 'achados' }}
          />
        </StatTile>
        <StatTile
          label="Tempo até detectar"
          value={pulse.timeToDetectSeconds === null ? '—' : formatDuration(pulse.timeToDetectSeconds)}
          detail={
            pulse.timeToDetectSeconds === null
              ? 'Nenhum achado nas últimas 24 horas.'
              : 'Mediana de 24 h, da hora do evento ao achado. Inclui o atraso de entrega da fonte.'
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

/**
 * Nada para decidir: com todas as fontes coletando, a Torre afirma que está tudo calmo e mostra a prova (OP-02); sem
 * a prova ou com a coleta parada, o estado vazio de sempre, que diz o que falta.
 */
function NothingToDecide({ summary }: { summary: TowerSummary }) {
  const proof = collectionProof(summary);
  const done = 'Tudo o que pedia uma decisão já foi tratado.';
  if (proof !== null && allCollecting(proof)) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border bg-surface p-8 text-center">
        <CircleCheck aria-hidden className={`size-6 ${SEVERITY_STYLES.ok.tone}`} />
        <p className="font-medium">Tudo calmo: nada para decidir agora</p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {done} {proofSentence(proof)}
        </p>
      </div>
    );
  }
  const description =
    proof === null
      ? done
      : proof.stalled.length > 0
        ? `${done} Mas há ${stalledPhrase(proof)}: veja a Saúde da coleta.`
        : `${done} ${proofSentence(proof)}`;
  return <EmptyState title="Nenhuma decisão pendente" description={description} />;
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

/**
 * "Saúde da coleta" (OP-02, no lugar da "Cobertura"): uma linha por fonte, com o estado e o último dado que prova a
 * coleta (a AWS pelo andamento dos eventos no Wazuh do nó, a GCP e o Cloudflare pela leitura bem-sucedida, com o
 * último evento à parte), as não configuradas por último. Num nó de antes do OP-02 (sem as fontes), as datas de antes.
 */
function CollectionHealth({ summary }: { summary: TowerSummary }) {
  const { coverage } = summary;
  const { icon: WarningIcon, tone, surface } = SEVERITY_STYLES.medium;
  const proof = collectionProof(summary);
  const sources = coverage.sources
    ? [
        ...coverage.sources.filter((source) => source.state !== 'not_configured'),
        ...coverage.sources.filter((source) => source.state === 'not_configured'),
      ]
    : null;
  return (
    <Card data-tour="torre-coleta" aria-labelledby="torre-coleta">
      <CardHeader>
        <div>
          <CardTitle id="torre-coleta">Saúde da coleta</CardTitle>
          {proof && <p className="text-sm text-muted-foreground">{proofSentence(proof)}</p>}
        </div>
        <Link to="/cadastros/contas" className="shrink-0 text-sm underline">
          Ver contas
        </Link>
      </CardHeader>
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
      <p className="mt-2 text-xs text-muted-foreground">
        {plural(coverage.connectedAccounts, 'conta conectada', 'contas conectadas')}
      </p>
      {/*
        A API decide quem é silenciosa: na AWS, a conta sem alerta e, conectada, sem os eventos andando no Wazuh do nó
        (OP-01); na GCP e no Cloudflare, a sem leitura bem-sucedida nem evento (o projeto calmo, lido, não entra).
        Em todos os casos, ela está sem eventos no período.
      */}
      {coverage.silentAccounts.length > 0 && (
        <p className={`mt-3 flex items-start gap-2 rounded-md border p-2 text-sm ${surface}`}>
          <WarningIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
          {/* wrap-anywhere: o ID de uma conta do Cloudflare tem 32 caracteres sem espaço e alargaria a página no celular. */}
          <span className="min-w-0 wrap-anywhere">
            {plural(coverage.silentAccounts.length, 'conta', 'contas')} sem eventos há mais de{' '}
            {coverage.silentAfterHours} horas: {formatList(coverage.silentAccounts)}.
          </span>
        </p>
      )}
      {/*
        A API decide a parada (PR-V6): com conta AWS conectada, os eventos da AWS no Wazuh do nó sem andar há mais de
        `awsStalledAfterHours` horas. O momento é o da última vez que andaram (ou o começo da observação).
      */}
      {coverage.awsLogsStalledSince && (
        <p className={`mt-3 flex items-start gap-2 rounded-md border p-2 text-sm ${surface}`}>
          <WarningIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
          <span className="min-w-0">
            <strong>Sem logs novos da AWS:</strong> a coleta das contas AWS conectadas está parada{' '}
            {formatRelative(coverage.awsLogsStalledSince)}. Confira a conexão e a coleta em{' '}
            <Link className="underline underline-offset-2" to="/cadastros/contas">
              Contas cloud
            </Link>
            .
          </span>
        </p>
      )}
      {/* Só a equipe da Verax recebe o campo: é do nó, não de um cliente. */}
      {coverage.awsMeterBlocked && (
        <p className={`mt-3 flex items-start gap-2 rounded-md border p-2 text-sm ${surface}`}>
          <WarningIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
          <span className="min-w-0">
            Medidor da AWS parado neste nó: há mais de um cliente no Wazuh dele, e o nó atende um cliente só.
            O volume não é medido para ninguém até sobrar um.
          </span>
        </p>
      )}
    </Card>
  );
}

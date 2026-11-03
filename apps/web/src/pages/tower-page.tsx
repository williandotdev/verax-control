import { useQuery } from '@tanstack/react-query';
import {
  FINDING_SEVERITIES,
  type PendingDecisionKind,
  type TowerSummary,
  towerSummarySchema,
} from '@verax/shared';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { DecisionCard } from '@/components/security/decision-card';
import { ScoreMeter } from '@/components/security/score-meter';
import { Semaphore } from '@/components/security/semaphore';
import { SeverityBadge } from '@/components/security/severity-badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { DEFAULT_THRESHOLDS } from '@/design/score';
import { MitreGrid } from '@/features/reports/mitre-grid';
import { type Severity, SEVERITY_STYLES } from '@/design/severity';
import { useMe } from '@/features/session/session';
import { api } from '@/lib/api';
import { formatList, formatRelative, plural } from '@/lib/format';
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
      <Card>
        <Semaphore state={summary.light} reason={towerReason(summary)} />
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <PendingDecisions summary={summary} />
        <div className="space-y-6">
          <OpenIncidents counts={summary.openIncidents} />
          <Posture posture={summary.posture} />
          <Coverage coverage={summary.coverage} />
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
    <section aria-labelledby="torre-decisoes" className="space-y-3 lg:col-span-2">
      <h2 id="torre-decisoes" className="text-lg font-semibold">
        Decisões pendentes
      </h2>
      {summary.pendingDecisions.length === 0 ? (
        <EmptyState
          title="Nenhuma decisão pendente"
          description="Tudo o que pedia uma decisão já foi tratado."
        />
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
        <p className="text-sm text-muted-foreground">
          Ainda sem varredura de postura. A primeira roda em até 24 horas depois de conectar a conta.
        </p>
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
    <Card aria-labelledby="torre-mitre" className="space-y-3">
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

function Coverage({ coverage }: { coverage: TowerSummary['coverage'] }) {
  const { icon: WarningIcon, tone, surface } = SEVERITY_STYLES.medium;
  return (
    <Card aria-labelledby="torre-cobertura">
      <CardHeader>
        <CardTitle id="torre-cobertura">Cobertura</CardTitle>
      </CardHeader>
      <dl className="space-y-1 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Contas conectadas</dt>
          <dd className="font-medium tabular-nums">{coverage.connectedAccounts}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Último evento recebido</dt>
          <dd className="font-medium">
            {coverage.lastEventAt ? formatRelative(coverage.lastEventAt) : 'nenhum ainda'}
          </dd>
        </div>
      </dl>
      {coverage.silentAccounts.length > 0 && (
        <p className={`mt-3 flex items-start gap-2 rounded-md border p-2 text-sm ${surface}`}>
          <WarningIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${tone}`} />
          <span>
            {plural(coverage.silentAccounts.length, 'conta', 'contas')} sem eventos há mais de{' '}
            {coverage.silentAfterHours} horas: {formatList(coverage.silentAccounts)}.
          </span>
        </p>
      )}
    </Card>
  );
}

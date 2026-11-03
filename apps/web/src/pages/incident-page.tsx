import { type IncidentDetail, INCIDENT_STATUSES, type IncidentStatus } from '@verax/shared';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { SeverityBadge } from '@/components/security/severity-badge';
import { Timeline } from '@/components/security/timeline';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectField } from '@/components/ui/select-field';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { IncidentStatusBadge } from '@/features/incidents/incident-status-badge';
import { useIncident, useIncidentAssignees, useUpdateIncident } from '@/features/incidents/incidents-api';
import { INCIDENT_STATUS_LABELS } from '@/features/incidents/labels';
import {
  incidentRecommendation,
  incidentSummary,
  incidentTitle,
  parseKeys,
} from '@/features/incidents/narrative';
import { useMe } from '@/features/session/session';
import { errorMessage } from '@/lib/errors';
import { formatRelative, plural } from '@/lib/format';

const NO_ASSIGNEE = '';

/** Detalhe do incidente (T7.9): resumo em português, linha do tempo, ativos, MITRE, status e responsável. */
export function IncidentPage() {
  const { id = '' } = useParams();
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const incident = useIncident(id, scope !== null);

  let content;
  if (me && scope === null) {
    content = (
      <EmptyState
        title="Escolha um cliente"
        description="Escolha no seletor do topo o cliente deste incidente."
      />
    );
  } else if (incident.isError) {
    content = <ErrorState error={incident.error} onRetry={() => void incident.refetch()} />;
  } else if (!incident.data) {
    content = <LoadingState rows={8} label="Carregando o incidente" />;
  } else {
    content = (
      <IncidentView
        incident={incident.data}
        canWrite={me?.permissions.includes('incidents:write') === true}
      />
    );
  }

  return (
    <section className="space-y-4">
      <Link
        to="/incidentes"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft aria-hidden className="size-4" />
        Incidentes
      </Link>
      {content}
    </section>
  );
}

function IncidentView({ incident, canWrite }: { incident: IncidentDetail; canWrite: boolean }) {
  const keys = parseKeys(incident.keys);
  const assets: [string, string[]][] = [
    ['Contas', incident.accounts],
    ['Recursos', incident.resources],
    ['Usuários', keys.user ?? []],
    ['Chaves de acesso', keys.key ?? []],
    ['IPs de origem', keys.ip ?? []],
  ];

  return (
    <>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{incidentTitle(incident)}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <SeverityBadge severity={incident.severity} />
          <IncidentStatusBadge status={incident.status} />
          <span>
            Nota de risco <strong className="text-foreground">{incident.riskScore}</strong> de 100
          </span>
          <span>· aberto {formatRelative(incident.firstSeenAt)}</span>
          <span>· último achado {formatRelative(incident.lastSeenAt)}</span>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card aria-labelledby="incidente-resumo">
            <CardHeader>
              <CardTitle id="incidente-resumo">Resumo</CardTitle>
            </CardHeader>
            <p className="text-sm leading-relaxed">{incidentSummary(incident)}</p>
            <p className="mt-3 rounded-md border bg-foreground/[0.03] p-3 text-sm">
              <strong>Primeiro passo:</strong> {incidentRecommendation(incident)}
            </p>
          </Card>

          <Card aria-labelledby="incidente-linha-do-tempo">
            <CardHeader>
              <CardTitle id="incidente-linha-do-tempo">
                Linha do tempo ({plural(incident.findingCount, 'achado', 'achados')})
              </CardTitle>
            </CardHeader>
            <Timeline
              events={incident.findings.map((finding) => ({
                id: finding.id,
                at: finding.occurredAt,
                title: finding.title,
                description: finding.eventName ?? undefined,
                severity: finding.severity,
                source: [finding.actor.user ?? finding.actor.ip, FINDING_SOURCE_LABELS[finding.source]]
                  .filter(Boolean)
                  .join(' · '),
                href: `/achados?achado=${finding.id}`,
              }))}
            />
          </Card>
        </div>

        <div className="space-y-4">
          <StatusAndAssignee incident={incident} canWrite={canWrite} />

          <Card aria-labelledby="incidente-ativos">
            <CardHeader>
              <CardTitle id="incidente-ativos">Ativos envolvidos</CardTitle>
            </CardHeader>
            <dl className="space-y-2 text-sm">
              {assets
                .filter(([, values]) => values.length > 0)
                .map(([label, values]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    {values.map((value) => (
                      <dd key={value} className="break-all font-mono text-xs">
                        {value}
                      </dd>
                    ))}
                  </div>
                ))}
            </dl>
          </Card>

          {incident.mitreTactics.length + incident.mitreTechniques.length > 0 && (
            <Card aria-labelledby="incidente-mitre">
              <CardHeader>
                <CardTitle id="incidente-mitre">MITRE ATT&CK</CardTitle>
              </CardHeader>
              <p className="text-xs text-muted-foreground">Táticas</p>
              <ul className="mb-2 flex flex-wrap gap-1.5">
                {incident.mitreTactics.map((tactic) => (
                  <li key={tactic} className="rounded border px-2 py-0.5 text-xs">
                    {tactic}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">Técnicas</p>
              <ul className="flex flex-wrap gap-1.5">
                {incident.mitreTechniques.map((technique) => (
                  <li key={technique} className="rounded border px-2 py-0.5 font-mono text-xs">
                    {technique}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function StatusAndAssignee({ incident, canWrite }: { incident: IncidentDetail; canWrite: boolean }) {
  const assignees = useIncidentAssignees(canWrite);
  const update = useUpdateIncident(incident.id);

  return (
    <Card aria-labelledby="incidente-tratamento">
      <CardHeader>
        <CardTitle id="incidente-tratamento">Tratamento</CardTitle>
      </CardHeader>
      {canWrite ? (
        <div className="space-y-3">
          <SelectField
            label="Status"
            value={incident.status}
            onChange={(value) => update.mutate({ status: value as IncidentStatus })}
            options={INCIDENT_STATUSES.map((value) => ({
              value,
              label: INCIDENT_STATUS_LABELS[value].label,
            }))}
          />
          <SelectField
            label="Responsável"
            value={incident.assignee?.id ?? NO_ASSIGNEE}
            onChange={(value) => update.mutate({ assigneeId: value === NO_ASSIGNEE ? null : value })}
            options={[
              { value: NO_ASSIGNEE, label: 'Ninguém' },
              ...(assignees.data ?? (incident.assignee ? [incident.assignee] : [])).map((person) => ({
                value: person.id,
                label: person.name,
              })),
            ]}
          />
          {update.isPending && (
            <p role="status" className="text-xs text-muted-foreground">
              Salvando…
            </p>
          )}
          {update.error && (
            <p role="alert" className="text-sm text-critical">
              {errorMessage(update.error)}
            </p>
          )}
        </div>
      ) : (
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Status</dt>
            <dd>{INCIDENT_STATUS_LABELS[incident.status].label}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Responsável</dt>
            <dd>{incident.assignee?.name ?? 'Ninguém'}</dd>
          </div>
        </dl>
      )}
    </Card>
  );
}

import { agentIdOfRef, type IncidentDetail, INCIDENT_STATUSES, type IncidentStatus } from '@verax/shared';
import { useSearchParams } from 'react-router';
import { SeverityBadge } from '@/components/security/severity-badge';
import { Timeline } from '@/components/security/timeline';
import { SelectField } from '@/components/ui/select-field';
import { FINDING_SOURCE_LABELS, findingOriginId } from '@/features/findings/labels';
import { IncidentStatusBadge } from '@/features/incidents/incident-status-badge';
import { selectionSearch } from '@/features/detections/url-state';
import { useIncidentAssignees, useUpdateIncident } from '@/features/incidents/incidents-api';
import { INCIDENT_STATUS_LABELS } from '@/features/incidents/labels';
import { TACTIC_LABELS } from '@/features/reports/labels';
import { incidentRecommendation, incidentSummary, parseKeys } from '@/features/incidents/narrative';
import { errorMessage } from '@/lib/errors';
import { formatRelative, plural } from '@/lib/format';

const NO_ASSIGNEE = '';

/**
 * Detalhe do incidente (T7.9), no painel ao lado da lista da tela Detecções: severidade, status e nota, o resumo em
 * português com o primeiro passo, o tratamento (status e responsável), a linha do tempo dos achados (cada um abre no
 * mesmo painel), os ativos e o MITRE. Numa coluna só: o painel é estreito.
 */
export function IncidentDetailView({ incident, canWrite }: { incident: IncidentDetail; canWrite: boolean }) {
  const [params] = useSearchParams();
  const keys = parseKeys(incident.keys);
  const assets: [string, string[]][] = [
    // Nos alertas das instâncias, a origem é o agente do Wazuh (`agente 001`).
    [
      incident.accounts.some((origin) => agentIdOfRef(origin) !== null) ? 'Contas e agentes' : 'Contas',
      incident.accounts.map(findingOriginId),
    ],
    ['Recursos', incident.resources],
    ['Usuários', keys.user ?? []],
    ['Chaves de acesso', keys.key ?? []],
    ['IPs de origem', keys.ip ?? []],
  ];

  const mitre = incident.mitreTactics.length + incident.mitreTechniques.length > 0;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <SeverityBadge severity={incident.severity} />
        <IncidentStatusBadge status={incident.status} />
        <span>
          Nota de risco <strong className="text-foreground">{incident.riskScore}</strong> de 100
        </span>
        <span>· aberto {formatRelative(incident.firstSeenAt)}</span>
        <span>· último achado {formatRelative(incident.lastSeenAt)}</span>
      </div>

      <section data-tour="incidente-resumo" aria-labelledby="incidente-resumo" className="space-y-2">
        <h3 id="incidente-resumo" className="text-sm font-semibold">
          Resumo
        </h3>
        <p className="text-sm leading-relaxed">{incidentSummary(incident)}</p>
        <p className="rounded-md border bg-foreground/[0.03] p-3 text-sm">
          <strong>Primeiro passo:</strong> {incidentRecommendation(incident)}
        </p>
      </section>

      <StatusAndAssignee incident={incident} canWrite={canWrite} />

      <section aria-labelledby="incidente-linha-do-tempo" className="space-y-3">
        <h3 id="incidente-linha-do-tempo" className="text-sm font-semibold">
          Linha do tempo ({plural(incident.findingCount, 'achado', 'achados')})
        </h3>
        <Timeline
          className="ml-2"
          events={incident.findings.map((finding) => ({
            id: finding.id,
            at: finding.occurredAt,
            title: finding.title,
            description: finding.eventName ?? undefined,
            severity: finding.severity,
            source: [finding.actor.user ?? finding.actor.ip, FINDING_SOURCE_LABELS[finding.source]]
              .filter(Boolean)
              .join(' · '),
            href: selectionSearch(params, { kind: 'finding', id: finding.id }),
          }))}
        />
      </section>

      <section aria-labelledby="incidente-ativos" className="space-y-2">
        <h3 id="incidente-ativos" className="text-sm font-semibold">
          Ativos envolvidos
        </h3>
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
      </section>

      {mitre && (
        <section aria-labelledby="incidente-mitre" className="space-y-1">
          <h3 id="incidente-mitre" className="text-sm font-semibold">
            MITRE ATT&CK
          </h3>
          <p className="text-xs text-muted-foreground">Táticas</p>
          <ul className="mb-2 flex flex-wrap gap-1.5">
            {incident.mitreTactics.map((tactic) => (
              <li key={tactic} className="rounded border px-2 py-0.5 text-xs">
                {TACTIC_LABELS[tactic] ?? tactic}
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
        </section>
      )}
    </>
  );
}

function StatusAndAssignee({ incident, canWrite }: { incident: IncidentDetail; canWrite: boolean }) {
  const assignees = useIncidentAssignees(canWrite);
  const update = useUpdateIncident(incident.id);

  return (
    <section aria-labelledby="incidente-tratamento" className="space-y-2 rounded-md border p-3">
      <h3 id="incidente-tratamento" className="text-sm font-semibold">
        Tratamento
      </h3>
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
            <p role="alert" className="text-sm text-critical-text">
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
    </section>
  );
}

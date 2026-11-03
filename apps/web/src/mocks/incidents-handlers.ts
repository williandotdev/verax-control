import {
  type Author,
  type FindingDetail,
  type FindingSeverity,
  type Incident,
  type IncidentDetail,
  incidentDetailSchema,
  incidentListQuerySchema,
  incidentSchema,
  type IncidentStatus,
  incidentUpdateSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_INCIDENTS } from './findings-fixtures';
import type { MockState } from './handlers';

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

/** Pessoas que podem ser responsáveis nos clientes fictícios. */
export const DEMO_ASSIGNEES: Author[] = [
  { id: 'demo-equipe-verax', name: 'Equipe Verax' },
  { id: 'demo-ana', name: 'Ana Souza' },
  { id: 'demo-joao', name: 'João Lima' },
  { id: 'demo-carlos', name: 'Carlos Dev' },
];
const [VERAX, ANA, JOAO, CARLOS] = DEMO_ASSIGNEES;

export interface IncidentState {
  status: IncidentStatus;
  assignee: Author | null;
}

/** Status e responsável de cada incidente fictício: dois sem responsável, como a Torre mostra. */
export function initialIncidents(): Map<string, IncidentState> {
  return new Map<string, IncidentState>([
    [DEMO_INCIDENTS.chaveComprometida, { status: 'investigating', assignee: VERAX ?? null }],
    [DEMO_INCIDENTS.forcaBrutaSsh, { status: 'investigating', assignee: ANA ?? null }],
    [DEMO_INCIDENTS.ataqueWaf, { status: 'open', assignee: null }],
    [DEMO_INCIDENTS.bucketPublico, { status: 'open', assignee: CARLOS ?? null }],
    [DEMO_INCIDENTS.portaSsh, { status: 'investigating', assignee: JOAO ?? null }],
    [DEMO_INCIDENTS.loginSemMfa, { status: 'open', assignee: null }],
    [DEMO_INCIDENTS.betaWaf, { status: 'open', assignee: VERAX ?? null }],
    [DEMO_INCIDENTS.betaLogin, { status: 'resolved', assignee: VERAX ?? null }],
  ]);
}

const ORDER: readonly FindingSeverity[] = ['low', 'medium', 'high', 'critical'];
const BASE: Record<FindingSeverity, number> = { critical: 70, high: 50, medium: 30, low: 10 };
const unique = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Resumo do incidente a partir dos achados, como a T5.6 calcula (sem lista de proteção na demonstração). */
function summarize(id: string, findings: FindingDetail[], state: IncidentState): IncidentDetail {
  const sorted = [...findings].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const severity = sorted.reduce<FindingSeverity>(
    (highest, finding) =>
      ORDER.indexOf(finding.severity) > ORDER.indexOf(highest) ? finding.severity : highest,
    'low',
  );
  const privileged = sorted.some((finding) => finding.actor.type === 'Root');
  const keys = unique(
    sorted.flatMap((finding) => [
      ...(finding.actor.user ? [`user:${finding.actor.user}`] : []),
      ...(finding.actor.accessKeyId ? [`key:${finding.actor.accessKeyId}`] : []),
      ...(finding.actor.ip ? [`ip:${finding.actor.ip}`] : []),
      ...(finding.resource ? [`resource:${finding.resource}`] : []),
    ]),
  );
  return incidentDetailSchema.parse({
    id,
    severity,
    status: state.status,
    riskScore: Math.min(100, BASE[severity] + (privileged ? 10 : 0) + Math.min(15, (sorted.length - 1) * 3)),
    findingCount: sorted.length,
    firstSeenAt: sorted[0]?.occurredAt,
    lastSeenAt: sorted[sorted.length - 1]?.occurredAt,
    keys,
    accounts: unique(sorted.map((finding) => finding.accountId)),
    resources: unique(sorted.flatMap((finding) => (finding.resource ? [finding.resource] : []))),
    mitreTactics: unique(sorted.flatMap((finding) => finding.mitreTactics)),
    mitreTechniques: unique(sorted.flatMap((finding) => finding.mitreTechniques)),
    assignee: state.assignee,
    findings: sorted.map(
      ({ ruleId: _r, ruleLevel: _l, mitreTechniques: _t, comments: _c, rawEvent: _e, ...finding }) => finding,
    ),
  });
}

/** Incidentes de um cliente, montados dos achados, ordenados pela nota (maior primeiro). */
export function incidentSummaries(
  tenantId: string,
  findings: Map<string, FindingDetail[]>,
  incidents: Map<string, IncidentState>,
): IncidentDetail[] {
  const byIncident = new Map<string, FindingDetail[]>();
  for (const finding of findings.get(tenantId) ?? []) {
    if (finding.incidentId && incidents.has(finding.incidentId)) {
      byIncident.set(finding.incidentId, [...(byIncident.get(finding.incidentId) ?? []), finding]);
    }
  }
  const list = [...byIncident.entries()].map(([id, items]) =>
    summarize(id, items, incidents.get(id) as IncidentState),
  );
  return list.sort((a, b) => b.riskScore - a.riskScore || b.lastSeenAt.localeCompare(a.lastSeenAt));
}

const toSummary = ({ mitreTechniques: _t, findings: _f, ...incident }: IncidentDetail): Incident =>
  incidentSchema.parse(incident);

/**
 * Incidentes do modo mock (T5.7), montados dos mesmos achados da tela de Achados: lista ordenada pela nota,
 * filtros, detalhe com a linha do tempo, e mudança de status e responsável com permissão e CSRF.
 */
export function createIncidentHandlers(
  state: MockState,
  findings: Map<string, FindingDetail[]>,
  incidents: Map<string, IncidentState> = initialIncidents(),
) {
  const scoped = () => {
    if (!state.me) return { error: problem(401, 'Não autenticado') } as const;
    const tenantId = state.me.scopeTenantId;
    if (!tenantId) return { error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') } as const;
    const list = incidentSummaries(tenantId, findings, incidents);
    return { me: state.me, list } as const;
  };

  return [
    http.get(url('/v1/incidents/assignees'), () => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      return HttpResponse.json({ items: DEMO_ASSIGNEES });
    }),

    http.get(url('/v1/incidents'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const query = incidentListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return problem(400, 'Filtro inválido');
      const { status, severity, unassigned, page, pageSize } = query.data;
      const items = scope.list.filter(
        (incident) =>
          (!status || incident.status === status) &&
          (!severity || incident.severity === severity) &&
          (!unassigned || incident.assignee === null),
      );
      const start = (page - 1) * pageSize;
      return HttpResponse.json({
        items: items.slice(start, start + pageSize).map(toSummary),
        page,
        pageSize,
        total: items.length,
      });
    }),

    http.get(url('/v1/incidents/:id'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const incident = scope.list.find((candidate) => candidate.id === params['id']);
      return incident ? HttpResponse.json(incident) : problem(404, 'Incidente não encontrado');
    }),

    http.patch(url('/v1/incidents/:id'), async ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      if (!scope.me.permissions.includes('incidents:write')) return problem(403, 'Sem permissão');
      if (request.headers.get('X-CSRF-Token') === null) return problem(403, 'CSRF', 'CSRF_INVALID');
      const id = String(params['id']);
      const current = incidents.get(id);
      if (!current || !scope.list.some((candidate) => candidate.id === id)) {
        return problem(404, 'Incidente não encontrado');
      }
      const body = incidentUpdateSchema.safeParse(await request.json());
      if (!body.success) return problem(400, 'Dados inválidos');
      if (body.data.status) current.status = body.data.status;
      if (body.data.assigneeId !== undefined) {
        const assignee = DEMO_ASSIGNEES.find((candidate) => candidate.id === body.data.assigneeId);
        if (body.data.assigneeId !== null && !assignee) return problem(400, 'Responsável inválido');
        current.assignee = assignee ?? null;
      }
      const after = scoped();
      if ('error' in after) return after.error;
      return HttpResponse.json(after.list.find((candidate) => candidate.id === id));
    }),
  ];
}

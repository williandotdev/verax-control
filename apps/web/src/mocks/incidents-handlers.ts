import {
  type Author,
  compareDetections,
  detectionListQuerySchema,
  type DetectionRow,
  detectionSortKey,
  type Finding,
  findingContentMatches,
  findingMatchesFilters,
  hasContentFilter,
  incidentMatchesFilters,
  type FindingDetail,
  type FindingSeverity,
  type Incident,
  type IncidentDetail,
  incidentDetailSchema,
  incidentListQuerySchema,
  incidentSchema,
  type IncidentStatus,
  incidentAttachSchema,
  incidentCreateSchema,
  incidentUpdateSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_INCIDENTS } from './findings-fixtures';
import type { MockState } from './handlers';
import { demoPeriodRefusal, demoRangeRefusal } from './plan-handlers';

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
  /** Quem confirmou o incidente (promoveu os alertas). */
  createdBy: Author | null;
}

/**
 * Os incidentes fictícios, todos confirmados por uma pessoa (decisão de 17/11/2026: o sync não abre incidente): dois
 * em análise e um aberto sem responsável no Alfa, e um resolvido no Beta. Os outros alertas do Alfa e do Beta esperam
 * validação na lista de alertas.
 */
export function initialIncidents(): Map<string, IncidentState> {
  return new Map<string, IncidentState>([
    [
      DEMO_INCIDENTS.chaveComprometida,
      { status: 'investigating', assignee: VERAX ?? null, createdBy: VERAX ?? null },
    ],
    [
      DEMO_INCIDENTS.forcaBrutaSsh,
      { status: 'investigating', assignee: ANA ?? null, createdBy: ANA ?? null },
    ],
    [DEMO_INCIDENTS.ataqueWaf, { status: 'open', assignee: null, createdBy: JOAO ?? null }],
    [DEMO_INCIDENTS.betaLogin, { status: 'resolved', assignee: VERAX ?? null, createdBy: CARLOS ?? null }],
  ]);
}

let created = 0;
/** Id de um incidente confirmado na demonstração. */
const newIncidentId = (): string =>
  `018f2c1e-0000-7000-8000-${(0xc00000 + (created += 1)).toString(16).padStart(12, '0')}`;

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
    createdBy: state.createdBy,
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

const toSummary = ({
  mitreTechniques: _t,
  findings: _f,
  createdBy: _c,
  ...incident
}: IncidentDetail): Incident => incidentSchema.parse(incident);

const findingsOf = (all: readonly FindingDetail[], incidentId: string) =>
  all.filter((finding) => finding.incidentId === incidentId);

const summaryOf = ({
  ruleId: _r,
  ruleLevel: _l,
  mitreTechniques: _t,
  comments: _c,
  rawEvent: _e,
  ...finding
}: FindingDetail): Finding => finding;

/**
 * Incidentes do modo mock (T5.7), montados dos mesmos alertas da lista de alertas: lista ordenada pela nota, filtros,
 * detalhe com a linha do tempo, mudança de status e responsável, e o trabalho de quem confirma (promover, anexar e
 * remover alertas), com permissão e CSRF, como a API.
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

  const writeDenied = (request: Request) => {
    if (!state.me?.permissions.includes('incidents:write')) return problem(403, 'Sem permissão');
    if (request.headers.get('X-CSRF-Token') === null) return problem(403, 'CSRF', 'CSRF_INVALID');
    return null;
  };
  /** Os alertas pedidos, todos do cliente e fora de incidente (404 se algum não é do cliente; 409 se já está num). */
  const freeFindings = (tenantId: string, ids: readonly string[]) => {
    const own = findings.get(tenantId) ?? [];
    const rows = ids.map((id) => own.find((finding) => finding.id === id));
    if (rows.some((row) => row === undefined))
      return { error: problem(404, 'Alerta não encontrado') } as const;
    const found = rows as FindingDetail[];
    if (found.some((row) => row.incidentId !== null)) {
      return {
        error: problem(
          409,
          'Um dos alertas já está em um incidente. Remova-o de lá antes.',
          'FINDING_IN_INCIDENT',
        ),
      } as const;
    }
    return { rows: found } as const;
  };
  const detailOf = (id: string) => {
    const after = scoped();
    if ('error' in after) return after.error;
    return HttpResponse.json(after.list.find((candidate) => candidate.id === id));
  };
  const resolvedRefusal = () =>
    problem(409, 'Incidente resolvido não muda de alertas. Reabra o incidente antes.', 'INCIDENT_RESOLVED');

  return [
    http.post(url('/v1/incidents'), async ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const denied = writeDenied(request);
      if (denied) return denied;
      const body = incidentCreateSchema.safeParse(await request.json());
      if (!body.success) return problem(400, 'Dados inválidos');
      const free = freeFindings(scope.me.scopeTenantId ?? '', body.data.findingIds);
      if ('error' in free) return free.error;
      const assignee = DEMO_ASSIGNEES.find((candidate) => candidate.id === body.data.assigneeId) ?? null;
      if (body.data.assigneeId && !assignee) return problem(400, 'Responsável inválido para este cliente');
      const id = newIncidentId();
      incidents.set(id, {
        status: 'open',
        assignee,
        createdBy: { id: scope.me.userId, name: scope.me.email },
      });
      for (const finding of free.rows) finding.incidentId = id;
      const after = scoped();
      if ('error' in after) return after.error;
      return HttpResponse.json(
        after.list.find((candidate) => candidate.id === id),
        { status: 201 },
      );
    }),

    http.post(url('/v1/incidents/:id/findings'), async ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const denied = writeDenied(request);
      if (denied) return denied;
      const id = String(params['id']);
      const incident = scope.list.find((candidate) => candidate.id === id);
      if (!incident) return problem(404, 'Incidente não encontrado');
      if (incident.status === 'resolved') return resolvedRefusal();
      const body = incidentAttachSchema.safeParse(await request.json());
      if (!body.success) return problem(400, 'Dados inválidos');
      const free = freeFindings(scope.me.scopeTenantId ?? '', body.data.findingIds);
      if ('error' in free) return free.error;
      for (const finding of free.rows) finding.incidentId = id;
      return detailOf(id);
    }),

    http.delete(url('/v1/incidents/:id/findings/:findingId'), ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const denied = writeDenied(request);
      if (denied) return denied;
      const id = String(params['id']);
      const incident = scope.list.find((candidate) => candidate.id === id);
      if (!incident) return problem(404, 'Incidente não encontrado');
      if (incident.status === 'resolved') return resolvedRefusal();
      const own = findingsOf(findings.get(scope.me.scopeTenantId ?? '') ?? [], id);
      const finding = own.find((candidate) => candidate.id === params['findingId']);
      if (!finding) return problem(404, 'Alerta não encontrado');
      if (own.length <= 1) {
        return problem(
          409,
          'O incidente precisa de pelo menos um alerta. Para encerrá-lo, marque o incidente como resolvido.',
          'INCIDENT_LAST_FINDING',
        );
      }
      finding.incidentId = null;
      return detailOf(id);
    }),

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

    // Tela Detecções: os incidentes (e, sem `kind=incident`, os alertas fora de incidente), com a regra e a ordem da API.
    http.get(url('/v1/detections'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      if (
        !scope.me.permissions.includes('findings:read') ||
        !scope.me.permissions.includes('incidents:read')
      ) {
        return problem(403, 'Sem permissão');
      }
      const query = detectionListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return problem(400, 'Filtro inválido');
      const { page, pageSize, sort = 'recent', kind, ...filters } = query.data;
      const refusal = demoPeriodRefusal(state, filters.period) ?? demoRangeRefusal(state, filters.from);
      if (refusal) return refusal;
      const now = new Date();
      const tenantFindings = findings.get(scope.me.scopeTenantId ?? '') ?? [];
      const content = hasContentFilter(filters);
      const rows: DetectionRow[] = [
        ...scope.list
          .filter((incident) =>
            incidentMatchesFilters(incident, findingsOf(tenantFindings, incident.id), filters, now),
          )
          .map((incident) => {
            const own = findingsOf(tenantFindings, incident.id);
            return {
              kind: 'incident' as const,
              incident: toSummary(incident),
              matchedFindings: content
                ? own.filter((finding) => findingContentMatches(finding, filters)).length
                : own.length,
            };
          }),
        ...(filters.unassigned || kind === 'incident'
          ? []
          : tenantFindings
              .filter(
                (finding) => finding.incidentId === null && findingMatchesFilters(finding, filters, now),
              )
              .map((finding) => ({ kind: 'finding' as const, finding: summaryOf(finding) }))),
      ];
      rows.sort((a, b) => compareDetections(sort, detectionSortKey(a), detectionSortKey(b)));
      const start = (page - 1) * pageSize;
      return HttpResponse.json({
        items: rows.slice(start, start + pageSize),
        page,
        pageSize,
        total: rows.length,
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

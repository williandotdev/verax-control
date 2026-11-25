import {
  type Finding,
  type FindingDetail,
  MAX_RELATED_FINDINGS,
  RELATED_FINDINGS_WINDOW_MINUTES,
  findingCommentCreateSchema,
  findingCommentSchema,
  findingListQuerySchema,
  findingStatusUpdateSchema,
  findingMatchesFilters,
  type Permission,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { demoFindingEvidence } from './finding-evidence';
import { demoFindings } from './findings-fixtures';
import type { MockState } from './handlers';
import { demoPeriodRefusal, demoRangeRefusal } from './plan-handlers';

const url = (path: string): string => `${API_URL}${path}`;

const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

let sequence = 0;
const newId = (): string =>
  `018f2c1e-0000-7000-8000-${(0xf00000 + (sequence += 1)).toString(16).padStart(12, '0')}`;

/** As chaves de correlação do alerta (usuário, chave de acesso, IP e recurso), como a API compara. */
function correlationKeysOf(finding: FindingDetail): string[] {
  return [
    ...(finding.actor.user ? [`user:${finding.actor.user}`] : []),
    ...(finding.actor.accessKeyId ? [`key:${finding.actor.accessKeyId}`] : []),
    ...(finding.actor.ip ? [`ip:${finding.actor.ip}`] : []),
    ...(finding.resource ? [`resource:${finding.resource}`] : []),
  ];
}

function summary(detail: FindingDetail): Finding {
  const {
    ruleId: _rule,
    ruleLevel: _level,
    mitreTechniques: _techniques,
    comments: _comments,
    rawEvent: _raw,
    ...item
  } = detail;
  return item;
}

/**
 * Alertas (achados) do modo mock, com o mesmo contrato da API: filtros e paginação na lista, os relacionados, escopo
 * do cliente da sessão, permissão e CSRF nas escritas. O estado fica em memória, então a demonstração é interativa.
 */
export function createFindingHandlers(
  state: MockState,
  store: Map<string, FindingDetail[]> = demoFindings(),
) {
  const scoped = () => {
    if (!state.me) return { error: problem(401, 'Não autenticado') } as const;
    const tenantId = state.me.scopeTenantId;
    if (!tenantId) return { error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') } as const;
    return { me: state.me, findings: store.get(tenantId) ?? [] } as const;
  };
  const writeDenied = (request: Request, permission: Permission) => {
    if (!state.me?.permissions.includes(permission)) return problem(403, 'Sem permissão');
    if (request.headers.get('X-CSRF-Token') === null) return problem(403, 'CSRF', 'CSRF_INVALID');
    return null;
  };

  return [
    http.get(url('/v1/findings'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const query = findingListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return problem(400, 'Filtro inválido');
      const { page, pageSize, ...filters } = query.data;
      const refusal = demoPeriodRefusal(state, filters.period) ?? demoRangeRefusal(state, filters.from);
      if (refusal) return refusal;
      const now = new Date();
      // A mesma regra da API (`findingMatchesFilters`), do mais recente para trás.
      const items = scope.findings
        .filter((finding) => findingMatchesFilters(finding, filters, now))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
      const start = (page - 1) * pageSize;
      return HttpResponse.json({
        items: items.slice(start, start + pageSize).map(summary),
        page,
        pageSize,
        total: items.length,
      });
    }),

    // A sugestão ao promover: alertas do cliente, em validação, fora de incidente, com chave em comum e a até 60 min.
    http.get(url('/v1/findings/:id/related'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const anchor = scope.findings.find((candidate) => candidate.id === params['id']);
      if (!anchor) return problem(404, 'Alerta não encontrado');
      const keys = new Set(correlationKeysOf(anchor));
      const at = Date.parse(anchor.occurredAt);
      const window = RELATED_FINDINGS_WINDOW_MINUTES * 60_000;
      const items = scope.findings
        .filter(
          (candidate) =>
            candidate.id !== anchor.id &&
            candidate.incidentId === null &&
            (candidate.status === 'new' || candidate.status === 'investigating') &&
            Math.abs(Date.parse(candidate.occurredAt) - at) <= window &&
            correlationKeysOf(candidate).some((key) => keys.has(key)),
        )
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id))
        .slice(0, MAX_RELATED_FINDINGS)
        .map(summary);
      return HttpResponse.json({ items });
    }),

    // A evidência dos ataques web: rota à parte do detalhe, como na API.
    http.get(url('/v1/findings/:id/evidence'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const finding = scope.findings.find((candidate) => candidate.id === params['id']);
      return finding
        ? HttpResponse.json(demoFindingEvidence(finding))
        : problem(404, 'Alerta não encontrado');
    }),

    http.get(url('/v1/findings/:id'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const finding = scope.findings.find((candidate) => candidate.id === params['id']);
      return finding ? HttpResponse.json(finding) : problem(404, 'Alerta não encontrado');
    }),

    http.patch(url('/v1/findings/:id/status'), async ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const denied = writeDenied(request, 'findings:triage');
      if (denied) return denied;
      const finding = scope.findings.find((candidate) => candidate.id === params['id']);
      if (!finding) return problem(404, 'Alerta não encontrado');
      const body = findingStatusUpdateSchema.safeParse(await request.json());
      if (!body.success) return problem(400, 'Dados inválidos');
      finding.status = body.data.status;
      if (body.data.comment) {
        finding.comments.push(
          findingCommentSchema.parse({
            id: newId(),
            author: { id: scope.me.userId, name: scope.me.email },
            body: body.data.comment,
            createdAt: new Date().toISOString(),
          }),
        );
        finding.commentCount = finding.comments.length;
      }
      return HttpResponse.json(finding);
    }),

    http.post(url('/v1/findings/:id/comments'), async ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const denied = writeDenied(request, 'findings:triage');
      if (denied) return denied;
      const finding = scope.findings.find((candidate) => candidate.id === params['id']);
      if (!finding) return problem(404, 'Alerta não encontrado');
      const body = findingCommentCreateSchema.safeParse(await request.json());
      if (!body.success) return problem(400, 'Dados inválidos');
      const comment = findingCommentSchema.parse({
        id: newId(),
        author: { id: scope.me.userId, name: scope.me.email },
        body: body.data.body,
        createdAt: new Date().toISOString(),
      });
      finding.comments.push(comment);
      finding.commentCount = finding.comments.length;
      return HttpResponse.json(comment, { status: 201 });
    }),
  ];
}

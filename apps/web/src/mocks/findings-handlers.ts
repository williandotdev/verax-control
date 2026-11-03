import {
  alertExceptionCreateSchema,
  alertExceptionSchema,
  type CloudAccount,
  cloudAccountSchema,
  type Finding,
  type FindingDetail,
  findingCommentCreateSchema,
  findingCommentSchema,
  findingListQuerySchema,
  findingStatusUpdateSchema,
  type Permission,
  readOnlyRoleArn,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_ACCOUNTS, DEMO_TENANTS } from './fixtures';
import { demoFindings } from './findings-fixtures';
import type { MockState } from './handlers';

const url = (path: string): string => `${API_URL}${path}`;
const PERIOD_HOURS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, '90d': 24 * 90 } as const;

const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

let sequence = 0;
const newId = (): string =>
  `018f2c1e-0000-7000-8000-${(0xf00000 + (sequence += 1)).toString(16).padStart(12, '0')}`;

/** Contas AWS fictícias de cada cliente (o filtro dos achados e, na T7.3, a tela de contas). */
export function demoCloudAccounts(now: Date = new Date()): Map<string, CloudAccount[]> {
  const [alfa, beta] = DEMO_TENANTS.map((tenant) => tenant.id);
  const account = (index: number, accountId: string, regions: string[]): CloudAccount =>
    cloudAccountSchema.parse({
      id: `018f2c1e-0000-7000-8000-0000000c${index.toString(16).padStart(4, '0')}`,
      provider: 'aws',
      accountId,
      regions,
      roleArn: readOnlyRoleArn(accountId),
      externalId: null,
      buckets: { cloudtrail: null, guardduty: null, waf: null },
      status: 'active',
      createdAt: new Date(now.getTime() - 40 * 86_400_000).toISOString(),
      updatedAt: new Date(now.getTime() - 10 * 86_400_000).toISOString(),
    });
  return new Map([
    [
      alfa ?? '',
      [
        account(1, DEMO_ACCOUNTS.alfaProducao, ['sa-east-1', 'us-east-1']),
        account(2, DEMO_ACCOUNTS.alfaHomologacao, ['sa-east-1']),
      ],
    ],
    [beta ?? '', [account(3, DEMO_ACCOUNTS.beta, ['sa-east-1'])]],
  ]);
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
 * Achados, contas e exceções do modo mock, com o mesmo contrato da API: filtros e paginação na lista, escopo do
 * cliente da sessão, permissão e CSRF nas escritas. O estado fica em memória, então a demonstração é interativa.
 */
export function createFindingHandlers(
  state: MockState,
  store: Map<string, FindingDetail[]> = demoFindings(),
  accounts: Map<string, CloudAccount[]> = demoCloudAccounts(),
) {
  const scoped = () => {
    if (!state.me) return { error: problem(401, 'Não autenticado') } as const;
    const tenantId = state.me.scopeTenantId;
    if (!tenantId) return { error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') } as const;
    return {
      me: state.me,
      findings: store.get(tenantId) ?? [],
      accounts: accounts.get(tenantId) ?? [],
    } as const;
  };
  const writeDenied = (request: Request, permission: Permission) => {
    if (!state.me?.permissions.includes(permission)) return problem(403, 'Sem permissão');
    if (request.headers.get('X-CSRF-Token') === null) return problem(403, 'CSRF', 'CSRF_INVALID');
    return null;
  };

  return [
    http.get(url('/v1/cloud-accounts'), () => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      return HttpResponse.json({
        items: scope.accounts,
        page: 1,
        pageSize: 100,
        total: scope.accounts.length,
      });
    }),

    http.get(url('/v1/findings'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const query = findingListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return problem(400, 'Filtro inválido');
      const { severity, status, accountId, period, page, pageSize } = query.data;
      const since = period ? Date.now() - PERIOD_HOURS[period] * 3_600_000 : null;
      const items = scope.findings.filter(
        (finding) =>
          (!severity || finding.severity === severity) &&
          (!status || finding.status === status) &&
          (!accountId || finding.accountId === accountId) &&
          (since === null || Date.parse(finding.occurredAt) >= since),
      );
      const start = (page - 1) * pageSize;
      return HttpResponse.json({
        items: items.slice(start, start + pageSize).map(summary),
        page,
        pageSize,
        total: items.length,
      });
    }),

    http.get(url('/v1/findings/:id'), ({ params }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const finding = scope.findings.find((candidate) => candidate.id === params['id']);
      return finding ? HttpResponse.json(finding) : problem(404, 'Achado não encontrado');
    }),

    http.patch(url('/v1/findings/:id/status'), async ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const denied = writeDenied(request, 'findings:triage');
      if (denied) return denied;
      const finding = scope.findings.find((candidate) => candidate.id === params['id']);
      if (!finding) return problem(404, 'Achado não encontrado');
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
      if (!finding) return problem(404, 'Achado não encontrado');
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

    http.post(url('/v1/alert-exceptions'), async ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const denied = writeDenied(request, 'alert_exceptions:write');
      if (denied) return denied;
      const body = alertExceptionCreateSchema.safeParse(await request.json());
      if (!body.success) return problem(400, 'Dados inválidos');
      const now = new Date().toISOString();
      return HttpResponse.json(
        alertExceptionSchema.parse({
          id: newId(),
          ...body.data,
          expiresAt: body.data.expiresAt ?? null,
          active: true,
          matchedCount: 0,
          lastMatchedAt: null,
          createdBy: { id: scope.me.userId, name: scope.me.email },
          createdAt: now,
          updatedAt: now,
        }),
        { status: 201 },
      );
    }),
  ];
}

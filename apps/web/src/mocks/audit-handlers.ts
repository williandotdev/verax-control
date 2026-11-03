import {
  type AuditEntry,
  type AuditEntryDetail,
  auditListQuerySchema,
  type AuditOutcome,
  type Role,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_ACCOUNTS, DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';

const url = (path: string): string => `${API_URL}${path}`;
const MINUTE = 60_000;
const PERIOD_HOURS = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 } as const;

const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

interface Person {
  id: string;
  name: string;
  role: Role;
}

/** Quem aparece na trilha fictícia: as mesmas pessoas da tela de Usuários, e a equipe da Verax. */
const PEOPLE = {
  verax: { id: 'demo-equipe-verax', name: 'Equipe Verax', role: 'admin_verax' },
  marina: { id: 'demo-marina.alves', name: 'Marina Alves', role: 'admin_cliente' },
  ana: { id: 'demo-ana.souza', name: 'Ana Souza', role: 'analista_cliente' },
  joao: { id: 'demo-joao.lima', name: 'João Lima', role: 'analista_cliente' },
  rafael: { id: 'demo-rafael.costa', name: 'Rafael Costa', role: 'admin_cliente' },
} as const satisfies Record<string, Person>;

interface MockAuditRecord {
  id: string;
  tenantId: string | null;
  occurredAt: string;
  actor: Person | 'anonymous';
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: AuditOutcome;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  before: AuditEntryDetail['before'];
  after: AuditEntryDetail['after'];
}

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0';
const VERAX_BROWSER = 'Mozilla/5.0 (X11; Linux x86_64) Firefox/145.0';

/** Trilha fictícia de cada cliente e da própria Verax, com horários relativos a agora. */
export function demoAuditTrail(now: Date = new Date()): MockAuditRecord[] {
  const [alfa = '', beta = ''] = DEMO_TENANTS.map((tenant) => tenant.id);
  let index = 0;
  const entry = (
    tenantId: string | null,
    minutesAgo: number,
    actor: Person | 'anonymous',
    action: string,
    details: Partial<Omit<MockAuditRecord, 'id' | 'tenantId' | 'occurredAt' | 'actor' | 'action'>> = {},
  ): MockAuditRecord => {
    index += 1;
    const verax = actor !== 'anonymous' && actor.role === 'admin_verax';
    return {
      id: `018f2c1e-0000-7000-8000-0000000d${index.toString(16).padStart(4, '0')}`,
      tenantId,
      occurredAt: new Date(now.getTime() - minutesAgo * MINUTE).toISOString(),
      actor,
      action,
      resourceType: null,
      resourceId: null,
      outcome: 'success',
      statusCode: 200,
      ip: verax ? '198.51.100.7' : '203.0.113.24',
      userAgent: verax ? VERAX_BROWSER : BROWSER,
      requestId: `req-demo-${index.toString().padStart(4, '0')}`,
      before: null,
      after: null,
      ...details,
    };
  };
  const day = 24 * 60;
  return [
    // Cliente Demo Alfa
    entry(alfa, 10, PEOPLE.ana, 'finding.status', {
      resourceType: 'finding',
      resourceId: '018f2c1e-0000-7000-8000-0000000f0001',
      before: { status: 'new' },
      after: { status: 'investigating' },
    }),
    entry(alfa, 25, PEOPLE.ana, 'finding.comment', {
      resourceType: 'finding',
      resourceId: '018f2c1e-0000-7000-8000-0000000f0001',
      statusCode: 201,
      after: { body: 'Confirmando com o time de infraestrutura se a mudança estava prevista.' },
    }),
    entry(alfa, 60, PEOPLE.verax, 'session.switch_tenant', {
      resourceType: 'tenant',
      resourceId: alfa,
      after: { activeTenantId: alfa },
    }),
    entry(alfa, 2 * 60, PEOPLE.marina, 'alert_exception.create', {
      resourceType: 'alert_exception',
      statusCode: 201,
      after: {
        ruleId: '80254',
        field: 'ip',
        value: '203.0.113.50',
        reason: 'Scanner de vulnerabilidade contratado, toda segunda de manhã',
      },
    }),
    entry(alfa, 3 * 60, PEOPLE.joao, 'POST /v1/cloud-accounts', {
      outcome: 'denied',
      statusCode: 403,
      ip: '203.0.113.31',
    }),
    entry(alfa, 5 * 60, PEOPLE.marina, 'auth.sign_in', {
      resourceType: 'login',
      resourceId: 'marina.alves@exemplo.com.br',
    }),
    entry(alfa, 5 * 60 + 1, PEOPLE.marina, 'auth.mfa_verify'),
    entry(alfa, day, PEOPLE.marina, 'user.invite', {
      resourceType: 'user',
      resourceId: 'demo-carlos.dev',
      statusCode: 201,
      after: { name: 'Carlos Dev', email: 'carlos.dev@exemplo.com.br', role: 'leitura' },
    }),
    entry(alfa, 2 * day, PEOPLE.verax, 'cloud_account.update', {
      resourceType: 'cloud_account',
      resourceId: DEMO_ACCOUNTS.alfaProducao,
      before: { regions: ['sa-east-1'] },
      after: { regions: ['sa-east-1', 'us-east-1'] },
    }),
    entry(alfa, 3 * day, PEOPLE.ana, 'auth.mfa_verify'),
    entry(alfa, 5 * day, PEOPLE.marina, 'protected_resource.create', {
      resourceType: 'protected_resource',
      statusCode: 201,
      after: { type: 's3_bucket', identifier: 'alfa-backups-prod', reason: 'Backups do banco de produção' },
    }),
    entry(alfa, 6 * day, PEOPLE.marina, 'cloud_account.create', {
      resourceType: 'cloud_account',
      outcome: 'failure',
      statusCode: 409,
    }),
    entry(alfa, 8 * day, PEOPLE.marina, 'user.deactivate', {
      resourceType: 'user',
      resourceId: 'demo-ex.funcionario',
      before: { status: 'active' },
      after: { status: 'disabled' },
    }),
    entry(alfa, 12 * day, PEOPLE.ana, 'auth.password_change'),
    entry(alfa, 20 * day, PEOPLE.verax, 'cloud_account.create', {
      resourceType: 'cloud_account',
      resourceId: DEMO_ACCOUNTS.alfaHomologacao,
      statusCode: 201,
      after: { accountId: DEMO_ACCOUNTS.alfaHomologacao, regions: ['sa-east-1'] },
    }),
    // Cliente Demo Beta
    entry(beta, 3 * 60, PEOPLE.rafael, 'auth.sign_in', {
      resourceType: 'login',
      resourceId: 'rafael.costa@exemplo.com.br',
    }),
    entry(beta, 4 * day, PEOPLE.rafael, 'incident.update', {
      resourceType: 'incident',
      before: { status: 'open', assigneeId: null },
      after: { status: 'investigating', assigneeId: PEOPLE.rafael.id },
    }),
    // Trilha da própria Verax (sem cliente)
    entry(null, 30, 'anonymous', 'auth.sign_in', {
      resourceType: 'login',
      resourceId: 'admin@exemplo.com',
      outcome: 'denied',
      statusCode: 401,
      ip: '192.0.2.44',
      userAgent: 'python-requests/2.32',
    }),
    entry(null, 31, 'anonymous', 'auth.sign_in', {
      resourceType: 'login',
      resourceId: 'admin@exemplo.com',
      outcome: 'denied',
      statusCode: 429,
      ip: '192.0.2.44',
      userAgent: 'python-requests/2.32',
    }),
    entry(null, 61, PEOPLE.verax, 'auth.sign_in', {
      resourceType: 'login',
      resourceId: 'equipe@veraxsistemas.com.br',
    }),
    entry(null, 3 * day, PEOPLE.verax, 'tenant.update', {
      resourceType: 'tenant',
      resourceId: beta,
      before: { contactEmail: 'ti@beta.exemplo.com.br' },
      after: { contactEmail: 'seguranca@beta.exemplo.com.br' },
    }),
    entry(null, 45 * day, PEOPLE.verax, 'tenant.create', {
      resourceType: 'tenant',
      resourceId: beta,
      statusCode: 201,
      after: { name: 'Cliente Demo Beta' },
    }),
  ];
}

/** O registro como a API devolve para quem lê: o cliente não vê o IP nem o navegador da equipe da Verax. */
function project(record: MockAuditRecord, viewerRole: Role): AuditEntryDetail {
  const person = record.actor === 'anonymous' ? null : record.actor;
  const verax = person?.role === 'admin_verax';
  const hidden = verax && viewerRole !== 'admin_verax';
  return {
    id: record.id,
    occurredAt: record.occurredAt,
    actor: {
      type: person ? 'user' : 'anonymous',
      id: person?.id ?? null,
      name: person?.name ?? null,
      verax,
    },
    action: record.action,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    outcome: record.outcome,
    statusCode: record.statusCode,
    ip: hidden ? null : record.ip,
    requestId: record.requestId,
    userAgent: hidden ? null : record.userAgent,
    before: record.before,
    after: record.after,
  };
}

const toEntry = ({ userAgent: _userAgent, before: _before, after: _after, ...entry }: AuditEntryDetail) =>
  entry satisfies AuditEntry;

/** Auditoria do modo mock, com o mesmo contrato e o mesmo escopo da API. */
export function createAuditHandlers(state: MockState, trail: MockAuditRecord[] = demoAuditTrail()) {
  /** A trilha que a sessão alcança: a do cliente da sessão, ou a da Verax para o admin_verax sem cliente. */
  const visible = () => {
    const me = state.me;
    if (!me) return { error: problem(401, 'Não autenticado') } as const;
    if (!me.permissions.includes('audit:read')) return { error: problem(403, 'Sem permissão') } as const;
    const tenantId = me.role === 'admin_verax' && me.scopeTenantId === null ? null : me.scopeTenantId;
    return { role: me.role, records: trail.filter((record) => record.tenantId === tenantId) } as const;
  };

  return [
    http.get(url('/v1/audit'), ({ request }) => {
      const scope = visible();
      if ('error' in scope) return scope.error;
      const query = auditListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return problem(400, 'Filtro inválido');
      const { page, pageSize, outcome, resourceType, actorId, period } = query.data;
      const from = period ? new Date(Date.now() - PERIOD_HOURS[period] * 3_600_000).toISOString() : null;
      const items = scope.records
        .filter(
          (record) =>
            (!outcome || record.outcome === outcome) &&
            (!resourceType || record.resourceType === resourceType) &&
            (!actorId || (record.actor !== 'anonymous' && record.actor.id === actorId)) &&
            (!from || record.occurredAt >= from),
        )
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
      return HttpResponse.json({
        items: items
          .slice((page - 1) * pageSize, page * pageSize)
          .map((record) => toEntry(project(record, scope.role))),
        page,
        pageSize,
        total: items.length,
      });
    }),
    http.get(url('/v1/audit/:id'), ({ params }) => {
      const scope = visible();
      if ('error' in scope) return scope.error;
      const record = scope.records.find((item) => item.id === params['id']);
      if (!record) return problem(404, 'Registro de auditoria não encontrado');
      return HttpResponse.json(project(record, scope.role));
    }),
  ];
}

import {
  type AlertException,
  alertExceptionCreateSchema,
  alertExceptionListQuerySchema,
  alertExceptionSchema,
  alertExceptionUpdateSchema,
  type CloudAccount,
  cloudAccountCreateSchema,
  cloudAccountListQuerySchema,
  cloudAccountSchema,
  cloudAccountUpdateSchema,
  fieldsOutsideProvider,
  type Me,
  type Permission,
  type ProtectedResource,
  protectedResourceCreateSchema,
  protectedResourceListQuerySchema,
  protectedResourceSchema,
  protectedResourceUpdateSchema,
  readOnlyRoleArn,
  type Tenant,
  tenantCreateSchema,
  tenantListQuerySchema,
  tenantSchema,
  tenantUpdateSchema,
  type User,
  userInviteSchema,
  userListQuerySchema,
  userSchema,
  userUpdateSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_ACCOUNTS, DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';

/**
 * Cadastros do modo mock (E3), num estado só: clientes, usuários, contas cloud, lista de proteção e exceções. As
 * outras telas usam o mesmo estado: a conta cadastrada vira filtro dos achados, e a exceção criada a partir de um
 * achado aparece na tela de Exceções.
 */
export interface AdminStore {
  tenants: Tenant[];
  users: Map<string, User[]>;
  accounts: Map<string, CloudAccount[]>;
  protectedResources: Map<string, ProtectedResource[]>;
  exceptions: Map<string, AlertException[]>;
}

const VERAX = { id: 'demo-equipe-verax', name: 'Equipe Verax' };
const ANA = { id: 'demo-ana', name: 'Ana Souza' };

export function demoAdminStore(now: Date = new Date()): AdminStore {
  const at = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
  const [alfa = '', beta = '', inativo = ''] = DEMO_TENANTS.map((tenant) => tenant.id);
  const tenant = (
    id: string,
    name: string,
    status: Tenant['status'],
    cnpj: string,
    plan: string,
    contact: string,
  ) =>
    tenantSchema.parse({
      id,
      name,
      status,
      cnpj,
      plan,
      escalationContact: {
        name: contact,
        email: `${contact.split(' ')[0]?.toLowerCase()}@exemplo.com.br`,
        phone: '+55 11 4000-0000',
      },
      createdAt: at(120),
      updatedAt: at(10),
    });
  const user = (
    id: string,
    name: string,
    role: User['role'],
    status: User['status'],
    mfaEnabled: boolean,
    days: number,
  ) =>
    userSchema.parse({
      id,
      name,
      email: `${id.replace('demo-', '')}@exemplo.com.br`,
      role,
      status,
      mfaEnabled,
      createdAt: at(days),
    });
  const account = (
    index: number,
    accountId: string,
    regions: string[],
    connection: CloudAccount['connection'],
    lastEventMinutes: number | null,
    other:
      | { provider: 'gcp'; pubsubSubscription: string }
      | { provider: 'cloudflare'; zones: string[] }
      | null = null,
  ) =>
    cloudAccountSchema.parse({
      id: `018f2c1e-0000-7000-8000-0000000c${index.toString(16).padStart(4, '0')}`,
      provider: other?.provider ?? 'aws',
      accountId,
      regions: other ? [] : regions,
      roleArn: other ? null : readOnlyRoleArn(accountId),
      externalId: other ? null : `vx-${accountId}-0f3c9a1e7b2d4c6e8a0b1c2d3e4f5a6b`,
      buckets: { cloudtrail: null, guardduty: null, waf: null },
      pubsubSubscription: other?.provider === 'gcp' ? other.pubsubSubscription : null,
      zones: other?.provider === 'cloudflare' ? other.zones : [],
      status: 'active',
      connection,
      lastEventAt:
        lastEventMinutes === null ? null : new Date(now.getTime() - lastEventMinutes * 60_000).toISOString(),
      createdAt: at(40),
      updatedAt: at(10),
    });
  const protectedItem = (id: string, type: ProtectedResource['type'], identifier: string, reason: string) =>
    protectedResourceSchema.parse({
      id,
      type,
      identifier,
      reason,
      createdBy: VERAX,
      createdAt: at(30),
      updatedAt: at(30),
    });
  const exception = (
    id: string,
    ruleId: string,
    field: AlertException['field'],
    value: string,
    reason: string,
    expiresInDays: number | null,
    matchedCount: number,
  ) =>
    alertExceptionSchema.parse({
      id,
      ruleId,
      field,
      value,
      reason,
      expiresAt:
        expiresInDays === null ? null : new Date(now.getTime() + expiresInDays * 86_400_000).toISOString(),
      active: expiresInDays === null || expiresInDays > 0,
      matchedCount,
      lastMatchedAt: matchedCount > 0 ? at(0.1) : null,
      createdBy: ANA,
      createdAt: at(20),
      updatedAt: at(20),
    });

  return {
    tenants: [
      tenant(
        alfa,
        'Cliente Demo Alfa',
        'active',
        '12.ABC.345/01DE-35',
        'Monitoramento completo',
        'Marina Alves',
      ),
      tenant(beta, 'Cliente Demo Beta', 'active', '11.222.333/0001-81', 'Postura e alertas', 'Rafael Costa'),
      tenant(
        inativo,
        'Cliente Demo Inativo',
        'inactive',
        '45.997.418/0001-53',
        'Monitoramento completo',
        'Paula Reis',
      ),
    ],
    users: new Map([
      [
        alfa,
        [
          user('demo-marina.alves', 'Marina Alves', 'admin_cliente', 'active', true, 100),
          user('demo-ana.souza', 'Ana Souza', 'analista_cliente', 'active', true, 90),
          user('demo-joao.lima', 'João Lima', 'analista_cliente', 'active', true, 60),
          user('demo-diretoria', 'Diretoria', 'leitura', 'active', true, 50),
          user('demo-carlos.dev', 'Carlos Dev', 'leitura', 'invited', false, 1),
          user('demo-ex.funcionario', 'Ex-funcionário', 'analista_cliente', 'disabled', true, 200),
        ],
      ],
      [beta, [user('demo-rafael.costa', 'Rafael Costa', 'admin_cliente', 'active', true, 80)]],
    ]),
    accounts: new Map([
      [
        alfa,
        [
          account(1, DEMO_ACCOUNTS.alfaProducao, ['sa-east-1', 'us-east-1'], 'ok', 3),
          account(2, DEMO_ACCOUNTS.alfaHomologacao, ['sa-east-1'], 'ok', 30 * 60),
          account(4, DEMO_ACCOUNTS.alfaGcp, [], 'ok', 12, {
            provider: 'gcp',
            pubsubSubscription: 'verax-logs-seguranca',
          }),
          account(5, DEMO_ACCOUNTS.alfaCloudflare, [], 'pending', null, {
            provider: 'cloudflare',
            zones: ['loja-alfa.example'],
          }),
        ],
      ],
      [beta, [account(3, DEMO_ACCOUNTS.beta, ['sa-east-1'], 'ok', 1)]],
    ]),
    protectedResources: new Map([
      [
        alfa,
        [
          protectedItem(
            '018f2c1e-0000-7000-8000-0000000d0001',
            'aws_account',
            DEMO_ACCOUNTS.alfaProducao,
            'Conta de produção: qualquer alerta nela sobe de prioridade.',
          ),
          protectedItem(
            '018f2c1e-0000-7000-8000-0000000d0002',
            'iam_user',
            'admin-financeiro',
            'Acesso ao sistema financeiro.',
          ),
          protectedItem(
            '018f2c1e-0000-7000-8000-0000000d0003',
            's3_bucket',
            'loja-exemplo-backups',
            'Backups do banco de clientes.',
          ),
        ],
      ],
      [beta, []],
    ]),
    exceptions: new Map([
      [
        alfa,
        [
          exception(
            '018f2c1e-0000-7000-8000-0000000e0001',
            '80270',
            'resource',
            'loja-exemplo-imagens',
            'Leitura pública do CDN, combinada com a infraestrutura.',
            null,
            12,
          ),
          exception(
            '018f2c1e-0000-7000-8000-0000000e0002',
            '80202',
            'user',
            'relatorios-app',
            'Job noturno de relatórios tenta listar buckets de outra conta; correção agendada.',
            30,
            48,
          ),
          exception(
            '018f2c1e-0000-7000-8000-0000000e0003',
            '80250',
            'ip',
            '203.0.113.0/24',
            'Escritório: logins com falha durante a troca de senha anual.',
            -5,
            7,
          ),
        ],
      ],
      [beta, []],
    ]),
  };
}

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

let sequence = 0;
const newId = (): string =>
  `018f2c1e-0000-7000-8000-${(0xa00000 + (sequence += 1)).toString(16).padStart(12, '0')}`;

const paginate = <T>(items: T[], page: number, pageSize: number) => {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length };
};
const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);
const author = (me: Me) => ({ id: me.userId, name: me.email });

type Denied = { ok: false; error: Response };
type Allowed = { ok: true; me: Me };
type Scoped = { ok: true; me: Me; tenantId: string };

export function createAdminHandlers(state: MockState, store: AdminStore) {
  /** Permissão de leitura ou escrita (com CSRF) e, quando pedido, o cliente da sessão. */
  const guard = (permission: Permission, request?: Request): Denied | Allowed => {
    if (!state.me) return { ok: false, error: problem(401, 'Não autenticado') };
    if (!state.me.permissions.includes(permission))
      return { ok: false, error: problem(403, 'Sem permissão') };
    if (request && request.method !== 'GET' && request.headers.get('X-CSRF-Token') === null) {
      return { ok: false, error: problem(403, 'CSRF', 'CSRF_INVALID') };
    }
    return { ok: true, me: state.me };
  };
  const scoped = (permission: Permission, request?: Request): Denied | Scoped => {
    const check = guard(permission, request);
    if (!check.ok) return check;
    const tenantId = check.me.scopeTenantId;
    if (!tenantId) return { ok: false, error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') };
    return { ok: true, me: check.me, tenantId };
  };
  const listOf = <T>(map: Map<string, T[]>, tenantId: string): T[] => {
    if (!map.has(tenantId)) map.set(tenantId, []);
    return map.get(tenantId) as T[];
  };
  const body = async (request: Request): Promise<unknown> => request.json().catch(() => undefined);

  return [
    // --- Clientes (T3.1): só admin_verax ---
    http.get(url('/v1/tenants'), ({ request }) => {
      const check = guard('tenants:read');
      if (!check.ok) return check.error;
      const query = tenantListQuerySchema.safeParse(queryOf(request));
      if (!query.success) return problem(400, 'Filtro inválido');
      const items = store.tenants
        .filter((tenant) => !query.data.status || tenant.status === query.data.status)
        .map(({ id, name, status }) => ({ id, name, status }));
      return HttpResponse.json(paginate(items, query.data.page, query.data.pageSize));
    }),
    http.get(url('/v1/tenants/:id'), ({ params }) => {
      const check = guard('tenants:read');
      if (!check.ok) return check.error;
      const tenant = store.tenants.find((candidate) => candidate.id === params['id']);
      return tenant ? HttpResponse.json(tenant) : problem(404, 'Cliente não encontrado');
    }),
    http.post(url('/v1/tenants'), async ({ request }) => {
      const check = guard('tenants:write', request);
      if (!check.ok) return check.error;
      const input = tenantCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      if (store.tenants.some((tenant) => tenant.cnpj === input.data.cnpj))
        return problem(409, 'CNPJ já cadastrado');
      const now = new Date().toISOString();
      const tenant = tenantSchema.parse({
        id: newId(),
        ...input.data,
        escalationContact: {
          ...input.data.escalationContact,
          phone: input.data.escalationContact.phone ?? null,
        },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      store.tenants.push(tenant);
      return HttpResponse.json(tenant, { status: 201 });
    }),
    http.patch(url('/v1/tenants/:id'), async ({ params, request }) => {
      const check = guard('tenants:write', request);
      if (!check.ok) return check.error;
      const tenant = store.tenants.find((candidate) => candidate.id === params['id']);
      if (!tenant) return problem(404, 'Cliente não encontrado');
      const input = tenantUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const { escalationContact, ...rest } = input.data;
      Object.assign(tenant, rest, {
        ...(escalationContact
          ? { escalationContact: { ...escalationContact, phone: escalationContact.phone ?? null } }
          : {}),
        updatedAt: new Date().toISOString(),
      });
      return HttpResponse.json(tenant);
    }),

    // --- Usuários do cliente (T3.2) ---
    http.get(url('/v1/users'), ({ request }) => {
      const scope = scoped('users:read');
      if (!scope.ok) return scope.error;
      const query = userListQuerySchema.safeParse(queryOf(request));
      if (!query.success) return problem(400, 'Filtro inválido');
      const items = listOf(store.users, scope.tenantId).filter(
        (user) => !query.data.status || user.status === query.data.status,
      );
      return HttpResponse.json(paginate(items, query.data.page, query.data.pageSize));
    }),
    http.post(url('/v1/users'), async ({ request }) => {
      const scope = scoped('users:write', request);
      if (!scope.ok) return scope.error;
      const input = userInviteSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const users = listOf(store.users, scope.tenantId);
      if (users.some((user) => user.email === input.data.email)) return problem(409, 'E-mail já cadastrado');
      const user = userSchema.parse({
        id: `demo-${input.data.email}`,
        ...input.data,
        status: 'invited',
        mfaEnabled: false,
        createdAt: new Date().toISOString(),
      });
      users.push(user);
      return HttpResponse.json(user, { status: 201 });
    }),
    http.patch(url('/v1/users/:id'), async ({ params, request }) => {
      const scope = scoped('users:write', request);
      if (!scope.ok) return scope.error;
      const user = listOf(store.users, scope.tenantId).find((candidate) => candidate.id === params['id']);
      if (!user) return problem(404, 'Usuário não encontrado');
      if (user.id === scope.me.userId) return problem(403, 'Ninguém altera o próprio acesso');
      const input = userUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      Object.assign(user, input.data);
      return HttpResponse.json(user);
    }),
    http.post(url('/v1/users/:id/invitation'), ({ params, request }) => {
      const scope = scoped('users:write', request);
      if (!scope.ok) return scope.error;
      const user = listOf(store.users, scope.tenantId).find((candidate) => candidate.id === params['id']);
      if (!user || user.status !== 'invited') return problem(404, 'Convite não encontrado');
      return new HttpResponse(null, { status: 204 });
    }),

    // --- Contas cloud (T3.3) ---
    http.get(url('/v1/cloud-accounts'), ({ request }) => {
      const scope = scoped('cloud_accounts:read');
      if (!scope.ok) return scope.error;
      const query = cloudAccountListQuerySchema.safeParse(queryOf(request));
      if (!query.success) return problem(400, 'Filtro inválido');
      const canSeeExternalId = scope.me.permissions.includes('cloud_accounts:write');
      const items = listOf(store.accounts, scope.tenantId)
        .filter((account) => !query.data.status || account.status === query.data.status)
        .map((account) => ({ ...account, externalId: canSeeExternalId ? account.externalId : null }));
      return HttpResponse.json(paginate(items, query.data.page, query.data.pageSize));
    }),
    http.post(url('/v1/cloud-accounts'), async ({ request }) => {
      const scope = scoped('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const input = cloudAccountCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const all = [...store.accounts.values()].flat();
      if (
        all.some(
          (account) => account.provider === input.data.provider && account.accountId === input.data.accountId,
        )
      ) {
        return problem(409, 'Esta conta já está cadastrada');
      }
      const data = input.data;
      const now = new Date().toISOString();
      const random = Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const account = cloudAccountSchema.parse({
        id: newId(),
        provider: data.provider,
        accountId: data.accountId,
        regions: data.provider === 'aws' ? data.regions : [],
        roleArn: data.provider === 'aws' ? readOnlyRoleArn(data.accountId) : null,
        externalId: data.provider === 'aws' ? `vx-${random}` : null,
        buckets: { cloudtrail: null, guardduty: null, waf: null },
        pubsubSubscription: data.provider === 'gcp' ? (data.pubsubSubscription ?? null) : null,
        zones: data.provider === 'cloudflare' ? (data.zones ?? []) : [],
        status: 'active',
        connection: 'pending',
        lastEventAt: null,
        createdAt: now,
        updatedAt: now,
      });
      listOf(store.accounts, scope.tenantId).push(account);
      return HttpResponse.json(account, { status: 201 });
    }),
    http.patch(url('/v1/cloud-accounts/:id'), async ({ params, request }) => {
      const scope = scoped('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const account = listOf(store.accounts, scope.tenantId).find(
        (candidate) => candidate.id === params['id'],
      );
      if (!account) return problem(404, 'Conta não encontrada');
      const input = cloudAccountUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const foreign = fieldsOutsideProvider(account.provider, input.data);
      if (foreign.length > 0) return problem(400, `Campo que não existe nesta conta: ${foreign.join(', ')}`);
      const { buckets: _buckets, ...rest } = input.data;
      Object.assign(account, rest, { updatedAt: new Date().toISOString() });
      return HttpResponse.json(account);
    }),

    // --- Lista de proteção (T3.4) ---
    http.get(url('/v1/protected-resources'), ({ request }) => {
      const scope = scoped('protected_resources:read');
      if (!scope.ok) return scope.error;
      const query = protectedResourceListQuerySchema.safeParse(queryOf(request));
      if (!query.success) return problem(400, 'Filtro inválido');
      return HttpResponse.json(
        paginate(listOf(store.protectedResources, scope.tenantId), query.data.page, query.data.pageSize),
      );
    }),
    http.post(url('/v1/protected-resources'), async ({ request }) => {
      const scope = scoped('protected_resources:write', request);
      if (!scope.ok) return scope.error;
      const input = protectedResourceCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const items = listOf(store.protectedResources, scope.tenantId);
      if (items.some((item) => item.type === input.data.type && item.identifier === input.data.identifier)) {
        return problem(409, 'Este item já está na lista');
      }
      const item = protectedResourceSchema.parse({
        id: newId(),
        ...input.data,
        createdBy: author(scope.me),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      items.push(item);
      return HttpResponse.json(item, { status: 201 });
    }),
    http.patch(url('/v1/protected-resources/:id'), async ({ params, request }) => {
      const scope = scoped('protected_resources:write', request);
      if (!scope.ok) return scope.error;
      const item = listOf(store.protectedResources, scope.tenantId).find(
        (candidate) => candidate.id === params['id'],
      );
      if (!item) return problem(404, 'Item não encontrado');
      const input = protectedResourceUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      item.reason = input.data.reason;
      item.updatedAt = new Date().toISOString();
      return HttpResponse.json(item);
    }),
    http.delete(url('/v1/protected-resources/:id'), ({ params, request }) => {
      const scope = scoped('protected_resources:write', request);
      if (!scope.ok) return scope.error;
      const items = listOf(store.protectedResources, scope.tenantId);
      const index = items.findIndex((candidate) => candidate.id === params['id']);
      if (index < 0) return problem(404, 'Item não encontrado');
      items.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),

    // --- Exceções (T3.5) ---
    http.get(url('/v1/alert-exceptions'), ({ request }) => {
      const scope = scoped('alert_exceptions:read');
      if (!scope.ok) return scope.error;
      const query = alertExceptionListQuerySchema.safeParse(queryOf(request));
      if (!query.success) return problem(400, 'Filtro inválido');
      const items = listOf(store.exceptions, scope.tenantId).filter(
        (item) =>
          (!query.data.ruleId || item.ruleId === query.data.ruleId) &&
          (!query.data.active || String(item.active) === query.data.active),
      );
      return HttpResponse.json(paginate(items, query.data.page, query.data.pageSize));
    }),
    http.post(url('/v1/alert-exceptions'), async ({ request }) => {
      const scope = scoped('alert_exceptions:write', request);
      if (!scope.ok) return scope.error;
      const input = alertExceptionCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const now = new Date().toISOString();
      const item = alertExceptionSchema.parse({
        id: newId(),
        ...input.data,
        expiresAt: input.data.expiresAt ?? null,
        active: true,
        matchedCount: 0,
        lastMatchedAt: null,
        createdBy: author(scope.me),
        createdAt: now,
        updatedAt: now,
      });
      listOf(store.exceptions, scope.tenantId).push(item);
      return HttpResponse.json(item, { status: 201 });
    }),
    http.patch(url('/v1/alert-exceptions/:id'), async ({ params, request }) => {
      const scope = scoped('alert_exceptions:write', request);
      if (!scope.ok) return scope.error;
      const item = listOf(store.exceptions, scope.tenantId).find(
        (candidate) => candidate.id === params['id'],
      );
      if (!item) return problem(404, 'Exceção não encontrada');
      const input = alertExceptionUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      if (input.data.reason !== undefined) item.reason = input.data.reason;
      if (input.data.expiresAt !== undefined) {
        item.expiresAt = input.data.expiresAt;
        item.active = input.data.expiresAt === null || Date.parse(input.data.expiresAt) > Date.now();
      }
      item.updatedAt = new Date().toISOString();
      return HttpResponse.json(item);
    }),
    http.delete(url('/v1/alert-exceptions/:id'), ({ params, request }) => {
      const scope = scoped('alert_exceptions:write', request);
      if (!scope.ok) return scope.error;
      const items = listOf(store.exceptions, scope.tenantId);
      const index = items.findIndex((candidate) => candidate.id === params['id']);
      if (index < 0) return problem(404, 'Exceção não encontrada');
      items.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

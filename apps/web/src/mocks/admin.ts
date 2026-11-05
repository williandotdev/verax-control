import {
  type AlertException,
  alertExceptionCreateSchema,
  alertExceptionListQuerySchema,
  alertExceptionSchema,
  alertExceptionUpdateSchema,
  AWS_READER_AUDIENCE,
  awsReaderRoleArn,
  type CloudAccount,
  cloudAccountCreateSchema,
  cloudAccountListQuerySchema,
  cloudAccountSchema,
  cloudAccountUpdateSchema,
  cloudCredentialInputSchema,
  CREDENTIAL_KIND_PROVIDERS,
  credentialStatus,
  fieldsOutsideProvider,
  type LogBuckets,
  logBucketNames,
  type Me,
  mergeLogBuckets,
  type Permission,
  type ProtectedResource,
  protectedResourceCreateSchema,
  protectedResourceListQuerySchema,
  protectedResourceSchema,
  protectedResourceUpdateSchema,
  sameLogBucketNames,
  TEMPORARY_PASSWORD_HOURS,
  type Tenant,
  tenantCreatedSchema,
  tenantCreateSchema,
  tenantListQuerySchema,
  tenantSchema,
  tenantUpdateSchema,
  type TemporaryPassword,
  temporaryPasswordSchema,
  type User,
  userCreatedSchema,
  userCreateSchema,
  userListQuerySchema,
  userSchema,
  userUpdateSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import {
  DEMO_ACCOUNTS,
  DEMO_ALFA_MORE_BUCKETS,
  DEMO_AWS_CHECK_DELAY_MS,
  DEMO_CLOUDFLARE_TOKEN_SUFFIX,
  DEMO_EGRESS_IPS,
  DEMO_NODE_SERVICE_ACCOUNT_ID,
  DEMO_SINK_TOPIC_PREFIX,
  DEMO_TENANTS,
} from './fixtures';
import type { MockState } from './handlers';
import { demoPlanRefusal } from './plan-handlers';

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
    mustChangePassword = false,
  ) =>
    userSchema.parse({
      id,
      name,
      email: `${id.replace('demo-', '')}@exemplo.com.br`,
      role,
      status,
      mfaEnabled,
      mustChangePassword,
      createdAt: at(days),
    });
  const minutesBefore = (minutes: number | null) =>
    minutes === null ? null : new Date(now.getTime() - minutes * 60_000).toISOString();
  const account = (
    index: number,
    accountId: string,
    regions: string[],
    /** Estado da coleta e há quantos minutos foi a última coleta bem-sucedida. */
    collection: {
      connection: CloudAccount['connection'];
      collectedMinutes: number | null;
      error?: string;
    },
    lastEventMinutes: number | null,
    other:
      | { provider: 'gcp'; pubsubSubscription: string; sinkWriterIdentity: string }
      | { provider: 'cloudflare'; zones: string[]; tokenExpiresInDays: number | null }
      | null = null,
    /** AWS: os buckets do GuardDuty e do WAF, além da trilha (`trilha-<conta>`, que toda conta AWS da demonstração tem). */
    moreBuckets: { guardduty?: string; waf?: string } = {},
  ) => {
    const cloudflare = other?.provider === 'cloudflare' ? other : null;
    const tokenExpiresAt =
      cloudflare?.tokenExpiresInDays != null
        ? new Date(now.getTime() + cloudflare.tokenExpiresInDays * 86_400_000).toISOString()
        : null;
    return cloudAccountSchema.parse({
      id: `018f2c1e-0000-7000-8000-0000000c${index.toString(16).padStart(4, '0')}`,
      provider: other?.provider ?? 'aws',
      accountId,
      regions: other ? [] : regions,
      // AWS: o papel de leitura sem chave, derivado do ID, e os três valores do nó para a pilha.
      readerRoleArn: other ? null : awsReaderRoleArn(accountId),
      nodeServiceAccountId: other ? null : DEMO_NODE_SERVICE_ACCOUNT_ID,
      webIdentityAudience: other ? null : AWS_READER_AUDIENCE,
      buckets: other
        ? { cloudtrail: null, guardduty: null, waf: null }
        : {
            cloudtrail: `trilha-${accountId}`,
            guardduty: moreBuckets.guardduty ?? null,
            waf: moreBuckets.waf ?? null,
          },
      pubsubSubscription: other?.provider === 'gcp' ? other.pubsubSubscription : null,
      sinkTopic: other?.provider === 'gcp' ? `${DEMO_SINK_TOPIC_PREFIX}${accountId}` : null,
      sinkWriterIdentity: other?.provider === 'gcp' ? other.sinkWriterIdentity : null,
      zones: cloudflare ? cloudflare.zones : [],
      // O token guardado no cofre: só os metadados, como a API devolve.
      keyStatus: cloudflare
        ? {
            kind: 'cloudflare_api_token',
            keyIdSuffix: DEMO_CLOUDFLARE_TOKEN_SUFFIX,
            issuedAt: null,
            expiresAt: tokenExpiresAt,
            verifiedAt: at(0.05),
            status: credentialStatus(tokenExpiresAt, now),
          }
        : null,
      egressIps: other?.provider === 'gcp' ? [] : DEMO_EGRESS_IPS,
      status: 'active',
      connection: collection.connection,
      connectionError: collection.error ?? null,
      checkRequestedAt: null,
      // A conta AWS conectada lê os logs desde o dia anterior à primeira verificação.
      ingestFrom: !other && collection.connection === 'connected' ? at(41).slice(0, 10) : null,
      lastCollectedAt: minutesBefore(collection.collectedMinutes),
      lastEventAt: minutesBefore(lastEventMinutes),
      createdAt: at(40),
      updatedAt: at(10),
    });
  };
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
          // Criado ontem, com a senha temporária: ainda não entrou.
          user('demo-carlos.dev', 'Carlos Dev', 'leitura', 'active', false, 1, true),
          user('demo-ex.funcionario', 'Ex-funcionário', 'analista_cliente', 'disabled', true, 200),
        ],
      ],
      [beta, [user('demo-rafael.costa', 'Rafael Costa', 'admin_cliente', 'active', true, 80)]],
    ]),
    accounts: new Map([
      [
        alfa,
        [
          // A produção lê as três fontes: a trilha, o export do GuardDuty e o log do WAF.
          account(
            1,
            DEMO_ACCOUNTS.alfaProducao,
            ['sa-east-1', 'us-east-1'],
            { connection: 'connected', collectedMinutes: 1 },
            3,
            null,
            DEMO_ALFA_MORE_BUCKETS,
          ),
          // A homologação perdeu o acesso há 30 horas (a AWS recusou a entrada no papel): é a conta silenciosa da
          // Torre. Verificada de novo na demonstração, continua recusada.
          account(
            2,
            DEMO_ACCOUNTS.alfaHomologacao,
            ['sa-east-1'],
            { connection: 'error', collectedMinutes: 30 * 60, error: 'trust_denied' },
            30 * 60,
          ),
          // Projeto de cliente: o sink que ele criou publica no tópico do nó, e o nó lê a assinatura do projeto do nó.
          account(4, DEMO_ACCOUNTS.alfaGcp, [], { connection: 'connected', collectedMinutes: 1 }, 12, {
            provider: 'gcp',
            pubsubSubscription: `${DEMO_SINK_TOPIC_PREFIX.replace('/topics/', '/subscriptions/')}${DEMO_ACCOUNTS.alfaGcp}`,
            sinkWriterIdentity: 'serviceAccount:service-123456789012@gcp-sa-logging.iam.gserviceaccount.com',
          }),
          account(
            5,
            DEMO_ACCOUNTS.alfaCloudflare,
            [],
            { connection: 'waiting', collectedMinutes: null },
            null,
            // O token vence em 9 dias: o cartão mostra o aviso de troca.
            {
              provider: 'cloudflare',
              zones: ['loja-alfa.example'],
              tokenExpiresInDays: 9,
            },
          ),
        ],
      ],
      [
        beta,
        [account(3, DEMO_ACCOUNTS.beta, ['sa-east-1'], { connection: 'connected', collectedMinutes: 1 }, 1)],
      ],
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

const NO_BUCKETS: LogBuckets = { cloudtrail: null, guardduty: null, waf: null };

/**
 * Como a API (`assertOriginsFree`): um bucket de log é de um cliente só, em qualquer fonte. Devolve o primeiro dos
 * buckets informados que já está numa conta de outro cliente.
 */
function bucketOfAnotherTenant(store: AdminStore, tenantId: string, buckets: LogBuckets): string | null {
  const names = logBucketNames(buckets);
  for (const [owner, accounts] of store.accounts) {
    if (owner === tenantId) continue;
    for (const account of accounts) {
      const taken = names.find((name) => logBucketNames(account.buckets).includes(name));
      if (taken) return taken;
    }
  }
  return null;
}

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

let sequence = 0;
const newId = (): string =>
  `018f2c1e-0000-7000-8000-${(0xa00000 + (sequence += 1)).toString(16).padStart(12, '0')}`;

/** Sem os caracteres que se confundem ao ler ou ditar (0/O, 1/l/I), como a senha temporária da API. */
const TEMPORARY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Senha temporária fictícia, sorteada a cada pedido: quatro grupos de cinco, no formato da API. */
function demoTemporaryPassword(now: Date = new Date()): TemporaryPassword {
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) =>
    TEMPORARY_ALPHABET.charAt(byte % TEMPORARY_ALPHABET.length),
  ).join('');
  return temporaryPasswordSchema.parse({
    temporaryPassword: chars.replace(/(.{5})(?=.)/g, '$1-'),
    expiresAt: new Date(now.getTime() + TEMPORARY_PASSWORD_HOURS * 3_600_000).toISOString(),
  });
}

const paginate = <T>(items: T[], page: number, pageSize: number) => {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length };
};
const queryOf = (request: Request) => Object.fromEntries(new URL(request.url).searchParams);
const author = (me: Me) => ({ id: me.userId, name: me.email });

type Denied = { ok: false; error: Response };
type Allowed = { ok: true; me: Me };
type Scoped = { ok: true; me: Me; tenantId: string };

/**
 * O "worker" da demonstração: responde o "Verificar" pendente há mais de `DEMO_AWS_CHECK_DELAY_MS`. A homologação da
 * demonstração continua recusada (`trust_denied`); qualquer outra conta conecta e ganha o dia de início da coleta (o
 * anterior), uma vez só, como a tarefa `aws-check`.
 */
function answerAwsCheck(account: CloudAccount, now: Date = new Date()): void {
  if (account.checkRequestedAt === null) return;
  if (now.getTime() - Date.parse(account.checkRequestedAt) < DEMO_AWS_CHECK_DELAY_MS) return;
  const refused = account.accountId === DEMO_ACCOUNTS.alfaHomologacao;
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
  Object.assign(account, {
    checkRequestedAt: null,
    connection: refused ? 'error' : 'connected',
    connectionError: refused ? 'trust_denied' : null,
    ingestFrom: refused ? account.ingestFrom : (account.ingestFrom ?? yesterday),
    updatedAt: now.toISOString(),
  });
}

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
    // O cliente nasce com o primeiro administrador (`admin_cliente`), com a senha temporária só nesta resposta.
    http.post(url('/v1/tenants'), async ({ request }) => {
      const check = guard('tenants:write', request);
      if (!check.ok) return check.error;
      const input = tenantCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      if (store.tenants.some((tenant) => tenant.cnpj === input.data.cnpj))
        return problem(409, 'CNPJ já cadastrado');
      const { firstAdmin, ...fields } = input.data;
      const email = firstAdmin.email.trim().toLowerCase();
      // Como na API: e-mail já usado em qualquer cliente recusa o cadastro inteiro, sem dizer de quem é.
      if ([...store.users.values()].flat().some((user) => user.email === email))
        return problem(409, 'Já existe um usuário com este e-mail');
      const now = new Date().toISOString();
      const tenant = tenantSchema.parse({
        id: newId(),
        ...fields,
        escalationContact: { ...fields.escalationContact, phone: fields.escalationContact.phone ?? null },
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      const admin = userSchema.parse({
        id: `demo-${email}`,
        name: firstAdmin.name,
        email,
        role: 'admin_cliente',
        status: 'active',
        mfaEnabled: false,
        mustChangePassword: true,
        createdAt: now,
      });
      store.tenants.push(tenant);
      store.users.set(tenant.id, [admin]);
      return HttpResponse.json(
        tenantCreatedSchema.parse({
          tenant,
          firstAdmin: { id: admin.id, name: admin.name, email: admin.email, ...demoTemporaryPassword() },
        }),
        { status: 201 },
      );
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
    // A conta nasce ativa, com a senha temporária devolvida só nesta resposta (como na API, nenhum e-mail sai).
    http.post(url('/v1/users'), async ({ request }) => {
      const scope = scoped('users:write', request);
      if (!scope.ok) return scope.error;
      const input = userCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      // Como a API: a conta nova pede vaga no plano do nó.
      const refusal = demoPlanRefusal(store, scope.tenantId, 'users');
      if (refusal) return refusal;
      const users = listOf(store.users, scope.tenantId);
      const email = input.data.email.trim().toLowerCase();
      if ([...store.users.values()].flat().some((user) => user.email === email))
        return problem(409, 'Já existe um usuário com este e-mail');
      const user = userSchema.parse({
        id: `demo-${email}`,
        ...input.data,
        email,
        status: 'active',
        mfaEnabled: false,
        mustChangePassword: true,
        createdAt: new Date().toISOString(),
      });
      users.push(user);
      return HttpResponse.json(userCreatedSchema.parse({ user, ...demoTemporaryPassword() }), {
        status: 201,
      });
    }),
    http.patch(url('/v1/users/:id'), async ({ params, request }) => {
      const scope = scoped('users:write', request);
      if (!scope.ok) return scope.error;
      const user = listOf(store.users, scope.tenantId).find((candidate) => candidate.id === params['id']);
      if (!user) return problem(404, 'Usuário não encontrado');
      if (user.id === scope.me.userId) return problem(403, 'Ninguém altera o próprio acesso');
      const input = userUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      // Reativar ocupa de novo uma vaga do plano.
      if (input.data.status === 'active' && user.status === 'disabled') {
        const refusal = demoPlanRefusal(store, scope.tenantId, 'users');
        if (refusal) return refusal;
      }
      Object.assign(user, input.data);
      return HttpResponse.json(user);
    }),
    // Senha temporária nova: a anterior deixa de valer e as sessões caem (no mock, só a marca de primeiro acesso).
    http.post(url('/v1/users/:id/temporary-password'), ({ params, request }) => {
      const scope = scoped('users:write', request);
      if (!scope.ok) return scope.error;
      const target = listOf(store.users, scope.tenantId).find((candidate) => candidate.id === params['id']);
      if (!target) return problem(404, 'Usuário não encontrado');
      if (target.id === scope.me.userId) return problem(403, 'Você não pode alterar o próprio acesso');
      if (target.status === 'disabled')
        return problem(409, 'Usuário desativado: reative antes de gerar uma senha temporária');
      target.mustChangePassword = true;
      target.status = 'active'; // conta do antigo convite, ainda sem senha, passa a ativa
      return HttpResponse.json(demoTemporaryPassword());
    }),

    // --- Contas cloud (T3.3) ---
    http.get(url('/v1/cloud-accounts'), ({ request }) => {
      const scope = scoped('cloud_accounts:read');
      if (!scope.ok) return scope.error;
      const query = cloudAccountListQuerySchema.safeParse(queryOf(request));
      if (!query.success) return problem(400, 'Filtro inválido');
      const accounts = listOf(store.accounts, scope.tenantId);
      for (const account of accounts) answerAwsCheck(account);
      const items = accounts.filter((account) => !query.data.status || account.status === query.data.status);
      return HttpResponse.json(paginate(items, query.data.page, query.data.pageSize));
    }),
    http.post(url('/v1/cloud-accounts'), async ({ request }) => {
      const scope = scoped('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const input = cloudAccountCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      // Como a API: a conta nova pede vaga no plano do nó.
      const refusal = demoPlanRefusal(store, scope.tenantId, 'cloudAccounts');
      if (refusal) return refusal;
      const all = [...store.accounts.values()].flat();
      if (
        all.some(
          (account) => account.provider === input.data.provider && account.accountId === input.data.accountId,
        )
      ) {
        return problem(409, 'Esta conta já está cadastrada');
      }
      const data = input.data;
      if (data.provider === 'aws') {
        const taken = bucketOfAnotherTenant(store, scope.tenantId, mergeLogBuckets(NO_BUCKETS, data.buckets));
        if (taken) return problem(409, `O bucket ${taken} já está cadastrado em outro cliente`);
      }
      const now = new Date().toISOString();
      const aws = data.provider === 'aws';
      const account = cloudAccountSchema.parse({
        id: newId(),
        provider: data.provider,
        accountId: data.accountId,
        regions: aws ? data.regions : [],
        readerRoleArn: aws ? awsReaderRoleArn(data.accountId) : null,
        nodeServiceAccountId: aws ? DEMO_NODE_SERVICE_ACCOUNT_ID : null,
        webIdentityAudience: aws ? AWS_READER_AUDIENCE : null,
        buckets: {
          cloudtrail: aws ? (data.buckets?.cloudtrail ?? null) : null,
          guardduty: aws ? (data.buckets?.guardduty ?? null) : null,
          waf: aws ? (data.buckets?.waf ?? null) : null,
        },
        pubsubSubscription: data.provider === 'gcp' ? (data.pubsubSubscription ?? null) : null,
        sinkTopic: data.provider === 'gcp' ? `${DEMO_SINK_TOPIC_PREFIX}${data.accountId}` : null,
        sinkWriterIdentity: data.provider === 'gcp' ? (data.sinkWriterIdentity ?? null) : null,
        zones: data.provider === 'cloudflare' ? (data.zones ?? []) : [],
        keyStatus: null,
        egressIps: data.provider === 'gcp' ? [] : DEMO_EGRESS_IPS,
        status: 'active',
        connection: 'waiting',
        connectionError: null,
        checkRequestedAt: null,
        ingestFrom: null,
        lastCollectedAt: null,
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
      // Reativar ocupa de novo uma vaga do plano.
      if (input.data.status === 'active' && account.status !== 'active') {
        const refusal = demoPlanRefusal(store, scope.tenantId, 'cloudAccounts');
        if (refusal) return refusal;
      }
      const { buckets, ...rest } = input.data;
      if (buckets) {
        const taken = bucketOfAnotherTenant(store, scope.tenantId, mergeLogBuckets(NO_BUCKETS, buckets));
        if (taken) return problem(409, `O bucket ${taken} já está cadastrado em outro cliente`);
      }
      const nextBuckets = mergeLogBuckets(account.buckets, buckets);
      // Como a API: outra assinatura ou outra lista de buckets é outra fonte, e a conta desativada ou reativada
      // recomeça; nos dois casos, a conexão volta a "aguardando" (e o "Verificar" pendente sai). Nada é verificado
      // sozinho.
      const sourceChanged =
        !sameLogBucketNames(account.buckets, nextBuckets) ||
        (rest.pubsubSubscription !== undefined && rest.pubsubSubscription !== account.pubsubSubscription);
      const statusChanged = rest.status !== undefined && rest.status !== account.status;
      Object.assign(
        account,
        rest,
        { buckets: { ...nextBuckets }, updatedAt: new Date().toISOString() },
        sourceChanged || statusChanged
          ? { connection: 'waiting', connectionError: null, checkRequestedAt: null }
          : {},
        // Como a API: a conta desativada não guarda credencial.
        rest.status === 'inactive' ? { keyStatus: null } : {},
      );
      return HttpResponse.json(account);
    }),
    // "Verificar" a conta AWS, como a API: grava o pedido (a conexão volta a aguardar) e responde na hora (202); o
    // pedido pendente não é renovado. Quem responde é o "worker" da demonstração, na leitura da lista.
    http.post(url('/v1/cloud-accounts/:id/aws/verify'), ({ params, request }) => {
      const scope = scoped('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const account = listOf(store.accounts, scope.tenantId).find(
        (candidate) => candidate.id === params['id'],
      );
      if (!account) return problem(404, 'Conta não encontrada');
      if (account.provider !== 'aws') return problem(400, 'Só uma conta AWS é verificada assim.');
      if (account.status !== 'active') {
        return problem(400, 'Reative o monitoramento antes de verificar a conta.');
      }
      if (account.checkRequestedAt === null) {
        const now = new Date().toISOString();
        Object.assign(account, {
          connection: 'waiting',
          connectionError: null,
          checkRequestedAt: now,
          updatedAt: now,
        });
      }
      return HttpResponse.json(account, { status: 202 });
    }),
    // Credencial de leitura (token do Cloudflare). O mock não fala com o Cloudflare: todo token no formato é aceito,
    // com um ID fictício, e nada do valor colado fica no estado (só o fim do ID, como na API).
    http.put(url('/v1/cloud-accounts/:id/credential'), async ({ params, request }) => {
      const scope = scoped('cloud_credentials:write', request);
      if (!scope.ok) return scope.error;
      const account = listOf(store.accounts, scope.tenantId).find(
        (candidate) => candidate.id === params['id'],
      );
      if (!account) return problem(404, 'Conta não encontrada');
      const input = cloudCredentialInputSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      if (CREDENTIAL_KIND_PROVIDERS[input.data.kind] !== account.provider) {
        return problem(400, 'Este tipo de credencial não vale para esta conta.');
      }
      if (account.status !== 'active') return problem(400, 'Reative a conta antes de guardar a credencial.');
      const tokenId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      const now = new Date().toISOString();
      Object.assign(account, {
        keyStatus: {
          kind: input.data.kind,
          keyIdSuffix: tokenId.slice(-4),
          issuedAt: null,
          expiresAt: null,
          verifiedAt: now,
          status: 'active',
        },
        connection: 'waiting',
        connectionError: null,
        updatedAt: now,
      });
      return HttpResponse.json(account);
    }),
    http.delete(url('/v1/cloud-accounts/:id/credential'), ({ params, request }) => {
      const scope = scoped('cloud_credentials:write', request);
      if (!scope.ok) return scope.error;
      const account = listOf(store.accounts, scope.tenantId).find(
        (candidate) => candidate.id === params['id'],
      );
      if (!account) return problem(404, 'Conta não encontrada');
      if (!account.keyStatus) return problem(404, 'Esta conta não tem credencial guardada.');
      Object.assign(account, {
        keyStatus: null,
        connection: 'waiting',
        connectionError: null,
        updatedAt: new Date().toISOString(),
      });
      return new HttpResponse(null, { status: 204 });
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

import {
  type CloudAccount,
  type CloudflareConnection,
  CLOUDFLARE_OAUTH_AUTHORIZE_URL,
  CLOUDFLARE_OAUTH_ISSUER,
  CLOUDFLARE_OAUTH_REFUSED_CODE,
  type CloudflareOauthAccount,
  type CloudflareOauthAttempt,
  type CloudflareOauthAttemptError,
  cloudflareOauthChooseSchema,
  cloudflareOauthCompleteSchema,
  cloudflareOauthStartSchema,
  type CloudflareZone,
  type CloudflareZones,
  type CloudflareZoneState,
  type Me,
  type Permission,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import type { AdminStore } from './admin';
import { DEMO_ACCOUNTS } from './fixtures';
import type { MockState } from './handlers';

/**
 * "Conectar com Cloudflare" (OAuth) na demonstração. Desligado por padrão, como um nó sem a configuração (ou anterior a
 * ela): as rotas do OAuth respondem 404 e a tela é a do token colado. `localStorage['verax.mock.cloudflare-oauth']` liga
 * e escolhe o que o "Cloudflare" autoriza:
 * - `one`: uma conta (a da migração, quando a tentativa é de uma conta cadastrada): ligada sozinha;
 * - `multi`: três contas, para escolher (uma sem permissão de leitura);
 * - `manual`: o Cloudflare não lista as contas, e o ID é digitado.
 * Com `legacy`, o nó é anterior ao OAuth: nem a conexão nem as zonas existem (404), e a tela é exatamente a de antes.
 * `localStorage['verax.mock.cloudflare-oauth.expire']` faz a tentativa vencer no retorno (`return`) ou na escolha
 * (`choosing`).
 *
 * O "Cloudflare" e o "worker" são de mentira e não há rede. O estado vai para o `sessionStorage` porque a ida ao
 * Cloudflare recarrega a página; dele, só o hash do `state` (nunca o `state` nem o código).
 */
export const CLOUDFLARE_OAUTH_SCENARIOS = ['one', 'multi', 'manual'] as const;
export type CloudflareOauthScenario = (typeof CLOUDFLARE_OAUTH_SCENARIOS)[number];

const STORAGE_KEY = 'verax.mock.cloudflare-demo';
/** O "worker" troca o código neste tempo depois do retorno. */
const WORK_DELAY_MS = 600;
const ATTEMPT_TTL_MS = 10 * 60_000;
const DEMO_SLUG = 'alfa';
const DEMO_SCOPES = ['audit-logs.read', 'zone.read', 'analytics.read', 'offline_access'];
/** A conta nova que o cenário `one` autoriza (ID fictício). */
export const DEMO_OAUTH_NEW_ACCOUNT = 'c0ffee00000000000000000000000a01';
/** As contas do cenário `multi`. O segundo nome tem marcação de propósito: a tela o mostra como texto. */
export const DEMO_OAUTH_ACCOUNTS: readonly CloudflareOauthAccount[] = [
  { accountId: 'c0ffee00000000000000000000000b01', name: 'Cliente Demo A', state: 'available' },
  { accountId: 'c0ffee00000000000000000000000b02', name: '<b>Cliente Demo B</b> & Cia', state: 'available' },
  { accountId: 'c0ffee00000000000000000000000b03', name: null, state: 'forbidden' },
];

interface StoredAttempt {
  id: string;
  stateHash: string;
  tenantId: string;
  userId: string;
  status: CloudflareOauthAttempt['status'];
  errorCode: CloudflareOauthAttemptError | null;
  cloudAccountId: string | null;
  scenario: CloudflareOauthScenario;
  receivedAt: number | null;
  expiresAt: number;
  chosen: string[];
  cloudAccountIds: string[];
}

interface Stored {
  attempts: StoredAttempt[];
  /** A conta cadastrada (UUID) lida por OAuth, e a concessão dela. */
  grants: Record<string, { grantId: string; consentedAt: string }>;
}

const stored = (key: string): string | null =>
  typeof window === 'undefined' ? null : window.localStorage.getItem(key);

function load(): Stored {
  try {
    const raw = typeof window === 'undefined' ? null : window.sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? null : (JSON.parse(raw) as Partial<Stored>);
    return { attempts: parsed?.attempts ?? [], grants: parsed?.grants ?? {} };
  } catch {
    return { attempts: [], grants: {} };
  }
}

function save(store: Stored): void {
  if (typeof window !== 'undefined') window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Texto aleatório no alfabeto do base64url, do tamanho pedido (43: os 32 bytes do `state` da API). */
function randomToken(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    BASE64URL.charAt(byte & 63),
  ).join('');
}

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });
const refused = () =>
  problem(
    400,
    'Não foi possível concluir a conexão com o Cloudflare. Comece de novo.',
    CLOUDFLARE_OAUTH_REFUSED_CODE,
  );

const CALLBACK_FAILURES: Readonly<Record<string, CloudflareOauthAttemptError>> = {
  access_denied: 'oauth_denied',
  server_error: 'source_unavailable',
  temporarily_unavailable: 'source_unavailable',
};

/** As zonas que a demonstração "leu" em cada conta: a de sempre da Alfa e as das contas novas. */
function demoZones(account: CloudAccount): { name: string; plan: string; state: CloudflareZoneState }[] {
  if (account.accountId === DEMO_ACCOUNTS.alfaCloudflare) {
    return [
      { name: 'loja-alfa.example', plan: 'Pro', state: 'reading' },
      { name: 'blog-alfa.example', plan: 'Free', state: 'not_entitled' },
      { name: 'antigo-alfa.example', plan: 'Free', state: 'missing' },
    ];
  }
  return [
    { name: 'cliente-demo.example', plan: 'Business', state: 'pending' },
    { name: 'extra-demo.example', plan: 'Free', state: 'over_limit' },
  ];
}

function zoneId(accountId: string, index: number): string {
  return `${accountId.slice(0, 30)}${index.toString(16).padStart(2, '0')}`;
}

export function createCloudflareOauthHandlers(state: MockState, admin: AdminStore) {
  const scenario = (): CloudflareOauthScenario | null =>
    state.cloudflareOauth !== undefined
      ? state.cloudflareOauth
      : (CLOUDFLARE_OAUTH_SCENARIOS.find((value) => value === stored('verax.mock.cloudflare-oauth')) ?? null);
  const legacy = () =>
    state.cloudflareOauth === undefined && stored('verax.mock.cloudflare-oauth') === 'legacy';
  const expire = () => state.cloudflareOauthExpire ?? stored('verax.mock.cloudflare-oauth.expire');

  type Check = { ok: false; error: Response } | { ok: true; me: Me; tenantId: string };
  const scoped = (permission: Permission, request?: Request): Check => {
    if (!state.me) return { ok: false, error: problem(401, 'Não autenticado') };
    if (!state.me.permissions.includes(permission))
      return { ok: false, error: problem(403, 'Sem permissão') };
    if (request && request.method !== 'GET' && request.headers.get('X-CSRF-Token') === null) {
      return { ok: false, error: problem(403, 'CSRF', 'CSRF_INVALID') };
    }
    const tenantId = state.me.scopeTenantId;
    if (!tenantId) return { ok: false, error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') };
    return { ok: true, me: state.me, tenantId };
  };
  /** Desligado, como a API: 404 antes de qualquer outra conferência. */
  const enabled = (permission: Permission, request?: Request): Check =>
    scenario() === null ? { ok: false, error: problem(404, 'Não encontrado') } : scoped(permission, request);
  const accountsOf = (tenantId: string) => {
    if (!admin.accounts.has(tenantId)) admin.accounts.set(tenantId, []);
    return admin.accounts.get(tenantId) as CloudAccount[];
  };
  const body = async (request: Request): Promise<unknown> => request.json().catch(() => undefined);

  /** O "worker": liga (ou cadastra) as contas autorizadas à concessão nova, apagando o token colado (a migração). */
  const link = (store: Stored, attempt: StoredAttempt, cloudflareIds: string[]) => {
    const accounts = accountsOf(attempt.tenantId);
    const grantId = crypto.randomUUID();
    const now = new Date().toISOString();
    const template = [...admin.accounts.values()].flat().find((account) => account.provider === 'cloudflare');
    attempt.cloudAccountIds = cloudflareIds.flatMap((accountId) => {
      let account = accounts.find(
        (candidate) => candidate.provider === 'cloudflare' && candidate.accountId === accountId,
      );
      if (!account && template) {
        account = {
          ...template,
          id: crypto.randomUUID(),
          accountId,
          zones: [],
          managedBy: 'panel',
          status: 'active',
          lastCollectedAt: null,
          lastEventAt: null,
          createdAt: now,
        };
        accounts.push(account);
      }
      if (!account) return [];
      Object.assign(account, {
        keyStatus: null,
        connection: 'waiting',
        connectionError: null,
        updatedAt: now,
      });
      store.grants[account.id] = { grantId, consentedAt: now };
      return [account.id];
    });
    attempt.status = 'done';
  };

  /** O "worker" anda na leitura da tentativa: troca o código, descobre as contas ou liga as escolhidas. */
  const advance = (store: Stored, attempt: StoredAttempt, now: number) => {
    const open =
      attempt.status === 'started' || attempt.status === 'code_received' || attempt.status === 'choosing';
    if (open && attempt.expiresAt <= now) {
      attempt.status = 'expired';
      return;
    }
    if (attempt.status !== 'code_received' || attempt.receivedAt === null) return;
    if (now - attempt.receivedAt < WORK_DELAY_MS) return;
    if (attempt.chosen.length > 0) {
      link(store, attempt, attempt.chosen);
      return;
    }
    if (attempt.scenario === 'one') {
      const existing = accountsOf(attempt.tenantId).find((account) => account.id === attempt.cloudAccountId);
      link(store, attempt, [existing?.accountId ?? DEMO_OAUTH_NEW_ACCOUNT]);
      return;
    }
    // A escolha que passa do prazo aparece vencida, como na API.
    attempt.status = expire() === 'choosing' ? 'expired' : 'choosing';
  };

  const toAttempt = (attempt: StoredAttempt): CloudflareOauthAttempt => {
    const choosing = attempt.status === 'choosing';
    return {
      id: attempt.id,
      status: attempt.status,
      errorCode: attempt.status === 'failed' ? attempt.errorCode : null,
      accounts: choosing && attempt.scenario === 'multi' ? [...DEMO_OAUTH_ACCOUNTS] : [],
      accountIdRequired: choosing && attempt.scenario === 'manual',
      cloudAccountIds: attempt.status === 'done' ? attempt.cloudAccountIds : [],
      expiresAt: new Date(attempt.expiresAt).toISOString(),
    };
  };

  const ownAttempt = (store: Stored, check: { me: Me; tenantId: string }, id: unknown) =>
    store.attempts.find(
      (attempt) =>
        attempt.id === id && attempt.tenantId === check.tenantId && attempt.userId === check.me.userId,
    );

  return [
    http.get(url('/v1/cloudflare-oauth/options'), () => {
      const check = enabled('cloud_accounts:read');
      return check.ok ? HttpResponse.json({ mode: 'oauth' }) : check.error;
    }),
    http.post(url('/v1/cloudflare-oauth/start'), async ({ request }) => {
      const check = enabled('cloud_credentials:write', request);
      if (!check.ok) return check.error;
      const input = cloudflareOauthStartSchema.safeParse((await body(request)) ?? {});
      if (!input.success) return problem(400, 'Dados inválidos');
      const cloudAccountId = input.data.cloudAccountId ?? null;
      if (cloudAccountId !== null) {
        const account = accountsOf(check.tenantId).find((candidate) => candidate.id === cloudAccountId);
        if (!account) return problem(404, 'Conta não encontrada');
        if (account.provider !== 'cloudflare')
          return problem(400, 'Só uma conta do Cloudflare é conectada assim.');
        if (account.status !== 'active')
          return problem(400, 'Reative o monitoramento antes de conectar a conta.');
      }
      const oauthState = `${DEMO_SLUG}.${randomToken(43)}`;
      const now = Date.now();
      const store = load();
      const attempt: StoredAttempt = {
        id: crypto.randomUUID(),
        stateHash: await sha256(oauthState),
        tenantId: check.tenantId,
        userId: check.me.userId,
        status: 'started',
        errorCode: null,
        cloudAccountId,
        scenario: scenario() ?? 'one',
        receivedAt: null,
        expiresAt: now + ATTEMPT_TTL_MS,
        chosen: [],
        cloudAccountIds: [],
      };
      store.attempts.push(attempt);
      save(store);
      const query = new URLSearchParams({
        response_type: 'code',
        client_id: 'demo-verax-control',
        redirect_uri: 'https://conta.example/v1/public/cloudflare/callback',
        scope: DEMO_SCOPES.join(' '),
        state: oauthState,
        code_challenge: randomToken(43),
        code_challenge_method: 'S256',
      });
      return HttpResponse.json({
        attemptId: attempt.id,
        authorizeUrl: `${CLOUDFLARE_OAUTH_AUTHORIZE_URL}?${query.toString()}`,
        expiresAt: new Date(attempt.expiresAt).toISOString(),
      });
    }),
    http.post(url('/v1/cloudflare-oauth/complete'), async ({ request }) => {
      const check = enabled('cloud_credentials:write', request);
      if (!check.ok) return check.error;
      const input = cloudflareOauthCompleteSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const store = load();
      const hash = await sha256(input.data.state);
      const attempt = store.attempts.find(
        (candidate) => candidate.stateHash === hash && candidate.tenantId === check.tenantId,
      );
      const now = Date.now();
      // Como a API: outra sessão ou usuário, vencida ou repetida, a mesma recusa.
      if (
        !attempt ||
        attempt.userId !== check.me.userId ||
        attempt.status !== 'started' ||
        attempt.expiresAt <= now ||
        expire() === 'return'
      ) {
        return refused();
      }
      if ('error' in input.data) {
        attempt.status = 'failed';
        attempt.errorCode = CALLBACK_FAILURES[input.data.error] ?? 'oauth_client_rejected';
      } else if (input.data.iss !== CLOUDFLARE_OAUTH_ISSUER) {
        attempt.status = 'failed';
        attempt.errorCode = 'oauth_code_rejected';
        save(store);
        return refused();
      } else {
        attempt.status = 'code_received';
        attempt.receivedAt = now;
        attempt.expiresAt = now + 5 * 60_000;
      }
      save(store);
      return HttpResponse.json({ attemptId: attempt.id });
    }),
    http.get(url('/v1/cloudflare-oauth/attempts/:id'), ({ params }) => {
      const check = enabled('cloud_credentials:write');
      if (!check.ok) return check.error;
      const store = load();
      const attempt = ownAttempt(store, check, params['id']);
      if (!attempt) return problem(404, 'Conexão não encontrada');
      advance(store, attempt, Date.now());
      save(store);
      return HttpResponse.json(toAttempt(attempt));
    }),
    http.post(url('/v1/cloudflare-oauth/attempts/:id/accounts'), async ({ params, request }) => {
      const check = enabled('cloud_credentials:write', request);
      if (!check.ok) return check.error;
      const store = load();
      const attempt = ownAttempt(store, check, params['id']);
      if (!attempt) return problem(404, 'Conexão não encontrada');
      const input = cloudflareOauthChooseSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const now = Date.now();
      advance(store, attempt, now);
      if (attempt.status !== 'choosing' || attempt.chosen.length > 0) {
        save(store);
        return problem(
          409,
          'Esta conexão não está esperando a escolha das contas.',
          'CLOUDFLARE_OAUTH_NOT_CHOOSING',
        );
      }
      const usable = DEMO_OAUTH_ACCOUNTS.filter((account) => account.state === 'available').map(
        (account) => account.accountId,
      );
      if (attempt.scenario === 'multi' && input.data.accountIds.some((id) => !usable.includes(id))) {
        return problem(
          400,
          'Escolha só contas da lista que podem ser monitoradas.',
          'CLOUDFLARE_OAUTH_ACCOUNT_NOT_OFFERED',
        );
      }
      attempt.chosen = [...input.data.accountIds];
      attempt.status = 'code_received';
      attempt.receivedAt = now;
      save(store);
      return HttpResponse.json(toAttempt(attempt), { status: 202 });
    }),
    http.get(url('/v1/cloud-accounts/:id/cloudflare-connection'), ({ params }) => {
      if (legacy()) return problem(404, 'Não encontrado');
      const check = scoped('cloud_accounts:read');
      if (!check.ok) return check.error;
      const account = accountsOf(check.tenantId).find((candidate) => candidate.id === params['id']);
      if (!account) return problem(404, 'Conta não encontrada');
      if (account.provider !== 'cloudflare') return problem(400, 'Só uma conta do Cloudflare tem zonas.');
      const { grants } = load();
      const grant = account.status === 'active' ? grants[account.id] : undefined;
      const connection: CloudflareConnection = grant
        ? {
            method: 'oauth',
            grant: {
              status: 'active',
              consentedAt: grant.consentedAt,
              lastRefreshAt: null,
              scopes: DEMO_SCOPES,
              accounts: Object.values(grants).filter((other) => other.grantId === grant.grantId).length,
            },
          }
        : { method: account.keyStatus?.kind === 'cloudflare_api_token' ? 'token' : null, grant: null };
      return HttpResponse.json(connection);
    }),
    http.get(url('/v1/cloud-accounts/:id/cloudflare-zones'), ({ params }) => {
      if (legacy()) return problem(404, 'Não encontrado');
      const check = scoped('cloud_accounts:read');
      if (!check.ok) return check.error;
      const account = accountsOf(check.tenantId).find((candidate) => candidate.id === params['id']);
      if (!account) return problem(404, 'Conta não encontrada');
      if (account.provider !== 'cloudflare') return problem(400, 'Só uma conta do Cloudflare tem zonas.');
      const listed = new Set(account.zones.map((zone) => zone.toLowerCase()));
      const active = account.status === 'active';
      const seen = new Date(Date.parse(account.createdAt)).toISOString();
      const read = account.lastCollectedAt;
      const zones: CloudflareZone[] = demoZones(account).map((zone, index) => {
        const monitored = active && (listed.size === 0 || listed.has(zone.name));
        const state: CloudflareZoneState =
          zone.state === 'missing' ? 'missing' : monitored ? zone.state : 'not_monitored';
        return {
          zoneId: zoneId(account.accountId, index),
          name: zone.name,
          plan: zone.plan,
          state,
          lastReadAt: state === 'reading' ? (read ?? seen) : null,
          lastErrorCode: state === 'not_entitled' ? 'not_entitled' : null,
          firstSeenAt: seen,
          missingSince: state === 'missing' ? seen : null,
        };
      });
      const response: CloudflareZones = {
        monitored: listed.size === 0 ? 'all' : 'listed',
        limit: 50,
        audit: { lastReadAt: read, lastErrorCode: null },
        zones,
      };
      return HttpResponse.json(response);
    }),
  ];
}

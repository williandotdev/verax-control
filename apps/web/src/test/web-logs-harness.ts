import {
  type AwsSource,
  WEB_ESTIMATE_MAX_AGE_MS,
  WEB_OBSERVE_MS,
  WEB_ROUTES_LIMIT,
  WEB_TRUSTED_LIMIT,
  type WebAlbLogging,
  webAlbLoggingSchema,
  type WebEstimate,
  webEstimateSchema,
  type WebLogSource,
  webLogSourceSchema,
  type WebRoute,
  webRouteSchema,
  type WebSourceHealth,
  webSourceHealthSchema,
  type WebSourceSettings,
  type WebTrustedSource,
  webTrustedSourceSchema,
} from '@verax/shared';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { API_URL } from '@/lib/env';
import {
  authorizedSourceFixture,
  FIXTURE_ACCOUNT_ID,
  fixtureId,
  sourceFixture,
} from './aws-onboarding-fixtures';

/**
 * A API dos ataques web (`/v1/web-logs`) nos testes das telas: o teste diz o que a leitura devolve e o que cada escrita responde, e
 * confere os pedidos que chegaram. Nada de regra aqui (a imitação com regras é `mocks/web-logs.ts`). Tudo passa pelo schema do
 * contrato: uma resposta que a API não daria quebra aqui, não na tela. Dados fictícios.
 */

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

/** O log de acesso ligado pelo painel, sem pedido nem resultado (o balanceador que nunca teve o log ligado pelo Verax). */
export function albLoggingFixture(sourceId: string, overrides: Partial<WebAlbLogging> = {}): WebAlbLogging {
  return webAlbLoggingSchema.parse({
    sourceId,
    pending: null,
    requestedAt: null,
    lastAction: null,
    status: null,
    errorCode: null,
    completedAt: null,
    enabledByVerax: false,
    bucket: null,
    enabledAt: null,
    enabledBy: null,
    disabledAt: null,
    disabledBy: null,
    previous: null,
    ...overrides,
  });
}

/** Um ALB com o log ligado, que o Verax lê, num nó com os ataques web. */
export function albFixture(name: string, overrides: Partial<AwsSource> = {}): AwsSource {
  return sourceFixture('elb_logs', {
    name,
    collectable: true,
    notes: ['high_volume'],
    state: 'available',
    stateCode: null,
    ...overrides,
    details: {
      arn: `arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/app/${name}/50dc6c495c0c9188`,
      internetFacing: true,
      destinationType: 's3',
      bucket: 'exemplo-logs-alb',
      ...overrides.details,
    },
  });
}

export function authorizedAlbFixture(
  name: string,
  state: AwsSource['state'] = 'collecting',
  overrides: Partial<AwsSource> = {},
): AwsSource {
  return authorizedSourceFixture('elb_logs', state, {
    name,
    collectable: true,
    notes: ['high_volume'],
    ...overrides,
  });
}

export function estimateFixture(overrides: Partial<WebEstimate> = {}): WebEstimate {
  const computedAt = overrides.computedAt === undefined ? iso(-HOUR) : overrides.computedAt;
  return webEstimateSchema.parse({
    requestedAt: null,
    status: 'ready',
    computedAt,
    day: '2026-11-24',
    objects: 864,
    truncated: false,
    errorCode: null,
    projection: {
      gbPerDay: 1,
      percent: 46.6,
      basis: 'monthly',
      acknowledgementRequired: true,
      validUntil: new Date(Date.parse(computedAt ?? iso(0)) + WEB_ESTIMATE_MAX_AGE_MS).toISOString(),
    },
    ...overrides,
  });
}

export function settingsFixture(overrides: Partial<WebSourceSettings> = {}): WebSourceSettings {
  return {
    mode: 'observe',
    observeUntil: iso(WEB_OBSERVE_MS - 30 * HOUR),
    thresholdMultiplier: 1,
    updatedAt: iso(-30 * HOUR),
    updatedBy: 'demo-ana',
    ...overrides,
  };
}

/** O balanceador em `/v1/web-logs`, a partir da fonte do onboarding. */
export function webSourceFixture(source: AwsSource, overrides: Partial<WebLogSource> = {}): WebLogSource {
  const authorized = source.authorization.authorizedAt !== null && source.authorization.revokedAt === null;
  return webLogSourceSchema.parse({
    id: source.id,
    cloudAccountId: FIXTURE_ACCOUNT_ID,
    accountId: '111111111111',
    region: source.region,
    name: source.name,
    loadBalancer: 'app/loja-alb/50dc6c495c0c9188',
    internetFacing: true,
    state: source.state,
    authorized,
    settings: authorized ? settingsFixture() : null,
    estimate: null,
    ...overrides,
  });
}

export function healthFixture(sourceId: string, overrides: Partial<WebSourceHealth> = {}): WebSourceHealth {
  return webSourceHealthSchema.parse({
    sourceId,
    since: iso(-24 * HOUR),
    objects: { read: 858, late: 0, quarantined: 0, gap: 0 },
    lines: { analysed: 412_830, malformed: 0, oversize: 0, foreign: 0 },
    bytes: 310_000_000,
    gap: null,
    observation: { since: iso(-30 * HOUR), rules: [], truncated: false },
    suppressed: [],
    notes: [],
    stateAt: iso(-60_000),
    ...overrides,
  });
}

export function trustedFixture(overrides: Partial<WebTrustedSource> = {}): WebTrustedSource {
  return webTrustedSourceSchema.parse({
    id: fixtureId(),
    sourceId: null,
    cidr: '192.0.2.10/32',
    kind: 'monitor',
    reason: 'Monitor do site',
    expiresAt: iso(90 * 24 * HOUR),
    active: true,
    createdAt: iso(-24 * HOUR),
    createdBy: 'demo-ana',
    updatedAt: iso(-24 * HOUR),
    updatedBy: 'demo-ana',
    ...overrides,
  });
}

export function routeFixture(sourceId: string, overrides: Partial<WebRoute> = {}): WebRoute {
  return webRouteSchema.parse({
    id: fixtureId(),
    sourceId,
    host: 'loja.exemplo.com.br',
    method: 'POST',
    path: '/entrar',
    kind: 'login',
    failureCodes: [401],
    successCodes: [200],
    multiplier: 1,
    createdAt: iso(-24 * HOUR),
    createdBy: 'demo-ana',
    updatedAt: iso(-24 * HOUR),
    updatedBy: 'demo-ana',
    ...overrides,
  });
}

export interface WebLogsCall {
  method: string;
  /** O caminho depois de `/v1/web-logs/`, com a query. */
  path: string;
  body: unknown;
}

export interface WebLogsState {
  sources: WebLogSource[];
  health: Map<string, WebSourceHealth>;
  routes: Map<string, WebRoute[]>;
  trusted: WebTrustedSource[];
  /** O log de acesso ligado pelo painel, por balanceador; sem a entrada, 404 (o nó de antes). */
  albLogging: Map<string, WebAlbLogging>;
}

export interface WebLogsApi {
  handlers: RequestHandler[];
  calls: WebLogsCall[];
  /** Só as escritas. */
  writes: () => WebLogsCall[];
  state: WebLogsState;
  /** Uma resposta no lugar da de sempre, para o pedido que começa assim ("POST sources/…/estimate"). */
  on: (
    prefix: string,
    reply: (call: WebLogsCall) => Response | undefined | Promise<Response | undefined>,
  ) => void;
}

const json = (body: unknown, status = 200) => HttpResponse.json(body as Record<string, unknown>, { status });
const missing = () => json({ statusCode: 404, message: 'não encontrado' }, 404);

/** Os ataques web desligados (ou um nó de antes deles): tudo é 404. */
export function webLogsDisabled(code: string | null = 'WEB_LOGS_DISABLED'): RequestHandler {
  return http.all(`${API_URL}/v1/web-logs/*`, () =>
    json({ statusCode: 404, message: 'desligado', ...(code !== null && { code }) }, 404),
  );
}

export function webLogsApi(initial: Partial<WebLogsState> = {}, pageSize?: number): WebLogsApi {
  const state: WebLogsState = {
    sources: [],
    health: new Map(),
    routes: new Map(),
    trusted: [],
    albLogging: new Map(),
    ...initial,
  };
  const calls: WebLogsCall[] = [];
  const replies: {
    prefix: string;
    reply: (call: WebLogsCall) => Response | undefined | Promise<Response | undefined>;
  }[] = [];
  const handler = http.all(`${API_URL}/v1/web-logs/*`, async ({ request }) => {
    const address = new URL(request.url);
    const path = `${address.pathname.split('/v1/web-logs/')[1] ?? ''}${address.search}`;
    const call: WebLogsCall = {
      method: request.method,
      path,
      body: await request.json().catch(() => undefined),
    };
    calls.push(call);
    const custom = [...replies].reverse().find(({ prefix }) => `${call.method} ${path}`.startsWith(prefix));
    const answered = await custom?.reply(call);
    if (answered !== undefined) return answered;
    const [first, id = '', rest, item] = (path.split('?')[0] ?? '').split('/');
    if (first === 'sources' && id === '') {
      const size = pageSize ?? Number(address.searchParams.get('pageSize'));
      const page = Number(address.searchParams.get('page'));
      return json({
        items: state.sources.slice((page - 1) * size, page * size),
        page,
        pageSize: size,
        total: state.sources.length,
      });
    }
    if (first === 'sources' && rest === 'access-logs') {
      const logging = state.albLogging.get(id);
      if (logging === undefined) return missing();
      if (call.method === 'GET') return json(logging);
      const next = webAlbLoggingSchema.parse({
        ...logging,
        pending: item === 'disable' ? 'disable' : 'enable',
        requestedAt: iso(0),
      });
      state.albLogging.set(id, next);
      return json(next, 202);
    }
    if (first === 'sources') {
      const source = state.sources.find((candidate) => candidate.id === id);
      if (source === undefined) return missing();
      if (rest === undefined) return json(source);
      if (rest === 'health') return json(state.health.get(id) ?? healthFixture(id));
      if (rest === 'estimate') {
        const next = webSourceFixtureOf(source, { estimate: pendingOf(source.estimate) });
        replace(state, next);
        return json(next, 202);
      }
      if (rest === 'settings') {
        const next = webSourceFixtureOf(source, {
          settings: {
            ...settingsFixture(),
            ...source.settings,
            ...(call.body as Partial<WebSourceSettings>),
          },
        });
        replace(state, next);
        return json(next);
      }
      const routes = state.routes.get(id) ?? [];
      if (rest === 'routes' && item === undefined) {
        if (call.method === 'GET') return json({ items: routes, limit: WEB_ROUTES_LIMIT });
        const route = routeFixture(id, call.body as Partial<WebRoute>);
        state.routes.set(id, [...routes, route]);
        return json(route, 201);
      }
      const known = routes.find((route) => route.id === item);
      if (known === undefined) return missing();
      if (call.method === 'DELETE') {
        state.routes.set(
          id,
          routes.filter((route) => route !== known),
        );
        return new HttpResponse(null, { status: 204 });
      }
      const changed = { ...known, ...(call.body as Partial<WebRoute>) };
      state.routes.set(
        id,
        routes.map((route) => (route === known ? changed : route)),
      );
      return json(changed);
    }
    if (first !== 'trusted-sources') return missing();
    if (id === '') {
      if (call.method === 'GET') return json({ items: state.trusted, limit: WEB_TRUSTED_LIMIT });
      const trusted = trustedFixture(call.body as Partial<WebTrustedSource>);
      state.trusted = [...state.trusted, trusted];
      return json(trusted, 201);
    }
    const known = state.trusted.find((trusted) => trusted.id === id);
    if (known === undefined) return missing();
    if (call.method === 'DELETE') {
      state.trusted = state.trusted.filter((trusted) => trusted !== known);
      return new HttpResponse(null, { status: 204 });
    }
    const changed = { ...known, ...(call.body as Partial<WebTrustedSource>), active: true };
    state.trusted = state.trusted.map((trusted) => (trusted === known ? changed : trusted));
    return json(changed);
  });
  return {
    handlers: [handler],
    calls,
    writes: () => calls.filter((call) => call.method !== 'GET'),
    state,
    on: (prefix, reply) => replies.push({ prefix, reply }),
  };
}

const webSourceFixtureOf = (source: WebLogSource, overrides: Partial<WebLogSource>): WebLogSource =>
  webLogSourceSchema.parse({ ...source, ...overrides });

function replace(state: WebLogsState, next: WebLogSource): void {
  state.sources = state.sources.map((source) => (source.id === next.id ? next : source));
}

/** A estimativa com o pedido gravado, como a API a devolve depois do clique. */
export function pendingOf(estimate: WebEstimate | null): WebEstimate {
  return webEstimateSchema.parse({
    ...(estimate ?? {
      status: null,
      computedAt: null,
      day: null,
      objects: null,
      truncated: false,
      errorCode: null,
      projection: null,
    }),
    requestedAt: iso(0),
  });
}

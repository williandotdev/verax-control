import {
  type AwsSource,
  type AwsSourcesAuthorize,
  type CloudAccount,
  hasCodeOverlap,
  isTrustedExpiryValid,
  type Me,
  type Permission,
  projectWebLogs,
  type VolumeAllowance,
  WEB_ESTIMATE_MAX_AGE_MS,
  WEB_ESTIMATE_REQUEST_INTERVAL_MS,
  WEB_LOGS_DISABLED_CODE,
  WEB_OBSERVE_MS,
  WEB_ROUTES_LIMIT,
  WEB_TRUSTED_LIMIT,
  type WebEstimate,
  type WebEstimateStatus,
  webLogSourceListQuerySchema,
  webLogSourceListSchema,
  type WebLogSource,
  webLogSourceSchema,
  type WebRoute,
  webRouteCreateSchema,
  webRouteListSchema,
  webRouteUpdateSchema,
  type WebSourceHealth,
  webSourceHealthSchema,
  type WebSourceSettings,
  webSourceSettingsUpdateSchema,
  type WebTrustedSource,
  webTrustedSourceCreateSchema,
  webTrustedSourceListSchema,
  webTrustedSourceUpdateSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';

/**
 * Os ataques web pelos logs do ALB no modo mock: uma imitação com estado de `/v1/web-logs` (`apps/api/src/weblogs/settings/`), com
 * as mesmas recusas. O "worker" da demonstração responde às estimativas uns segundos depois. Toda resposta passa pelo schema do
 * contrato. Tudo fictício: contas de exemplo, endereços das faixas de documentação (RFC 5737), nenhum log.
 *
 * Ligados por padrão na demonstração; `localStorage['verax.mock.web-logs'] = 'off'` (ou `webLogs: false` no estado dos testes)
 * os desliga, e tudo responde 404, como num nó sem eles.
 */

export const MOCK_WEB_LOGS_STORAGE_KEY = 'verax.mock.web-logs';

/** Quanto o "worker" da demonstração leva para responder a uma estimativa. */
export const DEMO_WEB_ESTIMATE_DELAY_MS = 6_000;

export function demoWebLogsEnabled(state: { webLogs?: boolean }): boolean {
  if (state.webLogs !== undefined) return state.webLogs;
  return typeof window === 'undefined' || window.localStorage.getItem(MOCK_WEB_LOGS_STORAGE_KEY) !== 'off';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GB = 1_000_000_000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Os balanceadores da conta de produção da Alfa que cobrem os estados que não aparecem no caminho feliz. */
export const DEMO_ALBS = {
  /** Autorizado há 30 h: observando, com a contagem. */
  observing: 'loja-alb',
  /** Alertando, com arquivos recusados. */
  alerting: 'api-alb',
  /** A observação terminou, atrás de uma CDN, e parte do log ficou sem leitura. */
  ready: 'checkout-alb',
  /** Estimativa pronta, acima de 20% do plano. */
  heavy: 'catalogo-alb',
  noSample: 'blog-alb',
  failed: 'campanhas-alb',
  expired: 'arquivo-alb',
  /** Nunca pedida. */
  fresh: 'relatorios-alb',
  noLogs: 'site-alb',
  network: 'rede-nlb',
  otherAccount: 'parceiros-alb',
  prefixed: 'legado-alb',
} as const;

interface DemoEstimate {
  requestedAt: string | null;
  lastRequestAt: string;
  status: WebEstimateStatus | null;
  computedAt: string | null;
  day: string | null;
  objects: number | null;
  bytesPerDay: number | null;
  truncated: boolean;
  errorCode: string | null;
}

export interface WebLogsStore {
  settings: Map<string, WebSourceSettings>;
  estimates: Map<string, DemoEstimate>;
  /** Por cliente. */
  trusted: Map<string, WebTrustedSource[]>;
  routes: Map<string, WebRoute[]>;
  /** A leitura dos balanceadores da demonstração; os outros saem da saúde da fonte. */
  health: Map<string, (now: number) => Omit<WebSourceHealth, 'sourceId' | 'since'>>;
}

let sequence = 0;
const newId = (): string => {
  sequence += 1;
  return `018f2c1e-0000-7000-8000-00a1${sequence.toString(16).padStart(8, '0')}`;
};

const DEMO_ADMIN = 'demo-marina.alves';

/** O que o "worker" mede de cada balanceador da demonstração, pelo nome. */
function measured(name: string, now: number): Omit<DemoEstimate, 'requestedAt' | 'lastRequestAt'> {
  const day = iso(now - DAY).slice(0, 10);
  const base = { computedAt: iso(now), day, truncated: false, errorCode: null };
  if (name === DEMO_ALBS.noSample) {
    return { ...base, status: 'no_sample', objects: 0, bytesPerDay: null };
  }
  if (name === DEMO_ALBS.failed) {
    return {
      ...base,
      status: 'failed',
      day: null,
      objects: null,
      bytesPerDay: null,
      errorCode: 'bucket_denied',
    };
  }
  const bytesPerDay = name === DEMO_ALBS.heavy ? GB : name === DEMO_ALBS.observing ? 0.3 * GB : 0.12 * GB;
  return { ...base, status: 'ready', objects: name === DEMO_ALBS.heavy ? 864 : 576, bytesPerDay };
}

function emptyStore(): WebLogsStore {
  return {
    settings: new Map(),
    estimates: new Map(),
    trusted: new Map(),
    routes: new Map(),
    health: new Map(),
  };
}

const NO_STATE = { observation: null, suppressed: [], notes: [], stateAt: null };
const NOTHING_READ: Omit<WebSourceHealth, 'sourceId' | 'since'> = {
  objects: { read: 0, late: 0, quarantined: 0, gap: 0 },
  lines: { analysed: 0, malformed: 0, oversize: 0, foreign: 0 },
  bytes: 0,
  gap: null,
  ...NO_STATE,
};

/** A configuração, as estimativas, as fontes confiáveis e as rotas da demonstração, sobre as fontes da conta da Alfa. */
export function demoWebLogsStore(
  tenantId: string,
  sources: readonly AwsSource[],
  now: Date = new Date(),
): WebLogsStore {
  const store = emptyStore();
  const at = now.getTime();
  const byName = (name: string) =>
    sources.find((source) => source.kind === 'elb_logs' && source.name === name);
  const estimate = (name: string, hoursAgo: number, extra: Partial<DemoEstimate> = {}) => {
    const source = byName(name);
    if (source === undefined) return;
    const computed = at - hoursAgo * HOUR;
    store.estimates.set(source.id, {
      requestedAt: null,
      lastRequestAt: iso(computed - MINUTE),
      ...measured(name, computed),
      ...extra,
    });
  };
  const settings = (name: string, hoursAgo: number, data: Partial<WebSourceSettings> = {}) => {
    const source = byName(name);
    if (source === undefined) return;
    store.settings.set(source.id, {
      mode: 'observe',
      observeUntil: iso(at - hoursAgo * HOUR + WEB_OBSERVE_MS),
      thresholdMultiplier: 1,
      updatedAt: iso(at - hoursAgo * HOUR),
      updatedBy: DEMO_ADMIN,
      ...data,
    });
  };

  estimate(DEMO_ALBS.heavy, 5);
  estimate(DEMO_ALBS.noSample, 20);
  estimate(DEMO_ALBS.failed, 3);
  estimate(DEMO_ALBS.expired, 9 * 24);
  for (const name of [DEMO_ALBS.observing, DEMO_ALBS.alerting, DEMO_ALBS.ready]) estimate(name, 12 * 24);
  settings(DEMO_ALBS.observing, 30);
  settings(DEMO_ALBS.alerting, 12 * 24, { mode: 'alert', thresholdMultiplier: 1.5 });
  settings(DEMO_ALBS.ready, 5 * 24);

  const monitor: WebTrustedSource = {
    id: newId(),
    sourceId: null,
    cidr: '192.0.2.10/32',
    kind: 'monitor',
    reason: 'Monitor do site, a cada minuto',
    expiresAt: iso(at + 200 * DAY),
    active: true,
    createdAt: iso(at - 12 * DAY),
    createdBy: DEMO_ADMIN,
    updatedAt: iso(at - 12 * DAY),
    updatedBy: DEMO_ADMIN,
  };
  store.trusted.set(tenantId, [
    monitor,
    {
      ...monitor,
      id: newId(),
      sourceId: byName(DEMO_ALBS.alerting)?.id ?? null,
      cidr: '203.0.113.8/29',
      kind: 'office',
      reason: 'Saída de internet do escritório',
      expiresAt: iso(at + 60 * DAY),
    },
    {
      ...monitor,
      id: newId(),
      cidr: '198.51.100.64/28',
      kind: 'pentest',
      reason: 'Teste de invasão de outubro',
      expiresAt: iso(at - 20 * DAY),
      active: false,
    },
  ]);

  const alerting = byName(DEMO_ALBS.alerting);
  if (alerting !== undefined) {
    const route = (data: Partial<WebRoute>): WebRoute => ({
      id: newId(),
      sourceId: alerting.id,
      host: 'api.exemplo.com.br',
      method: 'POST',
      path: '/v1/entrar',
      kind: 'login',
      failureCodes: [401, 422],
      successCodes: [200],
      multiplier: 1,
      createdAt: iso(at - 11 * DAY),
      createdBy: DEMO_ADMIN,
      updatedAt: iso(at - 11 * DAY),
      updatedBy: DEMO_ADMIN,
      ...data,
    });
    store.routes.set(alerting.id, [
      route({}),
      route({
        path: '/v1/lojas/*/recuperar-senha',
        kind: 'reset',
        failureCodes: [],
        successCodes: [],
        multiplier: 2,
      }),
      route({
        host: null,
        method: 'ANY',
        path: '/autores',
        kind: 'ignore',
        failureCodes: [],
        successCodes: [],
      }),
    ]);
  }

  const observing = byName(DEMO_ALBS.observing);
  if (observing !== undefined) {
    const rule = (ruleId: string, level: number, findings: number, from: number, to: number) => ({
      ruleId,
      level,
      findings,
      firstSeenAt: iso(at - from * HOUR),
      lastSeenAt: iso(at - to * HOUR),
    });
    store.health.set(observing.id, (current) => ({
      objects: { read: 858, late: 3, quarantined: 0, gap: 0 },
      lines: { analysed: 412_830, malformed: 2, oversize: 0, foreign: 0 },
      bytes: 0.31 * GB,
      gap: null,
      observation: {
        since: observing.authorization.authorizedAt ?? iso(at - 30 * HOUR),
        rules: [
          rule('990402', 7, 9, 29, 1),
          rule('990405', 10, 2, 21, 4),
          rule('990404', 7, 3, 25, 6),
          rule('990400', 4, 2, 29, 1),
        ],
        truncated: false,
      },
      suppressed: [
        { trustedId: monitor.id, ruleId: '990402', clients: 1, lastSeenAt: iso(current - 12 * MINUTE) },
      ],
      notes: [],
      stateAt: iso(current - 3 * MINUTE),
    }));
  }
  if (alerting !== undefined) {
    store.health.set(alerting.id, (current) => ({
      objects: { read: 1_704, late: 11, quarantined: 2, gap: 0 },
      lines: { analysed: 2_104_377, malformed: 14, oversize: 1, foreign: 0 },
      bytes: 1.62 * GB,
      gap: null,
      observation: { since: alerting.authorization.authorizedAt ?? iso(at), rules: [], truncated: false },
      suppressed: [],
      notes: [],
      stateAt: iso(current - 2 * MINUTE),
    }));
  }
  const ready = byName(DEMO_ALBS.ready);
  if (ready !== undefined) {
    store.health.set(ready.id, (current) => ({
      objects: { read: 1_120, late: 6, quarantined: 0, gap: 38 },
      lines: { analysed: 980_112, malformed: 0, oversize: 0, foreign: 3 },
      bytes: 0.78 * GB,
      gap: { from: iso(at - 40 * HOUR), to: iso(at - 37 * HOUR) },
      observation: {
        since: ready.authorization.authorizedAt ?? iso(at - 5 * DAY),
        rules: [
          {
            ruleId: '990407',
            level: 10,
            findings: 1,
            firstSeenAt: iso(at - 60 * HOUR),
            lastSeenAt: iso(at - 58 * HOUR),
          },
          {
            ruleId: '990400',
            level: 4,
            findings: 5,
            firstSeenAt: iso(at - 119 * HOUR),
            lastSeenAt: iso(at - HOUR),
          },
        ],
        truncated: true,
      },
      suppressed: [],
      notes: ['behind_proxy'],
      stateAt: iso(current - 4 * MINUTE),
    }));
  }
  return store;
}

/** O "worker" da demonstração: responde às estimativas pedidas há alguns segundos. */
function answerEstimates(store: WebLogsStore, nameOf: (id: string) => string | undefined, now: number): void {
  for (const [id, estimate] of store.estimates) {
    if (estimate.requestedAt === null) continue;
    if (now - Date.parse(estimate.requestedAt) < DEMO_WEB_ESTIMATE_DELAY_MS) continue;
    Object.assign(estimate, { requestedAt: null, ...measured(nameOf(id) ?? '', now) });
  }
}

/** A estimativa que vale para autorizar, como a API a lê. */
function projectionOf(estimate: DemoEstimate, allowance: VolumeAllowance, now: number) {
  const { status, computedAt } = estimate;
  if (computedAt === null || (status !== 'ready' && status !== 'no_sample')) return null;
  if (now - Date.parse(computedAt) > WEB_ESTIMATE_MAX_AGE_MS) return null;
  return {
    ...projectWebLogs(status === 'ready' ? estimate.bytesPerDay : null, estimate.truncated, allowance),
    validUntil: iso(Date.parse(computedAt) + WEB_ESTIMATE_MAX_AGE_MS),
  };
}

function toEstimate(estimate: DemoEstimate, allowance: VolumeAllowance | null, now: number): WebEstimate {
  return {
    requestedAt: estimate.requestedAt,
    status: estimate.status,
    computedAt: estimate.computedAt,
    day: estimate.day,
    objects: estimate.objects,
    truncated: estimate.truncated,
    errorCode: estimate.errorCode,
    projection: allowance === null ? null : projectionOf(estimate, allowance, now),
  };
}

/** A recusa da autorização pela estimativa, como a API; null sem problema. */
export function demoEstimateRefusal(
  store: WebLogsStore,
  balancers: readonly AwsSource[],
  input: AwsSourcesAuthorize,
  allowance: VolumeAllowance,
  now: number = Date.now(),
): 'WEB_LOGS_ESTIMATE_REQUIRED' | 'WEB_LOGS_ESTIMATE_CHANGED' | 'WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED' | null {
  for (const source of balancers) {
    const estimate = store.estimates.get(source.id);
    const projection = estimate === undefined ? null : projectionOf(estimate, allowance, now);
    const sent = input.webLogs?.find((item) => item.sourceId === source.id);
    if (estimate === undefined || projection === null || sent === undefined)
      return 'WEB_LOGS_ESTIMATE_REQUIRED';
    if (
      sent.estimatedAt !== estimate.computedAt ||
      sent.estimatedGbPerDay !== projection.gbPerDay ||
      sent.projectedPercent !== projection.percent
    ) {
      return 'WEB_LOGS_ESTIMATE_CHANGED';
    }
    if (projection.acknowledgementRequired && !sent.acknowledged) return 'WEB_LOGS_ACKNOWLEDGEMENT_REQUIRED';
  }
  return null;
}

/** A autorização cria a configuração (ou recomeça a observação dela), como a API. */
export function demoStartObservation(
  store: WebLogsStore,
  balancers: readonly AwsSource[],
  userId: string,
  now: number = Date.now(),
): void {
  for (const source of balancers) {
    store.settings.set(source.id, {
      thresholdMultiplier: store.settings.get(source.id)?.thresholdMultiplier ?? 1,
      mode: 'observe',
      observeUntil: iso(now + WEB_OBSERVE_MS),
      updatedAt: iso(now),
      updatedBy: userId,
    });
    store.health.delete(source.id);
  }
}

/** A fonte como a mostra um nó com os ataques web desligados (`gatedSource`, na API); null se ela nem aparece. */
export function demoGatedSource(source: AwsSource): AwsSource | null {
  if (source.kind !== 'elb_logs') return source;
  const authorized = source.authorization.authorizedAt !== null;
  if (!authorized && source.availability !== 'available') return null;
  const { internetFacing: _unknown, ...details } = source.details;
  const shown: AwsSource = {
    ...source,
    collectable: false,
    details,
    notes: ['not_collected_yet'],
    permission: 'unknown',
    permissionDetail: null,
    permissionCheckedAt: null,
  };
  if (authorized && source.authorization.revokedAt === null) {
    return { ...shown, state: 'authorized', stateCode: 'not_collectable_yet' };
  }
  return authorized ? shown : { ...shown, state: 'unavailable', stateCode: 'not_collectable_yet' };
}

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

type Scope = { ok: true; me: Me; tenantId: string } | { ok: false; error: Response };

export interface WebLogsMockDeps {
  store: WebLogsStore;
  enabled: () => boolean;
  /** O escopo da sessão, com a permissão conferida (e o CSRF, nas escritas). */
  scoped: (permission: Permission, request?: Request) => Scope;
  /** As contas AWS do cliente, com as fontes de cada uma já em dia. */
  accountsOf: (tenantId: string) => { account: CloudAccount; sources: readonly AwsSource[] }[];
  allowance: () => VolumeAllowance;
}

const isAuthorized = (source: AwsSource): boolean =>
  source.authorization.authorizedAt !== null && source.authorization.revokedAt === null;

/** As rotas de `/v1/web-logs` no mock. */
export function createWebLogsHandlers({ store, enabled, scoped, accountsOf, allowance }: WebLogsMockDeps) {
  const open = (permission: Permission, request?: Request): Scope => {
    const scope = scoped(permission, request);
    if (!scope.ok) return scope;
    return enabled() ? scope : { ok: false, error: problem(404, 'Desligado', WEB_LOGS_DISABLED_CODE) };
  };
  const balancersOf = (tenantId: string) =>
    accountsOf(tenantId).flatMap(({ account, sources }) =>
      sources
        .filter((source) => source.kind === 'elb_logs' && source.origin === 'discovered')
        .map((source) => ({ account, source })),
    );
  const find = (tenantId: string, id: unknown) =>
    balancersOf(tenantId).find(({ source }) => source.id === String(id)) ?? null;
  const viewOf = (
    me: Me,
    { account, source }: { account: CloudAccount; source: AwsSource },
  ): WebLogSource => {
    const now = Date.now();
    const estimate = store.estimates.get(source.id);
    const marker = ':loadbalancer/';
    const { arn } = source.details;
    const balancer = arn === undefined ? '' : arn.slice(arn.indexOf(marker) + marker.length);
    return webLogSourceSchema.parse({
      id: source.id,
      cloudAccountId: account.id,
      accountId: account.accountId,
      region: source.region,
      name: source.name,
      loadBalancer: balancer.startsWith('app/') ? balancer : null,
      internetFacing: source.details.internetFacing ?? null,
      state: source.state,
      authorized: isAuthorized(source),
      settings: store.settings.get(source.id) ?? null,
      estimate:
        estimate === undefined
          ? null
          : toEstimate(estimate, me.permissions.includes('plan:read') ? allowance() : null, now),
    });
  };
  const advance = (tenantId: string) => {
    const names = new Map(balancersOf(tenantId).map(({ source }) => [source.id, source.name]));
    answerEstimates(store, (id) => names.get(id), Date.now());
  };
  const body = (request: Request): Promise<unknown> => request.json().catch(() => undefined);
  const notFound = () => problem(404, 'Balanceador não encontrado');

  return [
    http.get(url('/v1/web-logs/sources'), ({ request }) => {
      const scope = open('cloud_accounts:read');
      if (!scope.ok) return scope.error;
      const query = webLogSourceListQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return problem(400, 'Filtro inválido');
      advance(scope.tenantId);
      const { page, pageSize, cloudAccountId } = query.data;
      const all = balancersOf(scope.tenantId)
        .filter(({ account }) => cloudAccountId === undefined || account.id === cloudAccountId)
        .sort(
          (a, b) =>
            a.source.region.localeCompare(b.source.region) ||
            a.source.name.localeCompare(b.source.name) ||
            a.source.id.localeCompare(b.source.id),
        );
      const items = all.slice((page - 1) * pageSize, page * pageSize).map((item) => viewOf(scope.me, item));
      return HttpResponse.json(webLogSourceListSchema.parse({ items, page, pageSize, total: all.length }));
    }),

    http.get(url('/v1/web-logs/sources/:id'), ({ params }) => {
      const scope = open('cloud_accounts:read');
      if (!scope.ok) return scope.error;
      advance(scope.tenantId);
      const found = find(scope.tenantId, params['id']);
      return found === null ? notFound() : HttpResponse.json(viewOf(scope.me, found));
    }),

    http.get(url('/v1/web-logs/sources/:id/health'), ({ params }) => {
      const scope = open('cloud_accounts:read');
      if (!scope.ok) return scope.error;
      const found = find(scope.tenantId, params['id']);
      if (found === null) return notFound();
      const now = Date.now();
      const { source } = found;
      const known = isAuthorized(source) ? store.health.get(source.id)?.(now) : undefined;
      const collecting = source.state === 'collecting';
      const settings = store.settings.get(source.id);
      const fresh =
        isAuthorized(source) && collecting
          ? {
              ...NOTHING_READ,
              objects: { ...NOTHING_READ.objects, read: 3 },
              lines: { ...NOTHING_READ.lines, analysed: source.health.eventsLast24h ?? 0 },
              bytes: source.health.bytesLast24h ?? 0,
              observation: {
                since: settings?.observeUntil
                  ? iso(Date.parse(settings.observeUntil) - WEB_OBSERVE_MS)
                  : iso(now),
                rules: [],
                truncated: false,
              },
              stateAt: iso(now - MINUTE),
            }
          : NOTHING_READ;
      return HttpResponse.json(
        webSourceHealthSchema.parse({ sourceId: source.id, since: iso(now - DAY), ...(known ?? fresh) }),
      );
    }),

    http.patch(url('/v1/web-logs/sources/:id/settings'), async ({ params, request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const input = webSourceSettingsUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const found = find(scope.tenantId, params['id']);
      if (found === null) return notFound();
      const before = store.settings.get(found.source.id);
      if (!isAuthorized(found.source) || before === undefined) {
        return problem(409, 'Este balanceador não está autorizado.', 'SOURCE_NOT_AUTHORIZED');
      }
      const now = Date.now();
      const starts = input.data.mode === 'alert' && before.mode !== 'alert';
      if (starts && before.observeUntil !== null && Date.parse(before.observeUntil) > now) {
        return problem(409, 'A observação deste balanceador ainda não terminou.', 'WEB_OBSERVATION_PENDING');
      }
      store.settings.set(found.source.id, {
        ...before,
        ...(input.data.mode !== undefined && { mode: input.data.mode }),
        ...(input.data.thresholdMultiplier !== undefined && {
          thresholdMultiplier: input.data.thresholdMultiplier,
        }),
        updatedAt: iso(now),
        updatedBy: scope.me.userId,
      });
      return HttpResponse.json(viewOf(scope.me, found));
    }),

    http.post(url('/v1/web-logs/sources/:id/estimate'), ({ params, request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      advance(scope.tenantId);
      const found = find(scope.tenantId, params['id']);
      if (found === null) return notFound();
      const { account, source } = found;
      if (account.status !== 'active' || account.connection !== 'connected') {
        return problem(409, 'Conecte a conta antes de estimar o volume.', 'ACCOUNT_NOT_CONNECTED');
      }
      if (source.availability !== 'available' || source.missingSince !== null) {
        return problem(409, 'Este balanceador não está disponível para coleta.', 'SOURCE_NOT_AVAILABLE');
      }
      if (source.permission !== 'granted') {
        return problem(
          409,
          'O Verax ainda não tem permissão para ler este balanceador.',
          'SOURCE_PERMISSION_MISSING',
        );
      }
      const now = Date.now();
      const before = store.estimates.get(source.id);
      if (before === undefined) {
        store.estimates.set(source.id, {
          requestedAt: iso(now),
          lastRequestAt: iso(now),
          status: null,
          computedAt: null,
          day: null,
          objects: null,
          bytesPerDay: null,
          truncated: false,
          errorCode: null,
        });
      } else if (before.requestedAt === null) {
        if (now - Date.parse(before.lastRequestAt) < WEB_ESTIMATE_REQUEST_INTERVAL_MS) {
          return problem(
            429,
            'A estimativa deste balanceador acabou de ser pedida. Tente de novo em alguns minutos.',
            'WEB_ESTIMATE_RATE_LIMITED',
          );
        }
        Object.assign(before, { requestedAt: iso(now), lastRequestAt: iso(now) });
      }
      return HttpResponse.json(viewOf(scope.me, found), { status: 202 });
    }),

    http.get(url('/v1/web-logs/sources/:id/routes'), ({ params }) => {
      const scope = open('cloud_accounts:read');
      if (!scope.ok) return scope.error;
      const found = find(scope.tenantId, params['id']);
      if (found === null) return notFound();
      const items = store.routes.get(found.source.id) ?? [];
      return HttpResponse.json(webRouteListSchema.parse({ items, limit: WEB_ROUTES_LIMIT }));
    }),

    http.post(url('/v1/web-logs/sources/:id/routes'), async ({ params, request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const input = webRouteCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const found = find(scope.tenantId, params['id']);
      if (found === null) return notFound();
      const list = store.routes.get(found.source.id) ?? [];
      if (list.length >= WEB_ROUTES_LIMIT) {
        return problem(409, 'O limite é de 50 rotas por balanceador.', 'WEB_ROUTE_LIMIT_REACHED');
      }
      const same = (route: WebRoute) =>
        route.host === input.data.host &&
        route.method === input.data.method &&
        route.path === input.data.path;
      if (list.some(same)) return problem(409, 'Esta rota já está declarada.', 'WEB_ROUTE_DUPLICATE');
      const now = iso(Date.now());
      const route: WebRoute = {
        id: newId(),
        sourceId: found.source.id,
        ...input.data,
        createdAt: now,
        createdBy: scope.me.userId,
        updatedAt: now,
        updatedBy: scope.me.userId,
      };
      store.routes.set(found.source.id, [...list, route]);
      return HttpResponse.json(route, { status: 201 });
    }),

    http.patch(url('/v1/web-logs/sources/:id/routes/:routeId'), async ({ params, request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const input = webRouteUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const found = find(scope.tenantId, params['id']);
      const route =
        found === null
          ? undefined
          : store.routes.get(found.source.id)?.find((item) => item.id === params['routeId']);
      if (route === undefined) return problem(404, 'Rota não encontrada');
      const failureCodes = input.data.failureCodes ?? route.failureCodes;
      const successCodes = input.data.successCodes ?? route.successCodes;
      if (hasCodeOverlap(failureCodes, successCodes)) {
        return problem(400, 'O mesmo código não pode ser falha e sucesso.');
      }
      Object.assign(route, {
        kind: input.data.kind ?? route.kind,
        multiplier: input.data.multiplier ?? route.multiplier,
        failureCodes,
        successCodes,
        updatedAt: iso(Date.now()),
        updatedBy: scope.me.userId,
      });
      return HttpResponse.json(route);
    }),

    http.delete(url('/v1/web-logs/sources/:id/routes/:routeId'), ({ params, request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const found = find(scope.tenantId, params['id']);
      const list = found === null ? [] : (store.routes.get(found.source.id) ?? []);
      if (found === null || !list.some((item) => item.id === params['routeId'])) {
        return problem(404, 'Rota não encontrada');
      }
      store.routes.set(
        found.source.id,
        list.filter((item) => item.id !== params['routeId']),
      );
      return new HttpResponse(null, { status: 204 });
    }),

    http.get(url('/v1/web-logs/trusted-sources'), () => {
      const scope = open('cloud_accounts:read');
      if (!scope.ok) return scope.error;
      const items = (store.trusted.get(scope.tenantId) ?? []).map((item) => ({
        ...item,
        active: Date.parse(item.expiresAt) > Date.now(),
      }));
      return HttpResponse.json(webTrustedSourceListSchema.parse({ items, limit: WEB_TRUSTED_LIMIT }));
    }),

    http.post(url('/v1/web-logs/trusted-sources'), async ({ request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const input = webTrustedSourceCreateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      if (input.data.sourceId !== null && find(scope.tenantId, input.data.sourceId) === null)
        return notFound();
      const now = new Date();
      if (!isTrustedExpiryValid(new Date(input.data.expiresAt), now)) {
        return problem(
          400,
          'A validade precisa ser no futuro, em até 365 dias.',
          'WEB_TRUSTED_EXPIRY_INVALID',
        );
      }
      const list = store.trusted.get(scope.tenantId) ?? [];
      if (list.length >= WEB_TRUSTED_LIMIT) {
        return problem(409, 'O limite é de 200 fontes confiáveis.', 'WEB_TRUSTED_LIMIT_REACHED');
      }
      if (list.some((item) => item.cidr === input.data.cidr && item.sourceId === input.data.sourceId)) {
        return problem(409, 'Esta faixa já é uma fonte confiável ali.', 'WEB_TRUSTED_DUPLICATE');
      }
      const trusted: WebTrustedSource = {
        id: newId(),
        ...input.data,
        active: true,
        createdAt: now.toISOString(),
        createdBy: scope.me.userId,
        updatedAt: now.toISOString(),
        updatedBy: scope.me.userId,
      };
      store.trusted.set(scope.tenantId, [...list, trusted]);
      return HttpResponse.json(trusted, { status: 201 });
    }),

    http.patch(url('/v1/web-logs/trusted-sources/:id'), async ({ params, request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const input = webTrustedSourceUpdateSchema.safeParse(await body(request));
      if (!input.success) return problem(400, 'Dados inválidos');
      const trusted = store.trusted.get(scope.tenantId)?.find((item) => item.id === params['id']);
      if (trusted === undefined) return problem(404, 'Fonte confiável não encontrada');
      const now = new Date();
      const { expiresAt } = input.data;
      if (expiresAt !== undefined && !isTrustedExpiryValid(new Date(expiresAt), now)) {
        return problem(
          400,
          'A validade precisa ser no futuro, em até 365 dias.',
          'WEB_TRUSTED_EXPIRY_INVALID',
        );
      }
      Object.assign(trusted, {
        kind: input.data.kind ?? trusted.kind,
        reason: input.data.reason ?? trusted.reason,
        expiresAt: expiresAt ?? trusted.expiresAt,
        active: Date.parse(expiresAt ?? trusted.expiresAt) > now.getTime(),
        updatedAt: now.toISOString(),
        updatedBy: scope.me.userId,
      });
      return HttpResponse.json(trusted);
    }),

    http.delete(url('/v1/web-logs/trusted-sources/:id'), ({ params, request }) => {
      const scope = open('cloud_accounts:write', request);
      if (!scope.ok) return scope.error;
      const list = store.trusted.get(scope.tenantId) ?? [];
      if (!list.some((item) => item.id === params['id']))
        return problem(404, 'Fonte confiável não encontrada');
      store.trusted.set(
        scope.tenantId,
        list.filter((item) => item.id !== params['id']),
      );
      return new HttpResponse(null, { status: 204 });
    }),
  ];
}

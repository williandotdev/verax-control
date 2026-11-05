import { performance } from 'node:perf_hooks';
import { type ActiveException, matchingException } from '../alerts/exception-match.js';
import type { FindingStore, LastEvents, PersistOutcome, SyncLease } from '../alerts/finding-store.js';
import type { CollectorCursor, CollectorCursors, CursorKey } from '../collectors/collector-cursor.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { CloudflareToken } from '../credentials/credential-vault.js';
import { UsageMeter } from '../usage/usage-meter.js';
import { CloudflareApiError, type CloudflareClient } from './cloudflare.client.js';
import {
  CLOUDFLARE_SECURITY_RULES,
  detectWindow,
  loginIpsOf,
  rateLimitedIps,
  type SecurityRule,
  toSecurityFindingDraft,
} from './cloudflare-security-rules.js';
import {
  batchLayout,
  chunk,
  decodeState,
  encodeState,
  type EventsQuery,
  eventsQueryNodes,
  eventsRequest,
  GRAPHQL_BUDGET_UNITS,
  lastReadableWindowEnd,
  nextReadableAt,
  type PathGroup,
  parseEvents,
  parsePaths,
  parseSettings,
  pathsRequest,
  QueryBudget,
  retentionFloor,
  SECURITY_BASELINE_MS,
  SECURITY_FIRST_READ_MS,
  SECURITY_MAX_CATCH_UP_MS,
  SECURITY_MAX_GROUPS,
  SECURITY_MAX_PATH_IPS,
  SECURITY_MAX_ZONES,
  SECURITY_MIN_BASELINE_MS,
  SECURITY_RETENTION_MARGIN_MS,
  SECURITY_WINDOW_MS,
  SECURITY_ZONES_PER_QUERY,
  type SecurityStreamState,
  settingsRequest,
  usableLimits,
  windowCeil,
  type ZoneEvents,
  type ZoneLimits,
} from './security-events.js';

/** Fluxo do cursor de cada conta: os eventos de segurança das zonas (GraphQL). */
export const CLOUDFLARE_SECURITY_STREAM = 'cloudflare_security';
/**
 * Espera depois de um estado que não se resolve sozinho em minutos (token sem `Analytics: Read`, plano sem o conjunto
 * de dados, token sem `Zone: Read`): o fluxo tenta de novo uma vez por hora, sem laço de erro.
 */
export const SECURITY_STATUS_RETRY_MS = 60 * 60 * 1000;

/** Espera depois de um 429 sem `retry-after`: o Cloudflare bloqueia o token por 5 minutos. */
const GRAPHQL_RATE_LIMIT_WAIT_MS = 5 * 60 * 1000;

/** Estado do fluxo guardado só pelo código (o nome do erro, como os da API). */
class SecurityStatus extends Error {
  constructor(readonly code: string) {
    super(`eventos de segurança do Cloudflare: ${code}`);
    this.name = code;
  }
}

/** O que a leitura deu, para a conexão da conta. */
export type SecurityOutcome =
  /** Leitura feita (inteira, até o teto da execução ou até o orçamento). */
  | { kind: 'done' }
  /** Estado que espera uma hora (permissão, plano, zonas): a auditoria segue, e o cartão mostra o código. */
  | { kind: 'status'; code: string }
  /** Falha passageira da origem (5xx, tempo esgotado, resposta fora do formato): o cursor recua. */
  | { kind: 'failed'; code: string }
  /** 429: o token inteiro espera; a auditoria e a conferência também. */
  | { kind: 'rate_limited'; retryAt: Date }
  /** Token recusado (401): a coleta para até o token ser trocado. */
  | { kind: 'blocked'; code: string };

/** As contagens da execução que este fluxo soma (as do achado são as mesmas da auditoria). */
export interface SecurityReport {
  created: number;
  duplicates: number;
  excepted: number;
  incidentsOpened: number;
  incidentsJoined: number;
  /** Janelas de 15 min lidas inteiras (todas as zonas). */
  securityWindows: number;
  /** Consultas GraphQL feitas (limites, eventos e rotas). */
  securityQueries: number;
  /** Linhas (grupos) lidas. */
  securityGroups: number;
  /** Zonas e janelas que bateram no limite de linhas (as contagens viram piso). */
  securityTruncated: number;
  /** IPs acima do limite que entraram num achado de resumo (o teto por regra, zona e janela). */
  securityFolded: number;
  /** Zonas fora da leitura: sem o conjunto de dados no plano, sem permissão ou além das 50. */
  securitySkippedZones: number;
  /** Lotes de zonas cuja janela já tinha saído da retenção do Cloudflare. */
  securityExpired: number;
  /** Execuções que pararam no orçamento de consultas do token. */
  budgetWaits: number;
}

export interface SecurityRunContext {
  now: Date;
  report: SecurityReport;
  exceptions: ReadonlyMap<string, ActiveException[]>;
  protectedItems: ReadonlyMap<string, ReadonlySet<string>>;
  lastEvents: LastEvents;
  signal: AbortSignal | undefined;
}

export interface SecurityAccount {
  id: string;
  tenantId: string;
  accountId: string;
  zones: string[];
}

export interface CloudflareSecurityEventsOptions {
  /** Janelas por execução (24 h). */
  maxWindowsPerRun?: number;
  /** A primeira leitura (24 h). */
  firstReadMs?: number;
  zonesPerQuery?: number;
  /** Linhas por zona em cada consulta. */
  maxGroups?: number;
  /** Unidades do orçamento de consultas do token a cada 5 min. */
  budgetUnits?: number;
  statusRetryMs?: number;
  /** As regras (os testes ligam a 990335). */
  rules?: readonly SecurityRule[];
}

interface Zone {
  tag: string;
  name: string;
}

/** A sessão desta leitura: o token, o orçamento, o estado guardado e o relógio da execução. */
interface Read {
  account: SecurityAccount;
  token: CloudflareToken;
  key: CursorKey;
  context: SecurityRunContext;
  budget: QueryBudget;
  state: SecurityStreamState;
  usage: UsageMeter;
  /** O horário da execução mais o tempo já passado nela (o gasto do orçamento cai no minuto certo). */
  clock: () => Date;
}

type Wait = { wait: Date };
const isWait = (value: unknown): value is Wait =>
  typeof value === 'object' && value !== null && 'wait' in value;

const NO_ACCESS: ZoneLimits = { enabled: false, maxDuration: 0, maxPageSize: 0, notOlderThan: 0 };

/**
 * Eventos de segurança das zonas do Cloudflare (fase 2, PR-13): o terceiro fluxo de cada conta no coletor do
 * Cloudflare, com o mesmo token do cofre. A cada execução:
 *
 * 1. **Zonas:** `GET /zones` da conta (com `Zone: Read`); a lista cadastrada filtra (vazia é todas, até 50, pelo nome).
 * 2. **Limites:** o nó `settings` de cada zona (`firewallEventsAdaptiveGroups`), em lotes de até 10. Zona sem o
 *    conjunto de dados no plano (`enabled: false`) ou que o token não lê fica de fora; se nenhuma sobra, a conexão
 *    mostra o estado (`security_events_not_entitled` ou `security_events_forbidden`) e o fluxo volta em uma hora, sem
 *    laço de erro. Um lote recusado é conferido zona a zona, para uma zona sem acesso não esconder as outras.
 * 3. **Janelas:** de 15 min, alinhadas em UTC, do cursor (a primeira leitura, 24 h) até a última fechada há 5 min, no
 *    máximo 24 h por execução e nunca antes da retenção da zona (`notOlderThan`, com 15 min de folga).
 * 4. **Lotes:** cada janela é lida em lotes de até 10 zonas, uma consulta por lote (os grupos por IP, ação, origem e
 *    host, até o `maxPageSize` da zona, e a base de 24 h para a regra de pico, dentro do `maxDuration`). Cada lote é
 *    gravado inteiro (achados, exceção e incidente pelo `FindingStore`) antes do próximo pedido: o progresso da janela
 *    fica na continuação, e o cursor vai para o fim da janela só quando o último lote dela está gravado. Uma falha no
 *    meio (da origem, do banco, do orçamento de tempo) recomeça do lote que não terminou; a chave única do achado
 *    (`cf/<conta>/sec:<resumo>`) não deixa a releitura duplicar.
 * 5. **Orçamento:** cada zona de cada nó conta uma consulta, e o token gasta no máximo 250 a cada 5 min (o Cloudflare
 *    permite 300). O gasto é gravado antes de cada consulta; sem orçamento, a execução para e marca a próxima leitura
 *    para quando ele voltar.
 * 6. **Medidor:** os bytes de cada resposta entram no uso do cliente (`cloudflare`), depois de o cursor avançar.
 *
 * O 429 (do HTTP ou a mensagem de orçamento esgotado do GraphQL) esvazia o orçamento e adia este fluxo; quem chama
 * adia também a auditoria e a conferência (o limite é do token inteiro). O 401 para a coleta, como na auditoria.
 */
export class CloudflareSecurityEvents {
  private readonly maxWindowsPerRun: number;
  private readonly firstReadMs: number;
  private readonly zonesPerQuery: number;
  private readonly maxGroups: number;
  private readonly budgetUnits: number;
  private readonly statusRetryMs: number;
  private readonly rules: readonly SecurityRule[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CloudflareClient,
    private readonly store: FindingStore,
    private readonly cursors: CollectorCursors,
    private readonly lease: SyncLease,
    options: CloudflareSecurityEventsOptions = {},
  ) {
    this.maxWindowsPerRun = options.maxWindowsPerRun ?? SECURITY_MAX_CATCH_UP_MS / SECURITY_WINDOW_MS;
    this.firstReadMs = options.firstReadMs ?? SECURITY_FIRST_READ_MS;
    this.zonesPerQuery = options.zonesPerQuery ?? SECURITY_ZONES_PER_QUERY;
    this.maxGroups = options.maxGroups ?? SECURITY_MAX_GROUPS;
    this.budgetUnits = options.budgetUnits ?? GRAPHQL_BUDGET_UNITS;
    this.statusRetryMs = options.statusRetryMs ?? SECURITY_STATUS_RETRY_MS;
    this.rules = options.rules ?? CLOUDFLARE_SECURITY_RULES;
    if (
      !(this.maxWindowsPerRun >= 1) ||
      !(this.zonesPerQuery >= 1 && this.zonesPerQuery <= SECURITY_ZONES_PER_QUERY) ||
      !(this.maxGroups >= 1 && this.maxGroups <= SECURITY_MAX_GROUPS) ||
      !(this.budgetUnits >= 1 && this.budgetUnits <= GRAPHQL_BUDGET_UNITS)
    ) {
      throw new RangeError('limites dos eventos de segurança fora da faixa');
    }
  }

  async read(
    account: SecurityAccount,
    token: CloudflareToken,
    cursor: CollectorCursor,
    key: CursorKey,
    context: SecurityRunContext,
  ): Promise<SecurityOutcome> {
    const { now } = context;
    const started = performance.now();
    const state = decodeState(cursor.continuation);
    const read: Read = {
      account,
      token,
      key,
      context,
      budget: new QueryBudget(this.budgetUnits, state.budget),
      state,
      usage: new UsageMeter(),
      clock: () => new Date(now.getTime() + Math.max(0, Math.round(performance.now() - started))),
    };
    try {
      return await this.collect(read, cursor);
    } catch (error) {
      if (!(error instanceof CloudflareApiError)) throw error;
      return this.failed(read, error);
    }
  }

  private encode(read: Read): string {
    return encodeState({ budget: read.budget.snapshot(read.clock()), progress: read.state.progress });
  }

  /** Grava o progresso (e o orçamento) e mede o uso lido até aqui. */
  private async advance(read: Read, step: { cursorAt?: Date; nextRunAt: Date }): Promise<void> {
    await this.cursors.advance(
      read.key,
      {
        ...(step.cursorAt !== undefined && { cursorAt: step.cursorAt }),
        continuation: this.encode(read),
        nextRunAt: step.nextRunAt,
      },
      read.context.now,
    );
    await read.usage.flush(this.prisma);
  }

  /** Gasta o orçamento de uma consulta e grava o gasto antes de fazê-la; sem orçamento, quando ele volta. */
  private async spend(read: Read, units: number): Promise<Wait | null> {
    if (!read.budget.take(units, read.clock())) return { wait: read.budget.availableAt(units, read.clock()) };
    await this.cursors.note(read.key, this.encode(read));
    read.context.report.securityQueries += 1;
    return null;
  }

  private async waitBudget(read: Read, wait: Wait): Promise<SecurityOutcome> {
    read.context.report.budgetWaits += 1;
    await this.advance(read, { nextRunAt: wait.wait });
    return { kind: 'done' };
  }

  private async collect(read: Read, cursor: CollectorCursor): Promise<SecurityOutcome> {
    const { now, report } = read.context;
    const lastEnd = lastReadableWindowEnd(now);
    const zones = await this.zonesOf(read);
    if (zones.length === 0) {
      read.state.progress = null;
      await this.advance(read, { cursorAt: lastEnd, nextRunAt: nextReadableAt(lastEnd) });
      return { kind: 'done' };
    }
    const limits = await this.limitsOf(read, zones);
    if (isWait(limits)) return this.waitBudget(read, limits);
    const usable = zones.filter((zone) => usableLimits(limits.get(zone.tag) ?? NO_ACCESS));
    report.securitySkippedZones += zones.length - usable.length;
    if (usable.length === 0) {
      // O token não lê nenhuma zona (alguma ficou de fora da resposta) ou o plano não dá o conjunto de dados.
      const code = zones.some((zone) => !limits.has(zone.tag))
        ? 'security_events_forbidden'
        : 'security_events_not_entitled';
      return this.status(read, code);
    }

    const retention = Math.max(...usable.map((zone) => (limits.get(zone.tag) ?? NO_ACCESS).notOlderThan));
    const floor = windowCeil(new Date(now.getTime() - retention * 1000 + SECURITY_RETENTION_MARGIN_MS));
    const from = cursor.cursorAt ?? new Date(lastEnd.getTime() - this.firstReadMs);
    let start = windowCeil(new Date(Math.max(from.getTime(), floor.getTime())));
    const runEnd = new Date(
      Math.min(lastEnd.getTime(), start.getTime() + this.maxWindowsPerRun * SECURITY_WINDOW_MS),
    );
    for (; start < runEnd; start = new Date(start.getTime() + SECURITY_WINDOW_MS)) {
      read.context.signal?.throwIfAborted();
      const wait = await this.readWindow(read, usable, limits, start);
      if (wait !== null) return this.waitBudget(read, wait);
      report.securityWindows += 1;
    }
    read.state.progress = null;
    await this.advance(read, {
      cursorAt: runEnd,
      nextRunAt: runEnd.getTime() >= lastEnd.getTime() ? nextReadableAt(lastEnd) : now,
    });
    return { kind: 'done' };
  }

  /** Zonas da conta pelo ID, filtradas pela lista cadastrada (vazia é todas), até 50, pelo nome. */
  private async zonesOf(read: Read): Promise<Zone[]> {
    const { account, token, context } = read;
    const listed = await this.client.zones(token, account.accountId, context.signal);
    const wanted = new Set(account.zones.map((zone) => zone.toLowerCase()));
    const zones = [...listed.ids]
      .map(([tag, name]) => ({ tag, name }))
      .filter((zone) => wanted.size === 0 || wanted.has(zone.name))
      .sort((a, b) => (a.name === b.name ? (a.tag < b.tag ? -1 : 1) : a.name < b.name ? -1 : 1));
    if (zones.length > SECURITY_MAX_ZONES)
      context.report.securitySkippedZones += zones.length - SECURITY_MAX_ZONES;
    return zones.slice(0, SECURITY_MAX_ZONES);
  }

  /** Os limites de cada zona (nó `settings`), em lotes. Zona que o token não lê fica fora do mapa. */
  private async limitsOf(read: Read, zones: readonly Zone[]): Promise<Map<string, ZoneLimits> | Wait> {
    const limits = new Map<string, ZoneLimits>();
    for (const batch of chunk(
      zones.map((zone) => zone.tag),
      this.zonesPerQuery,
    )) {
      const got = await this.settingsOf(read, batch);
      if (isWait(got)) return got;
      for (const [tag, value] of got) limits.set(tag, value);
    }
    return limits;
  }

  private async settingsOf(read: Read, tags: readonly string[]): Promise<Map<string, ZoneLimits> | Wait> {
    const wait = await this.spend(read, tags.length);
    if (wait !== null) return wait;
    try {
      const { data, bytes } = await this.client.graphql(
        read.token,
        settingsRequest(tags),
        read.context.signal,
      );
      read.usage.add(read.account.tenantId, 'cloudflare', bytes, 0, read.context.now);
      const parsed = parseSettings(data, tags);
      if (parsed === null) throw new CloudflareApiError('bad_response', 200);
      return parsed;
    } catch (error) {
      const code = error instanceof CloudflareApiError ? error.code : null;
      if (code !== 'security_events_forbidden' && code !== 'security_events_not_entitled') throw error;
      if (tags.length === 1) {
        // Sem permissão: fora do mapa. Sem o conjunto de dados no plano: no mapa, desligada.
        return code === 'security_events_forbidden' ? new Map() : new Map([[tags[0] ?? '', NO_ACCESS]]);
      }
      // Um lote recusado: zona a zona, para uma sem acesso não esconder as outras.
      const merged = new Map<string, ZoneLimits>();
      for (const tag of tags) {
        const one = await this.settingsOf(read, [tag]);
        if (isWait(one)) return one;
        for (const [zone, value] of one) merged.set(zone, value);
      }
      return merged;
    }
  }

  /**
   * Uma janela, lote a lote, seguindo do lote gravado (quando a divisão das zonas é a mesma). Devolve a espera do
   * orçamento, se ele acabou no meio; o progresso fica gravado.
   */
  private async readWindow(
    read: Read,
    usable: readonly Zone[],
    limits: ReadonlyMap<string, ZoneLimits>,
    windowStart: Date,
  ): Promise<Wait | null> {
    const { now } = read.context;
    const windowEnd = new Date(windowStart.getTime() + SECURITY_WINDOW_MS);
    // Só as zonas que ainda guardam esta janela (a retenção vale por zona).
    const zones = usable.filter(
      (zone) => windowStart >= retentionFloor(limits.get(zone.tag) ?? NO_ACCESS, now),
    );
    const batches = chunk(zones, this.zonesPerQuery);
    const layout = batchLayout(batches.map((batch) => batch.map((zone) => zone.tag)));
    const saved = read.state.progress;
    const resume =
      saved !== null && saved.windowStart.getTime() === windowStart.getTime() && saved.layout === layout
        ? saved.done
        : 0;
    for (let index = resume; index < batches.length; index += 1) {
      const batch = batches[index] ?? [];
      read.state.progress = { windowStart, done: index, layout };
      const query = this.eventsQuery(batch, limits, windowStart, windowEnd, now);
      const wait = await this.spend(read, batch.length * eventsQueryNodes(query));
      if (wait !== null) {
        // O que já foi gravado fica; a próxima execução segue deste lote.
        return wait;
      }
      const results = await this.queryEvents(read, query);
      if (results !== null) {
        const login = await this.loginIps(read, results, query, limits);
        await this.persist(read, batch, results, query, login);
      }
      await this.lease.renew();
      const last = index + 1 === batches.length;
      read.state.progress = last ? null : { windowStart, done: index + 1, layout };
      // O lote está gravado: o progresso anda (e, no último, o cursor vai para o fim da janela).
      await this.advance(read, { ...(last && { cursorAt: windowEnd }), nextRunAt: now });
    }
    if (batches.length === 0) {
      read.state.progress = null;
      await this.advance(read, { cursorAt: windowEnd, nextRunAt: now });
    }
    return null;
  }

  /** A consulta de um lote: o limite de linhas e a base de 24 h dentro dos limites de todas as zonas do lote. */
  private eventsQuery(
    batch: readonly Zone[],
    limits: ReadonlyMap<string, ZoneLimits>,
    since: Date,
    until: Date,
    now: Date,
  ): EventsQuery {
    const zoneLimits = batch.map((zone) => limits.get(zone.tag) ?? NO_ACCESS);
    const limit = Math.min(this.maxGroups, ...zoneLimits.map((value) => value.maxPageSize));
    const maxDurationMs = Math.min(...zoneLimits.map((value) => value.maxDuration * 1000));
    const floor = Math.max(...zoneLimits.map((value) => retentionFloor(value, now).getTime()));
    const baselineSince = windowCeil(
      new Date(Math.max(since.getTime() - SECURITY_BASELINE_MS, since.getTime() - maxDurationMs, floor)),
    );
    const span = since.getTime() - baselineSince.getTime();
    return {
      zoneTags: batch.map((zone) => zone.tag),
      since,
      until,
      limit,
      baselineSince: span >= SECURITY_MIN_BASELINE_MS ? baselineSince : null,
    };
  }

  /** Os eventos do lote; `null` quando a janela já saiu da retenção (o lote é pulado). */
  private async queryEvents(read: Read, query: EventsQuery): Promise<ZoneEvents[] | null> {
    let result;
    try {
      result = await this.client.graphql(read.token, eventsRequest(query), read.context.signal);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.code === 'security_events_expired') {
        read.context.report.securityExpired += 1;
        return null;
      }
      throw error;
    }
    const zones = parseEvents(result.data, query);
    if (zones === null) throw new CloudflareApiError('bad_response', 200);
    const rows = zones.reduce((sum, zone) => sum + zone.groups.length, 0);
    read.usage.add(read.account.tenantId, 'cloudflare', result.bytes, rows, read.context.now);
    return zones;
  }

  /**
   * Os IPs que dispararam o limite de taxa numa rota de login, por zona: uma consulta a mais, só quando a janela teve
   * limite de taxa. É complemento (decide o nível da 990332): se falhar ou se o orçamento não cobrir, o achado sai com
   * o nível das outras rotas. Só o 429 e o token recusado sobem, porque valem para o token inteiro.
   */
  private async loginIps(
    read: Read,
    results: readonly ZoneEvents[],
    query: EventsQuery,
    limits: ReadonlyMap<string, ZoneLimits>,
  ): Promise<Map<string, Set<string>>> {
    const byZone = new Map<string, Set<string>>();
    const limited = results.filter((zone) => rateLimitedIps(zone.groups).length > 0);
    if (limited.length === 0) return byZone;
    const ips = [...new Set(limited.flatMap((zone) => rateLimitedIps(zone.groups)))]
      .sort()
      .slice(0, SECURITY_MAX_PATH_IPS);
    const zoneTags = limited.map((zone) => zone.zoneTag);
    const limit = Math.min(
      this.maxGroups,
      ...zoneTags.map((tag) => (limits.get(tag) ?? NO_ACCESS).maxPageSize),
    );
    const pathsQuery = { zoneTags, since: query.since, until: query.until, clientIPs: ips, limit };
    if ((await this.spend(read, zoneTags.length)) !== null) return byZone;
    let paths: Map<string, PathGroup[]> | null;
    try {
      const result = await this.client.graphql(read.token, pathsRequest(pathsQuery), read.context.signal);
      paths = parsePaths(result.data, pathsQuery);
      if (paths !== null) {
        const rows = [...paths.values()].reduce((sum, rowsOf) => sum + rowsOf.length, 0);
        read.usage.add(read.account.tenantId, 'cloudflare', result.bytes, rows, read.context.now);
      }
    } catch (error) {
      if (
        error instanceof CloudflareApiError &&
        (error.code === 'rate_limited' || error.code === 'credential_rejected')
      ) {
        throw error;
      }
      if (!(error instanceof CloudflareApiError)) throw error;
      paths = null;
    }
    for (const [tag, rows] of paths ?? []) byZone.set(tag, loginIpsOf(rows));
    return byZone;
  }

  /** Os achados de cada zona do lote, com a exceção e o incidente na mesma transação (`FindingStore`). */
  private async persist(
    read: Read,
    batch: readonly Zone[],
    results: readonly ZoneEvents[],
    query: EventsQuery,
    loginIps: ReadonlyMap<string, ReadonlySet<string>>,
  ): Promise<void> {
    const { account, context } = read;
    const { report, now } = context;
    const names = new Map(batch.map((zone) => [zone.tag, zone.name]));
    const baselineWindows =
      query.baselineSince === null
        ? 0
        : (query.since.getTime() - query.baselineSince.getTime()) / SECURITY_WINDOW_MS;
    for (const zone of results) {
      report.securityGroups += zone.groups.length;
      if (zone.truncated) report.securityTruncated += 1;
      if (zone.groups.length > 0) context.lastEvents.see(account.tenantId, account.accountId, query.since);
      const { detections, folded } = detectWindow(
        { zone, baselineWindows, loginIps: loginIps.get(zone.zoneTag) ?? new Set() },
        this.rules,
      );
      report.securityFolded += folded;
      for (const detection of detections) {
        const draft = toSecurityFindingDraft(
          detection,
          account,
          { tag: zone.zoneTag, name: names.get(zone.zoneTag) ?? zone.zoneTag },
          query.since,
        );
        const exception = matchingException(draft, context.exceptions.get(account.tenantId) ?? [], now);
        const outcome = await this.store.persist(
          draft,
          exception,
          context.protectedItems.get(account.tenantId) ?? new Set(),
          now,
        );
        count(report, outcome);
      }
    }
  }

  private async status(read: Read, code: string): Promise<SecurityOutcome> {
    const { now } = read.context;
    await this.cursors.note(read.key, this.encode(read));
    await this.cursors.fail(read.key, new SecurityStatus(code), now, {
      retryAt: new Date(now.getTime() + this.statusRetryMs),
    });
    return { kind: 'status', code };
  }

  /** Falha da origem: o gasto do orçamento fica gravado, e o cursor não anda. */
  private async failed(read: Read, error: CloudflareApiError): Promise<SecurityOutcome> {
    const { now } = read.context;
    switch (error.code) {
      case 'credential_rejected':
        await this.cursors.note(read.key, this.encode(read));
        await this.cursors.fail(read.key, error, now, {
          retryAt: new Date(now.getTime() + this.statusRetryMs),
        });
        return { kind: 'blocked', code: error.code };
      case 'rate_limited': {
        // O Cloudflare bloqueia o token: o orçamento fica vazio, e nada sai antes da espera.
        read.budget.exhaust(read.clock());
        await this.cursors.note(read.key, this.encode(read));
        const retryAt = new Date(now.getTime() + (error.retryAfterMs ?? GRAPHQL_RATE_LIMIT_WAIT_MS));
        await this.cursors.fail(read.key, error, now, { retryAt });
        return { kind: 'rate_limited', retryAt };
      }
      case 'credential_forbidden':
        // 403 na lista de zonas: falta `Zone: Read` (não para a auditoria).
        return this.status(read, 'zones_forbidden');
      case 'security_events_forbidden':
      case 'security_events_not_entitled':
        return this.status(read, error.code);
      default:
        await this.cursors.note(read.key, this.encode(read));
        await this.cursors.fail(read.key, error, now);
        return { kind: 'failed', code: error.code };
    }
  }
}

function count(report: SecurityReport, outcome: PersistOutcome): void {
  if (outcome === 'duplicate') {
    report.duplicates += 1;
    return;
  }
  report.created += 1;
  if (outcome === 'excepted') report.excepted += 1;
  if (outcome === 'opened') report.incidentsOpened += 1;
  if (outcome === 'joined') report.incidentsJoined += 1;
}

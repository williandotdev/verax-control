import { type AlbLine, parseAlbLine } from './alb/alb-line.js';
import type { ClientClass, ClientClassifier } from './client-class.js';
import { methodOf, type WebMethod } from './evidence.js';
import { EvictedLedger, isSampled, MIN_LEDGER_CELLS } from './evicted.js';
import { IntSet, type KeyedHash } from './hash.js';
import { clientKeyOf, parseIp } from './ip.js';
import { SLOT_MS, type WebLimits } from './limits.js';
import { DEFAULT_FAILURE_CODES, isDefaultSuccess, LOGIN_METHODS, loginRouteLength } from './login-paths.js';
import { maskPath, type NormalPath, normalizePath } from './path.js';
import { matchProbe, type ProbeMatch } from './probes.js';
import type { RouteTable, WebRouteKind } from './routes.js';
import {
  classifyUserAgent,
  sampleUserAgent,
  UA_FAMILIES,
  type UaInfo,
  WORDLIST_TOOLS,
} from './user-agent.js';

/**
 * Contagem por slot de 5 minutos, com teto de memória em tudo que o atacante pode multiplicar.
 *
 * **O que acontece no teto** (nunca é "parar de contar em silêncio"): os registros de menor suspeita saem, os de maior
 * ficam, e o resultado sai com `truncated` (as contagens viram piso). Encher a memória com milhares de IPs de uma
 * requisição não esconde quem tem dezenas: quem sai é quem tem menos. Os pares de rota de login que saem continuam na
 * contagem da rota (990407).
 */

/**
 * Cópia do texto: uma fatia de string mantém viva na memória a linha inteira de onde saiu, e o que fica guardado não pode
 * segurar linhas de até 64 KB.
 */
export function detach(text: string): string {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0xff) return Buffer.from(text, 'utf16le').toString('utf16le');
  }
  return Buffer.from(text, 'latin1').toString('latin1');
}

/** Host fora do teto do slot. */
export const OVERFLOW_HOST = '*';
/** A rota comum das tentativas além do teto de rotas. */
const OVERFLOW_ROUTE = 'h:*';
const OVERFLOW_LABEL = '/{etc}';
const NO_OFFSET = -1;
/** As falhas de um par de cliente e rota, em passos de 10 s dentro do slot (`LoginCell.series`). */
export const SERIES_STEP_MS = 10_000;
export const SERIES_STEPS = SLOT_MS / SERIES_STEP_MS;
const INLINE_PATHS = 16;
const PROMOTE_ERRORS = 8;
const MAX_PATHS_PER_CLIENT = 512;
const MAX_UAS_PER_CLIENT = 32;
const DETAIL_AFTER = 3;
const MAX_DETAIL_ROUTES = 8;
const MAX_DETAIL_SAMPLES = 4;
/** Clientes por grupo de respostas, e além do primeiro de cada grupo, por slot. */
const MAX_ANSWERED_CLIENTS = 20;
const MAX_ANSWERED_EXTRA = 1_000;
const MAX_SIZES = 32;
const MAX_ROOT_SIZES = 16;
const MAX_DECLARED_ROUTES = 100;
const CACHE_ENTRIES = 2_048;
const CACHED_PATH_CHARS = 256;
const IDENTITY_ENTRIES = 8_192;

export interface RawSample {
  atMs: number;
  method: WebMethod;
  path: string;
  status: number;
  bytes: number;
  objectKey: string;
}

export interface ClientDetail {
  routes: Map<string, number>;
  samples: RawSample[];
  userAgent: string | null;
}

/** Quem é o cliente: a chave das contagens, o endereço visto primeiro (no IPv6, um dos do /64) e a classe. */
export interface ClientRef {
  key: string;
  ip: string;
  cls: ClientClass;
  /** Hash com chave do cliente (`tagOf`); null até alguém precisar. */
  tag: number | null;
}

/** Um cliente num slot. */
export class ClientEntry {
  readonly ref: ClientRef;
  total = 0;
  blocked = 0;
  ok = 0;
  redirect = 0;
  s400 = 0;
  s401 = 0;
  s403 = 0;
  s404 = 0;
  s405 = 0;
  s422 = 0;
  s429 = 0;
  s4xx = 0;
  s5xx = 0;
  tool = 0;
  toolBlocked = 0;
  toolWordlist = 0;
  probes = 0;
  probesBlocked = 0;
  /** Máscaras de bits das famílias de sonda: todas, e as que passaram pelo WAF. */
  families = 0;
  openFamilies = 0;
  /** Deslocamento em milissegundos dentro do slot. */
  first = SLOT_MS;
  last = 0;
  /** Host mais comum (voto da maioria). */
  host: string | null = null;
  hostVotes = 0;
  /** Famílias de User-Agent: um bit para cada (são 34; duas máscaras). */
  uaLow = 0;
  uaHigh = 0;
  firstUa: number | null = null;
  uas: number[] | null = null;
  /** Um caminho só (o caso comum), uma lista curta ou um conjunto. */
  paths: number | number[] | IntSet | null = null;
  notables = 0;
  loginFailures = 0;
  detail: ClientDetail | null = null;
  /** Bits das regras 990401, 990402 e 990404 que casaram numa janela com este slot (o resumo do dia). */
  flags = 0;
  truncated = false;
  /** Faltou lugar para contar os caminhos distintos: a contagem não diz nada. */
  pathsLost = false;

  constructor(ref: ClientRef) {
    this.ref = ref;
  }

  get errors(): number {
    return this.s400 + this.s403 + this.s404 + this.s405;
  }

  get suspicious(): boolean {
    return this.tool > 0 || this.probes > 0 || this.errors > 0;
  }

  /** Quem fica quando falta memória. */
  get score(): number {
    if (this.flags !== 0) return 1023;
    const raw =
      8 * this.tool + 8 * this.probes + 4 * this.loginFailures + 2 * this.errors + (this.uas?.length ?? 0);
    return Math.min(1022, raw);
  }
}

/** Um cliente numa rota de login, num slot. */
export class LoginCell {
  attempts = 0;
  /** Falhas que chegaram à aplicação. */
  open = 0;
  /** Falhas barradas pelo WAF: tentativas, não recusas de credencial. */
  blocked = 0;
  successes = 0;
  /** A primeira e a última tentativa, dentro do slot. */
  first = SLOT_MS;
  last = 0;
  /**
   * O primeiro e o último sucesso bastam para achar "falhas e depois um sucesso": se um sucesso do meio satisfaz a
   * condição, um dos dois também satisfaz (o último tem mais falhas antes; o primeiro está mais perto das de slots
   * anteriores).
   */
  firstSuccess = NO_OFFSET;
  lastSuccess = NO_OFFSET;
  /** As três primeiras falhas e, da quarta em diante, a série de 10 s. */
  early: number[] = [];
  series = -1;

  get failures(): number {
    return this.open + this.blocked;
  }
}

export interface LoginRoute {
  /** Igual entre hosts: a força bruta que troca de host não zera a contagem por cliente. */
  routeId: string;
  host: string | null;
  label: string;
  kind: WebRouteKind;
  declared: boolean;
  /** A rota declarada tem códigos de falha e de sucesso. */
  declaredCodes: boolean;
  multiplier: number;
  attempts: number;
  /** Recusas da aplicação que não são limite de taxa: provam que a rota distingue falha de sucesso. */
  hard: number;
  cells: Map<string, { client: ClientRef; cell: LoginCell }>;
  /** Quem saiu por falta de memória, com as falhas (para a 990407); null se ninguém. */
  evicted: EvictedLedger | null;
}

/** Sondas de família secreta respondidas, por host, assinatura e tamanho (2%). */
export interface AnsweredGroup {
  host: string | null;
  match: ProbeMatch;
  bytes: number;
  count: number;
  clients: Map<string, { client: ClientRef; count: number; first: RawSample; lastMs: number }>;
  moreClients: boolean;
}

interface SizeEntry {
  bytes: number;
  signatures: Set<string>;
}

/** Os dois primeiros clientes a pedir. */
interface Seen {
  a: string;
  b: string | null;
}

/** A página inicial de um host: quem a pediu e os tamanhos vistos. */
interface RootPage extends Seen {
  sizes: (Seen & { bytes: number })[];
}

/** Alguém além do cliente dado pediu; sem cliente, dois pediram. */
const byOther = (seen: Seen, clientKey: string | null): boolean =>
  seen.b !== null || (clientKey !== null && seen.a !== clientKey);

function see(seen: Seen, clientKey: string): void {
  if (seen.b === null && seen.a !== clientKey) seen.b = clientKey;
}

export class Slot {
  /** `fim / 5 min`. */
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly late: boolean;
  clients = new Map<string, ClientEntry>();
  login = new Map<string, LoginRoute>();
  answered = new Map<string, AnsweredGroup>();
  probeSizes = new Map<string, SizeEntry[]>();
  roots = new Map<string, RootPage>();
  hosts = new Map<string, string>();
  series = new Uint16Array(0);
  seriesUsed = 0;
  answeredFull = false;
  answeredDropped = 0;
  answeredExtra = 0;
  lines = 0;
  direct = 0;
  unverified = 0;
  /** Requisições sem registro próprio (o teto de clientes). */
  foldedRequests = 0;
  foldedClients = 0;
  truncated = false;
  closed = false;
  /** Saiu das janelas de 15 minutos. */
  trimmed = false;

  constructor(index: number, late: boolean) {
    this.index = index;
    this.endMs = index * SLOT_MS;
    this.startMs = this.endMs - SLOT_MS;
    this.late = late;
  }
}

export interface TallyCounters {
  lines: number;
  malformed: number;
  foreign: number;
  ambiguous: number;
  skewed: number;
}

interface PathInfo {
  path: NormalPath;
  hash: number | null;
  probe: ProbeMatch | null;
  loginLength: number;
  masked: string | null;
  loginLabel: string | null;
}

interface AgentInfo {
  info: UaInfo;
  hash: number;
  bit: number;
}

export type LineOutcome = 'counted' | 'malformed' | 'foreign';

/** Respostas sem o conteúdo do caminho. */
const BODILESS_METHODS: ReadonlySet<string> = new Set(['HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);

/** Rota que junta o que passou do teto (o `*` não é nome de host: o SNI não o traz). */
const isOverflow = (route: LoginRoute): boolean => route.host === OVERFLOW_HOST;

/** Os tamanhos diferem até 2%. */
export function sameSize(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.02 * Math.max(a, b);
}

export class WebTally {
  readonly slots = new Map<number, Slot>();
  readonly late = new Map<number, Slot>();
  readonly counters: TallyCounters = { lines: 0, malformed: 0, foreign: 0, ambiguous: 0, skewed: 0 };
  private readonly loadBalancer: string;
  private readonly hash: KeyedHash;
  private readonly limits: WebLimits;
  private routes: RouteTable;
  private classifier: ClientClassifier;
  private readonly paths = new Map<string, PathInfo>();
  private readonly agents = new Map<string, AgentInfo>();
  private readonly identities = new Map<string, ClientRef>();
  private clients = 0;
  private loginCells = 0;
  private details = 0;
  private pathSets = 0;
  private hashCells = 0;
  /** Posições dos registros de quem saiu, além do tamanho mínimo de cada um. */
  private evictedCells = 0;
  /** Trocas de classe já feitas. */
  private generation = 0;

  constructor(options: {
    loadBalancer: string;
    hash: KeyedHash;
    limits: WebLimits;
    routes: RouteTable;
    classifier: ClientClassifier;
  }) {
    this.loadBalancer = options.loadBalancer;
    this.hash = options.hash;
    this.limits = options.limits;
    this.routes = options.routes;
    this.classifier = options.classifier;
  }

  /**
   * Troca a configuração: as rotas valem para as linhas seguintes; a classe dos clientes, já para tudo o que está na
   * memória (`reconcile`). Devolve se alguma classe pode ter mudado: a tarefa configura a cada passo, quase sempre igual.
   */
  configure(routes: RouteTable, classifier: ClientClassifier): boolean {
    const changed = classifier.signature !== this.classifier.signature;
    this.routes = routes;
    this.classifier = classifier;
    if (!changed) return false;
    this.identities.clear();
    this.reconcile();
    return true;
  }

  /**
   * Acerta a classe de quem já está na memória, em todos os slots (registros, pares de rota de login e respostas a sondas).
   * A linha não diz quem está atrás do endereço, só o endereço: quem mudou de classe é a declaração, e o passado se lê
   * assim:
   *
   * - **direto que virou proxy, CDN ou privado:** ele já era isso quando as linhas chegaram. O que foi contado passa inteiro
   *   para a classe nova: as regras por IP param na hora, e as marcas do resumo do dia caem;
   * - **proxy que virou direto:** o que foi contado pode ser de centenas de visitantes, e não vira acusação a um IP. Fica
   *   de lado, com a classe antiga (`aside`), e as linhas novas começam do zero, no mesmo slot aberto inclusive;
   * - **de uma classe indireta para outra:** só muda o nome.
   *
   * A 990407 não liga para a classe e conta o mesmo endereço uma vez só, dos dois lados.
   */
  private reconcile(): void {
    const memo = new Map<string, ClientClass>();
    const target = new Map<ClientRef, ClientClass>();
    const visit = (ref: ClientRef): void => {
      if (target.has(ref)) return;
      let cls = memo.get(ref.ip);
      if (cls === undefined) {
        const ip = parseIp(ref.ip);
        cls = ip === null ? ref.cls : this.classifier.classify(ip);
        memo.set(ref.ip, cls);
      }
      target.set(ref, cls);
    };
    const all = [...this.slots.values(), ...this.late.values()];
    for (const slot of all) {
      for (const entry of slot.clients.values()) visit(entry.ref);
      for (const route of slot.login.values()) for (const { client } of route.cells.values()) visit(client);
      for (const group of slot.answered.values())
        for (const { client } of group.clients.values()) visit(client);
    }
    this.generation += 1;
    const becameDirect = (id: string, ref: ClientRef): boolean =>
      id === ref.key && ref.cls !== 'direct' && target.get(ref) === 'direct';
    for (const slot of all) {
      for (const entry of slot.clients.values())
        reclassify(slot, entry, target.get(entry.ref) ?? entry.ref.cls);
      this.setAside(slot.clients, (entry) => entry.ref, becameDirect);
      for (const route of slot.login.values())
        this.setAside(route.cells, (item) => item.client, becameDirect);
      for (const group of slot.answered.values())
        this.setAside(group.clients, (item) => item.client, becameDirect);
    }
    for (const [ref, cls] of target) if (cls !== 'direct') ref.cls = cls;
  }

  /** Tira da chave do endereço o que foi contado quando ele não era direto. */
  private setAside<T>(
    items: Map<string, T>,
    refOf: (item: T) => ClientRef,
    moves: (id: string, ref: ClientRef) => boolean,
  ): void {
    const moving = [...items].filter(([id, item]) => moves(id, refOf(item)));
    for (const [id, item] of moving) {
      items.delete(id);
      // A chave de lado nunca é um endereço, e a geração a separa da de uma troca anterior no mesmo slot.
      items.set(`${refOf(item).cls}!${id}!${this.generation}`, item);
    }
  }

  /** Registros na memória (para os testes e para as métricas da tarefa). */
  get usage(): {
    clients: number;
    loginCells: number;
    details: number;
    pathSets: number;
    hashCells: number;
    evictedCells: number;
  } {
    return {
      clients: this.clients,
      loginCells: this.loginCells,
      details: this.details,
      pathSets: this.pathSets,
      hashCells: this.hashCells,
      evictedCells: this.evictedCells,
    };
  }

  slot(index: number, late: boolean): Slot {
    const store = late ? this.late : this.slots;
    let slot = store.get(index);
    if (slot === undefined) {
      slot = new Slot(index, late);
      store.set(index, slot);
    }
    return slot;
  }

  ingest(slot: Slot, objectKey: string, text: string): LineOutcome {
    const line = parseAlbLine(text);
    if (line === null) {
      this.counters.malformed += 1;
      return 'malformed';
    }
    if (line.loadBalancer !== this.loadBalancer) {
      this.counters.foreign += 1;
      return 'foreign';
    }
    const entry = this.clientOf(slot, line.clientIp);
    if (entry === 'malformed') {
      this.counters.malformed += 1;
      return 'malformed';
    }
    this.counters.lines += 1;
    slot.lines += 1;
    if (line.ambiguous) this.counters.ambiguous += 1;
    if (entry === null) {
      slot.foldedRequests += 1;
      return 'counted';
    }
    if (entry.ref.cls === 'direct') slot.direct += 1;
    else if (entry.ref.cls === 'unverified') slot.unverified += 1;

    const offset = this.offsetOf(slot, line.timeMs);
    const host = line.domainName === null ? null : this.hostOf(slot, line.domainName);
    const info = line.path === null ? null : this.pathOf(line.path);
    const agent = this.agentOf(line.userAgent);
    this.countRequest(entry, line, offset, host, agent);
    if (info !== null) {
      this.countPath(entry, info);
      this.countProbe(slot, entry, line, info, host, offset, objectKey);
      // A página inicial é o `/` cru: um caminho que a normalização reduz a ela pode ser outro no servidor.
      if (line.path === '/') this.recordRoot(slot, entry, line, host);
    }
    const login = info === null ? null : this.countLogin(slot, entry, line, info, host, offset);
    const error = isRouteError(line.elbStatus);
    const probe = info?.probe ?? null;
    const isProbe = probe !== null && countsAsProbe(probe, line.elbStatus);
    if (agent.info.tool !== null || isProbe || error || login === 'failure') {
      entry.notables += 1;
      this.keepDetail(slot, entry, line, info, offset, objectKey);
    } else if (login === 'success' && entry.loginFailures > 0) {
      this.keepDetail(slot, entry, line, info, offset, objectKey);
    }
    return 'counted';
  }

  /** O horário dentro do slot: a linha fora do intervalo do arquivo conta na borda mais próxima. */
  private offsetOf(slot: Slot, timeMs: number): number {
    const offset = timeMs - slot.startMs;
    if (offset < -SLOT_MS || offset > 2 * SLOT_MS) this.counters.skewed += 1;
    return Math.min(SLOT_MS - 1, Math.max(0, offset));
  }

  private clientOf(slot: Slot, rawIp: string): ClientEntry | null | 'malformed' {
    const direct = slot.clients.get(rawIp);
    if (direct !== undefined) return direct;
    let identity = this.identities.get(rawIp);
    if (identity === undefined) {
      const ip = parseIp(rawIp);
      if (ip === null) return 'malformed';
      const text = detach(rawIp);
      const key = clientKeyOf(ip);
      identity = {
        key,
        ip: ip.version === 4 ? key : text.toLowerCase(),
        cls: this.classifier.classify(ip),
        tag: null,
      };
      if (this.identities.size >= IDENTITY_ENTRIES) this.identities.clear();
      this.identities.set(text, identity);
    }
    const known = slot.clients.get(identity.key);
    if (known !== undefined) return known;
    if (this.clients >= this.limits.maxClients) {
      this.shedClients(slot);
      if (this.clients >= this.limits.maxClients) {
        slot.truncated = true;
        return null;
      }
    }
    const entry = new ClientEntry(identity);
    slot.clients.set(identity.key, entry);
    this.clients += 1;
    return entry;
  }

  private hostOf(slot: Slot, domain: string): string {
    const known = slot.hosts.get(domain);
    if (known !== undefined) return known;
    if (slot.hosts.size >= this.limits.maxHosts) {
      slot.truncated = true;
      return OVERFLOW_HOST;
    }
    const host = detach(domain);
    slot.hosts.set(host, host);
    return host;
  }

  private pathOf(raw: string): PathInfo {
    const known = this.paths.get(raw);
    if (known !== undefined) return known;
    const path = normalizePath(raw);
    const info: PathInfo = {
      path: { ...path, segments: path.segments.map(detach), cased: path.cased.map(detach) },
      hash: null,
      probe: matchProbe(path.segments),
      loginLength: loginRouteLength(path.segments),
      masked: null,
      loginLabel: null,
    };
    if (raw.length <= CACHED_PATH_CHARS) {
      if (this.paths.size >= CACHE_ENTRIES) this.paths.clear();
      this.paths.set(detach(raw), info);
    }
    return info;
  }

  private agentOf(userAgent: string): AgentInfo {
    const known = this.agents.get(userAgent);
    if (known !== undefined) return known;
    const info = classifyUserAgent(userAgent);
    const agent: AgentInfo = {
      info,
      hash: this.hash.of(userAgent),
      bit: UA_FAMILIES.indexOf(info.family),
    };
    if (this.agents.size >= CACHE_ENTRIES) this.agents.clear();
    this.agents.set(detach(userAgent), agent);
    return agent;
  }

  private countRequest(
    entry: ClientEntry,
    line: AlbLine,
    offset: number,
    host: string | null,
    agent: AgentInfo,
  ): void {
    entry.total += 1;
    if (line.blocked) entry.blocked += 1;
    countStatus(entry, line.elbStatus);
    if (offset < entry.first) entry.first = offset;
    if (offset > entry.last) entry.last = offset;
    if (host !== null && host !== OVERFLOW_HOST) {
      if (entry.hostVotes === 0) entry.host = host;
      entry.hostVotes += entry.host === host ? 1 : -1;
    }
    if (agent.bit < 31) entry.uaLow |= 1 << agent.bit;
    else entry.uaHigh |= 1 << (agent.bit - 31);
    if (entry.firstUa === null) entry.firstUa = agent.hash;
    else if (entry.firstUa !== agent.hash) {
      entry.uas ??= [entry.firstUa];
      if (entry.uas.length < MAX_UAS_PER_CLIENT && !entry.uas.includes(agent.hash))
        entry.uas.push(agent.hash);
    }
    const { tool } = agent.info;
    if (tool !== null) {
      entry.tool += 1;
      if (line.blocked) entry.toolBlocked += 1;
      if (WORDLIST_TOOLS.has(tool)) entry.toolWordlist += 1;
    }
  }

  /** Caminhos distintos: 16 na própria lista; com 8 erros ou mais, um conjunto de até 512. */
  private countPath(entry: ClientEntry, info: PathInfo): void {
    const held = entry.paths;
    // Lista cheia de quem não errou: nada a contar, e o hash é a parte cara.
    if (Array.isArray(held) && held.length >= INLINE_PATHS && entry.errors === 0) return;
    info.hash ??= this.hash.of(info.path.segments.join('/'));
    const { hash } = info;
    if (held instanceof IntSet) {
      this.addPath(entry, held, hash);
      return;
    }
    if (held === null || held === hash) {
      entry.paths = hash;
      return;
    }
    const paths = typeof held === 'number' ? [held] : held;
    entry.paths = paths;
    if (entry.errors >= PROMOTE_ERRORS) {
      if (this.pathSets >= this.limits.maxPathSets || this.hashCells + 32 > this.limits.maxHashCells) {
        entry.truncated = true;
        entry.pathsLost = true;
      } else {
        const set = new IntSet(MAX_PATHS_PER_CLIENT);
        this.pathSets += 1;
        this.hashCells += set.cells;
        for (const value of paths) set.add(value);
        entry.paths = set;
        this.addPath(entry, set, hash);
        return;
      }
    }
    if (paths.includes(hash)) return;
    if (paths.length < INLINE_PATHS) paths.push(hash);
    else if (entry.errors > 0) entry.truncated = true;
  }

  private addPath(entry: ClientEntry, set: IntSet, hash: number): void {
    const before = set.cells;
    if (this.hashCells + before > this.limits.maxHashCells && set.size * 2 >= before) {
      entry.truncated = true;
      entry.pathsLost = true;
      return;
    }
    set.add(hash);
    this.hashCells += set.cells - before;
    if (set.full) entry.truncated = true;
  }

  private countProbe(
    slot: Slot,
    entry: ClientEntry,
    line: AlbLine,
    info: PathInfo,
    host: string | null,
    offset: number,
    objectKey: string,
  ): void {
    const { probe } = info;
    if (probe === null) return;
    if (countsAsProbe(probe, line.elbStatus)) {
      entry.probes += 1;
      entry.families |= probe.bit;
      if (line.blocked) entry.probesBlocked += 1;
      else entry.openFamilies |= probe.bit;
    }
    const answered =
      line.targetStatus >= 200 &&
      line.targetStatus <= 299 &&
      line.targetStatus !== 204 &&
      line.targetStatus !== 205 &&
      line.sentBytes > 0 &&
      !BODILESS_METHODS.has(line.method ?? '');
    if (!answered) return;
    this.recordSize(slot, host, probe.signature, line.sentBytes);
    if (probe.secret) this.recordAnswered(slot, entry, line, info, probe, host, offset, objectKey);
  }

  private recordSize(slot: Slot, host: string | null, signature: string, bytes: number): void {
    const key = host ?? '';
    let sizes = slot.probeSizes.get(key);
    if (sizes === undefined) {
      sizes = [];
      slot.probeSizes.set(key, sizes);
    }
    const known = sizes.find((entry) => entry.bytes === bytes);
    if (known !== undefined) known.signatures.add(signature);
    // Cheia, a lista não aceita tamanho novo: a guarda suprime menos, nunca mais.
    else if (sizes.length < MAX_SIZES) sizes.push({ bytes, signatures: new Set([signature]) });
  }

  /**
   * O tamanho da página inicial do host: só GET sem query com 200 do alvo e do balanceador. Com a query, o tamanho seria do
   * atacante (um texto refletido na página); um 206 ou uma conexão cortada também.
   */
  private recordRoot(slot: Slot, entry: ClientEntry, line: AlbLine, host: string | null): void {
    if (line.method !== 'GET' || line.hasQuery || line.targetStatus !== 200 || line.elbStatus !== 200) return;
    const key = host ?? '';
    const client = entry.ref.key;
    let page = slot.roots.get(key);
    if (page === undefined) {
      page = { a: client, b: null, sizes: [] };
      slot.roots.set(key, page);
    }
    // Quem pediu é contado mesmo com a lista cheia: enchê-la não faz parecer que ninguém mais pediu.
    see(page, client);
    const known = page.sizes.find((size) => size.bytes === line.sentBytes);
    if (known !== undefined) see(known, client);
    else if (page.sizes.length < MAX_ROOT_SIZES) {
      page.sizes.push({ bytes: line.sentBytes, a: client, b: null });
    }
  }

  private recordAnswered(
    slot: Slot,
    entry: ClientEntry,
    line: AlbLine,
    info: PathInfo,
    match: ProbeMatch,
    host: string | null,
    offset: number,
    objectKey: string,
  ): void {
    const bucket = Math.round(Math.log(Math.max(1, line.sentBytes)) / Math.log(1.02));
    const key = `${host ?? ''}|${match.signature}|${bucket}`;
    let group = slot.answered.get(key);
    if (group === undefined) {
      if (slot.answered.size >= this.limits.maxAnswered) this.purgeAnswered(slot);
      if (slot.answered.size >= this.limits.maxAnswered) {
        slot.answeredDropped += 1;
        slot.truncated = true;
        return;
      }
      group = { host, match, bytes: line.sentBytes, count: 0, clients: new Map(), moreClients: false };
      slot.answered.set(key, group);
    }
    group.count += 1;
    const atMs = slot.startMs + offset;
    const seen = group.clients.get(entry.ref.key);
    if (seen === undefined && group.clients.size > 0) {
      // O primeiro de cada grupo sempre entra: todo grupo tem de quem falar.
      if (group.clients.size >= MAX_ANSWERED_CLIENTS || slot.answeredExtra >= MAX_ANSWERED_EXTRA) {
        group.moreClients = true;
        return;
      }
      slot.answeredExtra += 1;
    }
    const first: RawSample = {
      atMs,
      method: methodOf(line.method),
      path: this.maskedOf(info),
      status: line.targetStatus,
      bytes: line.sentBytes,
      objectKey,
    };
    if (seen !== undefined) {
      seen.count += 1;
      seen.lastMs = Math.max(seen.lastMs, atMs);
      if (atMs < seen.first.atMs) seen.first = first;
      return;
    }
    group.clients.set(entry.ref.key, { client: entry.ref, count: 1, first, lastMs: atMs });
  }

  /**
   * No teto, saem os grupos que a guarda do catch-all já suprimiria com o que o slot sabe: encher a lista com respostas de
   * um site que responde tudo igual não empurra para fora uma resposta de verdade. Uma tentativa por slot.
   */
  private purgeAnswered(slot: Slot): void {
    if (slot.answeredFull) return;
    slot.answeredFull = true;
    for (const [key, group] of slot.answered) {
      if (!catchAllGuard([slot], group)(null)) continue;
      slot.answered.delete(key);
      slot.answeredDropped += group.count;
    }
    if (slot.answered.size < this.limits.maxAnswered / 2) slot.answeredFull = false;
  }

  private countLogin(
    slot: Slot,
    entry: ClientEntry,
    line: AlbLine,
    info: PathInfo,
    host: string | null,
    offset: number,
  ): 'failure' | 'success' | null {
    const method = line.method ?? '';
    // O host da linha, e não o do teto do slot: encher o teto com subdomínios não desliga a rota declarada por host.
    const declared = this.routes.empty
      ? null
      : this.routes.match(line.domainName, method, info.path.segments);
    let failure: boolean;
    let success: boolean;
    let route: LoginRoute;
    if (declared !== null) {
      if (declared.route.kind === 'ignore') return null;
      failure = declared.failures.has(line.elbStatus);
      success = declared.successes.has(line.elbStatus);
      route = this.loginRoute(slot, `d:${declared.route.id}`, host, true, {
        label: declared.route.path,
        kind: declared.route.kind,
        declaredCodes: declared.failures.size > 0 && declared.successes.size > 0,
        multiplier: declared.route.multiplier,
      });
    } else {
      if (info.loginLength === 0 || !LOGIN_METHODS.has(method)) return null;
      failure = DEFAULT_FAILURE_CODES.includes(line.elbStatus);
      success = isDefaultSuccess(line.elbStatus);
      // 404 e 405 não são resposta de login: sem isto, caminhos inventados gastariam o teto de rotas.
      if (!failure && !success) return null;
      info.loginLabel ??= maskPath({
        segments: info.path.segments.slice(0, info.loginLength),
        cased: info.path.cased.slice(0, info.loginLength),
        hidden: info.path.hidden.slice(0, info.loginLength),
      });
      route = this.loginRoute(slot, `h:${info.loginLabel}`, host, false, {
        label: info.loginLabel,
        kind: 'login',
        declaredCodes: false,
        multiplier: 1,
      });
    }
    route.attempts += 1;
    if (failure && !line.blocked && line.elbStatus !== 429) route.hard += 1;
    const cell = this.loginCell(slot, route, entry);
    cell.attempts += 1;
    if (offset < cell.first) cell.first = offset;
    if (offset > cell.last) cell.last = offset;
    if (failure) {
      entry.loginFailures += 1;
      if (line.blocked) cell.blocked += 1;
      else {
        cell.open += 1;
        this.recordFailure(slot, cell, offset);
      }
      return 'failure';
    }
    if (!success) return null;
    cell.successes += 1;
    if (cell.firstSuccess === NO_OFFSET || offset < cell.firstSuccess) cell.firstSuccess = offset;
    if (offset > cell.lastSuccess) cell.lastSuccess = offset;
    return 'success';
  }

  private loginRoute(
    slot: Slot,
    routeId: string,
    host: string | null,
    declared: boolean,
    meta: Pick<LoginRoute, 'label' | 'kind' | 'declaredCodes' | 'multiplier'>,
  ): LoginRoute {
    const known = slot.login.get(`${host ?? ''}|${routeId}`);
    if (known !== undefined) return known;
    if (host === OVERFLOW_HOST) return this.overflowRoute(slot, { routeId, declared, ...meta }, true);
    let same = 0;
    for (const route of slot.login.values()) {
      if (route.declared === declared && !isOverflow(route)) same += 1;
    }
    const cap = declared ? MAX_DECLARED_ROUTES : this.limits.maxLoginRoutes;
    if (same >= cap) {
      slot.truncated = true;
      // Sem lugar, a tentativa conta na rota comum: inventar 20 rotas não deixa a verdadeira fora da contagem.
      if (!this.shedRoutes(slot, declared)) {
        return this.overflowRoute(slot, { routeId, declared, ...meta }, false);
      }
    }
    return this.addRoute(slot, { routeId, host, declared, ...meta });
  }

  private addRoute(
    slot: Slot,
    identity: Pick<
      LoginRoute,
      'routeId' | 'host' | 'declared' | 'label' | 'kind' | 'declaredCodes' | 'multiplier'
    >,
  ): LoginRoute {
    const route: LoginRoute = {
      ...identity,
      attempts: 0,
      hard: 0,
      cells: new Map(),
      evicted: null,
    };
    slot.login.set(`${route.host ?? ''}|${route.routeId}`, route);
    return route;
  }

  /**
   * A rota que junta o que passou do teto, com host `*`. A mesma rota noutros hosts continua a mesma (força bruta que troca
   * de subdomínio não se divide em duas); a rota sem lugar nenhum cai na comum, `h:*`. Também elas têm teto.
   */
  private overflowRoute(
    slot: Slot,
    of: Pick<LoginRoute, 'routeId' | 'declared' | 'label' | 'kind' | 'declaredCodes' | 'multiplier'>,
    byHost: boolean,
  ): LoginRoute {
    const { declared, kind, declaredCodes, multiplier } = of;
    const known = slot.login.get(`${OVERFLOW_HOST}|${of.routeId}`);
    if (known !== undefined) return known;
    let sameRoute = declared || byHost;
    let spares = 0;
    for (const route of slot.login.values()) {
      if (route.declared !== declared) continue;
      if (isOverflow(route)) spares += 1;
      else if (route.routeId === of.routeId) sameRoute = true;
    }
    const own = sameRoute && (declared || spares <= this.limits.maxLoginRoutes);
    const routeId = own ? of.routeId : OVERFLOW_ROUTE;
    return (
      slot.login.get(`${OVERFLOW_HOST}|${routeId}`) ??
      this.addRoute(slot, {
        routeId,
        host: OVERFLOW_HOST,
        declared,
        label: own ? of.label : OVERFLOW_LABEL,
        kind,
        declaredCodes,
        multiplier,
      })
    );
  }

  /**
   * Sai a metade menos tentada, se tiver poucas tentativas (a rota com 20 ou mais nunca sai), e a contagem dela vai para a
   * rota comum: quem inventa rotas entre uma tentativa e outra não zera as próprias falhas.
   */
  private shedRoutes(slot: Slot, declared: boolean): boolean {
    const routes = [...slot.login].filter(([, route]) => route.declared === declared && !isOverflow(route));
    routes.sort(([a, x], [b, y]) => x.attempts - y.attempts || (a < b ? -1 : 1));
    let removed = 0;
    for (const [key, route] of routes.slice(0, Math.ceil(routes.length / 2))) {
      if (route.attempts >= 20) break;
      slot.login.delete(key);
      this.absorb(slot, this.overflowRoute(slot, route, false), route);
      removed += 1;
    }
    return removed > 0;
  }

  private absorb(slot: Slot, target: LoginRoute, source: LoginRoute): void {
    target.attempts += source.attempts;
    target.hard += source.hard;
    this.absorbLedger(slot, target, source);
    for (const [key, item] of source.cells) {
      const held = target.cells.get(key);
      if (held !== undefined) {
        this.mergeCell(slot, held.cell, item.cell);
        this.loginCells -= 1;
        continue;
      }
      if (target.cells.size < this.limits.maxRouteClients) {
        target.cells.set(key, item);
        continue;
      }
      this.keepCount(slot, target, item.client, item.cell.failures);
      this.loginCells -= 1;
    }
  }

  private mergeCell(slot: Slot, target: LoginCell, source: LoginCell): void {
    target.attempts += source.attempts;
    target.open += source.open;
    target.blocked += source.blocked;
    target.successes += source.successes;
    target.first = Math.min(target.first, source.first);
    target.last = Math.max(target.last, source.last);
    target.lastSuccess = Math.max(target.lastSuccess, source.lastSuccess);
    if (source.firstSuccess !== NO_OFFSET) {
      target.firstSuccess =
        target.firstSuccess === NO_OFFSET
          ? source.firstSuccess
          : Math.min(target.firstSuccess, source.firstSuccess);
    }
    if (source.series < 0) {
      for (const offset of source.early) this.recordFailure(slot, target, offset);
      return;
    }
    for (let step = 0; step < SERIES_STEPS; step += 1) {
      const count = slot.series[source.series * SERIES_STEPS + step] ?? 0;
      for (let i = 0; i < count; i += 1) this.recordFailure(slot, target, step * SERIES_STEP_MS);
    }
  }

  private loginCell(slot: Slot, route: LoginRoute, entry: ClientEntry): LoginCell {
    const known = route.cells.get(entry.ref.key);
    if (known !== undefined) return known.cell;
    if (route.cells.size >= this.limits.maxRouteClients) {
      slot.truncated = true;
      this.shedCells(slot, [route]);
    }
    if (this.loginCells >= this.limits.maxLoginCells) {
      slot.truncated = true;
      this.shedLogin();
    }
    const cell = new LoginCell();
    route.cells.set(entry.ref.key, { client: entry.ref, cell });
    this.loginCells += 1;
    return cell;
  }

  /** No teto de pares, o slot com mais deles fica com a metade de mais falhas. Sempre libera: quem chega tem lugar. */
  private shedLogin(): void {
    let largest: Slot | null = null;
    let most = 0;
    for (const slot of [...this.slots.values(), ...this.late.values()]) {
      let cells = 0;
      for (const route of slot.login.values()) cells += route.cells.size;
      if (cells > most) {
        most = cells;
        largest = slot;
      }
    }
    if (largest === null) return;
    largest.truncated = true;
    this.shedCells(largest, [...largest.login.values()]);
  }

  /** Sai a metade com menos falhas; quem saiu fica no registro de cada rota, para a distribuída. */
  private shedCells(slot: Slot, routes: readonly LoginRoute[]): void {
    const histogram = new Array<number>(256).fill(0);
    let total = 0;
    for (const route of routes) {
      for (const { cell } of route.cells.values()) {
        histogram[cellScore(cell)] = (histogram[cellScore(cell)] ?? 0) + 1;
        total += 1;
      }
    }
    let left = Math.ceil(total / 2);
    let cut = 0;
    while (cut < 255 && left > (histogram[cut] ?? 0)) {
      left -= histogram[cut] ?? 0;
      cut += 1;
    }
    for (const route of routes) {
      for (const [key, { client, cell }] of route.cells) {
        const score = cellScore(cell);
        if (score > cut || (score === cut && left <= 0)) continue;
        if (score === cut) left -= 1;
        route.cells.delete(key);
        this.loginCells -= 1;
        this.keepCount(slot, route, client, cell.failures);
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Quem saiu das rotas de login (a 990407)
  // -------------------------------------------------------------------------------------------------------------------

  /** O hash com chave do cliente, sempre diferente de zero. O mesmo endereço tem o mesmo, seja qual for a classe. */
  tagOf(client: ClientRef): number {
    client.tag ??= this.hash.of(client.key) || 1;
    return client.tag;
  }

  /** O par sai, e o cliente com as falhas dele fica no registro da rota. */
  private keepCount(slot: Slot, route: LoginRoute, client: ClientRef, failures: number): void {
    // Fora das janelas de 15 minutos, a 990407 não olha mais o slot.
    if (failures === 0 || slot.trimmed) return;
    route.evicted ??= new EvictedLedger();
    this.remember(route.evicted, this.tagOf(client), failures);
  }

  private remember(ledger: EvictedLedger, tag: number, failures: number): void {
    while (isSampled(tag, ledger.shift) && !ledger.add(tag, failures)) {
      if (this.evictedCells + ledger.cells <= this.limits.maxEvictedCells) {
        this.evictedCells += ledger.cells;
        ledger.grow();
        continue;
      }
      // No teto, paga o maior: uma rota inventada cheia de clientes não raleia a de verdade.
      const largest = this.largestLedger();
      const target = largest !== null && largest.cells > ledger.cells ? largest : ledger;
      this.evictedCells -= target.thin();
    }
  }

  private largestLedger(): EvictedLedger | null {
    let largest: EvictedLedger | null = null;
    for (const slot of [...this.slots.values(), ...this.late.values()]) {
      for (const { evicted } of slot.login.values()) {
        if (evicted !== null && evicted.cells > (largest?.cells ?? 0)) largest = evicted;
      }
    }
    return largest;
  }

  /** O registro de uma rota passa para outra, no nível de amostra do mais raleado. */
  private absorbLedger(slot: Slot, target: LoginRoute, source: LoginRoute): void {
    const from = source.evicted;
    if (from === null) return;
    this.forgetLedger(source);
    if (slot.trimmed) return;
    target.evicted ??= new EvictedLedger();
    while (target.evicted.shift < from.shift) this.evictedCells -= target.evicted.thin();
    for (const [tag, failures] of from.entries()) this.remember(target.evicted, tag, failures);
  }

  private forgetLedger(route: LoginRoute): void {
    if (route.evicted === null) return;
    this.evictedCells -= route.evicted.cells - MIN_LEDGER_CELLS;
    route.evicted = null;
  }

  private recordFailure(slot: Slot, cell: LoginCell, offset: number): void {
    if (cell.series < 0) {
      if (cell.early.length < 3) {
        cell.early.push(offset);
        return;
      }
      if (slot.seriesUsed >= this.limits.maxSeries) {
        // Sem série, as falhas do slot contam todas como anteriores ao sucesso: sobra alerta, não falta.
        slot.truncated = true;
        return;
      }
      cell.series = slot.seriesUsed;
      slot.seriesUsed += 1;
      const needed = slot.seriesUsed * SERIES_STEPS;
      if (slot.series.length < needed) {
        const next = new Uint16Array(Math.max(needed, slot.series.length * 2, 64 * SERIES_STEPS));
        next.set(slot.series);
        slot.series = next;
      }
      for (const early of cell.early) this.bump(slot, cell.series, early);
    }
    this.bump(slot, cell.series, offset);
  }

  private bump(slot: Slot, series: number, offset: number): void {
    const at = series * SERIES_STEPS + Math.floor(offset / SERIES_STEP_MS);
    const value = slot.series[at] ?? 0;
    if (value < 0xffff) slot.series[at] = value + 1;
  }

  private maskedOf(info: PathInfo): string {
    info.masked ??= maskPath(info.path);
    return info.masked;
  }

  private keepDetail(
    slot: Slot,
    entry: ClientEntry,
    line: AlbLine,
    info: PathInfo | null,
    offset: number,
    objectKey: string,
  ): void {
    if (entry.detail === null) {
      if (entry.notables < DETAIL_AFTER || this.details >= this.limits.maxDetails) return;
      entry.detail = { routes: new Map(), samples: [], userAgent: null };
      this.details += 1;
    }
    // Na linha ambígua, o campo pode ser um pedaço da query (uma aspa na URL desloca os campos): só serve para a família.
    if (!line.ambiguous) entry.detail.userAgent ??= sampleUserAgent(line.userAgent);
    if (info === null) return;
    const path = this.maskedOf(info);
    const { routes, samples } = entry.detail;
    const count = routes.get(path);
    if (count !== undefined) routes.set(path, count + 1);
    else if (routes.size < MAX_DETAIL_ROUTES) routes.set(path, 1);
    if (samples.length < MAX_DETAIL_SAMPLES) {
      samples.push({
        atMs: slot.startMs + offset,
        method: methodOf(line.method),
        path,
        status: line.elbStatus,
        bytes: line.sentBytes,
        objectKey,
      });
    }
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Memória
  // -------------------------------------------------------------------------------------------------------------------

  private release(entry: ClientEntry): void {
    this.clients -= 1;
    if (entry.detail !== null) this.details -= 1;
    if (entry.paths instanceof IntSet) {
      this.pathSets -= 1;
      this.hashCells -= entry.paths.cells;
    }
  }

  /** No teto de clientes, o slot com mais registros fica com a metade de maior suspeita. */
  private shedClients(current: Slot): void {
    let largest = current;
    for (const slot of [...this.slots.values(), ...this.late.values()]) {
      if (slot.clients.size > largest.clients.size) largest = slot;
    }
    this.keepTop(largest, Math.floor(largest.clients.size / 2));
    largest.truncated = true;
    current.truncated = true;
  }

  /** Deixa no slot os `keep` registros de maior suspeita; empate, os que chegaram primeiro. */
  private keepTop(slot: Slot, keep: number): void {
    const excess = slot.clients.size - keep;
    if (excess <= 0) return;
    const histogram = new Array<number>(1024).fill(0);
    for (const entry of slot.clients.values()) histogram[entry.score] = (histogram[entry.score] ?? 0) + 1;
    let cut = 0;
    let below = 0;
    while (cut < 1023 && below + (histogram[cut] ?? 0) <= excess) {
      below += histogram[cut] ?? 0;
      cut += 1;
    }
    // Abaixo do corte, saem todos; no corte, só o que falta, dos mais recentes.
    let atCut = excess - below;
    const entries = [...slot.clients];
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const held = entries[i];
      if (held === undefined) continue;
      const [id, entry] = held;
      const { score } = entry;
      if (score > cut) continue;
      if (score === cut) {
        if (atCut <= 0) continue;
        atCut -= 1;
      }
      slot.clients.delete(id);
      slot.foldedClients += 1;
      slot.foldedRequests += entry.total;
      this.release(entry);
    }
  }

  /** O slot fechou: ficam os suspeitos, até o teto. Quem não tem nada só serviria à razão de erros. */
  close(slot: Slot): void {
    slot.closed = true;
    if (slot.clients.size <= this.limits.maxClosedClients) return;
    this.keepTop(slot, this.limits.maxClosedClients);
  }

  /** O slot saiu de toda janela de 15 minutos aberta: na de 60, só interessam as falhas de login e os tamanhos. */
  trim(slot: Slot): void {
    slot.trimmed = true;
    slot.answered.clear();
    for (const route of slot.login.values()) {
      this.forgetLedger(route);
      for (const [key, { cell }] of route.cells) {
        if (cell.open > 0) continue;
        route.cells.delete(key);
        this.loginCells -= 1;
      }
    }
  }

  drop(slot: Slot): void {
    for (const entry of slot.clients.values()) this.release(entry);
    for (const route of slot.login.values()) {
      this.loginCells -= route.cells.size;
      this.forgetLedger(route);
    }
    (slot.late ? this.late : this.slots).delete(slot.index);
  }
}

/** As contas por classe do slot e as marcas do resumo, quando a classe de um registro muda para uma indireta. */
function reclassify(slot: Slot, entry: ClientEntry, cls: ClientClass): void {
  const before = entry.ref.cls;
  if (before === cls || cls === 'direct') return;
  if (before === 'direct') {
    slot.direct -= entry.total;
    // Marcado como varredura por um endereço que não era de um visitante só: sai do resumo.
    entry.flags = 0;
  }
  if (before === 'unverified') slot.unverified -= entry.total;
  if (cls === 'unverified') slot.unverified += entry.total;
}

/** Quanto vale guardar um par: as falhas, e um pouco mais se houve sucesso depois delas. */
const cellScore = (cell: LoginCell): number =>
  Math.min(255, cell.failures * 2 + (cell.successes > 0 && cell.failures > 0 ? 1 : 0));

/** A sonda de família secreta conta sempre; a de plataforma, só se o balanceador respondeu 4xx ou 5xx. */
function countsAsProbe(probe: ProbeMatch, status: number): boolean {
  return probe.secret || status >= 400;
}

const isRouteError = (status: number): boolean =>
  status === 400 || status === 403 || status === 404 || status === 405;

function countStatus(entry: ClientEntry, status: number): void {
  if (status >= 200 && status <= 299) entry.ok += 1;
  else if (status >= 300 && status <= 399) entry.redirect += 1;
  else if (status === 400) entry.s400 += 1;
  else if (status === 401) entry.s401 += 1;
  else if (status === 403) entry.s403 += 1;
  else if (status === 404) entry.s404 += 1;
  else if (status === 405) entry.s405 += 1;
  else if (status === 422) entry.s422 += 1;
  else if (status === 429) entry.s429 += 1;
  else if (status >= 400 && status <= 499) entry.s4xx += 1;
  else if (status >= 500) entry.s5xx += 1;
}

/**
 * Guarda do catch-all (990403): a resposta é a página que o site dá para qualquer caminho.
 *
 * - o tamanho está a até 2% do da página inicial do host. Se alguém mais pediu a página inicial, vale só o tamanho visto
 *   por outro cliente que não o da sonda: o atacante não fabrica a própria desculpa;
 * - ou 3 assinaturas de sonda diferentes tiveram esse tamanho (as assinaturas vêm do dicionário de `probes.ts`).
 *
 * Devolve o teste por cliente. Sem o cliente (`null`, a limpeza do teto), o tamanho da página inicial só vale se dois
 * clientes o viram.
 */
export function catchAllGuard(
  slots: readonly Slot[],
  group: Pick<AnsweredGroup, 'host' | 'bytes'>,
): (clientKey: string | null) => boolean {
  const key = group.host ?? '';
  const signatures = new Set<string>();
  const pages: RootPage[] = [];
  for (const slot of slots) {
    for (const size of slot.probeSizes.get(key) ?? []) {
      if (!sameSize(size.bytes, group.bytes)) continue;
      for (const signature of size.signatures) signatures.add(signature);
    }
    const page = slot.roots.get(key);
    if (page !== undefined) pages.push(page);
  }
  if (signatures.size >= 3) return () => true;
  if (pages.length === 0) return () => false;
  const same = pages.flatMap((page) => page.sizes.filter((size) => sameSize(size.bytes, group.bytes)));
  return (clientKey) => {
    if (same.some((size) => byOther(size, clientKey))) return true;
    const othersAsked = pages.some((page) => byOther(page, clientKey));
    return clientKey !== null && same.length > 0 && !othersAsked;
  };
}

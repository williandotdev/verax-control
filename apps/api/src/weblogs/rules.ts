import type { ClientClass } from './client-class.js';
import { type EvidenceNote, MAX_EVIDENCE_SAMPLES, type WebEvidence } from './evidence.js';
import { LONG_SLOTS, SHORT_SLOTS, SLOT_MS } from './limits.js';
import { countBits } from './probes.js';
import type { WebRouteKind } from './routes.js';
import {
  type AnsweredGroup,
  catchAllGuard,
  type ClientEntry,
  type ClientRef,
  type LoginCell,
  type LoginRoute,
  OVERFLOW_HOST,
  type RawSample,
  SERIES_STEP_MS,
  SERIES_STEPS,
  type Slot,
} from './tally.js';

/**
 * Regras 990400 a 990407, sobre a contagem em memória (`tally.ts`). W15 são os 3 slots e W60 os 12 que terminam no slot
 * avaliado. Níveis na escala das outras regras (12 crítica, 10 alta, 7 média, abaixo baixa); MITRE só o da tabela do
 * desenho de 24/11/2026.
 *
 * O título é fixo e em português; o texto do evento leva só contagens. Nada que o atacante escolhe (caminho, host,
 * User-Agent) entra em título, evento ou e-mail.
 */
export const WEB_RULES = {
  '990400': {
    title: 'Varredura oportunista contra o balanceador (resumo do dia)',
    tactics: ['Reconnaissance'],
    techniques: ['T1595'],
  },
  '990401': {
    title: 'Ferramenta de ataque identificada pelo User-Agent (5 ou mais requisições em 15 min)',
    tactics: ['Reconnaissance'],
    techniques: ['T1595.002'],
  },
  '990402': {
    title: 'Sondagem de caminhos sensíveis por um mesmo endereço',
    tactics: ['Reconnaissance'],
    techniques: ['T1595.003'],
  },
  '990403': {
    title: 'Caminho sensível respondido com conteúdo',
    tactics: ['Initial Access'],
    techniques: ['T1190'],
  },
  '990404': {
    title: 'Enumeração de rotas por um mesmo endereço',
    tactics: ['Reconnaissance'],
    techniques: ['T1595.003'],
  },
  '990405': {
    title: 'Força bruta numa rota de login por um mesmo endereço',
    tactics: ['Credential Access'],
    techniques: ['T1110'],
  },
  '990406': {
    title: 'Falhas de login seguidas de sucesso (possível acesso indevido)',
    tactics: ['Credential Access', 'Initial Access'],
    techniques: ['T1110', 'T1078'],
  },
  '990407': {
    title: 'Força bruta distribuída numa rota de login',
    tactics: ['Credential Access'],
    techniques: ['T1110'],
  },
} as const;
export type WebRuleId = keyof typeof WEB_RULES;

/** Regras do resumo do dia (990400), caladas por fonte confiável e rebaixadas quando o WAF barrou. */
export const NOISE_RULES: ReadonlySet<WebRuleId> = new Set(['990401', '990402', '990404']);
/** Regras que a fonte confiável cala: nunca o 990403, o 990406 nem o 990407. */
export const SUPPRESSIBLE_RULES: ReadonlySet<WebRuleId> = new Set(['990401', '990402', '990404', '990405']);
/** Avaliadas primeiro e fora do teto por regra. */
export const UNFOLDED_RULES: ReadonlySet<WebRuleId> = new Set(['990403', '990406']);

export const FLAG_OF: Readonly<Record<string, number>> = { '990401': 1, '990402': 2, '990404': 4 };

export const THRESHOLDS = {
  toolRequests: 5,
  probes: 10,
  probeFamilies: 3,
  enumRequests: 100,
  enumPaths: 40,
  enumErrorRatio: 0.6,
  enumHighPaths: 500,
  failures: 20,
  failureRatio: 0.7,
  failuresHigh: 100,
  volumePosts: 60,
  successFailures: 10,
  successFailuresCritical: 50,
  successesCritical: 3,
  successGapSteps: 60,
  distributedFailures: 500,
  distributedClients: 30,
  distributedPerClient: 20,
  distributedBaselineFailures: 200,
  distributedBaselineFactor: 5,
  natAgents: 25,
  natSuccesses: 5,
  natFactor: 5,
  wafShare: 0.95,
  /** Recusas de credencial que provam que uma rota não declarada distingue falha de sucesso. */
  observedHard: 5,
} as const;

/** Itens entre um passo e outro da avaliação (`evaluateSteps`). */
export const STEP_ITEMS = 2_000;

export interface WindowView {
  /** Os slots da janela de 15 e da de 60 minutos, em ordem. */
  short: readonly Slot[];
  long: readonly Slot[];
  endIndex: number;
  late: boolean;
}

export interface RuleContext {
  /** A fonte do WAF da conta está coletando: o que ela barrou já aparece por lá. */
  wafCollecting: boolean;
  /** Mediana de falhas por 15 min da rota nos 7 dias anteriores, por `host|rota` (`baselineKey`); vazio no MVP. */
  baselines: ReadonlyMap<string, number>;
}

export const baselineKey = (host: string | null, routeId: string): string => `${host ?? ''}|${routeId}`;

export type Semantics = 'declared' | 'observed' | 'unknown';

export interface EntryAt {
  slot: Slot;
  entry: ClientEntry;
}

export interface WebHit {
  rule: WebRuleId;
  level: number;
  /** null: não direto, ou mais de um. */
  client: ClientRef | null;
  clientClass: ClientClass | null;
  host: string | null;
  route: { id: string; label: string; kind: WebRouteKind; semantics: Semantics } | null;
  techniques: readonly string[];
  eventName: string;
  /** A contagem que disparou a regra: a ordem dentro do nível. */
  weight: number;
  firstMs: number;
  lastMs: number;
  counters: WebEvidence['counters'];
  entries: EntryAt[];
  participants: { client: ClientRef; requests: number; count: number }[];
  families: number;
  samples: RawSample[];
  notes: Set<EvidenceNote>;
  truncated: boolean;
  fromMs: number;
  toMs: number;
  /** Completa a detecção com o resto do que o cliente fez, só se ela virar achado (`loadHit`). */
  load: ((hit: WebHit) => void) | null;
}

/** Preenche o que só o achado precisa. */
export function loadHit(hit: WebHit): WebHit {
  hit.load?.(hit);
  hit.load = null;
  return hit;
}

export const emptyCounters = (): WebEvidence['counters'] => ({
  requests: 0,
  blocked: 0,
  errors: 0,
  toolRequests: 0,
  probes: 0,
  distinctPaths: 0,
  attempts: 0,
  failures: 0,
  successes: 0,
  clients: 0,
  answered: 0,
});

const scaled = (base: number, ...factors: number[]): number =>
  Math.ceil(factors.reduce((value, factor) => value * factor, base));

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function windowOf(view: WindowView, slots: readonly Slot[]): { fromMs: number; toMs: number } {
  const span = view.late ? 1 : slots === view.long ? LONG_SLOTS : SHORT_SLOTS;
  return { fromMs: (view.endIndex - span) * SLOT_MS, toMs: view.endIndex * SLOT_MS };
}

// ---------------------------------------------------------------------------------------------------------------------
// Por cliente: 990401, 990402 e 990404
// ---------------------------------------------------------------------------------------------------------------------

export interface ClientTotals {
  ref: ClientRef;
  entries: EntryAt[];
  total: number;
  blocked: number;
  errors: number;
  tool: number;
  toolBlocked: number;
  toolWordlist: number;
  probes: number;
  probesBlocked: number;
  families: number;
  openFamilies: number;
  truncated: boolean;
  pathsLost: boolean;
}

/** Soma os slots de um cliente. */
export function totalsOf(ref: ClientRef, slots: readonly Slot[]): ClientTotals {
  const totals: ClientTotals = {
    ref,
    entries: [],
    total: 0,
    blocked: 0,
    errors: 0,
    tool: 0,
    toolBlocked: 0,
    toolWordlist: 0,
    probes: 0,
    probesBlocked: 0,
    families: 0,
    openFamilies: 0,
    truncated: false,
    pathsLost: false,
  };
  for (const slot of slots) {
    const entry = slot.clients.get(ref.key);
    if (entry === undefined) continue;
    totals.entries.push({ slot, entry });
    totals.total += entry.total;
    totals.blocked += entry.blocked;
    totals.errors += entry.errors;
    totals.tool += entry.tool;
    totals.toolBlocked += entry.toolBlocked;
    totals.toolWordlist += entry.toolWordlist;
    totals.probes += entry.probes;
    totals.probesBlocked += entry.probesBlocked;
    totals.families |= entry.families;
    totals.openFamilies |= entry.openFamilies;
    totals.truncated ||= entry.truncated || slot.truncated;
    totals.pathsLost ||= entry.pathsLost;
  }
  return totals;
}

/** Caminhos distintos na janela (a união dos slots). */
export function distinctPaths(entries: readonly EntryAt[]): number {
  const all = new Set<number>();
  for (const { entry } of entries) {
    const { paths } = entry;
    if (paths === null) continue;
    if (typeof paths === 'number') all.add(paths);
    else if (Array.isArray(paths)) for (const value of paths) all.add(value);
    else paths.addTo(all);
  }
  return all.size;
}

function distinctAgents(key: string, slots: readonly Slot[]): number {
  const all = new Set<number>();
  for (const slot of slots) {
    const entry = slot.clients.get(key);
    if (entry === undefined) continue;
    if (entry.uas !== null) for (const value of entry.uas) all.add(value);
    else if (entry.firstUa !== null) all.add(entry.firstUa);
  }
  return all.size;
}

/** O host que a maioria das requisições do cliente usou; null se não há um só. */
function hostOf(entries: readonly EntryAt[]): string | null {
  const hosts = new Set<string>();
  for (const { entry } of entries) if (entry.host !== null && entry.hostVotes > 0) hosts.add(entry.host);
  const [only] = hosts;
  return hosts.size === 1 ? (only ?? null) : null;
}

function spanOf(entries: readonly EntryAt[]): { firstMs: number; lastMs: number } {
  let firstMs = Infinity;
  let lastMs = 0;
  for (const { slot, entry } of entries) {
    firstMs = Math.min(firstMs, slot.startMs + entry.first);
    lastMs = Math.max(lastMs, slot.startMs + entry.last);
  }
  return { firstMs, lastMs };
}

function clientHit(
  view: WindowView,
  rule: WebRuleId,
  totals: ClientTotals,
  nat: boolean,
  held: boolean,
  parts: { level: number; techniques: readonly string[]; eventName: string; weight: number; paths?: number },
): WebHit {
  const notes = new Set<EvidenceNote>();
  if (nat) notes.add('nat_like');
  if (held) notes.add('held_by_waf');
  return {
    rule,
    level: held ? 4 : parts.level,
    client: totals.ref,
    clientClass: totals.ref.cls,
    host: hostOf(totals.entries),
    route: null,
    techniques: parts.techniques,
    eventName: held ? `${parts.eventName}, barradas pelo WAF` : parts.eventName,
    weight: parts.weight,
    ...spanOf(totals.entries),
    counters: {
      ...emptyCounters(),
      requests: totals.total,
      blocked: totals.blocked,
      errors: totals.errors,
      toolRequests: totals.tool,
      probes: totals.probes,
      distinctPaths: parts.paths ?? 0,
      clients: 1,
    },
    entries: totals.entries,
    participants: [],
    families: totals.families,
    samples: [],
    notes,
    truncated: totals.truncated,
    ...windowOf(view, view.short),
    load: null,
  };
}

/**
 * Barrado pelo WAF: 95% ou mais das requisições do achado, com a fonte do WAF coletando, **e** o que passou não atinge a
 * regra sozinho. Sem a segunda condição, bastaria misturar 20 requisições que o WAF barra a cada uma que passa.
 */
function heldByWaf(context: RuleContext, blocked: number, total: number, openHits: boolean): boolean {
  return context.wafCollecting && total > 0 && blocked >= THRESHOLDS.wafShare * total && !openHits;
}

/** O cliente passa do menor limite de alguma regra: só aí vale montar os totais. */
function mayHit(key: string, slots: readonly Slot[]): boolean {
  let tool = 0;
  let probes = 0;
  let families = 0;
  let total = 0;
  let errors = 0;
  for (const slot of slots) {
    const entry = slot.clients.get(key);
    if (entry === undefined) continue;
    tool += entry.tool;
    probes += entry.probes;
    families |= entry.families;
    total += entry.total;
    errors += entry.errors;
  }
  return (
    tool >= THRESHOLDS.toolRequests ||
    probes >= THRESHOLDS.probes ||
    countBits(families) >= THRESHOLDS.probeFamilies ||
    (total >= THRESHOLDS.enumRequests && errors >= THRESHOLDS.enumErrorRatio * total)
  );
}

function* clientHits(
  view: WindowView,
  context: RuleContext,
  natKeys: ReadonlySet<string>,
  hits: WebHit[],
): Generator<void, void> {
  const seen = new Set<string>();
  let visited = 0;
  for (const source of view.short) {
    for (const [key, candidate] of source.clients) {
      visited += 1;
      if (visited % STEP_ITEMS === 0) yield;
      if (!candidate.suspicious || candidate.ref.cls !== 'direct' || seen.has(key)) continue;
      seen.add(key);
      if (!mayHit(key, view.short)) continue;
      const totals = totalsOf(candidate.ref, view.short);
      const nat = natKeys.has(key);
      const factor = nat ? THRESHOLDS.natFactor : 1;
      toolHit(view, context, totals, nat, factor, hits);
      probeHit(view, context, totals, nat, factor, hits);
      enumerationHit(view, context, totals, nat, factor, hits);
    }
  }
}

function toolHit(
  view: WindowView,
  context: RuleContext,
  totals: ClientTotals,
  nat: boolean,
  factor: number,
  hits: WebHit[],
): void {
  const limit = scaled(THRESHOLDS.toolRequests, factor);
  if (totals.tool < limit) return;
  const held = heldByWaf(context, totals.toolBlocked, totals.tool, totals.tool - totals.toolBlocked >= limit);
  hits.push(
    clientHit(view, '990401', totals, nat, held, {
      level: 7,
      techniques: totals.toolWordlist > 0 ? ['T1595.002', 'T1595.003'] : ['T1595.002'],
      eventName: `${plural(totals.tool, 'requisição', 'requisições')} de ferramenta de ataque em 15 min`,
      weight: totals.tool,
    }),
  );
}

function probeHit(
  view: WindowView,
  context: RuleContext,
  totals: ClientTotals,
  nat: boolean,
  factor: number,
  hits: WebHit[],
): void {
  const limit = scaled(THRESHOLDS.probes, factor);
  // As famílias não escalam: uma rede com muita gente não sonda três famílias por acaso.
  const enough = (probes: number, families: number): boolean =>
    probes >= limit || countBits(families) >= THRESHOLDS.probeFamilies;
  if (!enough(totals.probes, totals.families)) return;
  const open = totals.probes - totals.probesBlocked;
  const held = heldByWaf(context, totals.probesBlocked, totals.probes, enough(open, totals.openFamilies));
  const families = countBits(totals.families);
  hits.push(
    clientHit(view, '990402', totals, nat, held, {
      level: 7,
      techniques: WEB_RULES['990402'].techniques,
      eventName: `${plural(totals.probes, 'sonda', 'sondas')} a caminhos sensíveis (${plural(families, 'família', 'famílias')}) em 15 min`,
      weight: totals.probes,
    }),
  );
}

function enumerationHit(
  view: WindowView,
  context: RuleContext,
  totals: ClientTotals,
  nat: boolean,
  factor: number,
  hits: WebHit[],
): void {
  const limit = scaled(THRESHOLDS.enumRequests, factor);
  if (totals.total < limit || totals.errors < THRESHOLDS.enumErrorRatio * totals.total) return;
  const counted = distinctPaths(totals.entries);
  // Sem lugar para os conjuntos (alguém os encheu), vale o máximo possível: as recusas. Sobra alerta, não falta.
  const paths = totals.pathsLost ? Math.max(counted, totals.errors) : counted;
  if (paths < scaled(THRESHOLDS.enumPaths, factor)) return;
  const held = heldByWaf(context, totals.blocked, totals.total, totals.total - totals.blocked >= limit);
  hits.push(
    clientHit(view, '990404', totals, nat, held, {
      // O nível alto, só com a contagem de verdade.
      level: counted >= scaled(THRESHOLDS.enumHighPaths, factor) ? 10 : 7,
      techniques: WEB_RULES['990404'].techniques,
      eventName: `${totals.pathsLost ? 'até ' : ''}${paths} caminhos distintos em ${totals.total} requisições, ${totals.errors} recusadas, em 15 min`,
      weight: paths,
      paths,
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Rotas de login: 990405, 990406 e 990407, e a cara de NAT
// ---------------------------------------------------------------------------------------------------------------------

interface LoginPair {
  client: ClientRef;
  cells: { slot: Slot; cell: LoginCell }[];
}

interface LoginGroup {
  route: LoginRoute;
  hosts: Map<string | null, number>;
  hard: number;
  pairs: Map<string, LoginPair>;
  truncated: boolean;
}

/** Os pares de cliente e rota dos slots, com os hosts da mesma rota juntos. */
function loginGroups(slots: readonly Slot[]): Map<string, LoginGroup> {
  const groups = new Map<string, LoginGroup>();
  for (const slot of slots) {
    for (const route of slot.login.values()) {
      let group = groups.get(route.routeId);
      if (group === undefined) {
        group = { route, hosts: new Map(), hard: 0, pairs: new Map(), truncated: false };
        groups.set(route.routeId, group);
      }
      group.hard += route.hard;
      group.truncated ||= slot.truncated;
      group.hosts.set(route.host, (group.hosts.get(route.host) ?? 0) + route.attempts);
      for (const [key, { client, cell }] of route.cells) {
        const pair = group.pairs.get(key);
        if (pair === undefined) group.pairs.set(key, { client, cells: [{ slot, cell }] });
        else pair.cells.push({ slot, cell });
      }
    }
  }
  return groups;
}

function semanticsOf(group: LoginGroup): Semantics {
  if (group.route.declared) return group.route.declaredCodes ? 'declared' : 'unknown';
  return group.hard >= THRESHOLDS.observedHard ? 'observed' : 'unknown';
}

function groupHost(group: LoginGroup): string | null {
  const [host] = group.hosts.keys();
  return group.hosts.size === 1 && host !== undefined && host !== OVERFLOW_HOST ? host : null;
}

function pairTotals(pair: LoginPair): {
  attempts: number;
  open: number;
  failures: number;
  successes: number;
  firstMs: number;
  lastMs: number;
} {
  const totals = { attempts: 0, open: 0, failures: 0, successes: 0, firstMs: Infinity, lastMs: 0 };
  for (const { slot, cell } of pair.cells) {
    totals.attempts += cell.attempts;
    totals.open += cell.open;
    totals.failures += cell.failures;
    totals.successes += cell.successes;
    totals.firstMs = Math.min(totals.firstMs, slot.startMs + cell.first);
    totals.lastMs = Math.max(totals.lastMs, slot.startMs + cell.last);
  }
  return totals;
}

/**
 * Cara de NAT: 25 ou mais User-Agents e 5 ou mais logins limpos em 15 min (só das rotas em que o cliente mais acerta do que
 * erra: quem está forçando uma senha não ganha a folga com os próprios acertos). Os limites por IP valem cinco vezes.
 */
function natKeysOf(groups: Map<string, LoginGroup>, short: readonly Slot[]): Set<string> {
  const clean = new Map<string, number>();
  for (const group of groups.values()) {
    for (const [key, pair] of group.pairs) {
      const { successes, failures } = pairTotals(pair);
      if (successes > 0 && successes >= failures) clean.set(key, (clean.get(key) ?? 0) + successes);
    }
  }
  const keys = new Set<string>();
  for (const [key, successes] of clean) {
    if (successes < THRESHOLDS.natSuccesses) continue;
    if (distinctAgents(key, short) >= THRESHOLDS.natAgents) keys.add(key);
  }
  return keys;
}

function loginHit(
  view: WindowView,
  slots: readonly Slot[],
  rule: WebRuleId,
  group: LoginGroup,
  semantics: Semantics,
  pair: LoginPair,
  nat: boolean,
  parts: {
    level: number;
    eventName: string;
    weight: number;
    techniques: readonly string[];
    note?: EvidenceNote;
  },
): WebHit {
  const totals = pairTotals(pair);
  const notes = new Set<EvidenceNote>();
  if (nat) notes.add('nat_like');
  if (parts.note !== undefined) notes.add(parts.note);
  return {
    rule,
    level: parts.level,
    client: pair.client,
    clientClass: pair.client.cls,
    host: groupHost(group),
    route: { id: group.route.routeId, label: group.route.label, kind: group.route.kind, semantics },
    techniques: parts.techniques,
    eventName: parts.eventName,
    weight: parts.weight,
    firstMs: totals.firstMs,
    lastMs: totals.lastMs,
    counters: {
      ...emptyCounters(),
      blocked: totals.failures - totals.open,
      attempts: totals.attempts,
      failures: totals.failures,
      successes: totals.successes,
      clients: 1,
    },
    entries: [],
    participants: [],
    families: 0,
    samples: [],
    notes,
    truncated: group.truncated,
    ...windowOf(view, slots),
    load: (hit) => {
      const client = totalsOf(pair.client, slots);
      hit.entries = client.entries;
      hit.counters.requests = client.total;
      hit.counters.errors = client.errors;
      hit.truncated ||= client.truncated;
    },
  };
}

function bruteForceHits(
  view: WindowView,
  groups: Map<string, LoginGroup>,
  semantics: ReadonlyMap<string, Semantics>,
  natKeys: ReadonlySet<string>,
  hits: WebHit[],
): void {
  for (const group of groups.values()) {
    const { route } = group;
    const meaning = semantics.get(route.routeId) ?? 'unknown';
    // A subtécnica (adivinhação de senha) só quando o cliente disse que a rota é de login.
    const techniques = route.declared && route.kind === 'login' ? ['T1110', 'T1110.001'] : ['T1110'];
    for (const [key, pair] of group.pairs) {
      if (pair.client.cls !== 'direct') continue;
      const { attempts, failures, successes } = pairTotals(pair);
      const nat = natKeys.has(key);
      const limit = (base: number): number => scaled(base, route.multiplier, nat ? THRESHOLDS.natFactor : 1);
      // A razão olha só falha e sucesso: um 415 ou um 500 provocado de propósito não dilui.
      if (
        failures >= limit(THRESHOLDS.failures) &&
        failures >= THRESHOLDS.failureRatio * (failures + successes)
      ) {
        hits.push(
          loginHit(view, view.short, '990405', group, meaning, pair, nat, {
            level: failures >= limit(THRESHOLDS.failuresHigh) ? 10 : 7,
            eventName: `${plural(failures, 'falha', 'falhas')} em ${plural(attempts, 'tentativa', 'tentativas')} de login em 15 min`,
            weight: failures,
            techniques,
          }),
        );
      } else if (meaning === 'unknown' && attempts >= limit(THRESHOLDS.volumePosts)) {
        hits.push(
          loginHit(view, view.short, '990405', group, meaning, pair, nat, {
            level: 7,
            eventName: `muitas tentativas numa rota de login: ${attempts} em 15 min (a rota não distingue falha de sucesso)`,
            weight: attempts,
            techniques,
            note: 'volume_only',
          }),
        );
      }
    }
  }
}

/** Passos de 10 s com falha que chegou à aplicação, em ordem, e os candidatos a sucesso. */
function timelineOf(pair: LoginPair): { steps: number[]; counts: number[]; successes: number[] } {
  const byStep = new Map<number, number>();
  const successes: number[] = [];
  for (const { slot, cell } of pair.cells) {
    const base = Math.floor(slot.startMs / SERIES_STEP_MS);
    const add = (step: number, count: number): void => {
      byStep.set(base + step, (byStep.get(base + step) ?? 0) + count);
    };
    if (cell.series >= 0) {
      for (let step = 0; step < SERIES_STEPS; step += 1) {
        const count = slot.series[cell.series * SERIES_STEPS + step] ?? 0;
        if (count > 0) add(step, count);
      }
    } else if (cell.open > cell.early.length) {
      // Sem série (o teto): as falhas contam todas no passo da primeira tentativa.
      add(Math.floor(cell.first / SERIES_STEP_MS), cell.open);
    } else {
      for (const offset of cell.early) add(Math.floor(offset / SERIES_STEP_MS), 1);
    }
    for (const offset of [cell.firstSuccess, cell.lastSuccess]) {
      if (offset >= 0) successes.push(base + Math.floor(offset / SERIES_STEP_MS));
    }
  }
  const steps = [...byStep.keys()].sort((a, b) => a - b);
  return { steps, counts: steps.map((step) => byStep.get(step) ?? 0), successes };
}

/**
 * Falhas anteriores ao sucesso (na janela, que tem 60 min), se a última foi até 10 min antes; 0 se não. As falhas do mesmo passo de 10 s do
 * sucesso contam como anteriores: ninguém erra dez vezes em 10 s e acerta à mão.
 */
function failuresBefore(timeline: ReturnType<typeof timelineOf>): number {
  let best = 0;
  for (const success of timeline.successes) {
    let count = 0;
    let last = -Infinity;
    timeline.steps.forEach((step, i) => {
      if (step > success) return;
      count += timeline.counts[i] ?? 0;
      last = step;
    });
    if (success - last <= THRESHOLDS.successGapSteps) best = Math.max(best, count);
  }
  return best;
}

function failuresThenSuccessHits(
  view: WindowView,
  groups: Map<string, LoginGroup>,
  semantics: ReadonlyMap<string, Semantics>,
  natKeys: ReadonlySet<string>,
  hits: WebHit[],
): void {
  for (const group of groups.values()) {
    const { route } = group;
    const meaning = semantics.get(route.routeId) ?? 'unknown';
    // Cadastro que falha e depois dá certo não é acesso indevido; rota que não distingue não prova nada.
    if (meaning === 'unknown' || route.kind === 'signup') continue;
    for (const [key, pair] of group.pairs) {
      if (pair.client.cls !== 'direct') continue;
      const { open, successes } = pairTotals(pair);
      const nat = natKeys.has(key);
      const limit = (base: number): number => scaled(base, route.multiplier, nat ? THRESHOLDS.natFactor : 1);
      if (successes === 0 || open < limit(THRESHOLDS.successFailures)) continue;
      const failures = failuresBefore(timelineOf(pair));
      if (failures < limit(THRESHOLDS.successFailures)) continue;
      const critical =
        failures >= limit(THRESHOLDS.successFailuresCritical) && successes <= THRESHOLDS.successesCritical;
      hits.push(
        loginHit(view, view.long, '990406', group, meaning, pair, nat, {
          level: critical ? 12 : 10,
          eventName: `${plural(failures, 'falha', 'falhas')} de login e depois ${plural(successes, 'sucesso', 'sucessos')} na mesma rota, em 60 min`,
          weight: failures,
          techniques: WEB_RULES['990406'].techniques,
          note: 'valid_account_possible',
        }),
      );
    }
  }
}

interface DistributedGroup {
  route: LoginRoute;
  clients: Map<string, { client: ClientRef; failures: number; attempts: number }>;
  evictedClients: number;
  evictedFailures: number;
  firstMs: number;
  lastMs: number;
  truncated: boolean;
}

/**
 * Força bruta distribuída: só os clientes com até 20 falhas contam, e os outros ficam de fora da soma (o desenho pede
 * "cada um até 20"). Se bastasse um cliente barulhento para a regra não valer, o atacante mandaria um.
 */
function distributedHits(
  view: WindowView,
  context: RuleContext,
  semantics: ReadonlyMap<string, Semantics>,
  hits: WebHit[],
): void {
  const groups = new Map<string, DistributedGroup>();
  for (const slot of view.short) {
    for (const route of slot.login.values()) {
      const key = baselineKey(route.host, route.routeId);
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          route,
          clients: new Map(),
          evictedClients: 0,
          evictedFailures: 0,
          firstMs: Infinity,
          lastMs: 0,
          truncated: false,
        };
        groups.set(key, group);
      }
      group.evictedClients += route.evictedClients;
      group.evictedFailures += route.evictedFailures;
      group.truncated ||= slot.truncated;
      if (route.evictedFailures > 0) {
        group.firstMs = Math.min(group.firstMs, slot.startMs);
        group.lastMs = Math.max(group.lastMs, slot.endMs - 1);
      }
      for (const [client, { client: ref, cell }] of route.cells) {
        if (cell.failures === 0) continue;
        group.firstMs = Math.min(group.firstMs, slot.startMs + cell.first);
        group.lastMs = Math.max(group.lastMs, slot.startMs + cell.last);
        const held = group.clients.get(client);
        if (held === undefined) {
          group.clients.set(client, { client: ref, failures: cell.failures, attempts: cell.attempts });
        } else {
          held.failures += cell.failures;
          held.attempts += cell.attempts;
        }
      }
    }
  }
  for (const [key, group] of groups) {
    const { route } = group;
    const low = [...group.clients.values()].filter(
      ({ failures }) => failures <= THRESHOLDS.distributedPerClient,
    );
    const clients = low.length + group.evictedClients;
    const failures = low.reduce((sum, item) => sum + item.failures, 0) + group.evictedFailures;
    if (clients < THRESHOLDS.distributedClients) continue;
    const limit = (base: number): number => scaled(base, route.multiplier);
    const median = context.baselines.get(key);
    const spike =
      median !== undefined &&
      failures >= limit(THRESHOLDS.distributedBaselineFailures) &&
      failures >= THRESHOLDS.distributedBaselineFactor * median;
    if (failures < limit(THRESHOLDS.distributedFailures) && !spike) continue;
    const notes = new Set<EvidenceNote>();
    if (low.some(({ client }) => client.cls !== 'direct')) notes.add('client_not_direct');
    low.sort((a, b) => b.failures - a.failures || (a.client.key < b.client.key ? -1 : 1));
    hits.push({
      rule: '990407',
      level: 10,
      client: null,
      clientClass: null,
      host: route.host === OVERFLOW_HOST ? null : route.host,
      route: {
        id: route.routeId,
        label: route.label,
        kind: route.kind,
        semantics: semantics.get(route.routeId) ?? 'unknown',
      },
      techniques: WEB_RULES['990407'].techniques,
      eventName: `${failures} falhas de login de ${clients} endereços, até 20 cada um, em 15 min`,
      weight: failures,
      firstMs: group.firstMs,
      lastMs: group.lastMs,
      counters: {
        ...emptyCounters(),
        attempts: low.reduce((sum, item) => sum + item.attempts, 0) + group.evictedFailures,
        failures,
        clients,
      },
      entries: [],
      participants: low.map((item) => ({
        client: item.client,
        requests: item.attempts,
        count: item.failures,
      })),
      families: 0,
      samples: [],
      notes,
      truncated: group.truncated || group.evictedClients > 0,
      ...windowOf(view, view.short),
      load: null,
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// 990403: sonda respondida
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Um achado por cliente e host. Não depende do IP: uma resposta basta. Por isso o cliente que não é `direct` também vira
 * achado, sem IP e um por host (a regra ficaria cega atrás de uma CDN, onde o vazamento é o mesmo).
 */
function answeredHits(view: WindowView, hits: WebHit[]): number {
  const found = new Map<string, WebHit>();
  let suppressed = 0;
  for (const slot of view.short) {
    for (const group of slot.answered.values()) {
      const isCatchAll = catchAllGuard(view.long, group);
      for (const [key, item] of group.clients) {
        if (isCatchAll(key)) {
          suppressed += item.count;
          continue;
        }
        addAnswered(view, found, group, item, slot);
      }
    }
  }
  hits.push(...found.values());
  return suppressed;
}

function addAnswered(
  view: WindowView,
  found: Map<string, WebHit>,
  group: AnsweredGroup,
  item: { client: ClientRef; count: number; first: RawSample; lastMs: number },
  slot: Slot,
): void {
  const direct = item.client.cls === 'direct';
  const host = group.host === OVERFLOW_HOST ? null : group.host;
  const identity = `${direct ? item.client.key : `!${item.client.cls}`}|${host ?? ''}`;
  let hit = found.get(identity);
  if (hit === undefined) {
    const notes = new Set<EvidenceNote>(['bytes_include_headers']);
    if (!direct) notes.add('client_not_direct');
    hit = {
      rule: '990403',
      level: 10,
      client: direct ? item.client : null,
      clientClass: item.client.cls,
      host,
      route: null,
      techniques: WEB_RULES['990403'].techniques,
      eventName: '',
      weight: 0,
      firstMs: Infinity,
      lastMs: 0,
      counters: { ...emptyCounters(), clients: 1 },
      entries: [],
      participants: [],
      families: 0,
      samples: [],
      notes,
      truncated: false,
      ...windowOf(view, view.short),
      load: direct
        ? (loaded) => {
            const client = totalsOf(item.client, view.short);
            loaded.entries = client.entries;
            loaded.counters.requests = client.total;
            loaded.counters.blocked = client.blocked;
            loaded.counters.errors = client.errors;
            loaded.counters.probes = client.probes;
            loaded.truncated ||= client.truncated;
          }
        : null,
    };
    found.set(identity, hit);
  }
  hit.weight += item.count;
  hit.counters.answered += item.count;
  hit.families |= group.match.bit;
  hit.firstMs = Math.min(hit.firstMs, item.first.atMs);
  hit.lastMs = Math.max(hit.lastMs, item.lastMs);
  if (hit.samples.length < MAX_EVIDENCE_SAMPLES) hit.samples.push(item.first);
  hit.truncated ||= slot.truncated || group.moreClients;
  hit.eventName = `${plural(hit.weight, 'resposta', 'respostas')} com conteúdo a ${plural(countBits(hit.families), 'tipo', 'tipos')} de caminho sensível`;
}

// ---------------------------------------------------------------------------------------------------------------------

export interface WindowResult {
  hits: WebHit[];
  catchAllSuppressed: number;
  natKeys: ReadonlySet<string>;
}

/**
 * Todas as regras sobre uma janela. Primeiro as que nunca são dobradas. Em passos: quem chama pode soltar o laço de eventos
 * entre eles.
 */
export function* evaluateWindow(view: WindowView, context: RuleContext): Generator<void, WindowResult> {
  const short = loginGroups(view.short);
  const long = loginGroups(view.long);
  yield;
  const semantics = new Map<string, Semantics>();
  for (const [routeId, group] of long) semantics.set(routeId, semanticsOf(group));
  const natKeys = natKeysOf(short, view.short);
  const hits: WebHit[] = [];
  const catchAllSuppressed = answeredHits(view, hits);
  yield;
  failuresThenSuccessHits(view, long, semantics, natKeys, hits);
  yield;
  distributedHits(view, context, semantics, hits);
  bruteForceHits(view, short, semantics, natKeys, hits);
  yield;
  yield* clientHits(view, context, natKeys, hits);
  if (view.late) for (const hit of hits) hit.notes.add('late_object').add('counts_are_floor');
  return { hits, catchAllSuppressed, natKeys };
}

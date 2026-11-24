import { z } from 'zod';
import { severityOfLevel } from '../alerts/finding-draft.js';
import { correlationOf, type WebFindingDraft, webFindingKey, type WebSource } from './draft.js';
import { EVIDENCE_VERSION, MAX_EVIDENCE_CLIENTS, sealEvidence } from './evidence.js';
import { SLOT_MS } from './limits.js';
import { familiesOf } from './probes.js';
import { emptyCounters, FLAG_OF, WEB_RULES, type WebHit } from './rules.js';
import type { ClientEntry, Slot } from './tally.js';

/**
 * O resumo do dia (990400) e a barra do "direcionado": o que separa o robô que passa pela internet inteira de quem está
 * mirando este cliente.
 *
 * Uma detecção de 990401, 990402 ou 990404 vira achado próprio se o mesmo cliente, em 24 h, teve detecções em 3 slots ou
 * mais, 300 sondas ou mais, 500 caminhos distintos ou mais, ou qualquer 990403, 990405, 990406 ou 990407. Senão, entra no
 * resumo: um achado por balanceador e dia (UTC), que é revisto, com os totais e os 20 maiores. Todo endereço contado no
 * teto aparece num dos dois.
 *
 * **Contas idempotentes.** O total do dia é o assentado (os slots que já saíram da memória) mais o vivo (os slots que ainda
 * estão nela, recalculados a cada avaliação). Reavaliar não soma duas vezes. Num reinício, a tarefa devolve o assentado
 * (`restore`) e relê os slots depois do `settledThrough` (até 70 minutos): o vivo se refaz, e o que já foi assentado não
 * soma de novo.
 */
export const DAY_MS = 24 * 60 * 60_000;
const TARGET_SLOTS = 3;
const TARGET_PROBES = 300;
const TARGET_PATHS = 500;
const MAX_TRACKED = 4_000;
const NOISE_LEVEL = 4;

const digestClientSchema = z.strictObject({
  requests: z.int().min(0),
  tool: z.int().min(0),
  probes: z.int().min(0),
  errors: z.int().min(0),
  families: z.int().min(0),
  firstMs: z.int().min(0),
  lastMs: z.int().min(0),
});
type DigestClient = z.infer<typeof digestClientSchema>;

const trackSchema = z.strictObject({
  slots: z.array(z.int().min(0)).max(TARGET_SLOTS),
  seriousMs: z.int().min(0).nullable(),
  targetedMs: z.int().min(0).nullable(),
});
type Track = z.infer<typeof trackSchema>;

const clientKeySchema = z.string().min(1).max(49);

/** O que a tarefa guarda entre reinícios (PR-4). Só contagens e chaves de cliente. */
export const digestStateSchema = z.strictObject({
  version: z.literal(1),
  /** O último slot assentado; null se nenhum. */
  settledThrough: z.int().min(0).nullable(),
  days: z
    .array(
      z.strictObject({
        day: z.int().min(0),
        clients: z.array(z.tuple([clientKeySchema, digestClientSchema])).max(50_000),
        dropped: z.int().min(0),
      }),
    )
    .max(3),
  tracks: z.array(z.tuple([clientKeySchema, trackSchema])).max(MAX_TRACKED),
});
export type DigestState = z.infer<typeof digestStateSchema>;

interface Day {
  clients: Map<string, DigestClient>;
  dropped: number;
}

const emptyClient = (): DigestClient => ({
  requests: 0,
  tool: 0,
  probes: 0,
  errors: 0,
  families: 0,
  firstMs: Number.MAX_SAFE_INTEGER,
  lastMs: 0,
});

/** O que conta de um registro: só as partes das regras que casaram. */
function contribute(target: DigestClient, slot: Slot, entry: ClientEntry): void {
  target.requests += entry.total;
  if ((entry.flags & (FLAG_OF['990401'] ?? 0)) !== 0) target.tool += entry.tool;
  if ((entry.flags & (FLAG_OF['990402'] ?? 0)) !== 0) {
    target.probes += entry.probes;
    target.families |= entry.families;
  }
  if ((entry.flags & (FLAG_OF['990404'] ?? 0)) !== 0) target.errors += entry.errors;
  target.firstMs = Math.min(target.firstMs, slot.startMs + entry.first);
  target.lastMs = Math.max(target.lastMs, slot.startMs + entry.last);
}

const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

const weightOf = (client: DigestClient): number => client.tool + client.probes + client.errors;

/** O registro teve atividade da regra (só o slot que contribuiu conta para a barra). */
function active(entry: ClientEntry, rule: string): boolean {
  if (rule === '990401') return entry.tool > 0;
  if (rule === '990402') return entry.probes > 0;
  return entry.errors > 0;
}

export class NoiseDigest {
  private readonly days = new Map<number, Day>();
  private readonly tracks = new Map<string, Track>();
  private readonly maxDayClients: number;
  private settledThrough: number | null = null;

  constructor(maxDayClients: number) {
    this.maxDayClients = maxDayClients;
  }

  /** O slot já está no total assentado. O objeto atrasado é outro: chega uma vez só e se assenta sozinho. */
  private isSettled(slot: Slot): boolean {
    return !slot.late && this.settledThrough !== null && slot.index <= this.settledThrough;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // A barra
  // -------------------------------------------------------------------------------------------------------------------

  private trackOf(key: string): Track {
    let track = this.tracks.get(key);
    if (track === undefined) {
      if (this.tracks.size >= MAX_TRACKED) this.shedTracks();
      track = { slots: [], seriousMs: null, targetedMs: null };
      this.tracks.set(key, track);
    }
    return track;
  }

  /** No teto, sai a metade com menos história; quem teve detecção séria fica. */
  private shedTracks(): void {
    const weight = (track: Track): number =>
      (track.seriousMs === null ? 0 : 10) + (track.targetedMs === null ? 0 : 5) + track.slots.length;
    const all = [...this.tracks].sort(([a, x], [b, y]) => weight(x) - weight(y) || (a < b ? -1 : 1));
    for (const [key] of all.slice(0, Math.ceil(all.length / 2))) this.tracks.delete(key);
  }

  /** 990403, 990405, 990406 ou 990407: quem participou fica marcado por 24 h. */
  markSerious(hit: WebHit): void {
    if (hit.client?.cls === 'direct') this.trackOf(hit.client.key).seriousMs = hit.lastMs;
    for (const { client } of hit.participants.slice(0, 500)) {
      if (client.cls === 'direct') this.trackOf(client.key).seriousMs = hit.lastMs;
    }
  }

  /** Marca os registros da janela da detecção e os slots em que o cliente agiu. */
  markNoise(hit: WebHit): void {
    if (hit.client === null) return;
    const track = this.trackOf(hit.client.key);
    for (const { slot, entry } of hit.entries) {
      if (!active(entry, hit.rule)) continue;
      entry.flags |= FLAG_OF[hit.rule] ?? 0;
      if (track.slots.includes(slot.index)) continue;
      track.slots.push(slot.index);
      if (track.slots.length > TARGET_SLOTS) {
        // Ficam os mais recentes.
        track.slots.sort((a, b) => a - b).shift();
      }
    }
  }

  /** A detecção passa da barra; se passa, o cliente sai do resumo. */
  isTargeted(hit: WebHit, live: ReadonlyMap<number, ReadonlyMap<string, DigestClient>>): boolean {
    if (hit.client === null) return true;
    const track = this.trackOf(hit.client.key);
    const targeted = this.passesBar(hit, hit.client.key, track, live);
    if (targeted) track.targetedMs = Math.max(track.targetedMs ?? 0, hit.lastMs);
    return targeted;
  }

  private passesBar(
    hit: WebHit,
    key: string,
    track: Track,
    live: ReadonlyMap<number, ReadonlyMap<string, DigestClient>>,
  ): boolean {
    const oldest = Math.floor((hit.toMs - DAY_MS) / SLOT_MS);
    if (track.slots.filter((slot) => slot > oldest).length >= TARGET_SLOTS) return true;
    if (track.seriousMs !== null && track.seriousMs > hit.toMs - DAY_MS) return true;
    if (hit.counters.distinctPaths >= TARGET_PATHS) return true;
    const day = dayOf(hit.lastMs);
    const probes =
      (this.days.get(day)?.clients.get(key)?.probes ?? 0) + (live.get(day)?.get(key)?.probes ?? 0);
    return Math.max(probes, hit.counters.probes) >= TARGET_PROBES;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // O dia
  // -------------------------------------------------------------------------------------------------------------------

  /** O que os slots em memória somam, por dia e cliente. */
  live(slots: Iterable<Slot>): Map<number, Map<string, DigestClient>> {
    const days = new Map<number, Map<string, DigestClient>>();
    for (const slot of slots) {
      if (this.isSettled(slot)) continue;
      for (const [key, entry] of slot.clients) {
        if (entry.flags === 0) continue;
        const day = dayOf(slot.startMs);
        let clients = days.get(day);
        if (clients === undefined) {
          clients = new Map();
          days.set(day, clients);
        }
        let client = clients.get(key);
        if (client === undefined) {
          client = emptyClient();
          clients.set(key, client);
        }
        contribute(client, slot, entry);
      }
    }
    return days;
  }

  /** O slot vai sair da memória: a parte dele fica assentada. */
  settle(slot: Slot, now: number): void {
    if (this.isSettled(slot)) return;
    if (!slot.late) this.settledThrough = Math.max(this.settledThrough ?? 0, slot.index);
    const index = dayOf(slot.startMs);
    if (index < dayOf(now) - 1) return;
    for (const [key, entry] of slot.clients) {
      if (entry.flags === 0) continue;
      let day = this.days.get(index);
      if (day === undefined) {
        day = { clients: new Map(), dropped: 0 };
        this.days.set(index, day);
      }
      let client = day.clients.get(key);
      if (client === undefined) {
        if (day.clients.size >= this.maxDayClients) this.shedDay(day);
        client = emptyClient();
        day.clients.set(key, client);
      }
      contribute(client, slot, entry);
    }
  }

  private shedDay(day: Day): void {
    const all = [...day.clients].sort(([a, x], [b, y]) => weightOf(x) - weightOf(y) || (a < b ? -1 : 1));
    for (const [key] of all.slice(0, Math.ceil(all.length / 2))) {
      day.clients.delete(key);
      day.dropped += 1;
    }
  }

  /** Esquece os clientes que deixaram de ser diretos: o resumo e a barra são por endereço de um visitante. */
  forget(isDirect: (key: string) => boolean): void {
    for (const { clients } of this.days.values()) {
      for (const key of clients.keys()) if (!isDirect(key)) clients.delete(key);
    }
    for (const key of this.tracks.keys()) if (!isDirect(key)) this.tracks.delete(key);
  }

  /** Esquece os dias e as marcas que não valem mais. */
  prune(now: number): void {
    for (const index of this.days.keys()) if (index < dayOf(now) - 1) this.days.delete(index);
    const oldestSlot = Math.floor((now - DAY_MS) / SLOT_MS);
    for (const [key, track] of this.tracks) {
      track.slots = track.slots.filter((slot) => slot > oldestSlot);
      if (track.seriousMs !== null && track.seriousMs <= now - DAY_MS) track.seriousMs = null;
      if (track.targetedMs !== null && track.targetedMs <= now - DAY_MS) track.targetedMs = null;
      if (track.slots.length === 0 && track.seriousMs === null && track.targetedMs === null) {
        this.tracks.delete(key);
      }
    }
  }

  /** O cliente tem achado próprio desde o começo do dia: não repete no resumo. */
  private hasOwnFinding(key: string, dayMs: number): boolean {
    const track = this.tracks.get(key);
    return Math.max(track?.targetedMs ?? 0, track?.seriousMs ?? 0) >= dayMs;
  }

  /** Os achados de resumo: um por dia com algum cliente abaixo da barra. */
  drafts(
    source: WebSource,
    live: ReadonlyMap<number, ReadonlyMap<string, DigestClient>>,
    now: number,
  ): WebFindingDraft[] {
    const today = dayOf(now);
    const out: WebFindingDraft[] = [];
    for (const index of [today - 1, today]) {
      const merged = new Map<string, DigestClient>();
      for (const clients of [this.days.get(index)?.clients, live.get(index)]) {
        for (const [key, client] of clients ?? []) {
          const held = merged.get(key) ?? emptyClient();
          merged.set(key, {
            requests: held.requests + client.requests,
            tool: held.tool + client.tool,
            probes: held.probes + client.probes,
            errors: held.errors + client.errors,
            families: held.families | client.families,
            firstMs: Math.min(held.firstMs, client.firstMs),
            lastMs: Math.max(held.lastMs, client.lastMs),
          });
        }
      }
      for (const key of merged.keys()) if (this.hasOwnFinding(key, index * DAY_MS)) merged.delete(key);
      if (merged.size === 0) continue;
      out.push(digestDraft(source, index, merged, this.days.get(index)?.dropped ?? 0));
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Reinício
  // -------------------------------------------------------------------------------------------------------------------

  snapshot(): DigestState {
    return {
      version: 1,
      settledThrough: this.settledThrough,
      days: [...this.days].map(([day, { clients, dropped }]) => ({ day, clients: [...clients], dropped })),
      tracks: [...this.tracks].map(([key, track]) => [key, { ...track, slots: [...track.slots] }]),
    };
  }

  /** Vem do banco: validado como qualquer entrada. Estado que não serve é recusado (lança), e o dia recomeça do zero. */
  restore(state: unknown): void {
    const parsed = digestStateSchema.parse(state);
    this.days.clear();
    this.tracks.clear();
    this.settledThrough = parsed.settledThrough;
    for (const { day, clients, dropped } of parsed.days) {
      this.days.set(day, { clients: new Map(clients.slice(0, this.maxDayClients)), dropped });
    }
    for (const [key, track] of parsed.tracks) this.tracks.set(key, track);
  }
}

function digestDraft(
  source: WebSource,
  index: number,
  merged: ReadonlyMap<string, DigestClient>,
  dropped: number,
): WebFindingDraft {
  const dayMs = index * DAY_MS;
  const day = new Date(dayMs).toISOString().slice(0, 10);
  const clients = [...merged].sort(
    ([a, x], [b, y]) => weightOf(y) - weightOf(x) || y.requests - x.requests || (a < b ? -1 : 1),
  );
  const counters = { ...emptyCounters(), clients: clients.length };
  let families = 0;
  let firstMs = Number.MAX_SAFE_INTEGER;
  let lastMs = 0;
  for (const [, client] of clients) {
    counters.requests += client.requests;
    counters.toolRequests += client.tool;
    counters.probes += client.probes;
    counters.errors += client.errors;
    families |= client.families;
    firstMs = Math.min(firstMs, client.firstMs);
    lastMs = Math.max(lastMs, client.lastMs);
  }
  const key = webFindingKey(source, {
    rule: '990400',
    client: null,
    host: null,
    route: null,
    extra: day,
  });
  const rule = WEB_RULES['990400'];
  return {
    tenantId: source.tenantId,
    accountId: source.accountId,
    source: 'aws',
    sourceEventId: key,
    occurredAt: new Date(firstMs).toISOString(),
    severity: severityOfLevel(NOISE_LEVEL),
    ruleId: '990400',
    ruleLevel: NOISE_LEVEL,
    title: rule.title,
    logSource: 'alb',
    eventName: `${clients.length} endereços no dia: ${counters.probes} sondas, ${counters.toolRequests} requisições de ferramenta, ${counters.errors} recusas de enumeração`,
    region: source.region,
    resource: `alb:${source.loadBalancer}`,
    actorUser: null,
    actorType: null,
    accessKeyId: null,
    sourceIp: null,
    mitreTactics: [...rule.tactics],
    mitreTechniques: [...rule.techniques],
    revision: { lastSeenAt: new Date(lastMs).toISOString() },
    evidence: sealEvidence({
      version: EVIDENCE_VERSION,
      ruleId: '990400',
      windowFrom: new Date(dayMs).toISOString(),
      windowTo: new Date(dayMs + DAY_MS).toISOString(),
      firstSeenAt: new Date(firstMs).toISOString(),
      lastSeenAt: new Date(lastMs).toISOString(),
      client: null,
      clientClass: null,
      host: null,
      route: null,
      routeKind: null,
      routeSemantics: null,
      counters,
      blockedPercent: 0,
      statuses: [],
      probeFamilies: familiesOf(families),
      routes: [],
      clients: clients.slice(0, MAX_EVIDENCE_CLIENTS).map(([client, item]) => ({
        client,
        requests: item.requests,
        count: weightOf(item),
      })),
      userAgents: { families: [], sample: null },
      samples: [],
      pointers: [],
      truncated: dropped > 0,
      notes: dropped > 0 ? ['counts_are_floor'] : [],
    }),
    correlation: correlationOf(source, { rule: '990400', client: null, host: null, firstMs, lastMs }),
  };
}

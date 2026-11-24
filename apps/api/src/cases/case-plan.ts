import { randomBytes } from 'node:crypto';
import type { CaseQueue, FindingSeverity } from '../generated/prisma/client.js';
import { isNoticeSeverity } from '../notifications/finding-notices.js';
import {
  type CaseFold,
  type CaseKey,
  type CaseKeyInput,
  type CaseKeyPart,
  caseKeyOf,
  firstCharacters,
  foldedCaseKey,
} from './case-key.js';
import { arrivalOf, type CaseSealReason, type OpenCaseState, sealReasonFor } from './case-lifecycle.js';
import { fanOutGroup, foldFor, RecentOpenings } from './case-limits.js';
import { caseTitle, foldedCaseTitle } from './case-titles.js';

/**
 * O plano de um lote, sem banco: de que caso é cada alerta, que casos abrem, quais são selados e o que muda nos que já
 * existiam. Quem lê o banco antes e grava o plano depois é `case-assign-job.ts`.
 */

/** O alerta de um lote, pelas colunas gravadas dele. */
export interface PlanFinding extends CaseKeyInput {
  id: string;
  createdAt: Date;
  occurredAt: Date;
  lastSeenAt: Date | null;
  severity: FindingSeverity;
  accessKeyId: string | null;
  mitreTactics: string[];
  mitreTechniques: string[];
}

/** Os tetos das amostras (os mesmos do CHECK da migration). */
export const SAMPLE_LIMITS = {
  ruleIds: 20,
  accounts: 50,
  actors: 20,
  ips: 20,
  resources: 20,
  mitreTactics: 20,
  mitreTechniques: 50,
} as const;
export type SampleName = keyof typeof SAMPLE_LIMITS;
export type CaseSamples = Record<SampleName, string[]>;
/** O quanto de cada valor fica na amostra, em caracteres: ela só é mostrada. */
export const SAMPLE_VALUE_MAX = 256;

/** O que muda num caso a cada alerta que entra. */
export interface CaseFacts extends CaseSamples {
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastAlertAt: Date;
  noticedSeverity: FindingSeverity | null;
}

/** Um caso aberto, como está no banco. */
export interface OpenCase extends CaseFacts, OpenCaseState {
  id: string;
  groupKey: string;
  recurrence: number;
}

/** O último caso selado de uma chave. */
export interface PreviousCase {
  id: string;
  recurrence: number;
}

export interface PlannedCase extends CaseFacts {
  id: string;
  queue: CaseQueue;
  keyVersion: number;
  groupKey: string;
  family: string;
  title: string;
  keyParts: CaseKeyPart[];
  previousCaseId: string | null;
  recurrence: number;
  anchorFindingId: string;
  openedAt: Date;
  /**
   * `open`: nasce aberto. `sealed`: já nasce selado (o histórico passou da janela dentro do próprio lote). `replaces`:
   * nasce no lugar de um caso aberto no banco que este lote sela; só abre depois que o outro larga a chave.
   */
  state: { kind: 'open' | 'replaces' } | { kind: 'sealed'; reason: CaseSealReason };
}

export interface BatchPlan {
  created: PlannedCase[];
  assignments: { findingId: string; caseId: string; group: string | null }[];
  /** Os casos do banco que ganharam alertas, com os dados já juntados. */
  touched: (CaseFacts & { id: string })[];
  /** Os casos do banco a selar. */
  sealed: { id: string; reason: CaseSealReason }[];
  /** Alertas que foram para um caso reunido, por tipo. */
  folded: Record<CaseFold, number>;
}

export interface PlanInput {
  findings: readonly PlanFinding[];
  /** O relógio do servidor. */
  now: Date;
  /**
   * Até quando o aviso por e-mail sai alerta por alerta (`FindingStore`): o alerta que chegou antes é do passado, e o caso
   * nascido dele já nasce com a severidade avisada. Null: ainda sai sempre.
   */
  noticedBefore: Date | null;
  /** Os casos abertos, por `groupKey`: os das chaves dos alertas e os das reuniões possíveis. */
  open: ReadonlyMap<string, OpenCase>;
  previous: ReadonlyMap<string, PreviousCase>;
  openings: RecentOpenings;
  /** A lista de proteção do cliente (`protectedItemsOf`). */
  protectedItems: ReadonlySet<string>;
  /** O id de um caso novo (fixo nos testes). */
  newId?: () => string;
}

/** Um UUID v7, como os do Prisma (`uuid(7)`): o horário na frente, e o resto aleatório. */
export function uuidV7(at: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(at, 0, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

/** A ordem de chegada dos alertas, a mesma do índice da fila. */
export function byArrival(a: PlanFinding, b: PlanFinding): number {
  const difference = a.createdAt.getTime() - b.createdAt.getTime();
  if (difference !== 0) return difference;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** O alerta toca um item da lista de proteção: a conferência do resumo do incidente, mais o endereço de origem. */
export function touchesProtected(finding: PlanFinding, protectedItems: ReadonlySet<string>): boolean {
  return [finding.resource, finding.actorUser, finding.accessKeyId, finding.sourceIp].some(
    (item) => item !== null && protectedItems.has(item),
  );
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

function worst(a: FindingSeverity | null, b: FindingSeverity): FindingSeverity {
  return a === null || SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a;
}

const earlier = (a: Date, b: Date): Date => (b.getTime() < a.getTime() ? b : a);
const later = (a: Date, b: Date): Date => (b.getTime() > a.getTime() ? b : a);

function addSample(samples: string[], value: string | null, limit: number): void {
  if (value === null || samples.length >= limit) return;
  const kept = firstCharacters(value.toWellFormed(), SAMPLE_VALUE_MAX);
  if (kept.trim().length > 0 && !samples.includes(kept)) samples.push(kept);
}

/** Um caso em uso no lote: do banco (com as amostras copiadas) ou aberto por ele. */
interface LiveCase extends OpenCaseState, CaseFacts {
  id: string;
  recurrence: number;
  touched: boolean;
  /** O caso novo que este é; null se veio do banco. */
  planned: PlannedCase | null;
}

/** A situação de uma chave durante o lote. */
interface KeyTrack {
  current: LiveCase | null;
  previous: PreviousCase | null;
  /** O lote selou um caso do banco com esta chave. */
  sealedStored: boolean;
}

class Planner {
  private readonly tracks = new Map<string, KeyTrack>();
  private readonly lives: LiveCase[] = [];
  private readonly plan: BatchPlan = {
    created: [],
    assignments: [],
    touched: [],
    sealed: [],
    folded: { distributed: 0, overflow: 0, rollup: 0 },
  };

  constructor(private readonly input: PlanInput) {}

  run(): BatchPlan {
    for (const finding of [...this.input.findings].sort(byArrival)) this.place(finding);
    for (const track of this.tracks.values()) {
      const planned = track.current?.planned ?? null;
      if (planned !== null && track.sealedStored) planned.state = { kind: 'replaces' };
    }
    for (const live of this.lives) {
      const { firstSeenAt, lastSeenAt, lastAlertAt, noticedSeverity } = live;
      const facts: CaseFacts = { firstSeenAt, lastSeenAt, lastAlertAt, noticedSeverity, ...samplesOf(live) };
      if (live.planned !== null) Object.assign(live.planned, facts);
      else if (live.touched) this.plan.touched.push({ id: live.id, ...facts });
    }
    return this.plan;
  }

  private place(finding: PlanFinding): void {
    const arrival = arrivalOf(finding.createdAt, this.input.now);
    const key = caseKeyOf(finding);
    const own = this.track(key.groupKey);
    const fold = this.accepts(own, arrival)
      ? null
      : foldFor(
          key,
          {
            accountId: finding.accountId,
            severity: finding.severity,
            isProtected: touchesProtected(finding, this.input.protectedItems),
          },
          arrival,
          this.input.openings,
        );
    if (fold !== null) this.plan.folded[fold] += 1;
    const track = fold === null ? own : this.track(foldedCaseKey(finding, fold).groupKey);
    this.join(this.admit(track, finding, key, arrival, fold), finding, key, arrival);
  }

  private track(groupKey: string): KeyTrack {
    const known = this.tracks.get(groupKey);
    if (known !== undefined) return known;
    const open = this.input.open.get(groupKey);
    const track: KeyTrack = {
      current: open === undefined ? null : this.live({ ...open, ...samplesOf(open) }, null),
      previous: this.input.previous.get(groupKey) ?? null,
      sealedStored: false,
    };
    this.tracks.set(groupKey, track);
    return track;
  }

  private live(state: OpenCaseState & CaseFacts & PreviousCase, planned: PlannedCase | null): LiveCase {
    const live: LiveCase = { ...state, touched: false, planned };
    this.lives.push(live);
    return live;
  }

  private accepts({ current }: KeyTrack, arrival: Date): boolean {
    return current !== null && sealReasonFor(current, arrival) === null;
  }

  /** O caso que recebe o alerta: o aberto da chave ou, se ele não recebe mais, um novo (e o aberto é selado). */
  private admit(
    track: KeyTrack,
    finding: PlanFinding,
    key: CaseKey,
    arrival: Date,
    fold: CaseFold | null,
  ): LiveCase {
    const { current } = track;
    if (current !== null) {
      const reason = sealReasonFor(current, arrival);
      if (reason === null) return current;
      if (current.planned !== null) current.planned.state = { kind: 'sealed', reason };
      else {
        this.plan.sealed.push({ id: current.id, reason });
        track.sealedStored = true;
      }
      track.previous = { id: current.id, recurrence: current.recurrence };
    }
    const opened = this.open(finding, key, arrival, fold, track.previous);
    track.current = opened;
    return opened;
  }

  private open(
    finding: PlanFinding,
    key: CaseKey,
    arrival: Date,
    fold: CaseFold | null,
    previous: PreviousCase | null,
  ): LiveCase {
    const id = (this.input.newId ?? uuidV7)();
    const target = fold === null ? key : foldedCaseKey(finding, fold);
    const recurrence = previous === null ? 0 : previous.recurrence + 1;
    const facts: CaseFacts = {
      firstSeenAt: finding.occurredAt,
      lastSeenAt: finding.occurredAt,
      lastAlertAt: arrival,
      noticedSeverity: null,
      ...emptySamples(),
    };
    const planned: PlannedCase = {
      ...facts,
      id,
      queue: target.queue,
      keyVersion: target.version,
      groupKey: target.groupKey,
      family: target.family,
      title:
        fold === null ? caseTitle(key, finding.ruleId) : foldedCaseTitle(fold, key.family, finding.logSource),
      keyParts: target.parts,
      previousCaseId: previous?.id ?? null,
      recurrence,
      anchorFindingId: finding.id,
      openedAt: arrival,
      state: { kind: 'open' },
    };
    this.plan.created.push(planned);
    this.input.openings.add({
      queue: target.queue,
      openedAt: arrival,
      group: fanOutGroup(target.family, finding.accountId, target.parts),
    });
    return this.live(
      {
        ...facts,
        id,
        recurrence,
        queue: target.queue,
        openedAt: arrival,
        pending: true,
        promoted: false,
        treated: false,
      },
      planned,
    );
  }

  private join(live: LiveCase, finding: PlanFinding, key: CaseKey, arrival: Date): void {
    this.plan.assignments.push({ findingId: finding.id, caseId: live.id, group: key.group });
    live.touched = true;
    live.firstSeenAt = earlier(live.firstSeenAt, finding.occurredAt);
    live.lastSeenAt = later(
      live.lastSeenAt,
      later(finding.occurredAt, finding.lastSeenAt ?? finding.occurredAt),
    );
    live.lastAlertAt = later(live.lastAlertAt, arrival);
    if (isNoticeSeverity(finding.severity) && this.alreadyNoticed(finding, live)) {
      live.noticedSeverity = worst(live.noticedSeverity, finding.severity);
    }
    addSample(live.ruleIds, finding.ruleId, SAMPLE_LIMITS.ruleIds);
    addSample(live.accounts, finding.accountId, SAMPLE_LIMITS.accounts);
    addSample(live.actors, finding.actorUser, SAMPLE_LIMITS.actors);
    addSample(live.ips, finding.sourceIp, SAMPLE_LIMITS.ips);
    addSample(live.resources, finding.resource, SAMPLE_LIMITS.resources);
    for (const tactic of finding.mitreTactics) {
      addSample(live.mitreTactics, tactic, SAMPLE_LIMITS.mitreTactics);
    }
    for (const technique of finding.mitreTechniques) {
      addSample(live.mitreTechniques, technique, SAMPLE_LIMITS.mitreTechniques);
    }
  }

  /**
   * O aviso do alerta já saiu, alerta por alerta: ele chegou antes de os avisos por caso valerem. Só marca o caso que
   * também é de antes: um alerta antigo que volta à fila e entra num caso novo não cala o aviso dele.
   */
  private alreadyNoticed(finding: PlanFinding, live: LiveCase): boolean {
    const before = this.input.noticedBefore;
    return before === null || (finding.createdAt < before && live.openedAt < before);
  }
}

function samplesOf(from: CaseSamples): CaseSamples {
  return {
    ruleIds: [...from.ruleIds],
    accounts: [...from.accounts],
    actors: [...from.actors],
    ips: [...from.ips],
    resources: [...from.resources],
    mitreTactics: [...from.mitreTactics],
    mitreTechniques: [...from.mitreTechniques],
  };
}

function emptySamples(): CaseSamples {
  return {
    ruleIds: [],
    accounts: [],
    actors: [],
    ips: [],
    resources: [],
    mitreTactics: [],
    mitreTechniques: [],
  };
}

/** O plano de um lote. As aberturas do lote entram em `openings`. Puro: o mesmo lote e o mesmo banco dão o mesmo plano. */
export function planBatch(input: PlanInput): BatchPlan {
  return new Planner(input).run();
}

import {
  type Author,
  type FindingDetail,
  type FindingStatus,
  FINDING_SEVERITIES,
  hasPermission,
  isMassTriageRole,
  MAX_ACTIVE_TRIAGE_OPERATIONS,
  type Me,
  TRIAGE_ALERTS_PER_DAY,
  TRIAGE_ALERTS_PER_OPERATION,
  TRIAGE_EMPTY_CODE,
  TRIAGE_INCIDENT_RESOLVED_CODE,
  TRIAGE_NOT_ACTIVE_CODE,
  TRIAGE_NOT_RESUMABLE_CODE,
  TRIAGE_NOT_UNDOABLE_CODE,
  TRIAGE_QUEUE_FULL_CODE,
  TRIAGE_QUOTA_CODE,
  TRIAGE_REASON_REQUIRED_CODE,
  TRIAGE_REQUEST_REUSED_CODE,
  TRIAGE_SCOPE_CHANGED_CODE,
  TRIAGE_STILL_ACTIVE_CODE,
  TRIAGE_SYNC_ALERTS,
  TRIAGE_UNDO_EXPIRED_CODE,
  TRIAGE_UNDO_HOURS,
  type TriageAction,
  type TriageOperationCreate,
  type TriageOperationDetail,
  triageOperationDetailSchema,
  type TriageOperationView,
  triageScopeChanged,
  type TriageState,
  type TriageStop,
  type TriageTarget,
  type TriageTargetView,
} from '@verax/shared';
import { type DemoCases, isPending } from './case-store';

/**
 * A triagem em massa da demonstração, com as regras da API: conjunto congelado, críticos só com a inclusão, motivo, cotas do
 * analista, na hora até 200 alertas e na fila além disso (o andamento é pelo relógio, sem temporizador), desfazer, cancelar e
 * continuar. `scenario` simula o que dá errado; sem ele, tudo dá certo.
 */
export const TRIAGE_SCENARIOS = [
  /** A fila anda devagar, para dar tempo de ver o andamento e cancelar. */
  'lenta',
  /** A primeira operação da fila para no meio, com alertas que não puderam ser gravados. */
  'parcial',
  /** A primeira operação da fila nem começa (banco indisponível). */
  'falha',
  /** O primeiro pedido encontra o banco ocupado (503). */
  'ocupada',
  /** Entre a confirmação e o pedido, chegam mais alertas (uma vez). */
  'mudou',
  /** A fila já está cheia. */
  'cheia',
] as const;
export type TriageScenario = (typeof TRIAGE_SCENARIOS)[number];

/** Alertas por segundo da fila. */
const RATE = 120;
const SLOW_RATE = 12;
const HOUR_MS = 3_600_000;
/** Quantos alertas chegam no cenário `mudou`. */
const ARRIVING = 60;
/** Quantos alertas falham no cenário `parcial`. */
const FAILING = 3;

interface Operation {
  id: string;
  requestId: string;
  /** O pedido, para saber se o mesmo id veio com outro conteúdo. */
  content: string;
  action: TriageAction;
  status: FindingStatus | null;
  incidentId: string | null;
  includeCritical: boolean;
  excludedCritical: number;
  expectedCount: number;
  reason: string | null;
  author: Author;
  target: TriageTargetView;
  createdAt: number;
  updatedAt: number;
  undoUntil: number | null;
  undoOf: Operation | null;
  state: TriageState;
  /** O estado da operação desfeita, para o cancelamento do desfazer a devolver. */
  previousState: TriageState | null;
  ids: string[];
  cursor: number;
  matched: number;
  changed: number;
  skipped: number;
  failed: string[];
  stop: TriageStop | null;
  stopped: boolean;
  startedAt: number | null;
  /** O que cada alerta mudado era antes. */
  items: Map<string, { status: FindingStatus; incidentId: string | null; at: number }>;
}

/** Uma recusa da API: status, código e os números dela. */
export class TriageRefusal extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly details?: Record<string, number>,
  ) {
    super(message);
  }
}

const FORWARD: readonly TriageAction[] = ['status', 'promote', 'attach'];
const ACTIVE: readonly TriageState[] = ['queued', 'running'];
const UNDOABLE: readonly TriageState[] = ['done', 'partial', 'canceled'];
const RESUMABLE: readonly TriageState[] = ['partial', 'failed'];
const needsIncidents = (action: TriageAction) => action === 'promote' || action === 'attach';

let sequence = 0;
const newId = (): string =>
  `018f2c1e-0000-7000-8000-${(0x7_0000_0000 + (sequence += 1)).toString(16).padStart(12, '0')}`;

export interface TriageWorld {
  cases: DemoCases;
  /** Abre um incidente (promover) e diz o id; a situação de um incidente; e encerra um. */
  openIncident: (author: Author) => string;
  incidentStatus: (id: string) => 'open' | 'investigating' | 'resolved' | undefined;
  resolveIncident: (id: string) => void;
}

export class DemoTriage {
  private readonly operations: Operation[] = [];
  /** A operação que vale em cada alerta. */
  private readonly lastOperation = new Map<string, string>();
  private hiccups = new Set<string>();

  constructor(
    private readonly world: TriageWorld,
    private readonly scenario: () => TriageScenario | null,
  ) {}

  /** Uma vez só por cenário. */
  private once(scenario: TriageScenario): boolean {
    if (this.scenario() !== scenario || this.hiccups.has(scenario)) return false;
    this.hiccups.add(scenario);
    return true;
  }

  private findingOf(id: string): FindingDetail | undefined {
    return this.world.cases.findings.find((finding) => finding.id === id);
  }

  // -------------------------------------------------------------------------------------------------
  // A fila
  // -------------------------------------------------------------------------------------------------

  /** Uma operação por vez, na ordem do pedido, até onde o relógio deixa. */
  private advance(now: number): void {
    for (;;) {
      const operation = this.operations
        .filter((candidate) => ACTIVE.includes(candidate.state))
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!operation) return;
      operation.startedAt ??= now;
      operation.state = 'running';
      const rate = this.scenario() === 'lenta' ? SLOW_RATE : RATE;
      const due = Math.floor(((now - operation.startedAt) / 1_000) * rate);
      this.run(operation, due, now);
      if (ACTIVE.includes(operation.state)) return;
    }
  }

  private run(operation: Operation, upTo: number, now: number): void {
    if (operation.cursor === 0 && this.once('falha')) {
      this.finish(operation, 'unavailable', now);
      return;
    }
    const half = Math.floor(operation.ids.length / 2);
    const stopsHere = this.scenario() === 'parcial' && !operation.stopped && operation.undoOf === null;
    const end = Math.min(operation.ids.length, upTo, stopsHere ? half : Number.POSITIVE_INFINITY);
    for (; operation.cursor < end; operation.cursor += 1) {
      this.apply(operation, operation.ids[operation.cursor] ?? '', now);
    }
    operation.updatedAt = now;
    if (stopsHere && operation.cursor >= half) {
      operation.stopped = true;
      operation.failed = operation.ids.slice(operation.cursor, operation.cursor + FAILING);
      operation.skipped += operation.failed.length;
      this.finish(operation, 'failed_alerts', now);
      return;
    }
    if (operation.cursor >= operation.ids.length) this.finish(operation, null, now);
  }

  private apply(operation: Operation, id: string, now: number): void {
    const finding = this.findingOf(id);
    const before = operation.undoOf?.items.get(id);
    if (operation.undoOf !== null) {
      const source = operation.undoOf;
      const anchor = source.action === 'promote' && source.ids[0] === id;
      const untouched =
        finding !== undefined &&
        before !== undefined &&
        this.lastOperation.get(id) === source.id &&
        (source.action === 'status'
          ? finding.status === source.status && finding.incidentId === null
          : finding.incidentId === source.incidentId);
      if (!untouched || anchor) {
        operation.skipped += 1;
        return;
      }
      operation.items.set(id, { status: finding.status, incidentId: finding.incidentId, at: now });
      finding.status = before.status;
      finding.incidentId = before.incidentId;
    } else {
      if (
        !finding ||
        !isPending(finding) ||
        (operation.status !== null && finding.status === operation.status)
      ) {
        operation.skipped += 1;
        return;
      }
      operation.items.set(id, { status: finding.status, incidentId: finding.incidentId, at: now });
      if (operation.action === 'status' && operation.status !== null) finding.status = operation.status;
      else finding.incidentId = operation.incidentId;
    }
    this.lastOperation.set(id, operation.id);
    operation.changed += 1;
  }

  private finish(operation: Operation, stop: TriageStop | null, now: number): void {
    operation.stop = stop;
    operation.state = stop === null ? 'done' : operation.changed > 0 ? 'partial' : 'failed';
    operation.updatedAt = now;
    if (operation.undoOf === null) operation.undoUntil = now + TRIAGE_UNDO_HOURS * HOUR_MS;
    else if (stop === null) {
      operation.undoOf.state = 'undone';
      const { incidentId } = operation.undoOf;
      if (operation.undoOf.action === 'promote' && incidentId !== null)
        this.world.resolveIncident(incidentId);
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Pedidos
  // -------------------------------------------------------------------------------------------------

  private authorOf(me: Me): Author {
    return { id: me.userId, name: me.email };
  }

  private repeated(me: Me, requestId: string, content: string): Operation | null {
    const found = this.operations.find((operation) => operation.requestId === requestId);
    if (!found) return null;
    if (found.content !== content || found.author.id !== me.userId) {
      throw new TriageRefusal(409, 'Este pedido já foi usado.', TRIAGE_REQUEST_REUSED_CODE);
    }
    return found;
  }

  private resolve(target: TriageTarget, now: number) {
    const { cases } = this.world;
    if ('findingIds' in target) {
      const found = target.findingIds.map((id) => this.findingOf(id.toLowerCase()));
      if (found.some((finding) => finding === undefined))
        throw new TriageRefusal(404, 'Alerta não encontrado');
      return { findings: found as FindingDetail[], cases: null };
    }
    const chosen =
      'filter' in target
        ? cases.matching(target.filter, new Date(now))
        : target.caseIds.map((id) => {
            const row = cases.byId(id);
            if (!row) throw new TriageRefusal(404, 'Caso não encontrado');
            return row;
          });
    const group = 'caseIds' in target ? (target.group ?? null) : null;
    const findings = chosen
      .flatMap((row) => cases.findingsOf(row))
      .filter((finding) => group === null || cases.groupOfFinding.get(finding.id) === group);
    return { findings, cases: group === null ? chosen : null };
  }

  create(me: Me, input: TriageOperationCreate): { status: number; operation: TriageOperationDetail } {
    const now = Date.now();
    this.advance(now);
    if (input.action === 'undo_all_of') return this.undoAllOf(me, input, now);
    const { requestId, ...rest } = input;
    const content = JSON.stringify(rest);
    const repeated = this.repeated(me, requestId, content);
    if (repeated) return { status: 200, operation: this.view(repeated, me, now) };
    if (needsIncidents(input.action) && !hasPermission(me.role, 'incidents:write')) {
      throw new TriageRefusal(403, 'Sem permissão');
    }
    if (this.once('ocupada')) throw new TriageRefusal(503, 'Serviço indisponível');
    if (input.action === 'attach') this.assertOpenIncident(input.incidentId);
    let scope = this.resolve(input.target, now);
    const first = scope.findings.find(isPending);
    const firstCase = first && this.world.cases.cases.find((row) => row.findingIds.has(first.id));
    if (first && firstCase && !('findingIds' in input.target) && this.once('mudou')) {
      this.world.cases.addTo(firstCase, ARRIVING, { ...first, severity: 'low' });
      scope = this.resolve(input.target, now);
    }
    const wanted = input.action === 'status' ? input.status : null;
    const pending = scope.findings.filter((finding) => isPending(finding) && finding.status !== wanted);
    const excludedCritical = input.includeCritical
      ? 0
      : pending.filter((finding) => finding.severity === 'critical').length;
    const frozen = pending
      .filter((finding) => input.includeCritical || finding.severity !== 'critical')
      .sort(
        (a, b) =>
          FINDING_SEVERITIES.indexOf(a.severity) - FINDING_SEVERITIES.indexOf(b.severity) ||
          b.occurredAt.localeCompare(a.occurredAt),
      );
    if (frozen.length === 0) {
      throw new TriageRefusal(
        409,
        excludedCritical > 0
          ? 'Só há alertas críticos pendentes no alvo.'
          : 'Não há alerta pendente no alvo.',
        TRIAGE_EMPTY_CODE,
        { count: 0, excludedCritical },
      );
    }
    if (triageScopeChanged(input.expectedCount, frozen.length)) {
      throw new TriageRefusal(409, 'O alvo mudou.', TRIAGE_SCOPE_CHANGED_CODE, {
        count: frozen.length,
        excludedCritical,
      });
    }
    const closing =
      input.action === 'status' && (input.status === 'legitimate' || input.status === 'resolved');
    if (closing && frozen.length > 1 && input.reason === undefined) {
      throw new TriageRefusal(400, 'Explique o motivo.', TRIAGE_REASON_REQUIRED_CODE);
    }
    this.assertQuota(me, frozen.length, now);
    const sync = frozen.length <= TRIAGE_SYNC_ALERTS;
    if (!sync) this.assertQueue();

    const author = this.authorOf(me);
    const operation = this.add({
      requestId,
      content,
      action: input.action,
      status: wanted,
      incidentId:
        input.action === 'promote'
          ? this.world.openIncident(author)
          : input.action === 'attach'
            ? input.incidentId
            : null,
      includeCritical: input.includeCritical,
      excludedCritical,
      expectedCount: input.expectedCount,
      reason: input.reason ?? null,
      author,
      target: targetView(input.target),
      ids: frozen.map((finding) => finding.id),
      createdAt: now,
    });
    if (input.action === 'promote' && operation.incidentId !== null && scope.cases) {
      for (const row of scope.cases) row.incidentId = operation.incidentId;
    }
    if (sync) this.run(operation, operation.ids.length, now);
    else if (input.action === 'promote') {
      // O incidente já nasce com os piores; os outros entram na fila.
      operation.state = 'running';
      for (; operation.cursor < Math.min(50, operation.ids.length); operation.cursor += 1) {
        this.apply(operation, operation.ids[operation.cursor] ?? '', now);
      }
    }
    return { status: sync ? 201 : 202, operation: this.view(operation, me, now) };
  }

  private add(
    input: Omit<
      Operation,
      | 'id'
      | 'updatedAt'
      | 'undoUntil'
      | 'undoOf'
      | 'state'
      | 'previousState'
      | 'cursor'
      | 'matched'
      | 'changed'
      | 'skipped'
      | 'failed'
      | 'stop'
      | 'stopped'
      | 'startedAt'
      | 'items'
    > &
      Partial<Pick<Operation, 'undoOf' | 'previousState'>>,
  ): Operation {
    const operation: Operation = {
      undoOf: null,
      previousState: null,
      ...input,
      id: newId(),
      updatedAt: input.createdAt,
      undoUntil: input.undoOf ? null : input.createdAt + TRIAGE_UNDO_HOURS * HOUR_MS,
      state: 'queued',
      cursor: 0,
      matched: input.ids.length,
      changed: 0,
      skipped: 0,
      failed: [],
      stop: null,
      stopped: false,
      startedAt: null,
      items: new Map(),
    };
    this.operations.push(operation);
    return operation;
  }

  private assertOpenIncident(id: string): void {
    const status = this.world.incidentStatus(id);
    if (status === undefined) throw new TriageRefusal(404, 'Incidente não encontrado');
    if (status === 'resolved') {
      throw new TriageRefusal(409, 'Incidente resolvido não muda de alertas.', TRIAGE_INCIDENT_RESOLVED_CODE);
    }
  }

  private assertQuota(me: Me, count: number, now: number): void {
    if (isMassTriageRole(me.role)) return;
    if (count > TRIAGE_ALERTS_PER_OPERATION) {
      throw new TriageRefusal(403, 'Limite por operação.', TRIAGE_QUOTA_CODE, {
        limit: TRIAGE_ALERTS_PER_OPERATION,
        count,
      });
    }
    const total =
      count +
      this.operations
        .filter(
          (operation) =>
            operation.author.id === me.userId &&
            FORWARD.includes(operation.action) &&
            operation.createdAt > now - 24 * HOUR_MS,
        )
        .reduce((sum, operation) => sum + operation.matched, 0);
    if (total > TRIAGE_ALERTS_PER_DAY) {
      throw new TriageRefusal(403, 'Limite por dia.', TRIAGE_QUOTA_CODE, {
        limit: TRIAGE_ALERTS_PER_DAY,
        count: total,
      });
    }
  }

  private assertQueue(): void {
    const active = this.operations.filter((operation) => ACTIVE.includes(operation.state)).length;
    if (active >= MAX_ACTIVE_TRIAGE_OPERATIONS || this.scenario() === 'cheia') {
      throw new TriageRefusal(409, 'Já há operações demais na fila.', TRIAGE_QUEUE_FULL_CODE, {
        limit: MAX_ACTIVE_TRIAGE_OPERATIONS,
      });
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Cancelar, continuar e desfazer
  // -------------------------------------------------------------------------------------------------

  private managed(me: Me, id: string): Operation {
    const operation = this.operations.find((candidate) => candidate.id === id);
    if (!operation) throw new TriageRefusal(404, 'Operação não encontrada');
    if (!this.manages(me, operation)) throw new TriageRefusal(403, 'Sem permissão');
    return operation;
  }

  private manages(me: Me, operation: Operation): boolean {
    return (
      hasPermission(me.role, 'findings:triage') &&
      (isMassTriageRole(me.role) || operation.author.id === me.userId)
    );
  }

  cancel(me: Me, id: string): TriageOperationDetail {
    const now = Date.now();
    this.advance(now);
    const operation = this.managed(me, id);
    if (![...ACTIVE, ...RESUMABLE].includes(operation.state)) {
      throw new TriageRefusal(409, 'A operação já terminou.', TRIAGE_NOT_ACTIVE_CODE);
    }
    this.cancelNow(operation, now);
    return this.view(operation, me, now);
  }

  private cancelNow(operation: Operation, now: number): void {
    if (operation.undoOf === null && ACTIVE.includes(operation.state)) {
      operation.undoUntil = now + TRIAGE_UNDO_HOURS * HOUR_MS;
    }
    operation.state = 'canceled';
    operation.updatedAt = now;
    if (operation.undoOf?.state === 'undoing') operation.undoOf.state = operation.previousState ?? 'done';
  }

  continue(me: Me, id: string): TriageOperationDetail {
    const now = Date.now();
    this.advance(now);
    const operation = this.managed(me, id);
    if (!RESUMABLE.includes(operation.state)) {
      throw new TriageRefusal(409, 'Esta operação não pode mais ser continuada.', TRIAGE_NOT_RESUMABLE_CODE);
    }
    if (operation.incidentId !== null) this.assertOpenIncident(operation.incidentId);
    this.assertQueue();
    operation.skipped -= operation.failed.length;
    operation.failed = [];
    operation.stop = null;
    operation.state = 'queued';
    // O relógio recomeça do ponto em que parou.
    operation.startedAt = now - (operation.cursor / RATE) * 1_000;
    operation.updatedAt = now;
    return this.view(operation, me, now);
  }

  undo(
    me: Me,
    id: string,
    input: { requestId: string; reason?: string | undefined },
  ): { status: number; operation: TriageOperationDetail } {
    const now = Date.now();
    this.advance(now);
    const content = JSON.stringify({ undo: id });
    const repeated = this.repeated(me, input.requestId, content);
    if (repeated) return { status: 200, operation: this.view(repeated, me, now) };
    const operation = this.managed(me, id);
    if (ACTIVE.includes(operation.state)) {
      throw new TriageRefusal(409, 'A operação ainda está em curso.', TRIAGE_STILL_ACTIVE_CODE);
    }
    if (
      !FORWARD.includes(operation.action) ||
      !UNDOABLE.includes(operation.state) ||
      operation.changed === 0
    ) {
      throw new TriageRefusal(409, 'Esta operação não pode ser desfeita.', TRIAGE_NOT_UNDOABLE_CODE);
    }
    if (operation.undoUntil === null || operation.undoUntil <= now) {
      throw new TriageRefusal(409, 'O prazo de 24 horas já passou.', TRIAGE_UNDO_EXPIRED_CODE);
    }
    if (operation.incidentId !== null && this.world.incidentStatus(operation.incidentId) === 'resolved') {
      throw new TriageRefusal(409, 'Incidente resolvido não muda de alertas.', TRIAGE_INCIDENT_RESOLVED_CODE);
    }
    const undo = this.enqueueUndo(me, operation, input.requestId, content, input.reason ?? null, now);
    const sync = undo.matched <= TRIAGE_SYNC_ALERTS;
    if (sync) this.run(undo, undo.ids.length, now);
    return { status: sync ? 201 : 202, operation: this.view(undo, me, now) };
  }

  private enqueueUndo(
    me: Me,
    operation: Operation,
    requestId: string,
    content: string,
    reason: string | null,
    at: number,
  ): Operation {
    const undo = this.add({
      requestId,
      content,
      action: 'undo',
      status: null,
      incidentId: null,
      includeCritical: true,
      excludedCritical: 0,
      expectedCount: operation.changed,
      reason,
      author: this.authorOf(me),
      target: { kind: 'operation', operationId: operation.id },
      ids: [...operation.items.keys()],
      createdAt: at,
      undoOf: operation,
      previousState: operation.state,
    });
    operation.state = 'undoing';
    return undo;
  }

  private undoAllOf(
    me: Me,
    input: Extract<TriageOperationCreate, { action: 'undo_all_of' }>,
    now: number,
  ): { status: number; operation: TriageOperationDetail } {
    if (!isMassTriageRole(me.role)) throw new TriageRefusal(403, 'Sem permissão');
    const content = JSON.stringify({ all: input.target.userId, reason: input.reason });
    const repeated = this.repeated(me, input.requestId, content);
    if (repeated) return { status: 200, operation: this.view(repeated, me, now) };
    const mine = this.operations
      .filter(
        (operation) =>
          operation.author.id === input.target.userId &&
          FORWARD.includes(operation.action) &&
          (ACTIVE.includes(operation.state) ||
            (UNDOABLE.includes(operation.state) &&
              operation.changed > 0 &&
              operation.undoUntil !== null &&
              operation.undoUntil > now)),
      )
      .sort((a, b) => b.createdAt - a.createdAt);
    if (mine.length === 0) {
      throw new TriageRefusal(
        409,
        'Esta pessoa não tem operação que possa ser desfeita.',
        TRIAGE_EMPTY_CODE,
        {
          count: 0,
        },
      );
    }
    let undone = 0;
    for (const operation of mine) {
      if (ACTIVE.includes(operation.state)) this.cancelNow(operation, now);
      if (operation.changed === 0) continue;
      this.enqueueUndo(me, operation, newId(), '', input.reason, now + undone);
      undone += 1;
    }
    const all = this.add({
      requestId: input.requestId,
      content,
      action: 'undo_all_of',
      status: null,
      incidentId: null,
      includeCritical: true,
      excludedCritical: 0,
      expectedCount: 0,
      reason: input.reason,
      author: this.authorOf(me),
      target: { kind: 'user', userId: input.target.userId },
      ids: [],
      createdAt: now,
    });
    all.state = 'done';
    all.matched = mine.length;
    all.changed = undone;
    all.skipped = mine.length - undone;
    all.undoUntil = null;
    return { status: 202, operation: this.view(all, me, now) };
  }

  // -------------------------------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------------------------------

  list(
    me: Me,
    query: { state?: string | undefined; authorId?: string | undefined },
  ): TriageOperationDetail[] {
    const now = Date.now();
    this.advance(now);
    return this.operations
      .filter(
        (operation) =>
          (query.state === undefined || (query.state === 'active') === ACTIVE.includes(operation.state)) &&
          (query.authorId === undefined || operation.author.id === query.authorId),
      )
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))
      .map((operation) => this.view(operation, me, now));
  }

  get(me: Me, id: string): TriageOperationDetail | null {
    const now = Date.now();
    this.advance(now);
    const operation = this.operations.find((candidate) => candidate.id === id);
    return operation ? this.view(operation, me, now) : null;
  }

  /** As operações em vigor nos alertas de um caso, e as que elas desfizeram. */
  ofFindings(ids: ReadonlySet<string>): TriageOperationView[] {
    this.advance(Date.now());
    const chosen = new Set<Operation>();
    for (const id of ids) {
      const operation = this.operations.find((candidate) => candidate.id === this.lastOperation.get(id));
      if (!operation) continue;
      chosen.add(operation);
      if (operation.undoOf) chosen.add(operation.undoOf);
    }
    return [...chosen].sort((a, b) => b.createdAt - a.createdAt).map((operation) => summaryOf(operation));
  }

  /** As operações que mexeram num alerta. */
  ofFinding(id: string) {
    this.advance(Date.now());
    const entries = this.operations
      .filter((operation) => operation.items.has(id))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((operation) => {
        const item = operation.items.get(id);
        return {
          operation: summaryOf(operation),
          at: new Date(item?.at ?? operation.createdAt).toISOString(),
          previousStatus: item?.status ?? ('new' as const),
        };
      });
    return {
      operation: entries.find((entry) => entry.operation.id === this.lastOperation.get(id)) ?? null,
      operations: entries,
    };
  }

  /** Uma operação que já estava no histórico quando a demonstração abriu. */
  seed(input: {
    author: Author;
    status: FindingStatus;
    previousStatus: FindingStatus;
    reason: string;
    ids: string[];
    target: TriageTargetView;
    createdAt: number;
  }): void {
    const operation = this.add({
      requestId: newId(),
      content: '',
      action: 'status',
      status: input.status,
      incidentId: null,
      includeCritical: false,
      excludedCritical: 0,
      expectedCount: input.ids.length,
      reason: input.reason,
      author: input.author,
      target: input.target,
      ids: input.ids,
      createdAt: input.createdAt,
    });
    for (const id of input.ids) {
      operation.items.set(id, { status: input.previousStatus, incidentId: null, at: input.createdAt });
      this.lastOperation.set(id, operation.id);
    }
    operation.changed = input.ids.length;
    operation.cursor = input.ids.length;
    operation.state = 'done';
  }

  private view(operation: Operation, me: Me, now: number): TriageOperationDetail {
    const effective = operation.undoOf?.action ?? operation.action;
    const allowed =
      this.manages(me, operation) &&
      (!needsIncidents(effective) || hasPermission(me.role, 'incidents:write'));
    const active = ACTIVE.includes(operation.state);
    const stopped = RESUMABLE.includes(operation.state);
    return triageOperationDetailSchema.parse({
      ...summaryOf(operation),
      requestId: operation.requestId,
      target: operation.target,
      incidentId: operation.incidentId ?? operation.undoOf?.incidentId ?? null,
      includeCritical: operation.includeCritical,
      excludedCritical: operation.excludedCritical,
      expectedCount: operation.expectedCount,
      cutoffAt: new Date(operation.createdAt).toISOString(),
      remaining: Math.max(0, operation.matched - operation.changed - operation.skipped),
      failed: operation.failed.length,
      stop: operation.stop,
      updatedAt: new Date(operation.updatedAt).toISOString(),
      undoId: this.operations.filter((candidate) => candidate.undoOf === operation).at(-1)?.id ?? null,
      warnings: [
        ...(operation.excludedCritical > 0 ? ['critical_excluded' as const] : []),
        ...(operation.action === 'undo' && effective === 'promote'
          ? (['notice_not_recalled', 'anchor_kept'] as const)
          : []),
      ],
      can: {
        cancel: allowed && (active || stopped),
        continue: allowed && stopped,
        undo:
          allowed &&
          FORWARD.includes(operation.action) &&
          UNDOABLE.includes(operation.state) &&
          operation.changed > 0 &&
          operation.undoUntil !== null &&
          operation.undoUntil > now,
      },
    });
  }
}

function summaryOf(operation: Operation): TriageOperationView {
  return {
    id: operation.id,
    action: operation.action,
    status: operation.status,
    state: operation.state,
    reason: operation.reason,
    author: operation.author,
    createdAt: new Date(operation.createdAt).toISOString(),
    matched: operation.matched,
    changed: operation.changed,
    skipped: operation.skipped,
    undoUntil: operation.undoUntil === null ? null : new Date(operation.undoUntil).toISOString(),
    undoOfId: operation.undoOf?.id ?? null,
  };
}

function targetView(target: TriageTarget): TriageTargetView {
  if ('caseIds' in target) return { kind: 'cases', caseIds: target.caseIds, group: target.group ?? null };
  if ('findingIds' in target) return { kind: 'findings', count: target.findingIds.length };
  return {
    kind: 'filter',
    filter: Object.fromEntries(
      Object.entries(target.filter).flatMap(([name, value]) =>
        typeof value === 'string' ? [[name, value] as const] : [],
      ),
    ),
  };
}

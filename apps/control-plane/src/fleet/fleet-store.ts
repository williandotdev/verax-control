import { Inject, Injectable } from '@nestjs/common';
import { AuditService, type AuditEntry } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { isUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentStore,
  type DocumentTransaction,
  parseDocument,
} from '../firestore/document-store.js';
import {
  IN_FLIGHT_STATES,
  NODE_KEY_PATTERN,
  type Rollout,
  type RolloutNode,
  type RolloutNodeRecord,
  type RolloutRecord,
  rolloutNodeSchema,
  rolloutSchema,
} from './fleet.schema.js';

/** As contas de cada estado de nó, que a lista das rodadas mostra sem ler os nós. */
export function totalsOf(nodes: readonly Pick<RolloutNode, 'state'>[]): Rollout['totals'] {
  const totals = {
    nodes: nodes.length,
    pending: 0,
    inFlight: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    reverted: 0,
  };
  for (const node of nodes) {
    const state = node.state;
    if (state === 'pending') totals.pending += 1;
    else if (state === 'done' || state === 'failed' || state === 'skipped' || state === 'reverted')
      totals[state] += 1;
    else if (IN_FLIGHT_STATES.has(state)) totals.inFlight += 1;
  }
  return totals;
}

/** Uma operação do responsável que o estado relido não permite (a mensagem vai ao console). */
export class FleetConflictError extends Error {
  constructor(readonly code: string) {
    super(`frota: ${code}`);
    this.name = 'FleetConflictError';
  }
}

/** O que uma mudança dentro de uma transação devolve: a rodada e os nós alterados (o resto fica). */
export interface RolloutChange {
  rollout: Rollout;
  nodes: RolloutNodeRecord[];
  audit?: AuditEntry;
}

/**
 * O repositório das rodadas (`rollouts`) e dos nós de cada uma (`rollouts/{id}/nodes`). Toda gravação é uma transação
 * que relê o que vai mudar: as voltas do motor e as operações do responsável podem chegar juntas.
 */
@Injectable()
export class FleetStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Cria a rodada com todos os nós e a auditoria numa transação só. */
  async create(id: string, rollout: Rollout, nodes: RolloutNodeRecord[], audit: AuditEntry): Promise<void> {
    if (!isUlid(id)) throw new TypeError('id de rodada inválido');
    const parsed = rolloutSchema.parse(rollout);
    const parsedNodes = nodes.map((node) => ({ key: assertKey(node.key), data: toNodeData(node) }));
    await this.store.runTransaction((tx) => {
      tx.create(COLLECTIONS.rollouts, id, parsed);
      for (const node of parsedNodes) tx.create(COLLECTIONS.rolloutNodes(id), node.key, node.data);
      this.audit.record(tx, audit);
      return Promise.resolve();
    });
  }

  async get(id: string): Promise<RolloutRecord | undefined> {
    if (!isUlid(id)) return undefined;
    const data = await this.store.get(COLLECTIONS.rollouts, id);
    return data === undefined
      ? undefined
      : { id, ...parseDocument(rolloutSchema, COLLECTIONS.rollouts, id, data) };
  }

  /** As rodadas mais recentes primeiro. */
  async list(limit = 20): Promise<RolloutRecord[]> {
    const docs = await this.store.query(COLLECTIONS.rollouts, {
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit,
    });
    return docs.map((doc) => ({
      id: doc.id,
      ...parseDocument(rolloutSchema, COLLECTIONS.rollouts, doc.id, doc.data),
    }));
  }

  /** Os nós da rodada na ordem do plano (onda, ordem). */
  async nodes(id: string, reader: Pick<DocumentStore, 'query'> = this.store): Promise<RolloutNodeRecord[]> {
    const collection = COLLECTIONS.rolloutNodes(id);
    const docs = await reader.query(collection, { limit: 1000 });
    return docs
      .map((doc) => ({ key: doc.id, ...parseDocument(rolloutNodeSchema, collection, doc.id, doc.data) }))
      .sort((a, b) => a.wave - b.wave || a.order - b.order || a.key.localeCompare(b.key));
  }

  /**
   * Uma mudança na rodada: `fn` recebe a rodada e os nós relidos na transação e devolve o que gravar (ou `undefined`,
   * nada). Os nós devolvidos são gravados com `rev` + 1. A rodada sempre recebe os totais recalculados.
   */
  async change(
    id: string,
    fn: (rollout: RolloutRecord, nodes: RolloutNodeRecord[], now: Date) => RolloutChange | undefined,
  ): Promise<{ rollout: RolloutRecord; nodes: RolloutNodeRecord[] } | undefined> {
    if (!isUlid(id)) return undefined;
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.rollouts, id);
      if (data === undefined) return undefined;
      const rollout: RolloutRecord = { id, ...parseDocument(rolloutSchema, COLLECTIONS.rollouts, id, data) };
      const nodes = await this.nodes(id, tx);
      const now = this.clock.now();
      const change = fn(rollout, nodes, now);
      if (change === undefined) return { rollout, nodes };
      const byKey = new Map(nodes.map((node) => [node.key, node]));
      for (const node of change.nodes) {
        const current = byKey.get(node.key);
        const written: RolloutNodeRecord = { ...node, rev: (current?.rev ?? 0) + 1, updatedAt: now };
        byKey.set(node.key, written);
        tx.set(COLLECTIONS.rolloutNodes(id), assertKey(node.key), toNodeData(written));
      }
      const merged = [...byKey.values()];
      const { id: _id, ...rest } = { ...change.rollout, id };
      const next = rolloutSchema.parse({ ...rest, totals: totalsOf(merged), updatedAt: now });
      tx.set(COLLECTIONS.rollouts, id, next);
      if (change.audit !== undefined) this.audit.record(tx, change.audit);
      return {
        rollout: { id, ...next },
        nodes: merged.sort((a, b) => a.wave - b.wave || a.order - b.order || a.key.localeCompare(b.key)),
      };
    });
  }

  /**
   * Grava o que a volta calculou para um nó, só se ninguém mexeu nele desde a leitura (`rev`): uma operação do
   * responsável no meio vence. Devolve se gravou.
   */
  async saveNode(id: string, node: RolloutNodeRecord, readRev: number): Promise<boolean> {
    return this.store.runTransaction(async (tx) => {
      const collection = COLLECTIONS.rolloutNodes(id);
      const data = await tx.get(collection, assertKey(node.key));
      if (data === undefined) return false;
      const current = parseDocument(rolloutNodeSchema, collection, node.key, data);
      if (current.rev !== readRev) return false;
      writeNode(tx, id, { ...node, rev: readRev + 1, updatedAt: this.clock.now() });
      return true;
    });
  }
}

function assertKey(key: string): string {
  if (!NODE_KEY_PATTERN.test(key)) throw new TypeError('chave de nó inválida');
  return key;
}

function toNodeData(node: RolloutNodeRecord): RolloutNode {
  const { key: _key, ...data } = node;
  return rolloutNodeSchema.parse(data);
}

function writeNode(tx: DocumentTransaction, id: string, node: RolloutNodeRecord): void {
  tx.set(COLLECTIONS.rolloutNodes(id), assertKey(node.key), toNodeData(node));
}

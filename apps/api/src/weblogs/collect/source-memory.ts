import type { WebLogEngine } from '../engine.js';
import type { WebFindingDraft } from '../draft.js';
import type { EngineNote } from '../engine.js';
import type { SuppressedState } from './engine-state.js';
import type { Observation } from './observation.js';

/**
 * O que a tarefa tem na memória de cada balanceador, entre uma passagem e outra. Só vale enquanto a concessão é deste
 * processo sem interrupção (outra réplica que lesse no meio deixaria buracos aqui), e cai inteiro em qualquer erro fora da
 * leitura de um objeto: a passagem seguinte refaz o motor do estado guardado e da releitura dos últimos 70 minutos.
 */

/** Um motor e o que ele já contou. */
export interface EngineContext {
  engine: WebLogEngine;
  /** Os objetos contados inteiros, com o slot: nenhum conta duas vezes no mesmo motor. */
  seen: Map<string, number>;
  /** Os objetos cuja leitura foi interrompida, e quantas linhas deles já foram contadas. */
  partial: Map<string, number>;
}

export interface BacklogMemory {
  /** Só existe do primeiro objeto por ler em diante: um atraso sem arquivo nenhum não gasta memória. */
  context: EngineContext | null;
  /** O próximo slot. */
  next: number;
}

export interface SourceMemory {
  /** O que muda o motor: outro balanceador, outro bucket, outra autorização ou outra divisão da memória. */
  identity: string;
  live: EngineContext;
  observation: Observation;
  suppressed: SuppressedState;
  notes: EngineNote[];
  /** Falhas de leitura de cada objeto, só nas passagens em que outro foi lido. */
  attempts: Map<string, number>;
  /** A última versão gravada de cada achado: reavaliar as mesmas linhas não repete a gravação. */
  persisted: Map<string, string>;
  /** O último slot fechado na última gravação do estado; null se ainda não foi gravado por este processo. */
  savedThrough: number | null;
  /** A última conferência inteira das pastas de ontem e de hoje, e onde a atual parou. */
  deepAt: number | null;
  deepFrom: { day: number; after: string | null };
  backlog: BacklogMemory | null;
}

export const newContext = (engine: WebLogEngine): EngineContext => ({
  engine,
  seen: new Map(),
  partial: new Map(),
});

/** Esquece os objetos de slots que já saíram do motor. */
export function pruneContext(context: EngineContext, oldest: number): void {
  for (const [hash, index] of context.seen) if (index <= oldest) context.seen.delete(hash);
}

const MAX_PERSISTED = 5_000;

/** O que, se não mudou, dispensa gravar o achado de novo. */
function versionOf(draft: WebFindingDraft): string {
  const counters = Object.values(draft.evidence.counters).join(',');
  const version = draft.recurrence?.lastSeenAt ?? draft.revision?.lastSeenAt ?? '';
  return `${version}|${draft.evidence.lastSeenAt}|${draft.ruleLevel}|${counters}`;
}

export function isPersisted(memory: SourceMemory, draft: WebFindingDraft): boolean {
  return memory.persisted.get(draft.sourceEventId) === versionOf(draft);
}

export function markPersisted(memory: SourceMemory, draft: WebFindingDraft): void {
  if (memory.persisted.size >= MAX_PERSISTED) memory.persisted.clear();
  memory.persisted.set(draft.sourceEventId, versionOf(draft));
}

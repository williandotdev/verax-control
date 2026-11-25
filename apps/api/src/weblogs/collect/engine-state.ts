import { z } from 'zod';
import { type DigestState, digestStateSchema } from '../digest.js';
import { ENGINE_NOTES, type EngineNote, type EvaluateResult } from '../engine.js';
import { ENGINE_STATE_VERSION } from '../store/web-engine-state.js';
import { type ObservationState, observationSchema } from './observation.js';

/**
 * O que fica no banco de um balanceador entre reinícios (`WebEngineState.state`): o resumo do dia do motor (as chaves de
 * cliente, o único lugar com IP fora dos achados), a observação (contagens), o que as fontes confiáveis calaram e as notas
 * do motor. Lido de volta com zod, pedaço a pedaço: o que não serve recomeça vazio, sem derrubar o resto.
 *
 * O painel lê a observação, o calado e as notas (`readWebEngineView`, em `store/web-engine-state.ts`), nunca o resumo do dia.
 */
export { ENGINE_STATE_VERSION };
/** O teto do banco (`WebEngineState_state_check`), sobre o JSON como ele o escreve. */
export const MAX_ENGINE_STATE_BYTES = 4 * 1024 * 1024;
/** Quanto tempo uma fonte confiável que calou algo fica à vista. */
export const SUPPRESSED_KEEP_MS = 24 * 60 * 60_000;
const MAX_SUPPRESSED = 100;

const suppressedSchema = z
  .array(
    z.strictObject({
      trustedId: z.string().min(1).max(64),
      ruleId: z.string().min(1).max(6),
      /** Endereços calados na última avaliação em que houve algum. */
      clients: z.int().min(0),
      lastSeenAt: z.iso.datetime(),
    }),
  )
  .max(MAX_SUPPRESSED);
export type SuppressedState = z.infer<typeof suppressedSchema>;
const notesSchema = z.array(z.enum(ENGINE_NOTES)).max(ENGINE_NOTES.length);

export interface StoredEngineState {
  digest: DigestState | null;
  observation: unknown;
  suppressed: SuppressedState;
}

/** O estado gravado; a versão desconhecida (ou o pedaço fora do formato) é o vazio. */
export function readEngineState(version: number, state: unknown): StoredEngineState {
  const empty: StoredEngineState = { digest: null, observation: null, suppressed: [] };
  if (version !== ENGINE_STATE_VERSION || typeof state !== 'object' || state === null) return empty;
  const { digest, observation, suppressed } = state as Record<string, unknown>;
  const parsedDigest = digestStateSchema.safeParse(digest);
  const parsedSuppressed = suppressedSchema.safeParse(suppressed);
  return {
    digest: parsedDigest.success ? parsedDigest.data : null,
    observation,
    suppressed: parsedSuppressed.success ? parsedSuppressed.data : [],
  };
}

export interface EngineStateJson {
  digest: DigestState | null;
  observation: ObservationState;
  suppressed: SuppressedState;
  notes: EngineNote[];
}

/** Folga para as vírgulas e os espaços que o `jsonb` põe ao escrever. */
const JSONB_OVERHEAD = 1.35;
const fits = (json: string): boolean =>
  Buffer.byteLength(json, 'utf8') * JSONB_OVERHEAD <= MAX_ENGINE_STATE_BYTES;

/**
 * O JSON a gravar. No teto do banco (que os tetos do próprio motor não deixam alcançar), sai primeiro a barra de 24 h e
 * depois o resumo do dia: um estado que não coubesse faria a gravação inteira falhar para sempre.
 */
export function writeEngineState(state: EngineStateJson): string {
  const parsed = {
    digest: state.digest,
    observation: observationSchema.parse(state.observation),
    suppressed: suppressedSchema.parse(state.suppressed),
    notes: notesSchema.parse(state.notes),
  };
  const whole = JSON.stringify(parsed);
  if (fits(whole)) return whole;
  const untracked = JSON.stringify({
    ...parsed,
    digest: parsed.digest === null ? null : { ...parsed.digest, tracks: [] },
  });
  return fits(untracked) ? untracked : JSON.stringify({ ...parsed, digest: null });
}

/** O calado pelas fontes confiáveis, com o desta avaliação e sem o que passou de 24 h. */
export function mergeSuppressed(
  held: SuppressedState,
  suppressed: EvaluateResult['suppressed'],
  now: number,
): SuppressedState {
  const rows = new Map(held.map((row) => [`${row.trustedId}|${row.ruleId}`, row]));
  const lastSeenAt = new Date(now).toISOString();
  for (const { sourceId, rule, clients } of suppressed) {
    rows.set(`${sourceId}|${rule}`, { trustedId: sourceId, ruleId: rule, clients, lastSeenAt });
  }
  return [...rows.values()]
    .filter((row) => Date.parse(row.lastSeenAt) > now - SUPPRESSED_KEEP_MS)
    .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
    .slice(0, MAX_SUPPRESSED);
}

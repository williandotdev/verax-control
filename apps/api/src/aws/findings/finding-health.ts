import { type AwsSourceState, isAwsSourceActiveState } from '@verax/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * O estado e a saúde de uma fonte de achados (`AwsSource`, tipos lidos por API) depois de cada leitura da tarefa
 * `aws-findings`, e o que a tarefa guarda no cursor da fonte. Funções puras: quem grava é a tarefa.
 *
 * **Estado da fonte:**
 * - leitura sem erro: `collecting`, mesmo sem achado nenhum (`no_findings_yet` até o primeiro; depois, sem código). Uma
 *   fonte de achados nunca fica "parada" por não ter achado: o que conta é a última leitura;
 * - a AWS recusou por permissão: `permission_error`, com a ação do IAM que faltou (ou `capability_off`, sem chamada
 *   nenhuma, quando as tags do papel dizem que a leitura de achados está desligada);
 * - o serviço foi desligado ou o recurso sumiu depois da autorização: `source_missing` (`not_enabled` ou `not_found`),
 *   o mesmo estado que a descoberta dá. A fonte sai da coleta até a descoberta vê-la de novo;
 * - outra falha (limite de requisições, tempo esgotado, erro da AWS): o estado só muda para `ingestion_error` na
 *   terceira falha seguida, com o código (`throttled` ou o nome do erro). Antes disso, a fonte fica como estava.
 *
 * **Saúde:** `lastSyncAt` (a última leitura sem erro), `lastEventAt` (a atualização mais recente de um achado na
 * origem), `lastIngestedAt` (quando o achado mais recente entrou no nó), `lagSeconds` (o tempo desde a última leitura
 * sem erro, gravado a cada execução e recalculado na leitura do painel) e o volume das últimas 24 h.
 */

/** Falhas seguidas a partir das quais a fonte vira `ingestion_error`. */
export const AWS_FINDINGS_ERROR_AFTER = 3;

/** O código de `collecting` enquanto a fonte nunca trouxe um achado. */
export const NO_FINDINGS_YET = 'no_findings_yet';

const MAX_INT = 2_147_483_647;

/** O que a decisão lê da fonte. */
export interface SourceHealth {
  state: string;
  stateCode: string | null;
  permission: string;
  permissionDetail: string | null;
  missingSince: Date | null;
  lastSyncAt: Date | null;
  lastEventAt: Date | null;
}

export type SourceOutcome =
  | {
      type: 'synced';
      /** A atualização mais recente de um achado da fonte nesta leitura (inclusive os já gravados); null sem achado. */
      newestEventAt: Date | null;
      /** Algum achado novo (ou com versão nova) entrou no nó nesta leitura. */
      ingested: boolean;
      /** O volume das últimas 24 h, já com esta leitura. */
      volume: { events: number; bytes: number };
    }
  | { type: 'permission'; detail: string }
  | { type: 'missing'; code: 'not_enabled' | 'not_found' }
  | { type: 'failed'; code: string; failures: number };

export interface SourceChange {
  data: Prisma.AwsSourceUpdateManyMutationInput;
  /** A mudança de estado (não só de código), que é o que vai para a trilha de auditoria; null sem mudança. */
  transition: {
    from: { state: string; stateCode: string | null };
    to: { state: string; stateCode: string | null };
  } | null;
}

/** O tempo desde a última leitura sem erro, em segundos; null antes da primeira. */
export function lagSince(lastSyncAt: Date | null, now: Date): number | null {
  if (lastSyncAt === null) return null;
  return Math.min(MAX_INT, Math.max(0, Math.floor((now.getTime() - lastSyncAt.getTime()) / 1000)));
}

/**
 * O atraso de uma fonte lida por API, na hora da leitura do painel: o tempo desde a última leitura sem erro, só
 * enquanto a fonte está na coleta. Para as outras fontes (e as que saíram da coleta), null: vale o que está gravado.
 */
export function apiSourceLagSeconds(
  row: { method: string; state: string; lastSyncAt: Date | null },
  now: Date,
): number | null {
  if (row.method !== 'api' || !isAwsSourceActiveState(row.state as AwsSourceState)) return null;
  return lagSince(row.lastSyncAt, now);
}

/** O que muda na fonte depois de uma leitura. `now` é o horário da leitura. */
export function sourceChange(current: SourceHealth, outcome: SourceOutcome, now: Date): SourceChange {
  const moved = (
    state: string,
    stateCode: string | null,
  ): Pick<SourceChange, 'transition'> & {
    state: Prisma.AwsSourceUpdateManyMutationInput;
  } => ({
    state: {
      state,
      stateCode,
      ...(state !== current.state && { stateSince: now }),
    },
    transition:
      state === current.state
        ? null
        : { from: { state: current.state, stateCode: current.stateCode }, to: { state, stateCode } },
  });

  switch (outcome.type) {
    case 'synced': {
      const lastEventAt =
        outcome.newestEventAt !== null &&
        (current.lastEventAt === null || outcome.newestEventAt > current.lastEventAt)
          ? outcome.newestEventAt
          : current.lastEventAt;
      const next = moved('collecting', lastEventAt === null ? NO_FINDINGS_YET : null);
      return {
        data: {
          ...next.state,
          lastSyncAt: now,
          lagSeconds: 0,
          lastEventAt,
          ...(outcome.ingested && { lastIngestedAt: now }),
          eventsLast24h: Math.min(MAX_INT, outcome.volume.events),
          bytesLast24h: BigInt(outcome.volume.bytes),
          // A leitura que deu certo é a prova da permissão.
          ...(current.permission !== 'granted' && {
            permission: 'granted',
            permissionDetail: null,
            permissionCheckedAt: now,
          }),
          ...(current.missingSince !== null && { missingSince: null }),
        },
        transition: next.transition,
      };
    }
    case 'permission': {
      const next = moved('permission_error', outcome.detail);
      return {
        data: {
          ...next.state,
          lagSeconds: lagSince(current.lastSyncAt, now),
          ...((current.permission !== 'missing' || current.permissionDetail !== outcome.detail) && {
            permission: 'missing',
            permissionDetail: outcome.detail,
            permissionCheckedAt: now,
          }),
        },
        transition: next.transition,
      };
    }
    case 'missing': {
      const next = moved('source_missing', outcome.code);
      return {
        data: { ...next.state, missingSince: current.missingSince ?? now },
        transition: next.transition,
      };
    }
    case 'failed': {
      const lagSeconds = lagSince(current.lastSyncAt, now);
      if (outcome.failures < AWS_FINDINGS_ERROR_AFTER) return { data: { lagSeconds }, transition: null };
      const next = moved('ingestion_error', outcome.code);
      return { data: { ...next.state, lagSeconds }, transition: next.transition };
    }
  }
}

// --- O que fica no cursor da fonte ---

/** Tamanho da coluna `CollectorCursor.continuation`. */
const CONTINUATION_MAX = 2048;
const HOUR_MS = 60 * 60 * 1000;
/** As 24 horas do volume, mais a hora corrente. */
const VOLUME_HOURS = 25;

/** O volume de uma hora (a hora desde 1970, os achados e os bytes). */
export type HourVolume = readonly [hour: number, events: number, bytes: number];

/** A janela de uma leitura cortada no teto de páginas: a continuação da AWS e o intervalo em que ela vale. */
export interface ResumeWindow {
  since: Date;
  before: Date;
  token: string;
}

/** O que a tarefa guarda no cursor de cada fonte, além da posição (`cursorAt`) e da próxima leitura. */
export interface CursorState {
  /** Só quando a última leitura parou no teto de páginas: de onde a próxima continua. */
  resume: ResumeWindow | null;
  /** O volume por hora das últimas 24 h (só as horas com achado). */
  hours: HourVolume[];
}

const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const cursorStateSchema = z.strictObject({
  w: z.strictObject({ s: z.iso.datetime(), b: z.iso.datetime(), t: z.string().min(1) }).optional(),
  h: z
    .array(z.tuple([counter, counter, counter]))
    .max(VOLUME_HOURS)
    .optional(),
});

/** O estado guardado no cursor; o que não segue o formato (ou um cursor novo) é o estado vazio. */
export function decodeCursorState(text: string | null): CursorState {
  const empty: CursorState = { resume: null, hours: [] };
  if (text === null) return empty;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty;
  }
  const parsed = cursorStateSchema.safeParse(json);
  if (!parsed.success) return empty;
  const { w, h } = parsed.data;
  return {
    resume: w === undefined ? null : { since: new Date(w.s), before: new Date(w.b), token: w.t },
    hours: h ?? [],
  };
}

/**
 * O estado como texto do cursor. A continuação da AWS que não cabe na coluna fica de fora (`resumable: false`): a
 * leitura cortada recomeça a janela, e a chave única dos achados não deixa duplicar.
 */
export function encodeCursorState(state: CursorState): { text: string | null; resumable: boolean } {
  const hours = state.hours.length > 0 ? { h: state.hours } : {};
  if (state.resume !== null) {
    const full = JSON.stringify({
      w: { s: state.resume.since.toISOString(), b: state.resume.before.toISOString(), t: state.resume.token },
      ...hours,
    });
    if (full.length <= CONTINUATION_MAX) return { text: full, resumable: true };
  }
  const text = state.hours.length > 0 ? JSON.stringify(hours) : null;
  return { text, resumable: state.resume === null };
}

/** O volume por hora com o que entrou agora, sem as horas que saíram das últimas 24 h. */
export function addVolume(
  hours: readonly HourVolume[],
  now: Date,
  events: number,
  bytes: number,
): HourVolume[] {
  const current = Math.floor(now.getTime() / HOUR_MS);
  const kept = hours.filter(([hour]) => hour > current - VOLUME_HOURS + 1 && hour <= current);
  if (events === 0 && bytes === 0) return kept;
  const last = kept.at(-1);
  if (last !== undefined && last[0] === current) {
    return [...kept.slice(0, -1), [current, last[1] + events, last[2] + bytes]];
  }
  return [...kept, [current, events, bytes]];
}

/** O volume das últimas 24 h. */
export function volumeLast24h(hours: readonly HourVolume[], now: Date): { events: number; bytes: number } {
  const current = Math.floor(now.getTime() / HOUR_MS);
  let events = 0;
  let bytes = 0;
  for (const [hour, hourEvents, hourBytes] of hours) {
    if (hour <= current - 24 || hour > current) continue;
    events += hourEvents;
    bytes += hourBytes;
  }
  return { events, bytes };
}

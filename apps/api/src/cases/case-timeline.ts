import {
  BRASILIA_OFFSET_MS,
  CASE_TIMELINE_HOURLY_DAYS,
  CASE_TIMELINE_MAX_DAYS,
  type CaseTimeline,
} from '@verax/shared';

/**
 * A janela e as faixas da linha do tempo de um caso, sem banco. Horas cheias (as mesmas em UTC e em Brasília) ou dias do
 * calendário de Brasília, que é UTC-3 o ano todo: toda faixa tem o mesmo tamanho.
 */
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export interface TimelineWindow {
  granularity: CaseTimeline['granularity'];
  stepMs: number;
  /** O começo da primeira faixa e o fim (fora) da última. */
  from: Date;
  to: Date;
}

/** O começo da hora cheia, ou do dia de Brasília, de um instante. */
export function bucketStart(at: Date, granularity: CaseTimeline['granularity']): number {
  return granularity === 'hour'
    ? Math.floor(at.getTime() / HOUR_MS) * HOUR_MS
    : Math.floor((at.getTime() - BRASILIA_OFFSET_MS) / DAY_MS) * DAY_MS + BRASILIA_OFFSET_MS;
}

/** O que passa do fim da hora de agora é horário no futuro: fica fora da linha do tempo. */
export function timelineCap(now: Date): Date {
  return new Date(bucketStart(now, 'hour') + HOUR_MS);
}

/**
 * A janela dos alertas de um caso, do mais antigo ao mais recente: de hora em hora até 7 dias; além disso, por dia, no
 * máximo um ano até o mais recente. O horário vem do log: um alerta de anos atrás (verdadeiro ou forjado) não cria
 * milhares de faixas.
 */
export function timelineWindow(oldest: Date, newest: Date): TimelineWindow {
  const span = newest.getTime() - oldest.getTime();
  const granularity = span <= CASE_TIMELINE_HOURLY_DAYS * DAY_MS ? 'hour' : 'day';
  const stepMs = granularity === 'hour' ? HOUR_MS : DAY_MS;
  const last = bucketStart(newest, granularity);
  const first = bucketStart(oldest, granularity);
  const floor = granularity === 'hour' ? first : last - (CASE_TIMELINE_MAX_DAYS - 1) * DAY_MS;
  return { granularity, stepMs, from: new Date(Math.max(first, floor)), to: new Date(last + stepMs) };
}

/** As contagens de uma faixa, como o banco as devolve (só as faixas com alerta). */
export interface TimelineCounts {
  at: Date;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Todas as faixas da janela, em ordem, com zero onde não houve alerta. */
export function fillTimeline(
  window: TimelineWindow,
  counts: readonly TimelineCounts[],
): CaseTimeline['buckets'] {
  const byStart = new Map(counts.map((row) => [row.at.getTime(), row]));
  const buckets: CaseTimeline['buckets'] = [];
  for (let at = window.from.getTime(); at < window.to.getTime(); at += window.stepMs) {
    const row = byStart.get(at);
    buckets.push({
      at: new Date(at).toISOString(),
      critical: row?.critical ?? 0,
      high: row?.high ?? 0,
      medium: row?.medium ?? 0,
      low: row?.low ?? 0,
    });
  }
  return buckets;
}

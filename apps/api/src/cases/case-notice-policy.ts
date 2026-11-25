import { addDays, BRASILIA_OFFSET_MS, brasiliaDay, dayAsDate } from '@verax/shared';
import type { FindingSeverity } from '../generated/prisma/client.js';
import type { NoticeSeverity } from '../notifications/finding-notices.js';

/**
 * As regras dos avisos por caso, sem banco: os limites, as chaves de deduplicação e as decisões. Quem lê e grava é
 * `case-notice-store.ts`, e quem aplica, `case-notices.ts`.
 *
 * **Todos os limites estão aqui** (a decisão D4 do desenho de 24/11/2026 ainda espera a confirmação do responsável).
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Resumo diário de vulnerabilidades e postura: às 09:00 de Brasília (UTC-3 o ano todo, 12:00 UTC). */
export const CASE_DAILY_HOUR = 9;
/** Sem novidade, o resumo só se repete depois destes dias, enquanto houver alerta alto ou crítico pendente. */
export const CASE_DAILY_REMINDER_DAYS = 7;
/** Casos listados no resumo diário. */
export const CASE_DAILY_ITEMS = 10;
/** Vulnerabilidade e postura: no máximo um aviso imediato por cliente neste intervalo, com os casos críticos novos. */
export const CASE_CRITICAL_INTERVAL_MS = HOUR_MS;
/** Casos listados no aviso imediato. */
export const CASE_CRITICAL_ITEMS = 5;

/** Detecção: no máximo um aviso de crescimento por caso neste intervalo. */
export const CASE_GROWTH_INTERVAL_MS = DAY_MS;
/** O caso cresceu: pelo menos tantas vezes o que era há uma hora (ou no último aviso, se foi depois). */
export const CASE_GROWTH_FACTOR = 10;
export const CASE_GROWTH_WINDOW_MS = HOUR_MS;
/** Abaixo disto, dez vezes mais ainda é pouco: o caso que abriu com um alerta e tem dez não avisa de novo. */
export const CASE_GROWTH_MIN_ALERTS = 100;
/** Só o caso que recebeu alerta há pouco é conferido. */
export const CASE_GROWTH_LOOKBACK_MS = 2 * HOUR_MS;

/** O alerta alto ou crítico ainda sem caso depois disto avisa sozinho: a atribuição está atrasada, e nada fica calado. */
export const CASE_LAG_NOTICE_MS = 10 * MINUTE_MS;
/** O aviso que falhou em todas as tentativas é refeito depois disto, se o caso continua pendente. */
export const CASE_NOTICE_REARM_MS = 6 * HOUR_MS;

/**
 * A folga da virada: o alerta que chegou até isto antes de os avisos por caso valerem foi gravado com o aviso dele, e se
 * reconhece por ele. Sem a folga, o alerta gravado no instante da virada não seria de nenhum dos dois mecanismos.
 */
export const CASE_NOTICE_SLACK_MS = HOUR_MS;
/**
 * Por quanto tempo se sabe se um alerta já foi avisado; o mais antigo conta como avisado. A linha do aviso do caso sai com o
 * alerta da âncora dele, na retenção: este prazo, com a idade máxima de um caso de detecção (`CASE_AGE_MS`), cabe no menor
 * histórico de um plano (30 dias), e um caso de semanas atrás não avisa de novo porque a âncora saiu.
 */
export const CASE_NOTICE_MEMORY_MS = 14 * DAY_MS;

/** Casos decididos por vez (cada lote é uma transação, sob o lock dos alertas do cliente). */
export const CASE_NOTICE_PAGE = 200;
/** Casos críticos de vulnerabilidade e postura por lote: uma gravação só. */
export const CASE_CRITICAL_PAGE = 2_000;
/** Avisos alerta por alerta gravados por lote. */
export const CASE_NOTICE_BATCH = 500;
/** Avisos alerta por alerta tirados da fila por lote (a virada): uma gravação só, sem o lock do cliente. */
export const CASE_SUPERSEDE_BATCH = 2_000;
/** Lotes de um mesmo passo, por cliente, numa execução: o resto fica para a seguinte. */
export const CASE_NOTICE_MAX_BATCHES = 20;
/** Tempo de uma execução, por todos os clientes: a entrega vem depois, na mesma tarefa. */
export const CASE_NOTICE_WORK_MS = 30_000;

/** Os motivos de `skipped` dos avisos por caso (`Notification.lastError`). */
export const CASE_SKIP = {
  /** O aviso de um alerta, trocado pelo do caso dele; ou o do caso, trocado por um mais grave do mesmo caso. */
  byCase: 'superseded_by_case',
  /** Os alertas entraram num incidente, que tem o aviso dele. */
  byIncident: 'superseded_by_incident',
  /** Alguém tratou antes de o aviso sair. */
  treated: 'case_treated',
  /** O caso saiu na retenção. */
  gone: 'case_gone',
} as const;

/** As chaves dos avisos por caso. As do alerta são `finding:<id>` (`alertNotices`). */
const CASE_PREFIX = 'case:';
const CRITICAL_PREFIX = 'cases-critical:';
const DAILY_PREFIX = 'cases-daily:';
const GROWTH = ':growth:';

/** O caso avisa uma vez por severidade. */
export const caseNoticeKey = (caseId: string, severity: NoticeSeverity): string =>
  `${CASE_PREFIX}${caseId}:${severity}`;

/** Outra onda do mesmo caso e severidade (a de antes foi tratada, ou o aviso dela não saiu): o instante a distingue. */
export const caseWaveKey = (caseId: string, severity: NoticeSeverity, at: Date): string =>
  `${caseNoticeKey(caseId, severity)}:${at.getTime()}`;

export const caseGrowthKey = (caseId: string, at: Date): string =>
  `${CASE_PREFIX}${caseId}${GROWTH}${brasiliaDay(at)}`;

const hourOf = (at: Date): Date => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

/** O aviso imediato de vulnerabilidade e postura: no máximo um por hora cheia, por mais réplicas que haja. */
export const criticalCasesKey = (at: Date): string => `${CRITICAL_PREFIX}${hourOf(at).toISOString()}`;

/** As chaves dos avisos imediatos das últimas horas cheias, a de agora inclusive. */
export const recentCriticalCasesKeys = (at: Date, hours: number): string[] =>
  Array.from({ length: hours + 1 }, (_, back) => criticalCasesKey(new Date(at.getTime() - back * HOUR_MS)));

export const dailyCasesKey = (day: string): string => `${DAILY_PREFIX}${day}`;

/** Os 09:00 de Brasília de um dia do calendário de lá. */
export const dailyMoment = (day: string): Date =>
  new Date(dayAsDate(day).getTime() + CASE_DAILY_HOUR * HOUR_MS + BRASILIA_OFFSET_MS);

/** O resumo diário da vez: o dia de Brasília e os 09:00 dele; null antes disso. */
export function dueDaily(now: Date): { day: string; at: Date } | null {
  const day = brasiliaDay(now);
  const at = dailyMoment(day);
  return now.getTime() >= at.getTime() ? { day, at } : null;
}

/** Os dias em que um resumo enviado ainda conta: sem novidade depois dele, não há outro. */
export const rememberedDailyDays = (day: string): string[] =>
  Array.from({ length: CASE_DAILY_REMINDER_DAYS - 1 }, (_, index) => addDays(day, -(index + 1)));

/** O dia de um resumo diário, pela chave. */
export const dailyDayOf = (dedupeKey: string): string => dedupeKey.slice(DAILY_PREFIX.length);

/** O que um aviso da fila é, do ponto de vista dos casos. */
export type CaseNoticeType = 'case' | 'growth' | 'critical' | 'daily';

/** O tipo do aviso por caso; null no que não é de caso (o do alerta, o de incidente, os de operação). */
export function caseNoticeType(row: { caseId: string | null; dedupeKey: string }): CaseNoticeType | null {
  if (row.caseId !== null) return row.dedupeKey.includes(GROWTH) ? 'growth' : 'case';
  if (row.dedupeKey.startsWith(CRITICAL_PREFIX)) return 'critical';
  return row.dedupeKey.startsWith(DAILY_PREFIX) ? 'daily' : null;
}

const RANK: Readonly<Record<FindingSeverity, number>> = { low: 0, medium: 1, high: 2, critical: 3 };

/** A severidade já avisada cobre esta. */
export const covers = (noticed: FindingSeverity | null, severity: FindingSeverity): boolean =>
  noticed !== null && RANK[noticed] >= RANK[severity];

/** O que se sabe de um caso de detecção pendente, para decidir o aviso dele. */
export interface DetectionFacts {
  /** A pior severidade pendente. */
  worst: NoticeSeverity;
  /** A severidade já avisada (`AlertCase.noticedSeverity`). */
  noticed: FindingSeverity | null;
  /** Há alerta pendente da pior severidade que ninguém avisou. */
  fresh: boolean;
  /** Há alerta pendente dela que já foi avisado (só se olha com a severidade já avisada). */
  told: boolean;
  /** Há aviso de um alerta dele na fila, ainda não enviado a ninguém, sem aviso do caso que o cubra (a virada). */
  waiting: boolean;
}

/**
 * O que fazer com um caso de detecção:
 * - `notice`: avisar;
 * - `mark`: tudo o que ele tem já foi avisado alerta por alerta (a virada): a severidade fica como avisada, sem e-mail;
 * - `none`: já avisado.
 *
 * Avisa quando a pior severidade pendente passa da avisada, e de novo na mesma severidade quando **tudo o que foi avisado
 * já foi tratado** e chegou alerta novo (a onda seguinte). Um alerta a mais num caso avisado e pendente não avisa.
 */
export function detectionDecision(facts: DetectionFacts): 'notice' | 'mark' | 'none' {
  if (facts.waiting) return 'notice';
  if (!covers(facts.noticed, facts.worst)) return facts.fresh ? 'notice' : 'mark';
  return facts.fresh && !facts.told ? 'notice' : 'none';
}

/** O que mudou num caso de detecção já avisado, desde o último aviso dele. */
export interface GrowthFacts {
  total: number;
  /** Alertas que ele já tinha há uma hora, ou no último aviso, se foi depois (a contagem para um acima de `total / 10`). */
  earlier: number;
  /** Uma tática do MITRE que nenhum alerta de antes tinha. */
  newTactic: boolean;
  /** Um alerta crítico novo, com o caso já em análise. */
  newCritical: boolean;
  /** O último aviso de crescimento dele. */
  lastGrowthAt: Date | null;
}

/** O caso merece o aviso de crescimento. */
export function growthDue(facts: GrowthFacts, now: Date): boolean {
  const { lastGrowthAt } = facts;
  if (lastGrowthAt !== null && now.getTime() - lastGrowthAt.getTime() < CASE_GROWTH_INTERVAL_MS) return false;
  const surged = facts.total >= CASE_GROWTH_MIN_ALERTS && facts.total >= facts.earlier * CASE_GROWTH_FACTOR;
  return surged || facts.newTactic || facts.newCritical;
}

/** O tipo da linha do aviso: os do alerta, para nenhum enum mudar e uma imagem anterior do nó saber enviar. */
export const noticeKindOf = (severity: NoticeSeverity): 'critical_finding' | 'high_finding' =>
  severity === 'critical' ? 'critical_finding' : 'high_finding';

import { type CaseExceptionDraft, FINDING_SOURCES, type FindingSource } from '@verax/shared';
import { FINDING_SOURCE_LABELS } from '@/features/findings/labels';
import { formatCount, plural } from '@/lib/format';

type Target = CaseExceptionDraft['targets'][number];

const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (value: number) => String(value).padStart(2, '0');
/** A data local (AAAA-MM-DD) daqui a `days` dias. */
export function dateInDays(days: number, from = new Date()): string {
  const date = new Date(from.getTime() + days * DAY_MS);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
/** O fim do dia escolhido, no fuso do navegador; vazio é sem validade. */
export const endOfDay = (date: string): string | null =>
  date ? new Date(`${date}T23:59:59`).toISOString() : null;

const sourceLabel = (value: string): string =>
  (FINDING_SOURCES as readonly string[]).includes(value)
    ? FINDING_SOURCE_LABELS[value as FindingSource]
    : value;

/** O texto de um alvo do caso: regra, fonte, conta e evento. Tudo o que veio do log é texto. */
export function targetText(target: Target): string {
  const parts = [`Regra ${target.ruleId}`, sourceLabel(target.logSource), `conta ${target.accountId}`];
  if (target.eventName !== null) parts.push(target.eventName);
  return parts.join(' · ');
}

/** "Teria coberto N alertas nos últimos 30 dias, M altos." */
export function previewText(preview: { days: number; matched: number; high: number }): string {
  const covered = `Teria coberto ${plural(preview.matched, 'alerta', 'alertas')} nos últimos ${preview.days} dias`;
  return preview.high > 0
    ? `${covered}, ${formatCount(preview.high)} ${preview.high === 1 ? 'alto' : 'altos'}.`
    : `${covered}.`;
}

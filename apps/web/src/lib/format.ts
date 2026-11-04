const formatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

export function formatTimestamp(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
}

const dateFormatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

/** Só a data: "04/11/2026". */
export function formatDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter.format(date);
}

const relative = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** "há 3 minutos", "há 2 horas", "ontem". Menos de um minuto vira "agora há pouco". */
export function formatRelative(value: string | Date, now: Date = new Date()): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return 'agora há pouco';
}

const conjunction = new Intl.ListFormat('pt-BR', { style: 'long', type: 'conjunction' });

/** "a, b e c". */
export function formatList(items: readonly string[]): string {
  return conjunction.format(items);
}

/** "1 incidente", "2 incidentes". */
export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

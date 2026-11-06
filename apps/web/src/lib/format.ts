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

/**
 * Um dia do calendário (`AAAA-MM-DD`, sem hora nem fuso) como "03/11/2026". Pelas partes: como data, ele seria a
 * meia-noite UTC, e no fuso de Brasília apareceria o dia anterior.
 */
export function formatDay(value: string): string {
  const [year, month, day, ...rest] = value.split('-');
  if (rest.length > 0 || year?.length !== 4 || month?.length !== 2 || day?.length !== 2) return '—';
  return `${day}/${month}/${year}`;
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

/**
 * Uma duração curta, arredondada para a maior unidade que importa: "45 s", "4 min", "1 h 20 min", "2 h", "3 dias".
 * Negativo vira zero.
 */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  }
  const days = Math.round(minutes / (24 * 60));
  return days === 1 ? '1 dia' : `${days} dias`;
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

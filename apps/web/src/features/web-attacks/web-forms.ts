import { WEB_MULTIPLIER_BOUNDS, type WebRoute } from '@verax/shared';

/** O que os formulários dos ataques web leem do que a pessoa digitou, e como mostram de volta. Sem regex sobre o texto. */

const MINUTE = 60_000;
const isDigit = (char: string): boolean => char >= '0' && char <= '9';

/** O que falta da observação, em horas e minutos: "41 h 20 min". */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
export const formatMultiplier = (value: number): string => decimal.format(value);

/** O número digitado, com vírgula ou ponto; null fora do formato ou dos limites. */
export function parseMultiplier(text: string): number | null {
  const normalized = text.trim().split(',').join('.');
  if (normalized === '' || [...normalized].some((char) => char !== '.' && !isDigit(char))) return null;
  const value = Number(normalized);
  return Number.isFinite(value) && value >= WEB_MULTIPLIER_BOUNDS.min && value <= WEB_MULTIPLIER_BOUNDS.max
    ? value
    : null;
}

export const MULTIPLIER_ERROR = `Um número de ${formatMultiplier(WEB_MULTIPLIER_BOUNDS.min)} a ${formatMultiplier(WEB_MULTIPLIER_BOUNDS.max)}.`;

/** "401, 403" vira [401, 403]; null com algo que não é um código de resposta. */
export function parseCodes(text: string): number[] | null {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const codes = parts.map((part) => (part.length === 3 && [...part].every(isDigit) ? Number(part) : NaN));
  return codes.every((code) => code >= 100 && code <= 599) ? codes : null;
}

/** "POST loja.exemplo.com.br/entrar", como a rota aparece na lista e nos nomes dos botões. */
export function routeName(route: Pick<WebRoute, 'host' | 'method' | 'path'>): string {
  return `${route.method === 'ANY' ? '' : `${route.method} `}${route.host ?? ''}${route.path}`;
}

const pad = (value: number): string => String(value).padStart(2, '0');
/** A data do calendário de quem usa a tela (`AAAA-MM-DD`), para o campo de data. */
export function dateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** O fim do dia escolhido, no fuso de quem usa a tela; null fora do formato. */
export function endOfDay(value: string): Date | null {
  const [year, month, day, ...rest] = value.split('-').map(Number);
  if (rest.length > 0 || year === undefined || month === undefined || day === undefined) return null;
  const date = new Date(year, month - 1, day, 23, 59, 59);
  return Number.isNaN(date.getTime()) || dateInput(date) !== value ? null : date;
}

import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * O cursor dos alertas de um caso: o lugar do último alerta da página (horário e id) e a marca do caso com os filtros.
 *
 * É opaco, mas não é segredo nem autorização: a consulta filtra sempre pelo cliente da sessão e pelo caso da rota, então
 * um cursor montado à mão só muda o ponto de partida dentro do que a pessoa já pode ler. A conferência (formato, faixa do
 * horário, escrita única e a marca) evita o engano: o cursor de outro caso, ou de outros filtros, pularia alertas sem
 * ninguém perceber.
 */
const CURSOR_VERSION = 1;
/** Anos 1 a 9999: o que o banco e o ISO escrevem do mesmo jeito. */
const MIN_AT = Date.parse('0001-01-01T00:00:00.000Z');
const MAX_AT = Date.parse('9999-12-31T23:59:59.999Z');

export interface CaseCursorPosition {
  /** O horário em ISO, ou `infinity`. */
  at: string;
  id: string;
}

/** Antes do primeiro alerta: o começo da lista, do mais recente para trás. */
export const CASE_CURSOR_START: CaseCursorPosition = {
  at: 'infinity',
  id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
};

const cursorSchema = z.tuple([
  z.literal(CURSOR_VERSION),
  z.number().int().min(MIN_AT).max(MAX_AT),
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  z.string().regex(/^[0-9a-f]{16}$/),
]);

/** A marca do caso com os filtros: o cursor só vale para a mesma lista. */
export function caseCursorScope(
  caseId: string,
  filters: { status?: string | undefined; severity?: string | undefined; group?: string | undefined },
): string {
  const parts = [caseId, filters.status ?? null, filters.severity ?? null, filters.group ?? null];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

export function encodeCaseCursor(at: Date, id: string, scope: string): string {
  return Buffer.from(JSON.stringify([CURSOR_VERSION, at.getTime(), id, scope])).toString('base64url');
}

/** O lugar de um cursor; null se ele não é um cursor desta lista. Nunca lança. */
export function decodeCaseCursor(cursor: string, scope: string): CaseCursorPosition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const result = cursorSchema.safeParse(parsed);
  if (!result.success) return null;
  const [, ms, id] = result.data;
  const at = new Date(ms);
  // O mesmo texto que sairia daqui: a marca desta lista, e nada de espaços, número em outra forma ou base64 com sobra.
  if (encodeCaseCursor(at, id, scope) !== cursor) return null;
  return { at: at.toISOString(), id };
}

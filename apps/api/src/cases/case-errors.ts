import { Prisma } from '../generated/prisma/client.js';

/** Um lote que não bate com o que ele mesmo travou. Desfaz o lote; a causa é um alerta ou um caso dele. */
export class CaseBatchError extends Error {
  override readonly name = 'CaseBatchError';
}

/** O SQLSTATE de um erro do banco, como o adaptador do Prisma o entrega; null se não há (a conexão caiu, por exemplo). */
export function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const adapter = error.meta?.['driverAdapterError'] as { cause?: { originalCode?: unknown } } | undefined;
  const code = adapter?.cause?.originalCode;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * Classes do SQLSTATE em que a culpa é do dado: exceção de dado (22), integridade (23), rotina e gatilho (2F, 38, 39 e
 * P0), cardinalidade (21), `WITH CHECK` (44) e página corrompida (XX).
 */
const ALERT_FAULTS: ReadonlySet<string> = new Set(['21', '22', '23', '2F', '38', '39', '44', 'P0', 'XX']);

/**
 * A falha de um lote pode ser culpa de um alerta dele? Só então vale partir o lote. Fica de fora tudo o que é do banco
 * ou da hora: conexão, espera por trava, deadlock, falta de recurso, parada do servidor, prazo da transação.
 */
export function isAlertFault(error: unknown): boolean {
  if (error instanceof CaseBatchError) return true;
  const state = sqlStateOf(error);
  if (state !== null) return ALERT_FAULTS.has(state.slice(0, 2));
  // Erro do próprio código ao planejar um alerta (a chave não lança, mas o plano pode ter um defeito).
  return error instanceof TypeError || error instanceof RangeError;
}

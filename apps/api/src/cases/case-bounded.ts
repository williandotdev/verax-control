import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { sqlStateOf } from './case-errors.js';

/** O SQLSTATE de um comando que passou do `statement_timeout`. */
const QUERY_CANCELED = '57014';

/**
 * Uma leitura com prazo, numa transação só de leitura; null se o banco a cortou. O prazo é do comando no banco: quem
 * pede demais não fica com a conexão. Sem JIT: num caso grande, compilar o comando demoraria mais que rodá-lo.
 */
export async function boundedRead<T>(
  prisma: PrismaService,
  milliseconds: number,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T | null> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT set_config('statement_timeout', ${`${milliseconds}ms`}, true), set_config('jit', 'off', true),
            set_config('transaction_read_only', 'on', true)`;
        return read(tx);
      },
      { timeout: milliseconds * 2 + 5_000 },
    );
  } catch (error) {
    if (sqlStateOf(error) === QUERY_CANCELED) return null;
    throw error;
  }
}

import type { Prisma } from '../generated/prisma/client.js';
import { protectedItemsOf } from '../incidents/incident-summary.js';
import { firstCharacters } from './case-key.js';
import { SAMPLE_VALUE_MAX } from './case-plan.js';

/** A lista de proteção do cliente (o client do escopo dele), cortada no tamanho das amostras, que é com o que ela é comparada. */
export async function caseProtectedItems(
  db: Pick<Prisma.TransactionClient, 'protectedResource'>,
): Promise<Set<string>> {
  const items = protectedItemsOf(
    await db.protectedResource.findMany({ select: { type: true, identifier: true } }),
  );
  return new Set([...items].map((item) => firstCharacters(item, SAMPLE_VALUE_MAX)));
}

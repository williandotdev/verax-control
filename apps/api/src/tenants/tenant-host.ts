import { isTenantSlug } from '../common/config/cell.js';
import type { Prisma } from '../generated/prisma/client.js';

/** O endereço pedido não pode ser gravado: subdomínio inválido, já de outro cliente, ou o cliente já tem outro. */
export class TenantHostConflict extends Error {}

/**
 * Grava o endereço de um cliente na célula (CE-01): a API `api-<slug>.<CELL_DOMAIN>` passa a responder por ele. É o
 * único caminho de escrita do `TenantHost`, e só o sistema o chama (o provisionamento da célula), com o client sem
 * escopo; nenhuma rota aceita o subdomínio, e o escopo do cliente só lê a tabela (`SYSTEM_WRITTEN_MODELS`).
 *
 * Só insere. Gravar de novo o mesmo par não muda nada (o provisionamento pode repetir o passo); qualquer outra
 * combinação é recusada, sem alterar a linha existente: um endereço nunca troca de cliente em silêncio (o banco também
 * recusa `UPDATE` na tabela).
 */
export async function assignTenantHost(
  db: Prisma.TransactionClient,
  tenantId: string,
  slug: string,
): Promise<void> {
  if (!isTenantSlug(slug)) throw new TenantHostConflict('subdomínio inválido');
  const created = await db.tenantHost.createMany({ data: [{ tenantId, slug }], skipDuplicates: true });
  if (created.count === 1) return;
  const current = await db.tenantHost.findUnique({ where: { tenantId }, select: { slug: true } });
  if (current?.slug !== slug)
    throw new TenantHostConflict('endereço já em uso ou cliente com outro endereço');
}

import { type CellCloudIdentity, cellCloudIdentitySchema } from '@verax/shared';
import { Prisma } from '../generated/prisma/client.js';

/** A conta de serviço pedida já é de outro cliente da célula: nada é gravado. */
export class TenantCloudIdentityConflict extends Error {}

/**
 * Grava a identidade do cliente na nuvem (CE-05, §3.1 do desenho): a conta de serviço `vxt-<slug>` e o ID único dela,
 * de onde sai o token que lê a AWS do cliente (CE-11). É a ÚNICA escrita de `TenantCloudIdentity` da aplicação, e só o
 * comando `tenant.upsert` do plano de controle a chama (`cell-commands.ts`); o meta-teste confere as duas coisas e que
 * nenhuma rota aceita os campos. `db` é a transação do comando, nunca o escopo de um cliente (que recusa a gravação).
 *
 * A identidade do mesmo cliente pode mudar (o plano de controle recriou a conta; a mudança vai para a trilha pelo
 * comando), mas uma conta nunca é de dois clientes: o banco recusa (único no e-mail e no ID), e a recusa vira
 * `TenantCloudIdentityConflict`. Devolve a identidade anterior (null na primeira), para a trilha.
 */
export async function writeTenantCloudIdentity(
  db: Prisma.TransactionClient,
  tenantId: string,
  identity: CellCloudIdentity,
): Promise<CellCloudIdentity | null> {
  const valid = cellCloudIdentitySchema.parse(identity);
  const before = await db.tenantCloudIdentity.findUnique({
    where: { tenantId },
    select: { saEmail: true, saUniqueId: true },
  });
  if (before !== null && before.saEmail === valid.saEmail && before.saUniqueId === valid.saUniqueId)
    return before;
  try {
    // Numa transação, o erro de unicidade aborta a transação inteira: o comando é desfeito junto, como deve.
    await db.tenantCloudIdentity.upsert({
      where: { tenantId },
      create: { tenantId, ...valid },
      update: valid,
      select: { tenantId: true },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new TenantCloudIdentityConflict('a conta de serviço já é de outro cliente');
    }
    throw error;
  }
  return before;
}

/** A identidade do cliente na célula (null sem ela: o nó dedicado, ou o cliente antes do primeiro comando). */
export async function readTenantCloudIdentity(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<CellCloudIdentity | null> {
  return db.tenantCloudIdentity.findUnique({
    where: { tenantId },
    select: { saEmail: true, saUniqueId: true },
  });
}

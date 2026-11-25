import type { Prisma } from '../../generated/prisma/client.js';

/**
 * A gravação do estado do motor de um balanceador (`WebEngineState`), só pela tarefa `web-logs`, na transação que conferiu a
 * autorização e a concessão. A tabela é só do sistema (`SYSTEM_WRITTEN_MODELS`): a escrita é pela transação, sempre com o
 * cliente da fonte, e a chave composta recusa o par trocado. O formato é o de `collect/engine-state.ts`.
 */
export async function saveWebEngineState(
  tx: Prisma.TransactionClient,
  row: { sourceId: string; tenantId: string; loadBalancer: string; version: number; json: string },
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "WebEngineState" AS held
      ("sourceId", "tenantId", "loadBalancer", "version", "state", "updatedAt")
    VALUES (
      ${row.sourceId}::uuid, ${row.tenantId}::uuid, ${row.loadBalancer}, ${row.version}::smallint,
      ${row.json}::jsonb, now()
    )
    ON CONFLICT ("sourceId", "tenantId") DO UPDATE SET
      "loadBalancer" = EXCLUDED."loadBalancer",
      "version" = EXCLUDED."version",
      "state" = EXCLUDED."state",
      "updatedAt" = EXCLUDED."updatedAt"`;
}

/** O balanceador é outro: nada do que foi guardado do anterior vale. */
export async function deleteWebEngineState(
  tx: Prisma.TransactionClient,
  key: { sourceId: string; tenantId: string },
): Promise<void> {
  await tx.webEngineState.deleteMany({ where: key });
}

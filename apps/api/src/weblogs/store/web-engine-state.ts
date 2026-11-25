import type { Prisma } from '../../generated/prisma/client.js';

/** A versão do formato do estado (`collect/engine-state.ts`). */
export const ENGINE_STATE_VERSION = 1;

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

/** O que o painel pode ver do estado, ainda por conferir com o schema. */
export interface WebEngineView {
  loadBalancer: string;
  version: number;
  updatedAt: Date;
  observation: unknown;
  suppressed: unknown;
  notes: unknown;
}

/**
 * A observação, o calado e as notas de um balanceador, para o painel. O banco devolve só esses pedaços: o resumo do dia (o
 * único com endereços) e as chaves da observação não chegam à API. O cliente é o da sessão de quem chama, e entra no filtro.
 */
export async function readWebEngineView(
  db: Prisma.TransactionClient,
  key: { sourceId: string; tenantId: string },
): Promise<WebEngineView | null> {
  const rows = await db.$queryRaw<WebEngineView[]>`
    SELECT
      "loadBalancer",
      "version",
      "updatedAt",
      CASE WHEN jsonb_typeof("state" -> 'observation') = 'object'
        THEN ("state" -> 'observation') - 'keys'
      END AS "observation",
      "state" -> 'suppressed' AS "suppressed",
      "state" -> 'notes' AS "notes"
    FROM "WebEngineState"
    WHERE "sourceId" = ${key.sourceId}::uuid AND "tenantId" = ${key.tenantId}::uuid`;
  return rows[0] ?? null;
}

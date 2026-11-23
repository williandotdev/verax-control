import type { NodeSyncSourceCode } from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** O código da fonte do console que o cliente excluiu no painel (`NODE_SYNC_SOURCE_CODES`). */
export const DELETED_IN_PANEL: NodeSyncSourceCode = 'deleted_in_panel';

/**
 * A conta que a Verax cadastrou pelo console e que o cliente excluiu no painel (`CloudAccountsService.delete`): o item
 * da fonte em `ControlPlaneSyncItem` vira a falha `deleted_in_panel`, sem nova tentativa, na mesma transação que apaga a
 * conta. Com isso:
 * - a sincronização não recria a conta na mesma revisão (a falha de uma revisão só é tentada de novo quando a revisão
 *   muda, `applySource`), e a guarda de `applyAccount` confere o item de novo dentro da transação dela, depois do lock
 *   das vagas, para a sincronização que já tinha lido o item antes da exclusão também não a recriar;
 * - o relato seguinte ao plano de controle leva a falha com o código (sem a conta, que não existe mais), e o console
 *   mostra a fonte como "Falhou", com o que fazer;
 * - uma revisão maior do console (a fonte alterada lá) cadastra a conta de novo, e a lápide (`removed`) de uma revisão
 *   maior é contada como removida, sem erro.
 *
 * A revisão gravada é a maior entre a última aplicada na conta e a do item: um item numa revisão mais nova que falhou
 * (a vaga do plano, por exemplo) não pode ficar para trás, ou a sincronização a tentaria de novo e recriaria a conta.
 *
 * O item da credencial da fonte sai junto: a credencial da conta foi apagada com ela, e a conta recriada por uma revisão
 * maior recebe de novo a credencial que o console mandar, como uma conta nova.
 *
 * Ordem dos locks (a mesma em todo caminho que toca a conta, a credencial e os itens da sincronização): as vagas do
 * plano (`lockSeats`), o lock da credencial da conta (`lockCredential`, advisory de transação, reentrante) e só depois
 * os itens de `ControlPlaneSyncItem`. Quem chama já pegou os dois primeiros (`CloudAccountsService.delete`); a
 * sincronização (`applyAccount` e `applyCredential`, `apply-source.ts`) segue a mesma ordem.
 *
 * É a única gravação de `ControlPlaneSyncItem` fora da tarefa do worker, com o cliente base (o model é só leitura no
 * escopo do cliente, `SYSTEM_WRITTEN_MODELS`), e sempre com o cliente da sessão.
 */
export async function recordDeletedInPanel(
  db: Prisma.TransactionClient,
  input: { tenantId: string; sourceId: string; revision: number | null },
): Promise<void> {
  const where = { kind_itemId: { kind: 'log_source' as const, itemId: input.sourceId } };
  const item = await db.controlPlaneSyncItem.findUnique({
    where,
    select: { revision: true, tenantId: true },
  });
  const revision = Math.max(
    input.revision ?? 1,
    item !== null && item.tenantId === input.tenantId ? item.revision : 0,
  );
  const data = {
    tenantId: input.tenantId,
    revision,
    outcome: 'failed',
    code: DELETED_IN_PANEL,
    attempts: 0,
    nextAttemptAt: null,
  };
  await db.controlPlaneSyncItem.upsert({
    where,
    create: { kind: 'log_source', itemId: input.sourceId, ...data },
    update: data,
  });
  await db.controlPlaneSyncItem.deleteMany({
    where: { kind: 'log_source_credential', itemId: input.sourceId, tenantId: input.tenantId },
  });
}

/**
 * A guarda da sincronização: a fonte que o cliente excluiu no painel numa revisão igual ou maior que a desejada não é
 * cadastrada de novo. Lida na transação de `applyAccount`, depois do lock das vagas (o mesmo da exclusão).
 */
export async function deletedInPanelAt(
  db: Prisma.TransactionClient,
  sourceId: string,
  revision: number,
): Promise<boolean> {
  const item = await db.controlPlaneSyncItem.findUnique({
    where: { kind_itemId: { kind: 'log_source', itemId: sourceId } },
    select: { revision: true, outcome: true, code: true },
  });
  return (
    item !== null && item.outcome === 'failed' && item.code === DELETED_IN_PANEL && item.revision >= revision
  );
}

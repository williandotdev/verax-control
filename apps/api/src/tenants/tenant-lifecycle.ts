import type { TenantLifecycleStatus, TenantStatus } from '@verax/shared';
import { AuditService } from '../common/audit/audit.service.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { lockTenantRow } from '../escalation/escalation-contact-store.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Ciclo de vida da contratação no nó (CE-02): o espelho, em `Tenant.status`, dos estados que o plano de controle
 * decide (seção "Célula compartilhada (Plataforma)" de `docs/ARQUITETURA.md`). Na célula, quem chama é o comando do
 * plano de controle (CE-05, `cell/cell-commands.ts`, pela `applyTenantLifecycleStatus`); nenhuma rota da API chega
 * aqui, e o cadastro de clientes (`admin_verax`) só mexe em `active` e `inactive`, e nunca num cliente que está num
 * estado do ciclo de vida.
 *
 * O que cada estado bloqueia já vale em todo o nó, sem depender de quem o gravou:
 * - login e sessão: só cliente `active` entra (`auth.factory.ts` e `session-validation.ts`), e o suspenso ouve a
 *   mensagem de pagamento depois de acertar a senha;
 * - coleta: só conta de cliente `active` é lida (`COLLECTING_TENANT`, em `tenant-status.ts`);
 * - os dados ficam até o expurgo do cliente (`purging`, CE-16).
 */

/** O que o ciclo de vida grava: os três estados dele e a volta a `active` (reativação). */
export type TenantLifecycleTarget = TenantLifecycleStatus | 'active';

/**
 * As transições do ciclo de vida. Repetir o estado atual não é transição (o comando repetido não muda nada). O
 * `inactive` é a exclusão lógica do cadastro: o ciclo de vida não o move, nem chega a ele.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<TenantStatus, readonly TenantLifecycleTarget[]>> = {
  active: ['suspended', 'canceled'],
  suspended: ['active', 'canceled'],
  canceled: ['purging'],
  purging: [],
  inactive: [],
};

/** Ação da trilha de cada transição, na trilha do próprio cliente. */
const LIFECYCLE_ACTION: Readonly<Record<TenantLifecycleTarget, string>> = {
  active: 'tenant.lifecycle_reactivate',
  suspended: 'tenant.lifecycle_suspend',
  canceled: 'tenant.lifecycle_cancel',
  purging: 'tenant.lifecycle_purge_start',
};

/** Transição fora da tabela: o estado do cliente não muda e nada é gravado. */
export class TenantTransitionRefused extends Error {
  constructor(
    readonly from: TenantStatus,
    readonly to: TenantLifecycleTarget,
  ) {
    super(`transição do cliente recusada: ${from} → ${to}`);
  }
}

/**
 * As sessões dos usuários do cliente caem, e as seleções de `admin_verax` nele são limpas. O guard já recusaria essas
 * sessões na próxima requisição (só cliente `active` vale); apagar agora as tira também das listagens de sessão.
 */
export async function revokeTenantAccess(db: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await db.session.deleteMany({ where: { user: { tenantId } } });
  await db.session.updateMany({ where: { activeTenantId: tenantId }, data: { activeTenantId: null } });
}

export interface LifecycleChange {
  from: TenantStatus;
  to: TenantLifecycleTarget;
  changed: boolean;
}

/**
 * Leva o cliente ao estado pedido, numa transação, com a linha do cliente travada: confere a transição contra o estado
 * de agora (`TenantTransitionRefused` fora da tabela), grava, derruba o acesso quando o cliente sai de `active` e
 * registra a mudança na trilha do cliente (ator sistema; `actorId` diz quem pediu, como `control-plane`). Repetir o
 * estado atual não grava nada. O cliente que não existe lança o erro do Prisma.
 */
export async function setTenantLifecycleStatus(
  prisma: PrismaService,
  tenantId: string,
  to: TenantLifecycleTarget,
  options: { actorId?: string; audit?: AuditService } = {},
): Promise<LifecycleChange> {
  return prisma.$transaction((tx) => applyTenantLifecycleStatus(tx, tenantId, to, options));
}

/**
 * O mesmo que `setTenantLifecycleStatus`, dentro de uma transação aberta por quem chama: o comando da célula (CE-05)
 * aplica o estado desejado inteiro, e o relatório dele, numa transação só. Um erro desfaz tudo junto.
 */
export async function applyTenantLifecycleStatus(
  tx: Prisma.TransactionClient,
  tenantId: string,
  to: TenantLifecycleTarget,
  options: { actorId?: string; audit?: AuditService } = {},
): Promise<LifecycleChange> {
  const audit = options.audit ?? new AuditService();
  await lockTenantRow(tx, tenantId);
  const { status: from } = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { status: true },
  });
  if (from === to) return { from, to, changed: false };
  if (!LIFECYCLE_TRANSITIONS[from].includes(to)) throw new TenantTransitionRefused(from, to);
  await tx.tenant.update({ where: { id: tenantId }, data: { status: to }, select: { id: true } });
  if (to !== 'active') await revokeTenantAccess(tx, tenantId);
  await audit.write(tx, {
    actor: { type: 'system', tenantId, ...(options.actorId !== undefined && { id: options.actorId }) },
    action: LIFECYCLE_ACTION[to],
    outcome: 'success',
    resourceType: 'tenant',
    resourceId: tenantId,
    before: { status: from },
    after: { status: to },
  });
  return { from, to, changed: true };
}

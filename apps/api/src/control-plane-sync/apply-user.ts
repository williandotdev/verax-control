import type { NodeSyncDesiredUser, NodeSyncUserCode } from '@verax/shared';
import { CredentialVaultError, openUserPassword } from '@verax/vault-envelope';
import {
  prepareTemporaryPassword,
  type PreparedTemporaryPassword,
  writeTemporaryPassword,
} from '../auth/temporary-password.js';
import { type AuthIds, defaultAuthIds, insertUser } from '../auth/user-provisioning.js';
import { AuditService } from '../common/audit/audit.service.js';
import { errorKind } from '../common/logger/error-kind.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { VaultKeyring } from '../credentials/credential-keys.js';
import { Prisma } from '../generated/prisma/client.js';
import { assertWithinPlan, PlanLimitReached } from '../plan/plan-limits.js';
import type { TenantPlans } from '../plan/tenant-plan.js';
import { auditEntry, recordItem, type SyncLogger } from './apply-source.js';

/** O pedido de usuário não tem revisão: o item guarda sempre 1 (o resultado de um pedido é final). */
const USER_ITEM_REVISION = 1;
/** Uma transação da criação: o lock das vagas, a checagem do e-mail e as gravações (o hash já vem pronto). */
const TRANSACTION_TIMEOUT_MS = 15_000;

/** O que criar um usuário pedido pelo console precisa: o cliente do nó e o que vem da configuração do worker. */
export interface UserApplyContext {
  prisma: PrismaService;
  tenantId: string;
  keyring: VaultKeyring | null;
  plans: TenantPlans;
  /** `CONTROL_PLANE_USERS`: desligado, cada pedido é recusado com `users_disabled`. */
  enabled: boolean;
  logger: SyncLogger;
  now: () => Date;
  /** Os IDs do usuário e da conta de senha (por padrão, como o Better Auth os gera; os testes podem trocar). */
  ids?: AuthIds;
}

/** O que aconteceu com o pedido nesta passagem (as contagens da execução e a segunda chamada). */
export type UserApplyResult = 'created' | 'failed' | 'unchanged';

/** Uma recusa conhecida do pedido: o código do contrato. */
class UserFailure extends Error {
  constructor(readonly code: NodeSyncUserCode) {
    super(`usuário não criado: ${code}`);
    this.name = 'UserFailure';
  }
}

const audit = new AuditService();

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  status: true,
  twoFactorEnabled: true,
  mustChangePassword: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Cria a conta pedida, numa transação: a vaga do plano (sob o lock das vagas, como no painel), o e-mail livre na
 * plataforma inteira, o usuário (o papel do pedido, no cliente do nó, o e-mail em minúsculas), a senha temporária do
 * pedido com a validade do pedido (troca de senha e MFA no primeiro acesso, como a conta criada no painel), o id do
 * pedido na conta e a trilha `user.create` do sistema, com o ator do console e `origin: 'control_plane'` (nunca a
 * senha).
 */
async function createUser(
  ctx: UserApplyContext,
  desired: NodeSyncDesiredUser,
  prepared: PreparedTemporaryPassword,
): Promise<void> {
  const { prisma, tenantId } = ctx;
  await prisma.$transaction(
    async (tx) => {
      const plan = await ctx.plans.planOf(tenantId, tx);
      if (plan === null) throw new UserFailure('tenant_plan_missing');
      try {
        await assertWithinPlan(tx, plan, 'users', tenantId);
      } catch (error) {
        if (error instanceof PlanLimitReached) throw new UserFailure('plan_limit_reached');
        throw error;
      }
      const email = desired.email.trim().toLowerCase();
      // O e-mail é único na plataforma inteira: a busca é fora do escopo do cliente.
      if (await tx.user.findUnique({ where: { email }, select: { id: true } })) {
        throw new UserFailure('email_taken');
      }
      // Nasce sem acesso (`invited`) e fica ativa junto com a senha temporária, como no painel.
      const { id } = await insertUser(tx, ctx.ids ?? defaultAuthIds, {
        email,
        name: desired.name,
        role: desired.role,
        tenantId,
        status: 'invited',
      });
      const db = scopeToTenant(tx, tenantId);
      await db.user.update({
        where: { id },
        data: { controlPlaneRequestId: desired.requestId },
        select: { id: true },
      });
      await writeTemporaryPassword(tx, { id, email }, prepared);
      const row = await db.user.findUniqueOrThrow({ where: { id }, select: USER_SELECT });
      await audit.write(
        tx,
        auditEntry(tenantId, {
          action: 'user.create',
          resourceType: 'user',
          resourceId: id,
          after: {
            id: row.id,
            name: row.name,
            email: row.email,
            role: row.role,
            status: row.status,
            mfaEnabled: row.twoFactorEnabled,
            mustChangePassword: row.mustChangePassword,
            createdAt: row.createdAt.toISOString(),
            requestId: desired.requestId,
            origin: 'control_plane',
          },
        }),
      );
      await recordItem(tx, {
        kind: 'user',
        itemId: desired.requestId,
        tenantId,
        revision: USER_ITEM_REVISION,
        outcome: 'created',
      });
    },
    { timeout: TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * Um usuário que a Verax pediu no console (`docs/ARQUITETURA.md`, "Sincronização com o plano de controle: o lado do
 * nó"). O resultado de cada pedido é final e fica em `ControlPlaneSyncItem` (`kind = user`): o plano de controle apaga o
 * envelope com qualquer relato, e um pedido recusado não é tentado de novo (o console faz outro pedido). Na ordem:
 *
 * 1. a conta deste pedido já existe no cliente: `created` (o mesmo pedido de novo não cria outra conta);
 * 2. o prazo do pedido passou (`expired`), a criação de usuários está desligada no nó (`users_disabled`), o nó não tem
 *    o cofre (`vault_disabled`) ou o envelope não abre com a amarração `{cliente do nó, pedido, e-mail}`
 *    (`envelope_unreadable`);
 * 3. numa transação: a vaga do plano (`plan_limit_reached`, `tenant_plan_missing`), o e-mail livre (`email_taken`) e a
 *    criação.
 *
 * A senha só passa pela memória do worker: entra na máscara do logger assim que o envelope abre, vira o hash e sai da
 * máscara no fim; nunca volta ao plano de controle, nem vai para o log ou para a trilha.
 */
export async function applyUser(
  ctx: UserApplyContext,
  desired: NodeSyncDesiredUser,
): Promise<UserApplyResult> {
  const { prisma, tenantId } = ctx;
  const item = await prisma.controlPlaneSyncItem.findUnique({
    where: { kind_itemId: { kind: 'user', itemId: desired.requestId } },
  });
  // O resultado deste pedido já foi gravado (para este cliente, ou para outro que o banco tinha antes): é final.
  if (item !== null) return 'unchanged';
  const existing = await prisma.user.findUnique({
    where: { controlPlaneRequestId: desired.requestId },
    select: { tenantId: true },
  });
  if (existing !== null) {
    // A conta do pedido em outro cliente do banco: nada é contado nem criado (o relato só sai do cliente do nó).
    if (existing.tenantId !== tenantId) {
      ctx.logger.warn(
        { requestId: desired.requestId },
        'sincronização com o plano de controle: o pedido de usuário é de uma conta de outro cliente; ignorado',
      );
      return 'unchanged';
    }
    await recordItem(prisma, {
      kind: 'user',
      itemId: desired.requestId,
      tenantId,
      revision: USER_ITEM_REVISION,
      outcome: 'created',
    });
    return 'created';
  }

  const fail = async (code: NodeSyncUserCode): Promise<'failed'> => {
    await recordItem(prisma, {
      kind: 'user',
      itemId: desired.requestId,
      tenantId,
      revision: USER_ITEM_REVISION,
      outcome: 'failed',
      code,
    });
    ctx.logger.warn(
      { requestId: desired.requestId, code },
      'sincronização com o plano de controle: o usuário pedido no console não foi criado',
    );
    return 'failed';
  };

  // No próprio instante do prazo a senha já nasceria vencida (`temporaryPasswordExpired`).
  if (ctx.now().getTime() >= new Date(desired.notAfter).getTime()) return fail('expired');
  if (!ctx.enabled) return fail('users_disabled');
  if (ctx.keyring === null) return fail('vault_disabled');
  let password: string;
  try {
    password = openUserPassword(
      ctx.keyring,
      { nodeTenantId: tenantId.toLowerCase(), requestId: desired.requestId, email: desired.email },
      desired.envelope,
    );
  } catch (error) {
    if (error instanceof CredentialVaultError) {
      ctx.logger.warn(
        { requestId: desired.requestId, error: error.code },
        'sincronização com o plano de controle: o envelope da senha não abre neste nó',
      );
      return fail('envelope_unreadable');
    }
    throw error;
  }
  registerLiveSecret(password);
  try {
    try {
      // O hash (lento de propósito) fica fora da transação, como no painel.
      const prepared = await prepareTemporaryPassword(ctx.ids ?? defaultAuthIds, {
        password,
        expiresAt: new Date(desired.notAfter),
      });
      await createUser(ctx, desired, prepared);
      return 'created';
    } catch (error) {
      if (error instanceof UserFailure) return await fail(error.code);
      if (isUniqueViolation(error)) {
        // Outra gravação confirmou o mesmo e-mail (ou este pedido) entre a checagem e o commit.
        const same = await scopeToTenant(prisma, tenantId).user.findUnique({
          where: { controlPlaneRequestId: desired.requestId },
          select: { id: true },
        });
        if (same !== null) {
          await recordItem(prisma, {
            kind: 'user',
            itemId: desired.requestId,
            tenantId,
            revision: USER_ITEM_REVISION,
            outcome: 'created',
          });
          return 'created';
        }
        return await fail('email_taken');
      }
      ctx.logger.error(
        { requestId: desired.requestId, error: errorKind(error) },
        'sincronização com o plano de controle: falha ao criar o usuário pedido no console',
      );
      return await fail('internal_error');
    }
  } finally {
    forgetLiveSecret(password);
  }
}

import type { CloudflareOauthAttemptError } from '@verax/shared';
import { RESET_CONNECTION } from '../../cloud-accounts/cloud-account-data.js';
import type { AuditService } from '../../common/audit/audit.service.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import { lockCredential, lockGrant } from '../../credentials/credential-rekey.js';
import { Prisma } from '../../generated/prisma/client.js';
import { assertWithinPlan, lockPlanSeats, lockSeatRow, PlanLimitReached } from '../../plan/plan-limits.js';
import type { TenantPlans } from '../../plan/tenant-plan.js';
import { releaseGrantIfUnused } from './grant-store.js';

/** Uma transação: os locks das vagas, das contas e das concessões, poucas leituras e a gravação. */
const TRANSACTION_TIMEOUT_MS = 15_000;

/** A conexão não pôde ser feita: o código da tentativa. */
export class LinkRefused extends Error {
  constructor(readonly code: CloudflareOauthAttemptError) {
    super(`conexão do Cloudflare recusada: ${code}`);
    this.name = 'LinkRefused';
  }
}

/** A tentativa ou a concessão mudou no meio (venceu, a conta saiu): nada é gravado. */
export class LinkStale extends Error {
  constructor() {
    super('a tentativa de conectar o Cloudflare não está mais aberta');
    this.name = 'LinkStale';
  }
}

export interface LinkRequest {
  tenantId: string;
  attemptId: string;
  grantId: string;
  /** Os IDs no Cloudflare, cada um já provado com o acesso desta concessão (a leitura da auditoria). */
  accountIds: readonly string[];
}

export interface LinkDeps {
  prisma: PrismaService;
  plans: TenantPlans;
  audit: AuditService;
}

const EXISTING_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  status: true,
  cloudflareGrantId: true,
  credential: { select: { kind: true, keyIdSuffix: true, expiresAt: true } },
} as const satisfies Prisma.CloudAccountSelect;

/**
 * Liga as contas já provadas à concessão e termina a tentativa, tudo numa transação: ou todas, ou nenhuma.
 *
 * - A conta nova nasce com todas as zonas (a lista vazia), com vaga no plano.
 * - A que já está cadastrada e ativa passa a ser lida pela concessão: o token colado sai do cofre, e a conexão recomeça.
 *   Nada da coleta é tocado (cursores, achados, incidentes, zonas): a leitura segue de onde estava.
 * - A de outro cliente ou desativada recusa a conexão inteira (`account_exists`).
 * - A concessão anterior que ficou sem conta nenhuma vai para a revogação.
 *
 * Locks, nesta ordem: as vagas do plano, a credencial de cada conta (em ordem de ID) e as concessões (em ordem de ID).
 */
export async function linkAccounts(deps: LinkDeps, request: LinkRequest, now: Date): Promise<void> {
  try {
    await deps.prisma.$transaction((tx) => link(tx, deps, request, now), { timeout: TRANSACTION_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof PlanLimitReached) throw new LinkRefused('plan_limit_reached');
    // A mesma conta cadastrada por outro caminho ao mesmo tempo.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new LinkRefused('account_exists');
    }
    throw error;
  }
}

async function link(
  tx: Prisma.TransactionClient,
  { plans, audit }: LinkDeps,
  { tenantId, attemptId, grantId, accountIds }: LinkRequest,
  now: Date,
): Promise<void> {
  const db = scopeToTenant(tx, tenantId);
  const where = { provider: 'cloudflare' as const, accountId: { in: [...accountIds] } };
  const plan = await plans.planOf(tenantId, tx);
  if (plan === null) await lockSeatRow(tx, 'cloudAccounts', tenantId);
  else await lockPlanSeats(tx, plan, 'cloudAccounts', tenantId);

  // Sem o escopo: a conta é única por provedor e ID no nó inteiro, e a de outro cliente recusa sem ser tocada.
  const known = await tx.cloudAccount.findMany({ where, select: { id: true, tenantId: true } });
  if (known.some((account) => account.tenantId !== tenantId)) throw new LinkRefused('account_exists');
  for (const { id } of [...known].sort((a, b) => (a.id < b.id ? -1 : 1))) await lockCredential(tx, id);

  // Lidas de novo com os locks na mão: uma exclusão ou desativação ao mesmo tempo já terminou ou espera.
  const existing = await db.cloudAccount.findMany({ where, select: EXISTING_SELECT, orderBy: { id: 'asc' } });
  if (existing.some((account) => account.status !== 'active')) throw new LinkRefused('account_exists');
  const previous = new Set(existing.flatMap((account) => account.cloudflareGrantId ?? []));
  previous.delete(grantId);
  for (const id of [...previous, grantId].sort()) await lockGrant(tx, id);

  const grant = await db.cloudflareGrant.findUnique({ where: { id: grantId }, select: { status: true } });
  if (grant?.status !== 'active') throw new LinkStale();
  const { count } = await db.cloudflareConnectAttempt.updateMany({
    where: { id: attemptId, grantId, status: 'choosing', expiresAt: { gt: now } },
    data: { status: 'done', chosenAccountIds: [] },
  });
  if (count !== 1) throw new LinkStale();

  for (const account of existing) {
    if (account.cloudflareGrantId === grantId) continue;
    if (account.credential !== null) {
      await db.cloudCredential.delete({
        where: { cloudAccountId: account.id },
        select: { cloudAccountId: true },
      });
      await audit.write(tx, {
        actor: { type: 'system', tenantId },
        action: 'cloud_credential.wipe',
        outcome: 'success',
        resourceType: 'cloud_credential',
        resourceId: account.id,
        before: {
          kind: account.credential.kind,
          keyIdSuffix: account.credential.keyIdSuffix,
          expiresAt: account.credential.expiresAt?.toISOString() ?? null,
        },
        after: null,
      });
    }
    await db.cloudAccount.update({
      where: { id: account.id },
      data: { cloudflareGrantId: grantId, ...RESET_CONNECTION },
      select: { id: true },
    });
    await audit.write(tx, {
      actor: { type: 'system', tenantId },
      action: 'cloud_account.cloudflare_connect',
      outcome: 'success',
      resourceType: 'cloud_account',
      resourceId: account.id,
      before: {
        method:
          account.cloudflareGrantId !== null ? 'oauth' : account.credential === null ? null : 'pasted_token',
      },
      after: { method: 'oauth', attemptId },
    });
  }

  const registered = new Set(existing.map((account) => account.accountId));
  for (const accountId of accountIds) {
    if (registered.has(accountId)) continue;
    if (plan === null) throw new LinkRefused('tenant_plan_missing');
    await assertWithinPlan(tx, plan, 'cloudAccounts', tenantId);
    const { id } = await db.cloudAccount.create({
      data: {
        tenantId,
        provider: 'cloudflare',
        accountId,
        regions: [],
        zones: [],
        cloudflareGrantId: grantId,
      },
      select: { id: true },
    });
    await audit.write(tx, {
      actor: { type: 'system', tenantId },
      action: 'cloud_account.create',
      outcome: 'success',
      resourceType: 'cloud_account',
      resourceId: id,
      after: { provider: 'cloudflare', accountId, zones: [], method: 'oauth', attemptId },
    });
  }

  for (const id of [...previous].sort()) {
    if (!(await releaseGrantIfUnused(tx, tenantId, id, now))) continue;
    await audit.write(tx, {
      actor: { type: 'system', tenantId },
      action: 'cloudflare_grant.release',
      outcome: 'success',
      resourceType: 'cloudflare_grant',
      resourceId: id,
      after: { replacedBy: grantId },
    });
  }
}

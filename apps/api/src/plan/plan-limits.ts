import { HttpStatus } from '@nestjs/common';
import {
  PLAN_LIMIT_REACHED_CODE,
  PLAN_SEAT_LIMIT,
  type PlanSeat,
  planLimitMessage,
  type ResolvedPlan,
} from '@verax/shared';
import { ApiError } from '../common/http/api-error.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';

/** O que ocupa vaga no plano (a regra está em `packages/shared/src/plan-usage.ts`). */
const CLOUD_ACCOUNT_SEATS = { status: 'active' } as const satisfies Prisma.CloudAccountWhereInput;
const USER_SEATS = {
  status: { in: ['invited', 'active'] },
  // O CHECK do banco já deixa a equipe da Verax fora de qualquer cliente; o filtro repete a regra aqui.
  role: { not: 'admin_verax' },
} as const satisfies Prisma.UserWhereInput;

/** Nome do lock de cada vaga, por cliente: `verax:plan:<vaga>:<cliente>`. */
const LOCK_NAME: Readonly<Record<PlanSeat, string>> = {
  cloudAccounts: 'cloud_accounts',
  users: 'users',
};

/** Recusa por limite do plano: 409 com o código `PLAN_LIMIT_REACHED` e a mensagem que diz o limite. */
export class PlanLimitReached extends ApiError {
  constructor(
    readonly seat: PlanSeat,
    readonly limit: number,
  ) {
    super(HttpStatus.CONFLICT, planLimitMessage(seat, limit), PLAN_LIMIT_REACHED_CODE);
  }
}

/** Vagas ocupadas de um cliente, por um cliente do banco já no escopo dele (`scoped()` ou `forTenant`). */
export function countSeats(scoped: Prisma.TransactionClient, seat: PlanSeat): Promise<number> {
  return seat === 'cloudAccounts'
    ? scoped.cloudAccount.count({ where: CLOUD_ACCOUNT_SEATS })
    : scoped.user.count({ where: USER_SEATS });
}

/**
 * Trava as vagas de um cliente na transação: `pg_advisory_xact_lock(hashtext('verax:plan:<vaga>:<cliente>'))`, o mesmo
 * padrão das origens de log em `cloud-accounts.service.ts`. Sem limite (plano `interno`), não trava nada. Devolve o
 * limite.
 *
 * Toda escrita que ocupa ou libera uma vaga pega este lock antes de ler o status do recurso: criar, ativar e desativar.
 * Assim a decisão (a conta já está ativa? há vaga?) vale até o commit: uma desativação que corre junto com uma
 * reativação e uma criação não deixa as duas passarem com a mesma vaga. Por isso `db` tem de ser a transação que vai
 * gravar (a da requisição, `PrismaService.db()`, ou a de um `$transaction`): fora de uma transação, o lock seria solto
 * logo depois de pego. O lock é reentrante na mesma transação, e quem chama o pega antes de qualquer outro (as origens
 * de log, a credencial), para a ordem dos locks ser sempre a mesma.
 */
export async function lockPlanSeats(
  db: Prisma.TransactionClient,
  plan: ResolvedPlan,
  seat: PlanSeat,
  tenantId: string,
): Promise<number | null> {
  const limit = plan.limits[PLAN_SEAT_LIMIT[seat]];
  if (limit === null) return null;
  // O cliente base do Prisma conecta e desconecta; a transação, não (`$connect` está fora do `TransactionClient`).
  if (typeof (db as { $connect?: unknown }).$connect === 'function') {
    throw new Error('as vagas do plano só são travadas na transação que grava a conta ou o usuário');
  }
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:plan:${LOCK_NAME[seat]}:${tenantId}`}))`;
  return limit;
}

/**
 * Confere se o cliente ainda tem vaga no plano antes de criar ou reativar uma conta cloud ou um usuário (fase 2,
 * PR-18), sob o lock de `lockPlanSeats`: duas criações simultâneas no limite menos 1 terminam com uma aceita, porque a
 * segunda só conta depois que a primeira confirma (ou desfaz). Sem limite (plano `interno`), não faz nada.
 */
export async function assertWithinPlan(
  db: Prisma.TransactionClient,
  plan: ResolvedPlan,
  seat: PlanSeat,
  tenantId: string,
): Promise<void> {
  const limit = await lockPlanSeats(db, plan, seat, tenantId);
  if (limit === null) return;
  if ((await countSeats(scopeToTenant(db, tenantId), seat)) >= limit) {
    throw new PlanLimitReached(seat, limit);
  }
}

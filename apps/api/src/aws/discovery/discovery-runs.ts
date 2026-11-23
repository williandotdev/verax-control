import type { AwsDiscoveryTrigger } from '@verax/shared';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Os pedidos de descoberta de uma conta AWS (`AwsDiscoveryRun`) e o lock que serializa o que mexe nas fontes dela.
 *
 * - **Uma por vez:** uma conta tem no máximo uma execução pendente ou em curso. O pedido (do "Conectar", do painel ou do
 *   agendamento diário) confere isso sob o lock da conta e não cria outra: devolve a que já existe.
 * - **O lock** (`lockAwsOnboarding`, transacional) é o mesmo da autorização e da revogação de fontes pelo painel e da
 *   gravação do resultado da descoberta pelo worker: a descoberta nunca grava por cima de uma autorização que acabou de
 *   entrar, nem o contrário.
 */

/** Só vale dentro de uma transação, e no cliente do banco sem escopo (o escopo do cliente recusa os métodos `$`). */
export async function lockAwsOnboarding(tx: Prisma.TransactionClient, cloudAccountId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:aws-onboarding:${cloudAccountId}`}))`;
}

export const DISCOVERY_RUN_SELECT = {
  id: true,
  tenantId: true,
  cloudAccountId: true,
  trigger: true,
  status: true,
  requestedAt: true,
  startedAt: true,
  finishedAt: true,
  regions: true,
  errors: true,
  summary: true,
  requestedBy: true,
  updatedAt: true,
} as const satisfies Prisma.AwsDiscoveryRunSelect;
export type DiscoveryRunRow = Prisma.AwsDiscoveryRunGetPayload<{ select: typeof DISCOVERY_RUN_SELECT }>;

export interface DiscoveryRequest {
  tenantId: string;
  cloudAccountId: string;
  trigger: AwsDiscoveryTrigger;
  /** O usuário que pediu a descoberta manual. */
  requestedBy?: string;
  now: Date;
}

/**
 * Pede uma descoberta da conta, na transação de quem chama. Com outra pendente ou em curso, não cria nada e devolve a
 * que existe (`created: false`): quem pediu acompanha a mesma.
 */
export async function requestAwsDiscovery(
  tx: Prisma.TransactionClient,
  request: DiscoveryRequest,
): Promise<{ run: DiscoveryRunRow; created: boolean }> {
  await lockAwsOnboarding(tx, request.cloudAccountId);
  const db = scopeToTenant(tx, request.tenantId);
  const active = await db.awsDiscoveryRun.findFirst({
    where: { cloudAccountId: request.cloudAccountId, status: { in: ['pending', 'running'] } },
    orderBy: { requestedAt: 'desc' },
    select: DISCOVERY_RUN_SELECT,
  });
  if (active !== null) return { run: active, created: false };
  const run = await db.awsDiscoveryRun.create({
    data: {
      tenantId: request.tenantId,
      cloudAccountId: request.cloudAccountId,
      trigger: request.trigger,
      status: 'pending',
      requestedAt: request.now,
      requestedBy: request.trigger === 'manual' ? (request.requestedBy ?? null) : null,
    },
    select: DISCOVERY_RUN_SELECT,
  });
  return { run, created: true };
}

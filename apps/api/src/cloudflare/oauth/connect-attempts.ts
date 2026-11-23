import { CLOUDFLARE_OAUTH_ATTEMPT_RETENTION_MS, CLOUDFLARE_OAUTH_OPEN_STATUSES } from '@verax/shared';
import { AuditService } from '../../common/audit/audit.service.js';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import { lockGrant } from '../../credentials/credential-rekey.js';

/** Tarefa do worker, de hora em hora (e na partida, como toda tarefa do agendador). */
export const CONNECT_ATTEMPTS_PURGE_TASK = 'cloudflare-oauth-purge';
export const CONNECT_ATTEMPTS_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Concessões soltas por execução; as demais ficam para a próxima. */
const ORPHAN_BATCH = 100;

const OPEN = [...CLOUDFLARE_OAUTH_OPEN_STATUSES];

/** Folga antes de soltar: uma concessão nova nunca é solta no meio da conexão. */
const ORPHAN_GRACE_MS = 60 * 60 * 1000;

/** Concessão solta: passou da folga, nenhuma conta a usa e nenhuma tentativa aberta ainda pode usá-la. */
const orphanAt = (now: Date) => ({
  status: { in: ['active', 'reconnect'] },
  createdAt: { lt: new Date(now.getTime() - ORPHAN_GRACE_MS) },
  cloudAccounts: { none: {} },
  attempts: { none: { status: { in: OPEN } } },
});

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface ConnectAttemptsPurgeReport {
  expired: number;
  purged: number;
  /** Concessões soltas marcadas para revogação no Cloudflare. */
  orphaned: number;
}

/**
 * As tentativas de conectar o Cloudflare por OAuth (`CloudflareConnectAttempt`), de todos os clientes do nó:
 *
 * 1. a aberta que passou do prazo vira `expired` e perde, na mesma escrita, o verificador e o código cifrados. Quem usa
 *    uma tentativa confere o prazo por conta própria: esta tarefa não é a defesa, é a faxina;
 * 2. a concessão que ficou solta (a escolha de conta abandonada, a última conta excluída) passa a `revoking`: a
 *    autorização não fica viva no Cloudflare sem ninguém usar. Revogar lá e apagar a linha é da tarefa que fala com ele;
 * 3. a terminada some 24 h depois de criada.
 *
 * Os passos 1 e 3 são uma escrita só, com a condição no próprio comando: uma tentativa concluída ao mesmo tempo não é
 * tocada. O passo 2 confere tudo de novo sob o lock da concessão. Quem liga uma conta a uma concessão pega o mesmo lock
 * e exige `active`; quem cria a concessão a amarra à tentativa aberta na mesma transação.
 */
export class ConnectAttemptsPurge {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService = new AuditService(),
  ) {}

  async runOnce(now: Date = new Date(), signal?: AbortSignal): Promise<ConnectAttemptsPurgeReport> {
    signal?.throwIfAborted();
    const expired = await this.prisma.cloudflareConnectAttempt.updateMany({
      where: { status: { in: OPEN }, expiresAt: { lte: now } },
      data: { status: 'expired', verifierCiphertext: null, codeCiphertext: null },
    });
    signal?.throwIfAborted();
    const orphaned = await this.releaseOrphans(now, signal);
    signal?.throwIfAborted();
    const purged = await this.prisma.cloudflareConnectAttempt.deleteMany({
      where: {
        status: { notIn: OPEN },
        createdAt: { lt: new Date(now.getTime() - CLOUDFLARE_OAUTH_ATTEMPT_RETENTION_MS) },
      },
    });
    return { expired: expired.count, purged: purged.count, orphaned };
  }

  private async releaseOrphans(now: Date, signal?: AbortSignal): Promise<number> {
    const orphan = orphanAt(now);
    // Busca de sistema, entre todos os clientes: só as chaves. A escrita é pelo escopo do cliente da linha.
    const candidates = await this.prisma.cloudflareGrant.findMany({
      where: orphan,
      select: { id: true, tenantId: true },
      orderBy: { id: 'asc' },
      take: ORPHAN_BATCH,
    });
    let released = 0;
    for (const { id, tenantId } of candidates) {
      signal?.throwIfAborted();
      released += await this.prisma.$transaction(async (tx) => {
        await lockGrant(tx, id);
        const { count } = await scopeToTenant(tx, tenantId).cloudflareGrant.updateMany({
          where: { id, ...orphan },
          data: { status: 'revoking', revokeRequestedAt: now },
        });
        if (count === 0) return 0;
        await this.audit.write(tx, {
          actor: { type: 'system', tenantId },
          action: 'cloudflare_grant.release',
          outcome: 'success',
          resourceType: 'cloudflare_grant',
          resourceId: id,
        });
        return count;
      });
    }
    return released;
  }
}

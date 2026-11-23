import { CLOUDFLARE_OAUTH_ATTEMPT_RETENTION_MS, CLOUDFLARE_OAUTH_OPEN_STATUSES } from '@verax/shared';
import type { PrismaService } from '../../common/prisma/prisma.service.js';

/** Tarefa do worker, de hora em hora (e na partida, como toda tarefa do agendador). */
export const CONNECT_ATTEMPTS_PURGE_TASK = 'cloudflare-oauth-purge';
export const CONNECT_ATTEMPTS_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface ConnectAttemptsPurgeReport {
  expired: number;
  purged: number;
}

/**
 * As tentativas de conectar o Cloudflare por OAuth (`CloudflareConnectAttempt`), de todos os clientes do nó:
 *
 * 1. a aberta que passou do prazo vira `expired` e perde, na mesma escrita, o verificador e o código cifrados. Quem usa
 *    uma tentativa confere o prazo por conta própria: esta tarefa não é a defesa, é a faxina;
 * 2. a terminada some 24 h depois de criada.
 *
 * Cada passo é uma escrita só, com a condição no próprio comando: uma tentativa concluída ao mesmo tempo não é tocada.
 * A concessão que a tentativa criou não é apagada aqui: revogá-la no Cloudflare é da tarefa que a usa.
 */
export class ConnectAttemptsPurge {
  constructor(private readonly prisma: PrismaService) {}

  async runOnce(now: Date = new Date(), signal?: AbortSignal): Promise<ConnectAttemptsPurgeReport> {
    signal?.throwIfAborted();
    const open = [...CLOUDFLARE_OAUTH_OPEN_STATUSES];
    const expired = await this.prisma.cloudflareConnectAttempt.updateMany({
      where: { status: { in: open }, expiresAt: { lte: now } },
      data: { status: 'expired', verifierCiphertext: null, codeCiphertext: null },
    });
    signal?.throwIfAborted();
    const purged = await this.prisma.cloudflareConnectAttempt.deleteMany({
      where: {
        status: { notIn: open },
        createdAt: { lt: new Date(now.getTime() - CLOUDFLARE_OAUTH_ATTEMPT_RETENTION_MS) },
      },
    });
    return { expired: expired.count, purged: purged.count };
  }
}

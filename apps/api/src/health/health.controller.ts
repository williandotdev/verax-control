import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AnyHost, Public } from '../auth/decorators.js';
import { PrismaService } from '../common/prisma/prisma.service.js';

/** Tempo máximo da consulta de prontidão, abaixo do timeout do health check do ALB. */
export const READINESS_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`sem resposta em ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Health check do ALB e do ECS. Fica fora do prefixo /v1, não exige sessão e, na célula, não pertence a cliente nenhum.
 *
 * - `/health` responde se o processo está vivo e não consulta dependências: se o banco cair, as tasks não
 *   entram em ciclo de reinício.
 * - `/health/ready` confere o banco. Se falhar, 503 no formato padrão de erro, sem detalhe; o detalhe vai
 *   só para o log.
 */
@Controller('health')
@Public()
// Na célula, o health check responde em qualquer endereço: o Docker chama pelo IP, sem o nome de um cliente.
@AnyHost()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(HealthController.name) private readonly logger: PinoLogger,
  ) {}

  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, READINESS_TIMEOUT_MS);
      return { status: 'ok' };
    } catch (error) {
      this.logger.warn({ err: error }, 'banco indisponível no health check');
      throw new ServiceUnavailableException();
    }
  }
}

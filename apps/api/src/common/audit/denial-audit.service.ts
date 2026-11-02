import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service.js';
import { requestEntry, WRITE_METHODS } from './audit-request.js';
import { type AuditEntry, AuditService } from './audit.service.js';

/**
 * Escritas recusadas pelos guards (permissão, CSRF, MFA) também entram na trilha de auditoria. O
 * `AuditInterceptor` não as vê: no Nest, um guard que recusa encerra a requisição antes dos interceptors.
 *
 * Só grava recusas de quem tem sessão: requisição anônima recusada fica no log, para que ninguém de fora
 * consiga encher a tabela de auditoria (que não aceita exclusão).
 */
@Injectable()
export class DenialAudit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @InjectPinoLogger(DenialAudit.name) private readonly logger: PinoLogger,
  ) {}

  async record(request: Request, statusCode: number): Promise<void> {
    if (!WRITE_METHODS.has(request.method) || request.auth === undefined) return;
    const entry: AuditEntry = { ...requestEntry(request), outcome: 'denied', statusCode };
    try {
      await this.auditService.write(this.prisma, entry);
    } catch (error) {
      // Sem banco não há onde gravar; o log (com redaction) guarda a tentativa para não perdê-la.
      this.logger.error({ err: error, audit: entry }, 'falha ao gravar auditoria');
    }
  }
}

import { Injectable } from '@nestjs/common';
import { type AuditDetails, requestContext } from '../context/request-context.js';

/**
 * Usado pelos services para descrever a operação em andamento: o recurso afetado e os estados anterior e
 * novo. O `AuditInterceptor` grava tudo no fim da requisição, na mesma transação.
 *
 * ```ts
 * const before = await this.prisma.db().tenant.findUniqueOrThrow({ where: { id } });
 * const after = await this.prisma.db().tenant.update({ where: { id }, data });
 * this.audit.describe({ action: 'tenant.update', resourceType: 'tenant', resourceId: id, before, after });
 * ```
 */
@Injectable()
export class AuditContext {
  describe(details: AuditDetails): void {
    const store = requestContext.getStore();
    if (!store?.audit) {
      throw new Error('AuditContext.describe chamado fora de uma requisição de escrita auditada');
    }
    Object.assign(store.audit, details);
  }

  /**
   * Registro adicional da mesma requisição, para a operação que cria mais de um recurso (o cliente novo e o primeiro
   * administrador dele). Entra na mesma transação do principal, com o mesmo ator, IP e request id; sem `tenantId`,
   * na trilha do principal (a do cliente cujos dados foram tocados), nunca só na do ator. Se a requisição falhar,
   * só a tentativa principal é registrada, porque nada disto foi gravado.
   */
  also(details: AuditDetails): void {
    const store = requestContext.getStore();
    if (!store?.audit || !store.additionalAudit) {
      throw new Error('AuditContext.also chamado fora de uma requisição de escrita auditada');
    }
    store.additionalAudit.push(details);
  }
}

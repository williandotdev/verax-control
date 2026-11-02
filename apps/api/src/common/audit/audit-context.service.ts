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
}

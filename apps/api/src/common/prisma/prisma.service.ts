import { HttpStatus, Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { requestContext } from '../context/request-context.js';
import { ApiError } from '../http/api-error.js';
import { scopeToTenant } from './tenant-scope.js';
import { type Prisma, PrismaClient } from '../../generated/prisma/client.js';

/**
 * Cliente Prisma único da aplicação, com o driver `pg`.
 *
 * Não conecta no boot: o pool abre conexões sob demanda, então a API sobe mesmo com o banco
 * indisponível e o estado real aparece em `/health/ready`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL }) });
  }

  /**
   * Cliente que os services devem usar. Dentro de uma requisição de escrita é a transação aberta pelo
   * `AuditInterceptor`, de modo que a alteração e o registro de auditoria são gravados juntos ou nada é
   * gravado. Fora dela (leituras, jobs) é o próprio cliente.
   *
   * É método, e não getter, de propósito: o PrismaClient do Prisma 7 é um Proxy, e getters de subclasse
   * rodam sobre o objeto interno, sem os models.
   */
  db(): Prisma.TransactionClient {
    return requestContext.getStore()?.tx ?? this;
  }

  /**
   * Cliente do banco restrito ao cliente da sessão (T2.5). É o caminho padrão para dado de cliente em
   * qualquer rota de usuário: o filtro é aplicado em toda leitura e escrita dos models protegidos, e o
   * `tenantId` nunca vem do corpo, da query ou da URL.
   */
  scoped(): Prisma.TransactionClient {
    const scopeTenantId = requestContext.getStore()?.auth?.scopeTenantId;
    if (!scopeTenantId) {
      throw new ApiError(HttpStatus.CONFLICT, 'Selecione um cliente para continuar', 'TENANT_REQUIRED');
    }
    return scopeToTenant(this.db(), scopeTenantId);
  }

  /** Escopo explícito de um cliente, para jobs sem sessão (sync, Prowler). Nunca com valor vindo do usuário. */
  forTenant(tenantId: string): Prisma.TransactionClient {
    return scopeToTenant(this.db(), tenantId);
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

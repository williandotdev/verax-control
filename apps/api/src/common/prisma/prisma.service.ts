import { HttpStatus, Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { requestContext } from '../context/request-context.js';
import { ApiError } from '../http/api-error.js';
import { scopeToTenant } from './tenant-scope.js';
import { type Prisma, PrismaClient } from '../../generated/prisma/client.js';

/**
 * Conexões do pool em cada processo (API e worker). É o padrão do `pg`, fixado aqui: o worker roda tarefas ao mesmo
 * tempo (agendador) e precisa de pelo menos 5. O Postgres do nó aceita 40 (`max_connections` em `infra/node/compose.yaml`).
 */
export const DATABASE_POOL_MAX = 10;

/**
 * Cliente Prisma único da aplicação, com o driver `pg`.
 *
 * Não conecta no boot: o pool abre conexões sob demanda, então a API sobe mesmo com o banco
 * indisponível e o estado real aparece em `/health/ready`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(@Inject(APP_CONFIG) config: Pick<AppConfig, 'DATABASE_URL'>) {
    super({ adapter: new PrismaPg({ connectionString: config.DATABASE_URL, max: DATABASE_POOL_MAX }) });
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
    const store = requestContext.getStore();
    const scopeTenantId = store?.auth?.scopeTenantId;
    if (!scopeTenantId) {
      throw new ApiError(HttpStatus.CONFLICT, 'Selecione um cliente para continuar', 'TENANT_REQUIRED');
    }
    // Numa escrita, o registro de auditoria entra na trilha do cliente cujos dados foram tocados.
    if (store.audit && store.audit.tenantId === undefined) store.audit.tenantId = scopeTenantId;
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

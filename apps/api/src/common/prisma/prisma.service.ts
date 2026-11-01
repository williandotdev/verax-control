import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { requestContext } from '../context/request-context.js';
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
   */
  get db(): Prisma.TransactionClient {
    return requestContext.getStore()?.tx ?? this;
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

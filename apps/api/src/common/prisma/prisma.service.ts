import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { PrismaClient } from '../../generated/prisma/client.js';

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

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

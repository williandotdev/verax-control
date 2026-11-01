import 'reflect-metadata';
import { z } from 'zod';
import { createAuth } from '../auth/auth.factory.js';
import { provisionUser } from '../auth/user-provisioning.js';
import { loadEnvFileForLocalDevelopment } from '../common/config/load-env-file.js';
import { loadConfig } from '../common/config/load-config.js';
import { AuditService } from '../common/audit/audit.service.js';
import { PrismaService } from '../common/prisma/prisma.service.js';

/** Clientes fictícios para desenvolvimento. Nenhum nome de cliente real entra no repositório. */
const DEMO_TENANTS = ['Cliente Demo Alfa', 'Cliente Demo Beta'] as const;

const seedEnvSchema = z.object({
  SEED_ADMIN_EMAIL: z.email(),
  SEED_ADMIN_PASSWORD: z.string().min(12),
});

/**
 * Dados iniciais de desenvolvimento: um `admin_verax` e dois clientes fictícios. Idempotente. Recusa
 * rodar em produção: lá o primeiro administrador é criado por procedimento manual documentado (E8).
 */
async function seed(): Promise<void> {
  loadEnvFileForLocalDevelopment();
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('O seed não roda em produção.');
  }
  const config = loadConfig();
  const env = seedEnvSchema.safeParse(process.env);
  if (!env.success) {
    throw new Error(
      'Defina SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD (mínimo 12 caracteres) no .env (pnpm setup:env).',
    );
  }

  const prisma = new PrismaService(config);
  try {
    const auditService = new AuditService();
    const auth = createAuth({
      config,
      prisma,
      logger: console,
      audit: (entry) => auditService.write(prisma, entry),
    });

    for (const name of DEMO_TENANTS) {
      const existing = await prisma.tenant.findFirst({ where: { name }, select: { id: true } });
      if (!existing) await prisma.tenant.create({ data: { name } });
    }

    const email = env.data.SEED_ADMIN_EMAIL.toLowerCase();
    if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
      console.log(`Admin ${email} já existe; nada alterado.`);
    } else {
      await provisionUser(auth, {
        email,
        name: 'Administrador Verax',
        role: 'admin_verax',
        tenantId: null,
        status: 'active',
        password: env.data.SEED_ADMIN_PASSWORD,
      });
      console.log(`Admin ${email} criado. A senha está em SEED_ADMIN_PASSWORD no seu .env.`);
    }
    console.log(`Clientes de demonstração: ${DEMO_TENANTS.join(', ')}.`);
  } finally {
    await prisma.$disconnect();
  }
}

seed().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha no seed');
  process.exitCode = 1;
});

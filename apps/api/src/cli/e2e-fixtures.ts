import 'reflect-metadata';
import { createAuth } from '../auth/auth.factory.js';
import { provisionUser } from '../auth/user-provisioning.js';
import { AuditService } from '../common/audit/audit.service.js';
import { loadConfig } from '../common/config/load-config.js';
import { PrismaService } from '../common/prisma/prisma.service.js';

/** Domínio dos usuários de e2e: tudo dele é apagado e recriado a cada execução. */
const E2E_DOMAIN = 'e2e.verax.local';
const TENANTS = { a: 'Cliente E2E A', b: 'Cliente E2E B' } as const;

/**
 * Dados dos testes de ponta a ponta do painel (Playwright contra a API real). Só roda com
 * `NODE_ENV=test` e banco cujo nome termina em `_test`; a senha vem de `E2E_PASSWORD`. Imprime só JSON
 * com e-mails e IDs, nunca a senha.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const databaseName = new URL(config.DATABASE_URL).pathname.slice(1);
  if (config.NODE_ENV !== 'test' || !databaseName.endsWith('_test')) {
    throw new Error('Os dados de e2e só são criados com NODE_ENV=test num banco "_test".');
  }
  const password = process.env['E2E_PASSWORD'] ?? '';
  if (password.length < 12) throw new Error('Defina E2E_PASSWORD (mínimo 12 caracteres).');

  const prisma = new PrismaService(config);
  try {
    const auditService = new AuditService();
    const auth = createAuth({
      config,
      prisma,
      logger: console,
      mail: { send: () => Promise.resolve() },
      audit: (entry) => auditService.write(prisma, entry),
    });

    await prisma.user.deleteMany({ where: { email: { endsWith: `@${E2E_DOMAIN}` } } });
    await prisma.loginAttempt.deleteMany({ where: { email: { endsWith: `@${E2E_DOMAIN}` } } });

    const tenantIds: Record<keyof typeof TENANTS, string> = { a: '', b: '' };
    for (const [key, name] of Object.entries(TENANTS) as [keyof typeof TENANTS, string][]) {
      const existing = await prisma.tenant.findFirst({ where: { name }, select: { id: true } });
      tenantIds[key] =
        existing?.id ?? (await prisma.tenant.create({ data: { name }, select: { id: true } })).id;
    }

    const users = {
      adminVerax: { role: 'admin_verax', tenantId: null },
      adminA: { role: 'admin_cliente', tenantId: tenantIds.a },
      leituraA: { role: 'leitura', tenantId: tenantIds.a },
      adminB: { role: 'admin_cliente', tenantId: tenantIds.b },
      lockout: { role: 'leitura', tenantId: tenantIds.a },
      reset: { role: 'leitura', tenantId: tenantIds.a },
    } as const;

    const created: Record<string, { email: string; id: string }> = {};
    for (const [key, user] of Object.entries(users)) {
      const email = `${key.toLowerCase()}@${E2E_DOMAIN}`;
      const { id } = await provisionUser(auth, {
        email,
        name: `E2E ${key}`,
        role: user.role,
        tenantId: user.tenantId,
        status: 'active',
        password,
      });
      created[key] = { email, id };
    }
    process.stdout.write(JSON.stringify({ tenants: tenantIds, users: created }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Falha ao criar os dados de e2e');
  process.exitCode = 1;
});

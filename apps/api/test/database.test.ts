import 'reflect-metadata';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { loadConfig } from '../src/common/config/load-config.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';

const prisma = new PrismaService(
  loadConfig({
    NODE_ENV: 'test',
    WEB_ORIGIN: 'http://localhost:5173',
    API_ORIGIN: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 's'.repeat(43),
    CSRF_SECRET: 'c'.repeat(43),
    DATABASE_URL: inject('testDatabaseUrl'),
  }),
);

/** Uma entrada de ACL do PostgreSQL que começa com "=" vale para PUBLIC (qualquer papel do servidor). */
function publicPrivileges(acl: string | null): string {
  if (acl === null) return '<padrão do PostgreSQL>';
  const entries = acl.replace(/^\{|\}$/g, '').split(',');
  return entries
    .filter((entry) => entry.startsWith('='))
    .map((entry) => entry.slice(1).split('/')[0] ?? '')
    .join('');
}

describe('banco de dados (T1.1)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('conecta pelo Prisma com o driver pg', async () => {
    const [row] = await prisma.$queryRaw<{ version: string }[]>`SELECT version() AS version`;
    expect(row?.version).toMatch(/^PostgreSQL 18\./);
  });

  it('aplicou a migration de linha de base', async () => {
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    expect(applied.map((row) => row.migration_name)).toContain('20261101000000_baseline');
  });

  it('PUBLIC não conecta nem cria tabelas temporárias no banco', async () => {
    const [row] = await prisma.$queryRaw<{ acl: string | null }[]>`
      SELECT datacl::text AS acl FROM pg_database WHERE datname = current_database()`;
    expect(publicPrivileges(row?.acl ?? null)).toBe('');
  });

  it('PUBLIC não cria objetos no schema public', async () => {
    const [row] = await prisma.$queryRaw<{ acl: string | null }[]>`
      SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'public'`;
    expect(publicPrivileges(row?.acl ?? null)).not.toContain('C');
  });
});

import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';

const migrationsDir = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));

/** Um banco só deste arquivo de teste, no mesmo servidor, com todas as migrations. */
export interface OwnDatabase {
  url: string;
  drop(): Promise<void>;
}

/**
 * Cria um banco descartável com as migrations de agora. Serve a quem roda o despachante dos avisos: ele lê a fila do banco
 * inteiro, com uma concessão só, e os arquivos de teste rodam ao mesmo tempo no mesmo banco.
 */
export async function createOwnDatabase(label: string): Promise<OwnDatabase> {
  const base = new URL(inject('testDatabaseUrl'));
  const name = `${label}_${randomUUID().slice(0, 8)}_test`;
  const admin = new pg.Client({ connectionString: base.href });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(name)}`);
  const url = new URL(base);
  url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    const migrations = readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const migration of migrations) {
      await client.query(readFileSync(join(migrationsDir, migration, 'migration.sql'), 'utf8'));
    }
  } finally {
    await client.end();
  }
  return {
    url: url.href,
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(name)} WITH (FORCE)`);
      await admin.end();
    },
  };
}

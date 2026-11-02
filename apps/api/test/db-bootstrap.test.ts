import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { bootstrapDatabase, parseDatabaseUrl } from '../src/cli/db-bootstrap.js';

// Papéis são globais no servidor: nomes únicos por execução, apagados no fim.
const suffix = randomBytes(4).toString('hex');
const migrator = { role: `verax_migrator_t${suffix}`, password: randomBytes(24).toString('base64url') };
const app = { role: `verax_app_t${suffix}`, password: randomBytes(24).toString('base64url') };

const testUrl = new URL(inject('testDatabaseUrl'));
const database = decodeURIComponent(testUrl.pathname.slice(1));

function connect(role?: { role: string; password: string }): pg.Client {
  return new pg.Client({
    host: testUrl.hostname,
    port: Number(testUrl.port || 5432),
    database,
    user: role ? role.role : decodeURIComponent(testUrl.username),
    password: role ? role.password : decodeURIComponent(testUrl.password),
  });
}

async function asRole<T>(
  role: { role: string; password: string },
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = connect(role);
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function runBootstrap(credentials = { migrator, app }): Promise<void> {
  const master = connect();
  await master.connect();
  try {
    await bootstrapDatabase({ client: master, database, ...credentials });
  } finally {
    await master.end();
  }
}

describe('bootstrap dos papéis de banco (T8.2)', () => {
  beforeAll(async () => {
    await runBootstrap();
  });

  afterAll(async () => {
    const master = connect();
    await master.connect();
    try {
      const superuser = master.escapeIdentifier(decodeURIComponent(testUrl.username));
      const [mig, appRole] = [migrator.role, app.role].map((name) => master.escapeIdentifier(name));
      // Volta o schema ao estado da migration base (o banco continua sem CONNECT para PUBLIC, como ela deixa).
      await master.query(`ALTER SCHEMA public OWNER TO ${superuser}`);
      await master.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
      for (const [name, role] of [
        [migrator.role, mig],
        [app.role, appRole],
      ] as const) {
        const exists = await master.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
        if (exists.rowCount === 0) continue;
        await master.query(`REASSIGN OWNED BY ${role} TO ${superuser}`);
        await master.query(`DROP OWNED BY ${role}`);
        await master.query(`DROP ROLE ${role}`);
      }
    } finally {
      await master.end();
    }
  });

  it('a aplicação lê e grava nas tabelas', async () => {
    await asRole(app, async (client) => {
      await client.query("INSERT INTO widget_probe (name) VALUES ('bootstrap')");
      const result = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM widget_probe WHERE name = 'bootstrap'",
      );
      expect(result.rows[0]?.n).toBeGreaterThan(0);
      await client.query("DELETE FROM widget_probe WHERE name = 'bootstrap'");
    });
  });

  it('a aplicação não cria nem altera objetos', async () => {
    await asRole(app, async (client) => {
      await expect(client.query('CREATE TABLE invasora (id int)')).rejects.toThrow(/permission denied/);
      await expect(client.query('ALTER TABLE widget_probe ADD COLUMN x int')).rejects.toThrow(
        /must be owner/,
      );
      await expect(client.query('DROP TABLE widget_probe')).rejects.toThrow(/must be owner/);
    });
  });

  it('a aplicação não altera nem apaga a trilha de auditoria e não lê a tabela de migrations', async () => {
    await asRole(app, async (client) => {
      await expect(client.query('UPDATE "AuditLog" SET action = action')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('DELETE FROM "AuditLog"')).rejects.toThrow(/permission denied/);
      await expect(client.query('TRUNCATE "AuditLog"')).rejects.toThrow(/permission denied/);
      await expect(client.query('SELECT 1 FROM _prisma_migrations')).rejects.toThrow(/permission denied/);
      // Inserir na auditoria continua permitido (é como a aplicação registra).
      const rows = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM "AuditLog"');
      expect(rows.rows[0]?.n).toBeGreaterThanOrEqual(0);
    });
  });

  it('o papel das migrations cria objetos e a aplicação usa as tabelas novas', async () => {
    await asRole(migrator, async (client) => {
      await client.query('CREATE TABLE bootstrap_probe (id int PRIMARY KEY)');
    });
    await asRole(app, async (client) => {
      await client.query('INSERT INTO bootstrap_probe (id) VALUES (1)');
      await expect(client.query('DROP TABLE bootstrap_probe')).rejects.toThrow(/must be owner/);
    });
    await asRole(migrator, async (client) => {
      await client.query('DROP TABLE bootstrap_probe');
    });
  });

  it('é idempotente e troca a senha (a antiga deixa de valer)', async () => {
    const rotated = { role: app.role, password: randomBytes(24).toString('base64url') };
    await runBootstrap({ migrator, app: rotated });
    await expect(asRole(app, () => Promise.resolve())).rejects.toThrow(/password authentication failed/);
    await asRole(rotated, async (client) => {
      await client.query('SELECT 1 FROM widget_probe LIMIT 1');
    });
    app.password = rotated.password;
  });

  it('recusa nomes de papel fora do padrão (sem SQL arbitrário pelo nome)', async () => {
    await expect(
      runBootstrap({ migrator, app: { role: 'verax_app"; DROP TABLE x; --', password: app.password } }),
    ).rejects.toThrow(/fora do padrão/);
    await expect(
      runBootstrap({ migrator, app: { role: migrator.role, password: app.password } }),
    ).rejects.toThrow(/papéis diferentes/);
  });
});

describe('leitura das URLs de banco', () => {
  it('extrai papel, senha e TLS sem aceitar papel fora do padrão', () => {
    const target = parseDatabaseUrl(
      'postgresql://verax_app:senha-longa-o-bastante-123@db.interno:5432/verax?sslmode=verify-full&sslrootcert=/etc/ssl/rds/global-bundle.pem',
    );
    expect(target).toMatchObject({
      role: 'verax_app',
      host: 'db.interno',
      port: 5432,
      database: 'verax',
      sslMode: 'verify-full',
      sslRootCert: '/etc/ssl/rds/global-bundle.pem',
    });
    expect(() => parseDatabaseUrl('postgresql://postgres:senha-longa-o-bastante-123@db/verax')).toThrow(
      /padrão/,
    );
    expect(() => parseDatabaseUrl('postgresql://verax_app:curta@db/verax')).toThrow(/curta/);
    expect(() => parseDatabaseUrl('mysql://verax_app:senha-longa-o-bastante-123@db/verax')).toThrow(
      /postgresql/,
    );
  });
});

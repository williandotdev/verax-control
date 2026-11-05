import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';
import { bootstrapDatabase, parseDatabaseUrl, RETENTION_FUNCTIONS } from '../src/cli/db-bootstrap.js';

// Papéis são globais no servidor: nomes únicos por execução, apagados no fim.
const suffix = randomBytes(4).toString('hex');
const migrator = { role: `verax_migrator_t${suffix}`, password: randomBytes(24).toString('base64url') };
const app = { role: `verax_app_t${suffix}`, password: randomBytes(24).toString('base64url') };

const testUrl = new URL(inject('testDatabaseUrl'));
const database = decodeURIComponent(testUrl.pathname.slice(1));

function connect(role?: { role: string; password: string }, target = database): pg.Client {
  return new pg.Client({
    host: testUrl.hostname,
    port: Number(testUrl.port || 5432),
    database: target,
    user: role ? role.role : decodeURIComponent(testUrl.username),
    password: role ? role.password : decodeURIComponent(testUrl.password),
  });
}

async function asRole<T>(
  role: { role: string; password: string } | undefined,
  work: (client: pg.Client) => Promise<T>,
  target = database,
): Promise<T> {
  const client = connect(role, target);
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

  it('a aplicação não altera nem apaga os comentários dos achados, nem com a flag do expurgo ligada (PR-19)', async () => {
    await asRole(app, async (client) => {
      await expect(client.query('UPDATE "FindingComment" SET body = body')).rejects.toThrow(
        /permission denied/,
      );
      await expect(client.query('DELETE FROM "FindingComment"')).rejects.toThrow(/permission denied/);
      await expect(client.query('TRUNCATE "FindingComment"')).rejects.toThrow(/permission denied/);
      // A flag é só uma das duas condições do trigger: sem DELETE na tabela, ligar a flag não abre nada.
      await client.query("SET verax.retention = 'on'");
      await expect(client.query('DELETE FROM "FindingComment"')).rejects.toThrow(/permission denied/);
      await expect(client.query('DELETE FROM "AuditLog"')).rejects.toThrow(/permission denied/);
      await expect(client.query('UPDATE "AuditLog" SET action = action')).rejects.toThrow(
        /permission denied/,
      );
      // Ler os comentários continua permitido.
      await client.query('SELECT count(*) FROM "FindingComment"');
    });
  });

  it('a aplicação executa as funções do expurgo, e a própria função recusa corte novo demais (PR-19)', async () => {
    await asRole(app, async (client) => {
      await expect(client.query('SELECT * FROM verax_purge_audit_log(now(), 10)')).rejects.toThrow(
        /piso de 13 meses/,
      );
      await expect(
        client.query("SELECT * FROM verax_purge_audit_log(now() - interval '12 months', 10)"),
      ).rejects.toThrow(/piso de 13 meses/);
      const empty = await client.query<{ deleted: number }>(
        "SELECT verax_purge_finding_comments('{}'::uuid[]) AS deleted",
      );
      expect(empty.rows[0]?.deleted).toBe(0);
    });
  });

  it('nenhum outro papel executa as funções do expurgo: PUBLIC não tem EXECUTE (PR-19)', async () => {
    // O papel das migrations deste teste não é dono das funções (no banco de teste, o dono é o superusuário) nem
    // recebeu o EXECUTE: só teria acesso por PUBLIC.
    await asRole(migrator, async (client) => {
      await expect(
        client.query("SELECT * FROM verax_purge_audit_log(now() - interval '14 months', 10)"),
      ).rejects.toThrow(/permission denied for function/);
      await expect(client.query("SELECT verax_purge_finding_comments('{}'::uuid[])")).rejects.toThrow(
        /permission denied for function/,
      );
    });
    await asRole(undefined, async (client) => {
      for (const signature of RETENTION_FUNCTIONS) {
        const grantees = await client.query<{ grantee: string }>(
          `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $1::regprocedure`,
          [signature],
        );
        const names = grantees.rows.map((row) => row.grantee);
        expect(names).toContain(app.role);
        expect(names).not.toContain('PUBLIC');
        expect(names).not.toContain(migrator.role);
      }
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

/**
 * A sequência do deploy (a mesma do nó, do ECS e do teste da imagem no CI): bootstrap, migrations pelo papel das
 * migrations e bootstrap de novo, num banco só deste teste. É aqui que as funções do expurgo nascem como em produção,
 * com o papel das migrations como dono (no banco de teste compartilhado, quem aplica as migrations é o superusuário).
 */
describe('sequência do deploy: expurgo pelas funções controladas (PR-19)', () => {
  const deploySuffix = randomBytes(4).toString('hex');
  const deployDb = `verax_deploy_t${deploySuffix}_test`;
  const owner = { role: `verax_migrator_d${deploySuffix}`, password: randomBytes(24).toString('base64url') };
  const runtime = { role: `verax_app_d${deploySuffix}`, password: randomBytes(24).toString('base64url') };
  const apiDir = fileURLToPath(new URL('..', import.meta.url));
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');

  const bootstrapDeployDb = () =>
    asRole(
      undefined,
      (client) => bootstrapDatabase({ client, database: deployDb, migrator: owner, app: runtime }),
      deployDb,
    );

  beforeAll(async () => {
    await asRole(undefined, (client) => client.query(`CREATE DATABASE ${client.escapeIdentifier(deployDb)}`));
    await bootstrapDeployDb();
    const url = new URL(testUrl);
    url.username = owner.role;
    url.password = owner.password;
    url.pathname = `/${deployDb}`;
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: url.toString(), CHECKPOINT_DISABLE: '1' },
      stdio: 'pipe',
    });
    await bootstrapDeployDb();
  }, 120_000);

  afterAll(async () => {
    await asRole(undefined, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${client.escapeIdentifier(deployDb)} WITH (FORCE)`);
      for (const role of [owner.role, runtime.role]) {
        const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
        if (exists.rowCount !== 0) await client.query(`DROP ROLE ${client.escapeIdentifier(role)}`);
      }
    });
  }, 60_000);

  it('as funções são do papel das migrations, SECURITY DEFINER, com search_path fixo e EXECUTE só para a aplicação', async () => {
    await asRole(
      undefined,
      async (client) => {
        const functions = await client.query<{
          name: string;
          owner: string;
          definer: boolean;
          config: string[] | null;
          grantees: string[];
        }>(
          `SELECT p.proname AS name, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer,
                  p.proconfig AS config,
                  ARRAY(SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
                        FROM aclexplode(p.proacl) a ORDER BY 1) AS grantees
           FROM pg_proc p WHERE p.oid = ANY($1::regprocedure[]) ORDER BY 1`,
          [RETENTION_FUNCTIONS],
        );
        expect(functions.rows).toEqual(
          ['verax_purge_audit_log', 'verax_purge_finding_comments'].map((name) => ({
            name,
            owner: owner.role,
            definer: true,
            config: ['search_path=pg_catalog, public, pg_temp', 'TimeZone=UTC'],
            grantees: [owner.role, runtime.role].sort(),
          })),
        );
        // O dono das funções é o dono das tabelas (é com ele que o DELETE roda), e os triggers seguem com ele.
        const tables = await client.query<{ owner: string }>(
          `SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class
           WHERE oid IN ('public."AuditLog"'::regclass, 'public."FindingComment"'::regclass)`,
        );
        expect(tables.rows).toEqual([{ owner: owner.role }]);
        const triggers = await client.query<{ owner: string; definer: boolean }>(
          `SELECT DISTINCT pg_get_userbyid(proowner) AS owner, prosecdef AS definer FROM pg_proc
           WHERE proname IN ('audit_log_reject_change', 'finding_comment_reject_change')`,
        );
        expect(triggers.rows).toEqual([{ owner: owner.role, definer: false }]);
      },
      deployDb,
    );
  });

  it('auditoria: a aplicação apaga o antigo só pela função; o recente, o DELETE direto, UPDATE e TRUNCATE são recusados', async () => {
    await asRole(
      runtime,
      async (client) => {
        const insert = async (age: string) =>
          (
            await client.query<{ id: string }>(
              `INSERT INTO "AuditLog" (id, "occurredAt", "actorType", action, outcome)
               VALUES (gen_random_uuid(), now() - $1::interval, 'system', 'teste.expurgo', 'success') RETURNING id`,
              [age],
            )
          ).rows[0]?.id;
        const old = await insert('14 months');
        const recent = await insert('12 months');
        await expect(client.query('SELECT * FROM verax_purge_audit_log(now(), 10)')).rejects.toThrow(
          /piso de 13 meses/,
        );
        await expect(client.query('DELETE FROM "AuditLog" WHERE id = $1', [old])).rejects.toThrow(
          /permission denied/,
        );
        await client.query("SET verax.retention = 'on'");
        await expect(client.query('DELETE FROM "AuditLog" WHERE id = $1', [old])).rejects.toThrow(
          /permission denied/,
        );
        await expect(client.query('UPDATE "AuditLog" SET action = action')).rejects.toThrow(
          /permission denied/,
        );
        await expect(client.query('TRUNCATE "AuditLog"')).rejects.toThrow(/permission denied/);
        await client.query('RESET verax.retention');

        const purged = await client.query<{ tenant_id: string | null; deleted: number }>(
          "SELECT * FROM verax_purge_audit_log(now() - interval '13 months', 1000)",
        );
        expect(purged.rows).toEqual([{ tenant_id: null, deleted: 1 }]);
        const left = await client.query<{ id: string }>(
          'SELECT id FROM "AuditLog" WHERE id = ANY($1::uuid[])',
          [[old, recent]],
        );
        expect(left.rows.map((row) => row.id)).toEqual([recent]);
      },
      deployDb,
    );
  });

  it('comentários: a aplicação apaga só pela função, e só de achado e comentário com mais de 30 dias', async () => {
    await asRole(
      runtime,
      async (client) => {
        const tenantId = (
          await client.query<{ id: string }>(
            `INSERT INTO "Tenant" (id, name, "updatedAt") VALUES (gen_random_uuid(), 'Cliente Demo A', now())
             RETURNING id`,
          )
        ).rows[0]?.id;
        const authorId = randomUUID();
        await client.query(
          `INSERT INTO "User" (id, name, email, role, "tenantId", status, "updatedAt")
           VALUES ($1, 'Analista', $2, 'analista_cliente', $3, 'active', now())`,
          [authorId, `analista-${authorId}@cliente.example`, tenantId],
        );
        const finding = async (age: string) =>
          (
            await client.query<{ id: string }>(
              `INSERT INTO "Finding" (id, "tenantId", "accountId", source, "sourceEventId", "logSource", "occurredAt",
                                      severity, "ruleId", "ruleLevel", title, "mitreTactics", "mitreTechniques",
                                      "updatedAt")
               VALUES (gen_random_uuid(), $1, '111111111111', 'wazuh', gen_random_uuid()::text, 'cloudtrail',
                       now() - $2::interval, 'high', '80255', 10, 'Achado de teste', '{}', '{}', now())
               RETURNING id`,
              [tenantId, age],
            )
          ).rows[0]?.id;
        const comment = async (findingId: string | undefined, age: string) =>
          (
            await client.query<{ id: string }>(
              `INSERT INTO "FindingComment" (id, "tenantId", "findingId", "authorId", body, "createdAt")
               VALUES (gen_random_uuid(), $1, $2, $3, 'registro', now() - $4::interval) RETURNING id`,
              [tenantId, findingId, authorId, age],
            )
          ).rows[0]?.id;
        const oldFinding = await finding('200 days');
        const recentFinding = await finding('10 days');
        const oldComment = await comment(oldFinding, '199 days');
        const recentComment = await comment(recentFinding, '9 days');

        await expect(
          client.query('DELETE FROM "FindingComment" WHERE id = $1', [oldComment]),
        ).rejects.toThrow(/permission denied/);
        await expect(
          client.query('SELECT verax_purge_finding_comments($1::uuid[])', [[recentFinding]]),
        ).rejects.toThrow(/piso de 30 dias/);
        const purged = await client.query<{ deleted: number }>(
          'SELECT verax_purge_finding_comments($1::uuid[]) AS deleted',
          [[oldFinding]],
        );
        expect(purged.rows[0]?.deleted).toBe(1);
        const left = await client.query<{ id: string }>(
          'SELECT id FROM "FindingComment" WHERE id = ANY($1::uuid[])',
          [[oldComment, recentComment]],
        );
        expect(left.rows.map((row) => row.id)).toEqual([recentComment]);
        // Sem o comentário, o achado antigo sai pela aplicação (Finding é tabela comum).
        await client.query('DELETE FROM "Finding" WHERE id = $1', [oldFinding]);
      },
      deployDb,
    );
  });

  it('nem o dono das tabelas apaga registro recente, altera ou trunca sem derrubar o trigger', async () => {
    await asRole(
      owner,
      async (client) => {
        await client.query(
          `INSERT INTO "AuditLog" (id, "occurredAt", "actorType", action, outcome)
           VALUES (gen_random_uuid(), now() - interval '1 day', 'system', 'teste.dono', 'success')`,
        );
        await expect(client.query(`DELETE FROM "AuditLog" WHERE action = 'teste.dono'`)).rejects.toThrow(
          'somente inserção: DELETE bloqueado',
        );
        await client.query("SET verax.retention = 'on'");
        await expect(client.query(`DELETE FROM "AuditLog" WHERE action = 'teste.dono'`)).rejects.toThrow(
          'somente inserção: DELETE bloqueado',
        );
        await expect(client.query(`UPDATE "AuditLog" SET action = 'adulterado'`)).rejects.toThrow(
          'somente inserção: UPDATE bloqueado',
        );
        await expect(client.query('TRUNCATE "AuditLog"')).rejects.toThrow(
          'somente inserção: TRUNCATE bloqueado',
        );
        await expect(client.query('TRUNCATE "FindingComment"')).rejects.toThrow(
          'somente inserção: TRUNCATE bloqueado',
        );
        await expect(client.query(`UPDATE "FindingComment" SET body = 'outro'`)).rejects.toThrow(
          'somente inserção: UPDATE bloqueado',
        );
      },
      deployDb,
    );
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

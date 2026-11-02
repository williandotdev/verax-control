/**
 * Papéis de banco da aplicação (T8.2 e T8.4), criados e mantidos a cada deploy por uma tarefa avulsa do ECS.
 *
 * A conta mestra do RDS (senha gerenciada pelo próprio RDS) só é usada aqui. Ela cria e mantém:
 * - o papel das migrations, dono do schema `public`, usado só pela tarefa de migrations;
 * - o papel da aplicação, só com SELECT, INSERT, UPDATE e DELETE nas tabelas: não cria nem altera objetos, não lê a
 *   tabela de migrations e não altera nem apaga a trilha de auditoria (barreira além do trigger de imutabilidade).
 *
 * As senhas vêm das URLs de conexão de cada papel, gravadas pelo Terraform no Secrets Manager. Idempotente: o deploy
 * roda antes das migrations (para o papel delas existir) e depois (para as permissões valerem nas tabelas novas).
 *
 * Ambiente: DB_MASTER_USERNAME e DB_MASTER_PASSWORD (do segredo do RDS), MIGRATOR_DATABASE_URL e DATABASE_URL.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const ROLE_NAME = /^verax_[a-z0-9_]{1,40}$/;

export interface RoleCredentials {
  role: string;
  password: string;
}

export interface ConnectionTarget extends RoleCredentials {
  host: string;
  port: number;
  database: string;
  sslMode: string | null;
  sslRootCert: string | null;
}

/** Lê papel, senha e destino de uma URL postgresql://. Nunca registra a URL. */
export function parseDatabaseUrl(url: string): ConnectionTarget {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('URL de banco precisa ser postgresql://');
  }
  const role = decodeURIComponent(parsed.username);
  if (!ROLE_NAME.test(role)) {
    throw new Error('papel de banco fora do padrão verax_*');
  }
  const password = decodeURIComponent(parsed.password);
  if (password.length < 24) {
    throw new Error(`a senha do papel ${role} é curta demais`);
  }
  return {
    role,
    password,
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    sslMode: parsed.searchParams.get('sslmode'),
    sslRootCert: parsed.searchParams.get('sslrootcert'),
  };
}

export interface BootstrapOptions {
  /** Conectado como a conta mestra. */
  client: pg.Client;
  database: string;
  migrator: RoleCredentials;
  app: RoleCredentials;
}

/** Cria ou atualiza os dois papéis e as permissões, numa transação. */
export async function bootstrapDatabase({
  client,
  database,
  migrator,
  app,
}: BootstrapOptions): Promise<void> {
  for (const { role } of [migrator, app]) {
    if (!ROLE_NAME.test(role)) {
      throw new Error('papel de banco fora do padrão verax_*');
    }
  }
  if (migrator.role === app.role) {
    throw new Error('migrations e aplicação precisam de papéis diferentes');
  }

  // Comandos de definição (CREATE/ALTER ROLE, GRANT) não aceitam parâmetros: nomes e senhas entram pelo escape do
  // próprio driver, e os nomes já passaram pelo padrão acima.
  const id = (name: string): string => client.escapeIdentifier(name);
  const literal = (value: string): string => client.escapeLiteral(value);
  const [db, mig, appRole] = [id(database), id(migrator.role), id(app.role)];

  const tableExists = async (name: string): Promise<boolean> => {
    const result = await client.query<{ found: string | null }>('SELECT to_regclass($1) AS found', [name]);
    return result.rows[0]?.found !== null && result.rows[0]?.found !== undefined;
  };

  await client.query('BEGIN');
  try {
    for (const { role, password } of [migrator, app]) {
      const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (existing.rowCount === 0) {
        await client.query(`CREATE ROLE ${id(role)}`);
      }
      await client.query(
        `ALTER ROLE ${id(role)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS ` +
          `PASSWORD ${literal(password)}`,
      );
    }

    // A conta mestra precisa agir como o dono das tabelas para conceder permissões nelas.
    await client.query(`GRANT ${mig} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`);

    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${mig}, ${appRole}`);

    await client.query(`ALTER SCHEMA public OWNER TO ${mig}`);
    await client.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await client.query(`GRANT USAGE ON SCHEMA public TO ${appRole}`);

    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${mig} IN SCHEMA public ` +
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
    );
    await client.query(
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${mig} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`,
    );
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${appRole}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${appRole}`);

    if (await tableExists('public._prisma_migrations')) {
      await client.query(`REVOKE ALL ON TABLE public._prisma_migrations FROM ${appRole}`);
    }
    if (await tableExists('public."AuditLog"')) {
      await client.query(`REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public."AuditLog" FROM ${appRole}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} não definida`);
  }
  return value;
}

export async function main(): Promise<void> {
  const migrator = parseDatabaseUrl(requireEnv('MIGRATOR_DATABASE_URL'));
  const app = parseDatabaseUrl(requireEnv('DATABASE_URL'));
  if (migrator.host !== app.host || migrator.database !== app.database) {
    throw new Error('as duas URLs precisam apontar para o mesmo banco');
  }
  if (migrator.sslMode !== 'verify-full' || !migrator.sslRootCert) {
    throw new Error('a conexão precisa de sslmode=verify-full e sslrootcert (TLS com certificado conferido)');
  }

  const client = new pg.Client({
    host: migrator.host,
    port: migrator.port,
    database: migrator.database,
    user: requireEnv('DB_MASTER_USERNAME'),
    password: requireEnv('DB_MASTER_PASSWORD'),
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho do bundle de CAs, vindo da URL
    ssl: { ca: readFileSync(migrator.sslRootCert, 'utf8'), rejectUnauthorized: true },
    application_name: 'verax-db-bootstrap',
  });
  await client.connect();
  try {
    await bootstrapDatabase({ client, database: migrator.database, migrator, app });
  } finally {
    await client.end();
  }
  console.log(`Papéis de banco prontos: ${migrator.role} (migrations) e ${app.role} (aplicação).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    // Só a mensagem: o erro do driver pode trazer detalhes da conexão.
    console.error(`ERRO: ${error instanceof Error ? error.message : 'falha desconhecida'}`);
    process.exit(1);
  });
}

import pg from 'pg';

const LOCK_KEY = 'test:control-plane-sync-row';

/**
 * A linha única de `ControlPlaneSync` (a sequência e a próxima chamada) é do banco inteiro, e os arquivos da tarefa
 * `control-plane-sync` (as fontes e os usuários) rodam em paralelo no mesmo banco de teste: cada teste zera a linha e
 * depende dela. Este lock de sessão do Postgres, numa conexão própria, deixa um teste por vez entre os arquivos (pegue
 * no `beforeEach`, antes de zerar a linha, e solte no `afterEach`).
 */
export class ControlPlaneSyncRowLock {
  private client: pg.Client | null = null;

  constructor(private readonly url: string) {}

  async acquire(): Promise<void> {
    const client = new pg.Client({ connectionString: this.url });
    await client.connect();
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_KEY]);
    this.client = client;
  }

  async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client === null) return;
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
    } finally {
      await client.end();
    }
  }
}

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPinoOptions } from '../../src/common/logger/logger.options.js';
import { alertsAfter, ALERTS_INDEX, type AlertSearch } from '../../src/indexer/alert-queries.js';
import { IndexerClient, IndexerError } from '../../src/indexer/indexer.client.js';
import { loadIndexerConfig } from '../../src/indexer/indexer.config.js';
import {
  indexerSecretsFor,
  type IndexerCredentials,
  type IndexerSecrets,
} from '../../src/indexer/indexer-secrets.js';
import { Scheduler } from '../../src/worker/scheduler.js';
import { LogCapture } from '../support/log-capture.js';

// "Indexer" HTTPS local com uma CA descartável: o teste exercita TLS, autenticação, timeout e rotação de senha
// sem depender de um OpenSearch de verdade (o Wazuh real é testado no infra/wazuh).
const dir = mkdtempSync(join(tmpdir(), 'verax-indexer-tls-'));
const OLD_PASSWORD = 'senha-antiga-do-indexer-0000000';
const NEW_PASSWORD = 'senha-nova-do-indexer-11111111111';

function openssl(...args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

interface Received {
  method: string;
  path: string;
  authorization: string;
  body: unknown;
}

let server: Server;
let port: number;
let received: Received[] = [];
let acceptedPassword = OLD_PASSWORD;
let delayMs = 0;
let failWith: number | null = null;
let partial: 'timeout' | 'shard' | null = null;

beforeAll(async () => {
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=CA de teste',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
  );
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    'server.key',
    '-out',
    'server.csr',
  );
  writeFileSync(join(dir, 'san.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1\n');
  openssl(
    'x509',
    '-req',
    '-in',
    'server.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    'san.ext',
    '-out',
    'server.pem',
  );
  openssl(
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=Outra CA',
    '-keyout',
    'other.key',
    '-out',
    'other.pem',
  );

  server = createServer(
    { key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.pem')) },
    (req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        const body = parseBody(raw);
        received.push({
          method: req.method ?? '',
          path: decodeURIComponent(req.url ?? ''),
          authorization: req.headers.authorization ?? '',
          body,
        });
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        setTimeout(() => {
          const expected = `Basic ${Buffer.from(`verax_api_read:${acceptedPassword}`).toString('base64')}`;
          if (req.headers.authorization !== expected) return respond(401, { error: 'unauthorized' });
          if (failWith !== null) return respond(failWith, { error: { type: 'interno' } });
          respond(200, {
            timed_out: partial === 'timeout',
            _shards: {
              total: 2,
              successful: partial === 'shard' ? 1 : 2,
              skipped: 0,
              failed: partial === 'shard' ? 1 : 0,
            },
            hits: {
              hits: [
                {
                  _index: 'wazuh-alerts-4.x-2026.11.02',
                  _id: 'abc',
                  _source: { id: '1793500000.1', rule: { level: 10 } },
                  sort: ['2026-11-02T01:00:00Z', '1793500000.1'],
                },
              ],
            },
          });
        }, delayMs);
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
  acceptedPassword = OLD_PASSWORD;
  delayMs = 0;
  failWith = null;
  partial = null;
});

function parseBody(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return 'corpo ilegível';
  }
}

/** Segredos falsos: a senha "antiga" até alguém pedir renovação. */
class RotatingSecrets implements IndexerSecrets {
  refreshes = 0;
  constructor(private readonly caFile: string) {}
  credentials(refresh = false): Promise<IndexerCredentials> {
    if (refresh) this.refreshes += 1;
    return Promise.resolve({
      username: 'verax_api_read',
      password: this.refreshes > 0 ? NEW_PASSWORD : OLD_PASSWORD,
    });
  }
  certificateAuthority(): Promise<string> {
    return Promise.resolve(readFileSync(join(dir, this.caFile), 'utf8'));
  }
}

function client(caFile = 'ca.pem', timeoutMs = '1000'): { indexer: IndexerClient; secrets: RotatingSecrets } {
  const secrets = new RotatingSecrets(caFile);
  const config = loadIndexerConfig({
    NODE_ENV: 'test',
    INDEXER_URL: `https://localhost:${port}`,
    INDEXER_TIMEOUT_MS: timeoutMs,
    INDEXER_USERNAME: 'n/a',
    INDEXER_PASSWORD: 'n/a',
    INDEXER_CA_FILE: 'n/a',
  });
  return { indexer: new IndexerClient(config, secrets), secrets };
}

describe('cliente do indexer (T5.1)', () => {
  it('busca os alertas com TLS validado pela CA do Wazuh e a credencial só leitura', async () => {
    const { indexer } = client();
    const search = alertsAfter({ cursor: null, since: '2026-11-01T00:00:00Z', size: 10 });
    const hits = await indexer.search(search);
    expect(hits).toEqual([
      {
        index: 'wazuh-alerts-4.x-2026.11.02',
        id: 'abc',
        sort: ['2026-11-02T01:00:00Z', '1793500000.1'],
        source: { id: '1793500000.1', rule: { level: 10 } },
      },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe('POST');
    expect(received[0]?.path).toBe(`/${ALERTS_INDEX}/_search?allow_partial_search_results=false`);
    expect(received[0]?.body).toEqual(search.body);
  });

  it('recusa um servidor cujo certificado não foi assinado pela CA do Wazuh', async () => {
    const { indexer } = client('other.pem');
    await expect(indexer.search(alertsAfter({ cursor: null }))).rejects.toThrow(/TLS/);
    expect(received).toHaveLength(0);
  });

  it('desiste no tempo limite', async () => {
    delayMs = 3000;
    const { indexer } = client('ca.pem', '1000');
    const started = Date.now();
    await expect(indexer.search(alertsAfter({ cursor: null }))).rejects.toThrow(IndexerError);
    expect(Date.now() - started).toBeLessThan(2900);
  });

  it('renova a credencial uma vez quando a senha foi rotacionada', async () => {
    acceptedPassword = NEW_PASSWORD;
    const { indexer, secrets } = client();
    await expect(indexer.search(alertsAfter({ cursor: null }))).resolves.toHaveLength(1);
    expect(secrets.refreshes).toBe(1);
    expect(received.map((request) => request.authorization.length > 0)).toEqual([true, true]);
  });

  it('erros não carregam a requisição nem a credencial', async () => {
    failWith = 500;
    const { indexer } = client();
    const error = await indexer.search(alertsAfter({ cursor: null })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IndexerError);
    expect((error as IndexerError).statusCode).toBe(500);
    const serialized =
      JSON.stringify(error) + String(error) + JSON.stringify(Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(OLD_PASSWORD);
    expect(serialized).not.toContain('Basic ');
    expect(error).not.toHaveProperty('meta');
  });

  it.each(['timeout', 'shard'] as const)(
    'resposta incompleta (%s) é recusada: o cursor não avança sobre alertas que faltaram',
    async (kind) => {
      partial = kind;
      const { indexer } = client();
      await expect(indexer.search(alertsAfter({ cursor: null }))).rejects.toThrow(/incompleta/);
    },
  );

  it('não envia nada fora do padrão de alertas nem com consulta interpretável', async () => {
    const { indexer } = client();
    const otherIndex = { index: 'wazuh-states-*', body: {} } as unknown as AlertSearch;
    await expect(indexer.search(otherIndex)).rejects.toThrow(/índice não permitido/);
    const textQuery = {
      index: ALERTS_INDEX,
      // eslint-disable-next-line no-restricted-syntax -- o teste confere que o cliente recusa query_string
      body: { query: { query_string: { query: '*' } } },
    } as AlertSearch;
    await expect(indexer.search(textQuery)).rejects.toThrow(/query_string/);
    expect(received).toHaveLength(0);
  });
});

describe('cliente do indexer no nó (fase 2, PR-W2)', () => {
  /** Como o worker e a API montam o cliente no nó: modo `node`, credencial do ambiente e CA do volume. */
  function nodeClient(password = OLD_PASSWORD, caFile = 'ca.pem'): IndexerClient {
    const config = loadIndexerConfig({
      NODE_ENV: 'production',
      INDEXER_URL: `https://localhost:${port}`,
      INDEXER_TIMEOUT_MS: '1000',
      INDEXER_AUTH: 'node',
      INDEXER_USERNAME: 'verax_api_read',
      INDEXER_PASSWORD: password,
      INDEXER_CA_FILE: join(dir, caFile),
    });
    return new IndexerClient(config, indexerSecretsFor(config));
  }

  it('lê os alertas com a credencial do ambiente e TLS validado pela CA do arquivo', async () => {
    await expect(nodeClient().search(alertsAfter({ cursor: null }))).resolves.toHaveLength(1);
    expect(received[0]?.authorization).toBe(
      `Basic ${Buffer.from(`verax_api_read:${OLD_PASSWORD}`).toString('base64')}`,
    );
  });

  it('recusa um indexer cujo certificado não foi assinado pela CA do volume', async () => {
    await expect(nodeClient(OLD_PASSWORD, 'other.pem').search(alertsAfter({ cursor: null }))).rejects.toThrow(
      /TLS/,
    );
    expect(received).toHaveLength(0);
  });

  it('senha recusada, erro do indexer e CA ausente vão para o log só pelo tipo, sem a credencial', async () => {
    const wrongPassword = 'senha-errada-do-indexer-2222222222';
    failWith = 500;
    const capture = new LogCapture();
    const logger = pino(buildPinoOptions({ LOG_LEVEL: 'debug' }), capture);
    const errors: unknown[] = [];
    // As três falhas pelo mesmo caminho do worker: cada uma é uma tarefa do agendador.
    const failing = (name: string, client: IndexerClient) => ({
      name,
      intervalMs: 60_000,
      budgetMs: 10_000,
      run: () =>
        client.search(alertsAfter({ cursor: null })).catch((error: unknown) => {
          errors.push(error);
          throw error;
        }),
    });
    const scheduler = new Scheduler(
      [
        failing('senha-recusada', nodeClient(wrongPassword)),
        failing('indexer-com-erro', nodeClient()),
        failing('sem-ca', nodeClient(OLD_PASSWORD, 'ainda-nao-existe.pem')),
      ],
      logger,
    );
    scheduler.start();
    await vi.waitFor(() => expect(errors).toHaveLength(3), { timeout: 5000 });
    await scheduler.stop();
    // O que um descuido registraria: o próprio erro, serializado pelo logger.
    for (const error of errors) logger.error({ err: error }, 'falha no indexer');

    const failures = capture.entries().filter((entry) => entry['msg'] === 'tarefa falhou');
    expect(failures.map((entry) => entry['error'])).toEqual(['IndexerError', 'IndexerError', 'IndexerError']);
    for (const secret of [
      OLD_PASSWORD,
      wrongPassword,
      Buffer.from(`verax_api_read:${OLD_PASSWORD}`).toString('base64'),
      Buffer.from(`verax_api_read:${wrongPassword}`).toString('base64'),
      'Basic ',
    ]) {
      expect(capture.text).not.toContain(secret);
    }
    // A senha errada foi enviada e recusada duas vezes (com a renovação): o teste passou pelo indexer de verdade.
    expect(received.filter((request) => request.authorization.length > 0).length).toBeGreaterThanOrEqual(3);
  });
});

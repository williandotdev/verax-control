import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sanitize } from '../../src/common/logger/sanitize.js';
import {
  ANALYSISD_STATS_PATH,
  WAZUH_STATS_ACCOUNT,
  WazuhApiError,
  WazuhStatsClient,
} from '../../src/usage/wazuh-stats.js';

// A API do manager falsa, em HTTPS local com uma CA descartável gerada aqui (nenhuma chave privada no repositório): o
// teste exercita o TLS conferido com a CA e o nome, o login do verax_stats, o token e os limites. O manager de verdade é
// testado no infra/wazuh (scripts/test-api-users.sh).
const dir = mkdtempSync(join(tmpdir(), 'verax-wazuh-api-tls-'));
const STATS_PHRASE = 'senha-de-teste-do-medidor-1';
// O token de teste é montado aqui (um JWT de mentira, sem assinatura de verdade), como a API do manager o devolveria.
const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const TOKEN = [jwtPart({ alg: 'HS256' }), jwtPart({ sub: 'verax_stats' }), 'assinatura-de-teste'].join('.');
const sample = readFileSync(
  fileURLToPath(new URL('../fixtures/wazuh-analysisd-stats.json', import.meta.url)),
  'utf8',
);

function openssl(...args: string[]): void {
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
}

/** Um par emitido pela CA de teste para o nome dado (SAN). */
function issue(name: string, san: string): void {
  openssl(
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    `/CN=${name}`,
    '-keyout',
    `${name}.key`,
    '-out',
    `${name}.csr`,
  );
  writeFileSync(join(dir, `${name}.ext`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);
  openssl(
    'x509',
    '-req',
    '-in',
    `${name}.csr`,
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '1',
    '-extfile',
    `${name}.ext`,
    '-out',
    `${name}.pem`,
  );
}

interface Seen {
  method: string;
  path: string;
  authorization: string;
  body: string;
}

let seen: Seen[] = [];
let loginStatus = 200;
let loginBody = TOKEN;
let statsStatus = 200;
let statsBody = sample;
let delayMs = 0;
const servers: Server[] = [];
let port: number;
let otherNamePort: number;

function serve(name: string): Promise<number> {
  const server = createServer(
    { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`)) },
    (req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          path: req.url ?? '',
          authorization: req.headers.authorization ?? '',
          body,
        });
        setTimeout(() => {
          if (req.url === '/security/user/authenticate?raw=true') {
            res.writeHead(loginStatus, { 'content-type': 'text/plain' });
            res.end(loginBody);
            return;
          }
          res.writeHead(statsStatus, { 'content-type': 'application/json' });
          res.end(statsBody);
        }, delayMs);
      });
    },
  );
  servers.push(server);
  return new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

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
    '/CN=CA de teste do nó',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
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
    'other-ca.key',
    '-out',
    'other-ca.pem',
  );
  issue('localhost', 'DNS:localhost');
  issue('outro-nome', 'DNS:outro-nome.exemplo.internal');
  port = await serve('localhost');
  otherNamePort = await serve('outro-nome');
});

afterAll(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  loginStatus = 200;
  loginBody = TOKEN;
  statsStatus = 200;
  statsBody = sample;
  delayMs = 0;
});

function client(options: { ca?: string; targetPort?: number; timeoutMs?: number } = {}): WazuhStatsClient {
  return new WazuhStatsClient({
    url: `https://localhost:${options.targetPort ?? port}`,
    caFile: join(dir, options.ca ?? 'ca.pem'),
    password: STATS_PHRASE,
    timeoutMs: options.timeoutMs ?? 2_000,
  });
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'ok';
  } catch (error) {
    expect(error).toBeInstanceOf(WazuhApiError);
    // Só o tipo: nada da resposta, da senha nem do token.
    const message = (error as Error).message;
    expect(message).not.toContain(STATS_PHRASE);
    expect(message).not.toContain(TOKEN);
    return (error as WazuhApiError).kind;
  }
}

describe('API do manager do Wazuh com a CA do nó (PR-V6)', () => {
  it('entra como verax_stats, lê os contadores do analysisd com o token e devolve só o que a tarefa usa', async () => {
    const counters = await client().read(new AbortController().signal);
    expect(counters).toEqual({
      startedAt: new Date('2026-11-05T07:18:18.000Z'),
      bytesReceived: 978_815,
      awsEvents: 3,
    });
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/security/user/authenticate?raw=true',
        authorization: `Basic ${Buffer.from(`${WAZUH_STATS_ACCOUNT}:${STATS_PHRASE}`).toString('base64')}`,
        body: '',
      },
      { method: 'GET', path: ANALYSISD_STATS_PATH, authorization: `Bearer ${TOKEN}`, body: '' },
    ]);
  });

  it('o TLS confere a CA: com a CA de outro, nada sai (nem o login)', async () => {
    expect(await kindOf(client({ ca: 'other-ca.pem' }).read(new AbortController().signal))).toBe(
      'connection',
    );
    expect(seen).toEqual([]);
  });

  it('o TLS confere o nome: um certificado da mesma CA para outro nome é recusado', async () => {
    expect(await kindOf(client({ targetPort: otherNamePort }).read(new AbortController().signal))).toBe(
      'connection',
    );
    expect(seen).toEqual([]);
  });

  it('sem o arquivo da CA, nada sai', async () => {
    expect(await kindOf(client({ ca: 'nao-existe.pem' }).read(new AbortController().signal))).toBe('ca');
    expect(seen).toEqual([]);
  });

  it('só https', () => {
    expect(
      () =>
        new WazuhStatsClient({ url: `http://localhost:${port}`, caFile: 'ca.pem', password: STATS_PHRASE }),
    ).toThrow('só por https');
  });

  it('login recusado, token fora do formato, contadores recusados ou com erro: cada um pelo tipo', async () => {
    loginStatus = 401;
    expect(await kindOf(client().read(new AbortController().signal))).toBe('auth');
    expect(seen).toHaveLength(1);
    loginStatus = 500;
    expect(await kindOf(client().read(new AbortController().signal))).toBe('status');
    loginStatus = 200;
    loginBody = 'não é um token\n"Authorization": x';
    expect(await kindOf(client().read(new AbortController().signal))).toBe('format');
    loginBody = TOKEN;
    statsStatus = 403;
    expect(await kindOf(client().read(new AbortController().signal))).toBe('auth');
    statsStatus = 500;
    expect(await kindOf(client().read(new AbortController().signal))).toBe('status');
    statsStatus = 200;
    statsBody = '{"data": ';
    expect(await kindOf(client().read(new AbortController().signal))).toBe('format');
    statsBody = JSON.stringify({ error: 0, data: { affected_items: [] } });
    expect(await kindOf(client().read(new AbortController().signal))).toBe('format');
  });

  it('resposta grande demais é cortada e recusada', async () => {
    statsBody = `{"pad":"${'x'.repeat(300 * 1024)}"}`;
    expect(await kindOf(client().read(new AbortController().signal))).toBe('format');
  });

  it('o manager lento estoura o prazo', async () => {
    delayMs = 500;
    expect(await kindOf(client({ timeoutMs: 100 }).read(new AbortController().signal))).toBe('timeout');
  });

  it('a parada do worker cancela a leitura com o motivo do sinal', async () => {
    delayMs = 500;
    const controller = new AbortController();
    const reading = client().read(controller.signal);
    setTimeout(() => controller.abort(new DOMException('parada', 'AbortError')), 50);
    await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('a senha e o cabeçalho com ela viram segredos vivos do logger', () => {
    client();
    const basic = `Basic ${Buffer.from(`${WAZUH_STATS_ACCOUNT}:${STATS_PHRASE}`).toString('base64')}`;
    const line = JSON.stringify(sanitize({ msg: `falhou com ${STATS_PHRASE} e ${basic}`, token: TOKEN }));
    expect(line).not.toContain(STATS_PHRASE);
    expect(line).not.toContain(basic);
    expect(line).not.toContain(TOKEN);
  });
});

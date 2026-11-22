import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NodeSyncRequest, NodeSyncResponse } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_NODE_SYNC_AUDIENCE } from '../src/common/config/env.schema.js';
import { newEnrollmentSecret } from '../src/enrollment/enrollment.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import type { NodeSyncCredential } from '../src/node-sync/node-identity.js';
import {
  type NodeSyncFailureCode,
  type NodeSyncGateway,
  NodeSyncGatewayError,
} from '../src/node-sync/node-sync-gateway.js';
import { NODE_SYNC_PER_IP } from '../src/node-sync/node-sync.controller.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { fakeEnvelope, nodeSyncRequest, sourceId, sourceReport } from './support/node-sync-fixtures.js';

const START = new Date('2026-11-20T12:00:00.000Z');
const SITE = 'https://veraxsistemas.com.br';
const SA = 'vx-cliente-demo-a@projeto-dos-nos-demo.iam.gserviceaccount.com';
const SUB = '100000000000000000001';

/** O cp-worker de mentira: grava o que chegou e responde o que o teste mandar. */
class FakeNodeSyncGateway implements NodeSyncGateway {
  calls: { credential: NodeSyncCredential; request: NodeSyncRequest }[] = [];
  failure: NodeSyncFailureCode | 'crash' | undefined;
  retryAfter: number | undefined;
  response: NodeSyncResponse = { protocol: 1, generation: 0, pollAfterSeconds: 300, sources: [], users: [] };

  syncManaged(token: string, request: NodeSyncRequest): Promise<NodeSyncResponse> {
    return this.answer({ kind: 'gcp_identity', token }, request);
  }

  syncCustomer(nodeKey: string, request: NodeSyncRequest): Promise<NodeSyncResponse> {
    return this.answer({ kind: 'node_key', nodeKey }, request);
  }

  /** Grava qual método (e com que credencial) o cp-public chamou e responde o que o teste mandou. */
  private answer(credential: NodeSyncCredential, request: NodeSyncRequest): Promise<NodeSyncResponse> {
    this.calls.push({ credential, request });
    if (this.failure === 'crash') return Promise.reject(new Error('rede'));
    if (this.failure !== undefined) {
      return Promise.reject(new NodeSyncGatewayError(this.failure, this.retryAfter));
    }
    return Promise.resolve(this.response);
  }
}

/**
 * A sincronização do nó pelo cp-public (`POST /v1/node-sync`): o que ele confere antes de acordar o cp-worker (o limite
 * por IP, o JSON, o formato da credencial e a olhada barata no token, o corpo estrito), o limite de 256 KB só nesta
 * rota, os códigos do cp-worker que o nó vê, a falta de CORS, o `no-store` e a máscara da credencial no log. O cp-worker
 * é um dublê; o caminho inteiro está em `node-sync-worker.test.ts`.
 */
describe('cp-public: sincronização do nó', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const google = new TestGoogleIdentity();
  const gateway = new FakeNodeSyncGateway();
  let app: NestExpressApplication;
  let sequence = 0;
  let ip = '';

  beforeAll(async () => {
    app = await createApp({
      role: 'public',
      clock,
      documentStore: new MemoryDocumentStore(),
      nodeSyncGateway: gateway,
      capture,
      trustProxyHops: 1,
      env: { LOG_LEVEL: 'debug', SITE_ORIGINS: SITE },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clock.set(START);
    gateway.calls = [];
    gateway.failure = undefined;
    gateway.retryAfter = undefined;
    sequence += 1;
    // Um IP de documentação por teste: o limite por IP não vaza de um teste para outro.
    ip = `203.0.113.${sequence}`;
  });

  /** O token do nó: só o formato e as declarações importam aqui (a assinatura é do cp-worker). */
  function nodeToken(payload: Record<string, unknown> = {}): string {
    const exp = Math.floor(START.getTime() / 1000) + 3600;
    return google.token({
      email: SA,
      aud: DEFAULT_NODE_SYNC_AUDIENCE,
      payload: { sub: SUB, iat: exp - 3600, exp, ...payload },
    });
  }

  function body(overrides: Partial<Parameters<typeof nodeSyncRequest>[0]> = {}): NodeSyncRequest {
    return nodeSyncRequest({ sequence: 1, sentAt: clock.now(), ...overrides });
  }

  function sync(authorization: string | undefined, payload: unknown): request.Test {
    const call = request(app.getHttpServer())
      .post('/v1/node-sync')
      .set('X-Forwarded-For', ip)
      .set('Origin', SITE);
    return (authorization === undefined ? call : call.set('Authorization', authorization)).send(
      payload as object,
    );
  }

  it('o token do nó vai ao cp-worker com o corpo conferido; a resposta sai sem cache, sem CORS e o token fora do log', async () => {
    const token = nodeToken();
    gateway.response = { protocol: 1, generation: 4, pollAfterSeconds: 300, sources: [] };
    const sent = body();
    const response = await sync(`Bearer ${token}`, sent);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(gateway.response);
    expect(response.headers['cache-control']).toBe('private, no-store');
    // Chamado por máquina: nem a origem do site recebe cabeçalho de CORS.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(gateway.calls).toEqual([{ credential: { kind: 'gcp_identity', token }, request: sent }]);
    expect(capture.text).not.toContain(token);
    // O preflight também não abre CORS.
    const preflight = await request(app.getHttpServer())
      .options('/v1/node-sync')
      .set('Origin', SITE)
      .set('Access-Control-Request-Method', 'POST');
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a chave do nó da VM do cliente vai ao cp-worker como node_key', async () => {
    const nodeKey = newEnrollmentSecret();
    const response = await sync(`Bearer ${nodeKey}`, body({ platform: 'vm' }));
    expect(response.status).toBe(200);
    expect(gateway.calls[0]?.credential).toEqual({ kind: 'node_key', nodeKey });
    expect(capture.text).not.toContain(nodeKey);
  });

  it('401 sem acordar o cp-worker: sem credencial, fora do formato, sem assinatura, outro aud, vencido ou outro sub', async () => {
    const [header, payload] = nodeToken().split('.');
    for (const authorization of [
      undefined,
      'Bearer curta',
      `Basic ${newEnrollmentSecret()}`,
      `Bearer ${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`,
      `Bearer ${header}.${payload}`,
      `Bearer ${nodeToken({ aud: 'https://conta.veraxsistemas.com.br/v1/node-enrollment/report' })}`,
      `Bearer ${nodeToken({ exp: Math.floor(START.getTime() / 1000) - 1 })}`,
      `Bearer ${nodeToken({ sub: 'cp-public' })}`,
    ]) {
      const response = await sync(authorization, body());
      expect(response.status, authorization).toBe(401);
      expect(response.body).toMatchObject({ message: 'Não autenticado', code: 'unauthenticated' });
    }
    expect(gateway.calls).toEqual([]);
  });

  it('corpo estrito (400) e só JSON (415), sem acordar o cp-worker', async () => {
    const auth = `Bearer ${nodeToken()}`;
    const valid = body();
    for (const payload of [
      { ...valid, extra: true },
      { ...valid, protocol: 2 },
      { ...valid, sequence: 0 },
      { ...valid, node: { ...valid.node, mode: 'cell' } },
      { ...valid, capabilities: ['log_sources', 'log_sources'] },
      { ...valid, sources: [sourceReport('NAO-E-UUID', 1)] },
      { ...valid, node: undefined },
    ]) {
      expect((await sync(auth, payload)).status).toBe(400);
    }
    const form = await request(app.getHttpServer())
      .post('/v1/node-sync')
      .set('X-Forwarded-For', ip)
      .set('Authorization', auth)
      .type('form')
      .send('protocol=1');
    expect(form.status).toBe(415);
    expect(gateway.calls).toEqual([]);
  });

  it('256 KB só nesta rota: um relato grande passa, acima do teto é 413; as outras rotas seguem com 16 KB', async () => {
    const auth = `Bearer ${nodeToken()}`;
    // ~100 KB de relato (500 fontes): acima dos 16 KB das outras rotas, dentro dos 256 KB desta.
    const sources = Array.from({ length: 500 }, () => sourceReport(sourceId(), 1));
    const large = body({ sources });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(64 * 1024);
    expect((await sync(auth, large)).status).toBe(200);
    expect(gateway.calls[0]?.request.sources).toHaveLength(500);
    const tooLarge = await sync(auth, { ...body(), padding: fakeEnvelope(200 * 1024) });
    expect(tooLarge.status).toBe(413);
    expect(tooLarge.body).toMatchObject({ statusCode: 413, message: 'Requisição muito grande' });
    expect(gateway.calls).toHaveLength(1);
    // O mesmo corpo grande em outra rota de JSON do cp-public: 413 pelos 16 KB de sempre.
    const elsewhere = await request(app.getHttpServer())
      .post('/v1/node-enrollment/report')
      .set('X-Forwarded-For', ip)
      .set('Authorization', `Bearer ${newEnrollmentSecret()}`)
      .send(large);
    expect(elsewhere.status).toBe(413);
  });

  it('os códigos do cp-worker que o nó vê, com mensagem genérica; 429 repete o Retry-After', async () => {
    const auth = `Bearer ${nodeToken()}`;
    const expected: [NodeSyncFailureCode | 'crash', number, string][] = [
      ['invalid_request', 400, 'invalid_request'],
      ['clock_skew', 400, 'clock_skew'],
      ['unauthenticated', 401, 'unauthenticated'],
      ['not_found', 404, 'not_found'],
      ['stale_sequence', 409, 'stale_sequence'],
      ['unavailable', 503, 'node_sync_unavailable'],
      ['crash', 503, 'node_sync_unavailable'],
    ];
    for (const [failure, status, code] of expected) {
      gateway.failure = failure;
      const response = await sync(auth, body());
      expect(response.status, failure).toBe(status);
      expect(response.body).toMatchObject({ code });
    }
    gateway.failure = 'too_soon';
    gateway.retryAfter = 13;
    const limited = await sync(auth, body());
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    expect(limited.headers['retry-after']).toBe('13');
    expect(capture.text).not.toContain(auth.slice(7));
  });

  it('limite por IP (429 com Retry-After), antes de tudo; outro IP segue', async () => {
    for (let index = 0; index < NODE_SYNC_PER_IP.capacity; index += 1) {
      expect((await sync(undefined, body())).status).toBe(401);
    }
    const limited = await sync(`Bearer ${nodeToken()}`, body());
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(gateway.calls).toEqual([]);
    ip = '198.51.100.7';
    expect((await sync(`Bearer ${nodeToken()}`, body())).status).toBe(200);
  });
});

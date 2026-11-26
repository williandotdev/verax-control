import type { NestExpressApplication } from '@nestjs/platform-express';
import { CLOUDFLARE_OAUTH_ISSUER } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../src/audit/audit.service.js';
import { CLOUDFLARE_CALLBACK_PER_IP } from '../src/cloudflare-oauth/cloudflare-callback.controller.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { TenantStore } from '../src/tenants/tenant-store.js';
import { tenantIn } from './support/access-store-contract.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';
import { demoTenant } from './support/tenant-store-contract.js';

const START = new Date('2026-11-20T12:00:00.000Z');
const SITE = 'https://veraxsistemas.com.br';
const PATH = '/v1/public/cloudflare/callback';
/** Valores marcados: nenhum pedaço deles pode aparecer em log ou em resposta de recusa. */
const CODE = 'CODIGOMARCADO-abc.123~+/=';
const NONCE = 'NONCEMARCADO'.padEnd(43, 'x');
const RELEASED = ['liberado-a', 'liberado-vm', 'liberado-fim', 'liberado-susp', 'liberado-livre'];

function stateOf(slug: string): string {
  return `${slug}.${NONCE}`;
}

/**
 * O retorno do Cloudflare pelo cp-public, com a conexão por OAuth ligada para uma lista de clientes, sobre o Firestore em
 * memória: o destino (sempre o painel gravado do cliente), a recusa única, o limite por IP e o que fica no log.
 */
describe('cp-public: retorno do Cloudflare (OAuth ligado)', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  const tenants = new TenantStore(documents, clock, new AuditService(documents, clock));
  let app: NestExpressApplication;
  let ips = 0;
  let ip = '';

  beforeAll(async () => {
    await tenantIn(tenants, 'liberado-a', 'active');
    await tenantIn(tenants, 'fora-da-lista', 'active');
    await tenantIn(tenants, 'liberado-fim', 'canceled');
    await tenantIn(tenants, 'liberado-susp', 'pending');
    const seed = demoTenant('liberado-vm');
    await tenants.create(
      {
        ...seed,
        consent: undefined,
        stripe: undefined,
        billing: { mode: 'contract' },
        hosting: 'customer',
        configuration: { ...seed.configuration, mode: 'self_hosted' },
      },
      { reason: 'teste', audit: { actor: 'system' }, initialState: 'waiting_customer_install' },
    );
    app = await createApp({
      role: 'public',
      clock,
      documentStore: documents,
      capture,
      trustProxyHops: 1,
      env: {
        LOG_LEVEL: 'trace',
        SITE_ORIGINS: SITE,
        CLOUDFLARE_OAUTH_CLIENT_ID: 'appdetestedemo01',
        CLOUDFLARE_OAUTH_SCOPES: 'zone.read,offline_access',
        CLOUDFLARE_OAUTH_TENANT_SLUGS: RELEASED.join(','),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    clock.set(START);
    ips += 1;
    ip = `203.0.113.${ips}`;
    vi.restoreAllMocks();
  });

  function get(query: string): request.Test {
    return request(app.getHttpServer()).get(`${PATH}?${query}`).set('X-Forwarded-For', ip).redirects(0);
  }

  function query(values: Record<string, string>): string {
    return new URLSearchParams(values).toString();
  }

  const good = query({ code: CODE, state: stateOf('liberado-a'), iss: CLOUDFLARE_OAUTH_ISSUER });

  it('devolve o navegador ao painel do cliente, com o código só no fragmento', async () => {
    const response = await get(good).set('Origin', SITE);
    expect(response.status).toBe(303);
    const target = new URL(response.headers['location'] ?? '');
    expect(target.origin).toBe('https://liberado-a.control.veraxsistemas.com.br');
    expect(target.pathname).toBe('/conexao-cloudflare');
    expect(target.search).toBe('');
    expect([...new URLSearchParams(target.hash.slice(1))]).toEqual([
      ['code', CODE],
      ['state', stateOf('liberado-a')],
      ['iss', CLOUDFLARE_OAUTH_ISSUER],
    ]);
    expect(response.text ?? '').toBe('');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('o erro do Cloudflare volta ao painel pela lista fechada', async () => {
    const response = await get(
      query({ error: 'access_denied', error_description: 'segredo-do-texto', state: stateOf('liberado-a') }),
    );
    expect(response.status).toBe(303);
    const hash = new URL(response.headers['location'] ?? '').hash;
    expect(Object.fromEntries(new URLSearchParams(hash.slice(1)))).toEqual({
      error: 'access_denied',
      state: stateOf('liberado-a'),
    });
    expect(hash).not.toContain('segredo-do-texto');
  });

  it('o endereço do pedido não entra no destino (Host e X-Forwarded-Host hostis)', async () => {
    const response = await get(good).set('Host', 'evil.example').set('X-Forwarded-Host', 'evil.example');
    expect(new URL(response.headers['location'] ?? '').host).toBe('liberado-a.control.veraxsistemas.com.br');
  });

  it('toda recusa é a mesma resposta, e nenhuma redireciona', async () => {
    const cases: Record<string, string> = {
      inexistente: query({ code: CODE, state: stateOf('liberado-livre') }),
      'fora da lista': query({ code: CODE, state: stateOf('fora-da-lista') }),
      'VM do cliente': query({ code: CODE, state: stateOf('liberado-vm') }),
      cancelado: query({ code: CODE, state: stateOf('liberado-fim') }),
      pendente: query({ code: CODE, state: stateOf('liberado-susp') }),
      'slug com ponto': query({ code: CODE, state: stateOf('liberado-a.evil') }),
      'slug com barra': query({ code: CODE, state: stateOf('liberado-a/..') }),
      'sem query': '',
      duplicado: `${good}&state=${stateOf('liberado-a')}`,
      'redirect na query': `${good}&redirect=https%3A%2F%2Fevil.example`,
      'iss de outro': query({ code: CODE, state: stateOf('liberado-a'), iss: 'https://evil.example' }),
      CRLF: `code=abcdefgh%0d%0aLocation:%20https://evil.example&state=${stateOf('liberado-a')}`,
      unicode: `code=abcdefgh%E2%80%AE&state=${stateOf('liberado-a')}`,
    };
    const seen = new Set<string>();
    for (const [name, hostile] of Object.entries(cases)) {
      const response = await get(hostile);
      expect(response.status, name).toBe(400);
      expect(response.headers['location'], name).toBeUndefined();
      const headers = { ...response.headers };
      for (const varying of ['date', 'x-request-id', 'keep-alive', 'connection']) delete headers[varying];
      seen.add(JSON.stringify([headers, response.text]));
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).not.toContain('MARCADO');
    expect([...seen][0]).toContain('Volte ao painel do Verax Control');
  });

  it('fora da lista não custa leitura do banco', async () => {
    const find = vi.spyOn(TenantStore.prototype, 'findBySlug');
    await get(query({ code: CODE, state: stateOf('fora-da-lista') }));
    expect(find).not.toHaveBeenCalled();
    await get(good);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('banco fora do ar: página genérica, sem detalhe e sem redirecionar', async () => {
    vi.spyOn(TenantStore.prototype, 'findBySlug').mockRejectedValue(new Error(`falha em ${CODE}`));
    const response = await get(good);
    expect(response.status).toBe(503);
    expect(response.headers['location']).toBeUndefined();
    expect(response.text).not.toContain('MARCADO');
  });

  it('só GET: POST (form_post) responde 404', async () => {
    const response = await request(app.getHttpServer())
      .post(PATH)
      .set('X-Forwarded-For', ip)
      .type('form')
      .send(good);
    expect(response.status).toBe(404);
  });

  it('limite por IP, com Retry-After; outro IP segue', async () => {
    const statuses: number[] = [];
    for (let index = 0; index <= CLOUDFLARE_CALLBACK_PER_IP.capacity; index += 1) {
      statuses.push((await get('')).status);
    }
    expect(statuses.slice(0, -1).every((status) => status === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const limited = await get(good);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited.headers['location']).toBeUndefined();
    ip = '198.51.100.9';
    expect((await get(good)).status).toBe(303);
    clock.advance(MINUTE_MS);
  });

  it('nada do código nem do state vai ao log, nem no nível mais detalhado', () => {
    expect(capture.text).toContain('cloudflare_oauth_callback');
    expect(capture.text).toContain(PATH);
    for (const secret of [CODE, encodeURIComponent(CODE), NONCE, 'CODIGOMARCADO', 'NONCEMARCADO']) {
      expect(capture.text).not.toContain(secret);
    }
    expect(capture.text).not.toContain('segredo-do-texto');
    const reasons = capture
      .entries()
      .filter((entry) => entry['event'] === 'cloudflare_oauth_callback_refused')
      .map((entry) => entry['reason']);
    expect(new Set(reasons)).toEqual(new Set(['invalid_query', 'not_released', 'not_eligible']));
  });
});

import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { LEGAL_PER_IP } from '../src/legal/legal.controller.js';
import { legalTextDocumentSchema } from '../src/legal/legal.schema.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { fictitiousLegalText, seedPublishedLegalTexts } from './support/legal-seed.js';
import { LogCapture } from './support/log-capture.js';

const SITE = 'https://veraxsistemas.com.br';
const START = new Date('2026-11-10T12:00:00.000Z');
const DAY_MS = 24 * 60 * MINUTE_MS;
const PUBLISHED_AT = new Date(START.getTime() - DAY_MS);

/**
 * Os textos legais para o site (`GET /v1/public/legal...`, só no `cp-public`) pelo app inteiro, sobre textos FICTÍCIOS
 * gravados direto no dublê do Firestore: as vigentes, o texto vigente e uma versão antiga pelo nome, o cache do CDN só
 * no sucesso, o CORS das origens do site e o rascunho nunca à mostra. Um app por arquivo.
 */
describe('cp-public: textos legais para o site', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  let app: NestExpressApplication;
  let ipSequence = 0;

  function nextIp(): string {
    ipSequence += 1;
    return `203.0.113.${ipSequence}`;
  }

  function get(path: string, ip = nextIp()): request.Test {
    return request(app.getHttpServer()).get(path).set('X-Forwarded-For', ip);
  }

  async function seedDraft(
    kind: 'terms' | 'privacy' | 'dpa',
    version: string,
    content: string,
  ): Promise<void> {
    const document = legalTextDocumentSchema.parse({
      status: 'draft',
      content,
      createdAt: START,
      createdBy: 'responsavel@verax.example',
      updatedAt: START,
      updatedBy: 'responsavel@verax.example',
    });
    await documents.runTransaction((tx) => {
      tx.set(COLLECTIONS.legalVersions(kind), version, { ...document });
      return Promise.resolve();
    });
  }

  beforeAll(async () => {
    app = await createApp({
      role: 'public',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      env: { SITE_ORIGINS: SITE },
    });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(() => {
    clock.set(START);
    documents.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /v1/public/legal: a vigente de cada texto, sem quem publicou, cacheável por 5 min', async () => {
    await seedPublishedLegalTexts(documents, '2026-11-01', PUBLISHED_AT, ['terms', 'privacy']);
    await seedDraft('dpa', '2026-11-09', 'rascunho do DPA');

    const response = await get('/v1/public/legal').expect(200);
    expect(response.body).toEqual({
      terms: { version: '2026-11-01', publishedAt: PUBLISHED_AT.toISOString() },
      privacy: { version: '2026-11-01', publishedAt: PUBLISHED_AT.toISOString() },
      dpa: null,
    });
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(JSON.stringify(response.body)).not.toContain('responsavel@');
  });

  it('GET /v1/public/legal/{tipo}: o texto vigente em Markdown, com o título e a versão', async () => {
    await seedPublishedLegalTexts(documents, '2026-11-01', PUBLISHED_AT);
    await seedPublishedLegalTexts(documents, '2026-11-09', START, ['terms']);
    await seedDraft('terms', '2026-11-10', 'rascunho que não pode sair');

    const response = await get('/v1/public/legal/terms').expect(200);
    expect(response.body).toEqual({
      kind: 'terms',
      title: 'Termos de uso',
      version: '2026-11-09',
      publishedAt: START.toISOString(),
      current: true,
      content: fictitiousLegalText('terms', '2026-11-09'),
    });
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['content-type']).toMatch(/^application\/json/);

    const privacy = await get('/v1/public/legal/privacy').expect(200);
    expect(privacy.body).toMatchObject({ title: 'Política de privacidade', version: '2026-11-01' });
  });

  it('GET /v1/public/legal/{tipo}/{versão}: uma publicada antiga (cache de 1 h), nunca um rascunho', async () => {
    await seedPublishedLegalTexts(documents, '2026-11-01', PUBLISHED_AT, ['terms']);
    await seedPublishedLegalTexts(documents, '2026-11-09', START, ['terms']);
    await seedDraft('terms', '2026-11-10', 'rascunho que não pode sair');

    const old = await get('/v1/public/legal/terms/2026-11-01').expect(200);
    expect(old.body).toMatchObject({ version: '2026-11-01', current: false });
    expect(old.headers['cache-control']).toBe('public, max-age=3600');
    const current = await get('/v1/public/legal/terms/2026-11-09').expect(200);
    expect(current.body).toMatchObject({ current: true });
    expect(current.headers['cache-control']).toBe('public, max-age=300');

    const draft = await get('/v1/public/legal/terms/2026-11-10').expect(404);
    expect(draft.body).toMatchObject({ code: 'legal_text_not_found' });
    expect(JSON.stringify(draft.body)).not.toContain('rascunho');
    expect(draft.headers['cache-control']).toBe('private, no-store');
  });

  it('tipo desconhecido, versão fora do formato ou texto nunca publicado: 404 sem cache', async () => {
    await seedDraft('dpa', 'v1', 'só rascunho');
    for (const path of [
      '/v1/public/legal/cookies',
      '/v1/public/legal/dpa',
      '/v1/public/legal/terms/..%2F..%2Ftenants',
      '/v1/public/legal/terms/VERSAO',
    ]) {
      const response = await get(path).expect(404);
      expect(response.body, path).toMatchObject({ code: 'legal_text_not_found' });
      expect(response.headers['cache-control'], path).toBe('private, no-store');
    }
  });

  it('CORS só para as origens do site, sem credenciais', async () => {
    await seedPublishedLegalTexts(documents, '2026-11-01', PUBLISHED_AT);
    const allowed = await get('/v1/public/legal/dpa').set('Origin', SITE).expect(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(SITE);
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    const other = await get('/v1/public/legal/dpa').set('Origin', 'https://outro.example').expect(200);
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('limite por IP: 429 com Retry-After depois da rajada', async () => {
    await seedPublishedLegalTexts(documents, '2026-11-01', PUBLISHED_AT);
    const ip = nextIp();
    for (let index = 0; index < LEGAL_PER_IP.capacity; index += 1) {
      await get('/v1/public/legal', ip).expect(200);
    }
    const limited = await get('/v1/public/legal/terms', ip).expect(429);
    expect(limited.body).toMatchObject({ code: 'rate_limited' });
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

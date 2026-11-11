import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { sha256Hex } from '../src/legal/legal-store.js';
import { MAX_LEGAL_TEXT_BYTES } from '../src/legal/legal.schema.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock, MINUTE_MS } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const START = new Date('2026-11-10T12:00:00.000Z');
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';
const TEXT = '# Termos de uso (teste)\n\nTexto **fictício**.\n';

/**
 * Os textos legais no console do responsável (`/v1/admin/legal...`, `ROLE=admin`) pelo app inteiro: a sessão exigida,
 * o rascunho em branco e copiado, a edição com a guarda de revisão, a publicação com a versão digitada de novo, a
 * imutabilidade da publicada e a trilha de auditoria. Textos FICTÍCIOS. Um app por arquivo.
 */
describe('cp-admin: textos legais', () => {
  const capture = new LogCapture();
  const clock = new FakeClock(START);
  const documents = new MemoryDocumentStore();
  let app: NestExpressApplication;
  let ownerCookie = '';
  let strangerCookie = '';

  function call(method: 'get' | 'post' | 'put', path: string, cookie: string | null = ownerCookie) {
    const test = request(app.getHttpServer())[method](path);
    return cookie === null ? test : test.set('Cookie', cookie);
  }

  function send(method: 'post' | 'put', path: string, body: unknown, cookie: string | null = ownerCookie) {
    return call(method, path, cookie).set('Content-Type', 'application/json').send(JSON.stringify(body));
  }

  /** Cria o rascunho, grava o texto e devolve o `updatedAt` gravado (a revisão para publicar). */
  async function draftWithText(kind: string, version: string, content = TEXT): Promise<string> {
    const created = await send('post', `/v1/admin/legal/${kind}/versions`, { version }).expect(201);
    clock.advance(MINUTE_MS);
    const saved = await send('put', `/v1/admin/legal/${kind}/versions/${version}`, {
      content,
      expectedUpdatedAt: (created.body as { updatedAt: string }).updatedAt,
    }).expect(200);
    return (saved.body as { updatedAt: string }).updatedAt;
  }

  beforeAll(async () => {
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: new MemoryAdminSecrets(),
      env: {
        LOG_LEVEL: 'debug',
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: OWNER,
      },
    });
    await app.listen(0, '127.0.0.1');
  });

  beforeEach(async () => {
    clock.set(START);
    documents.clear();
    ownerCookie = await seedOwnerSession(documents, clock, OWNER);
    strangerCookie = await seedOwnerSession(documents, clock, STRANGER);
  });

  afterAll(async () => {
    await app.close();
  });

  it('sem sessão: 401; sessão de quem não é responsável: 403; escrita sem JSON: 415', async () => {
    await call('get', '/v1/admin/legal', null).expect(401);
    await call('get', '/v1/admin/legal', strangerCookie).expect(403);
    await send('post', '/v1/admin/legal/terms/versions', { version: 'v1' }, null).expect(401);
    await call('post', '/v1/admin/legal/terms/versions')
      .set('Content-Type', 'text/plain')
      .send('{"version":"v1"}')
      .expect(415);
    expect(await documents.query(COLLECTIONS.legalVersions('terms'))).toEqual([]);
  });

  it('a lista dos três textos começa vazia; o rascunho em branco aparece nela, sem o texto', async () => {
    await call('get', '/v1/admin/legal').expect(200, { terms: [], privacy: [], dpa: [] });
    const created = await send('post', '/v1/admin/legal/privacy/versions', { version: '2026-11-10' }).expect(
      201,
    );
    expect(created.body).toMatchObject({
      kind: 'privacy',
      version: '2026-11-10',
      status: 'draft',
      content: '',
      createdBy: OWNER,
    });
    const list = await call('get', '/v1/admin/legal').expect(200);
    expect(list.body).toMatchObject({
      terms: [],
      dpa: [],
      privacy: [{ version: '2026-11-10', status: 'draft', current: false, bytes: 0, updatedBy: OWNER }],
    });
    expect((list.body as { privacy: unknown[] }).privacy[0]).not.toHaveProperty('content');
  });

  it('publica com a revisão e a versão digitada: vira a vigente, imutável; a cópia começa do texto dela', async () => {
    const revision = await draftWithText('terms', '2026-11-10');
    clock.advance(MINUTE_MS);

    const wrong = await send('post', '/v1/admin/legal/terms/versions/2026-11-10/publish', {
      expectedUpdatedAt: revision,
      confirmVersion: '2026-11-1',
    }).expect(400);
    expect(wrong.body).toMatchObject({
      code: 'invalid_request',
      details: { issues: [{ path: 'confirmVersion' }] },
    });

    const published = await send('post', '/v1/admin/legal/terms/versions/2026-11-10/publish', {
      expectedUpdatedAt: revision,
      confirmVersion: '2026-11-10',
    }).expect(200);
    expect(published.body).toMatchObject({
      kind: 'terms',
      version: '2026-11-10',
      status: 'published',
      current: true,
      publishedAt: clock.now().toISOString(),
      publishedBy: OWNER,
      contentSha256: sha256Hex(TEXT),
    });

    const edit = await send('put', '/v1/admin/legal/terms/versions/2026-11-10', {
      content: 'outro texto',
      expectedUpdatedAt: clock.now().toISOString(),
    }).expect(409);
    expect(edit.body).toMatchObject({ code: 'version_immutable' });

    const copy = await send('post', '/v1/admin/legal/terms/versions', {
      version: '2026-12-01',
      from: '2026-11-10',
    }).expect(201);
    expect(copy.body).toMatchObject({ status: 'draft', content: TEXT, basedOn: '2026-11-10' });
    const read = await call('get', '/v1/admin/legal/terms/versions/2026-11-10').expect(200);
    expect(read.body).toMatchObject({ status: 'published', content: TEXT });
  });

  it('rascunho que mudou desde a leitura: 409 draft_changed na edição e na publicação, sem gravar', async () => {
    const created = await send('post', '/v1/admin/legal/dpa/versions', { version: 'v1' }).expect(201);
    const stale = (created.body as { updatedAt: string }).updatedAt;
    clock.advance(MINUTE_MS);
    await send('put', '/v1/admin/legal/dpa/versions/v1', {
      content: 'aba A',
      expectedUpdatedAt: stale,
    }).expect(200);
    const conflict = await send('put', '/v1/admin/legal/dpa/versions/v1', {
      content: 'aba B',
      expectedUpdatedAt: stale,
    }).expect(409);
    expect(conflict.body).toMatchObject({ code: 'draft_changed' });
    const publish = await send('post', '/v1/admin/legal/dpa/versions/v1/publish', {
      expectedUpdatedAt: stale,
      confirmVersion: 'v1',
    }).expect(409);
    expect(publish.body).toMatchObject({ code: 'draft_changed' });
    const read = await call('get', '/v1/admin/legal/dpa/versions/v1').expect(200);
    expect(read.body).toMatchObject({ status: 'draft', content: 'aba A' });
  });

  it('validação: versão, tipo, texto grande, campo a mais, texto em branco e versão repetida', async () => {
    const invalid = await send('post', '/v1/admin/legal/terms/versions', { version: 'Versão 1' }).expect(400);
    expect(invalid.body).toMatchObject({ details: { issues: [{ path: 'version' }] } });
    await send('post', '/v1/admin/legal/cookies/versions', { version: 'v1' }).expect(404);
    await send('post', '/v1/admin/legal/terms/versions', { version: 'v1', extra: true }).expect(400);
    const missing = await send('post', '/v1/admin/legal/terms/versions', {
      version: 'v2',
      from: 'nao-existe',
    }).expect(404);
    expect(missing.body).toMatchObject({ code: 'version_not_found' });

    const created = await send('post', '/v1/admin/legal/terms/versions', { version: 'v1' }).expect(201);
    const revision = (created.body as { updatedAt: string }).updatedAt;
    await send('post', '/v1/admin/legal/terms/versions', { version: 'v1' }).expect(409);
    const big = await send('put', '/v1/admin/legal/terms/versions/v1', {
      content: 'x'.repeat(MAX_LEGAL_TEXT_BYTES + 1),
      expectedUpdatedAt: revision,
    }).expect(400);
    expect(big.body).toMatchObject({ details: { issues: [{ path: 'content' }] } });
    // No teto, com acento e quebra de linha (o JSON fica maior que o texto), cabe no corpo do console.
    const line = 'ção\n';
    const atLimit = line.repeat(Math.floor(MAX_LEGAL_TEXT_BYTES / Buffer.byteLength(line)));
    const saved = await send('put', '/v1/admin/legal/terms/versions/v1', {
      content: atLimit,
      expectedUpdatedAt: revision,
    }).expect(200);
    expect(saved.body).toMatchObject({ content: atLimit });
    const blankDraft = await send('post', '/v1/admin/legal/terms/versions', { version: 'v3' }).expect(201);
    const blank = await send('post', '/v1/admin/legal/terms/versions/v3/publish', {
      expectedUpdatedAt: (blankDraft.body as { updatedAt: string }).updatedAt,
      confirmVersion: 'v3',
    }).expect(422);
    expect(blank.body).toMatchObject({ code: 'legal_text_empty' });
    await call('get', '/v1/admin/legal/terms/versions/nao-existe').expect(404);
  });

  it('a trilha de cada texto: quem, quando, a versão, o tamanho e o hash; nunca o texto nem os outros textos', async () => {
    const revision = await draftWithText('terms', 'v1');
    clock.advance(MINUTE_MS);
    await send('post', '/v1/admin/legal/terms/versions/v1/publish', {
      expectedUpdatedAt: revision,
      confirmVersion: 'v1',
    }).expect(200);
    await draftWithText('dpa', 'v1', 'outro texto');

    const trail = await call('get', '/v1/admin/legal/terms/audit').expect(200);
    expect(trail.body).toMatchObject([
      { event: 'published', version: 'v1', actor: `owner:${OWNER}`, contentSha256: sha256Hex(TEXT) },
      { event: 'draft.updated', version: 'v1', bytes: Buffer.byteLength(TEXT) },
      { event: 'draft.created', version: 'v1', bytes: 0 },
    ]);
    expect(JSON.stringify(trail.body)).not.toContain('fictício');
    await call('get', '/v1/admin/legal/cookies/audit').expect(404);

    // Os logs levam o tipo e a versão, nunca o texto nem o e-mail de quem publicou.
    expect(capture.text).toContain('legal_text_published');
    expect(capture.text).not.toContain('fictício');
  });
});

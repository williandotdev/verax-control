import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSOLE_CSP } from '../src/admin/console-assets.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryAdminSecrets, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';
import { LogCapture } from './support/log-capture.js';

const OWNER = 'responsavel@verax.example';
const INDEX = '<!doctype html><title>Console de teste</title><div id="root"></div>';
const SCRIPT = 'console.log("teste");';

/**
 * As telas do console servidas pelo próprio `cp-admin` (`admin/console-assets.ts`), com uma pasta de build falsa
 * gerada no teste: as telas abrem sem sessão (o login e o primeiro cadastro estão nelas), com a CSP das telas, o cache
 * por tipo de arquivo, as rotas do app caindo no `index.html`, e nada fora da pasta. Os dados só pela API, com sessão.
 * Um app por arquivo.
 */
describe('cp-admin: as telas do console no mesmo serviço', () => {
  const capture = new LogCapture();
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock(new Date('2026-11-04T12:00:00.000Z'));
  const root = mkdtempSync(join(tmpdir(), 'verax-console-'));
  let app: NestExpressApplication;
  let cookie = '';

  function get(path: string, withSession = true): request.Test {
    const test = request(app.getHttpServer()).get(path);
    return withSession ? test.set('Cookie', cookie) : test;
  }

  beforeAll(async () => {
    writeFileSync(join(root, 'index.html'), INDEX);
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'index-abc123.js'), SCRIPT);
    writeFileSync(join(root, 'theme-init.js'), SCRIPT);
    // Um arquivo oculto na pasta do build (não deveria existir, e mesmo assim nunca é servido).
    writeFileSync(join(root, '.env'), 'NAO_SERVIR=1');
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      capture,
      documentStore: documents,
      clock,
      adminSecrets: new MemoryAdminSecrets(),
      consoleRoot: root,
      env: { ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo', OWNER_PRINCIPALS: OWNER },
    });
    await app.listen(0, '127.0.0.1');
    cookie = await seedOwnerSession(documents, clock, OWNER);
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('as telas abrem sem sessão (o login está nelas); os dados da API, não', async () => {
    for (const path of ['/entrar', '/configurar', '/', '/clientes']) {
      const page = await get(path, false).expect(200);
      expect(page.text, path).toBe(INDEX);
    }
    await get('/assets/index-abc123.js', false).expect(200);
    const data = await get('/v1/admin/pricing-tables', false).expect(401);
    expect(data.body).toMatchObject({ code: 'unauthenticated' });
    expect(data.text).not.toContain('Console de teste');
  });

  it('o responsável recebe o index.html com a CSP das telas e sem cache, em qualquer rota do app', async () => {
    for (const path of ['/', '/modelos-de-custo', '/tabelas-de-preco/2026-11-v1', '/simulador']) {
      const page = await get(path).expect(200);
      expect(page.text, path).toBe(INDEX);
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.headers['content-security-policy']).toBe(CONSOLE_CSP);
      expect(page.headers['cache-control']).toBe('private, no-store');
      expect(page.headers['x-content-type-options']).toBe('nosniff');
    }
    expect(CONSOLE_CSP).toContain("script-src 'self'");
    expect(CONSOLE_CSP).toContain("frame-ancestors 'none'");
    expect(CONSOLE_CSP).not.toContain('unsafe-inline');
  });

  it('os arquivos com hash ficam em cache privado imutável; os outros, sem cache', async () => {
    const asset = await get('/assets/index-abc123.js').expect(200);
    expect(asset.text).toBe(SCRIPT);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toBe('private, max-age=31536000, immutable');
    const theme = await get('/theme-init.js').expect(200);
    expect(theme.headers['cache-control']).toBe('private, no-store');
  });

  it('arquivo inexistente é 404 (nunca o index.html); oculto ou fora da pasta, nunca servido', async () => {
    const missing = await get('/assets/nao-existe.js').expect(404);
    expect(missing.text).not.toContain('Console de teste');
    for (const path of [
      '/.env',
      '/assets/../.env',
      '/%2e%2e/%2e%2e/package.json',
      '/..%2f..%2fpackage.json',
    ]) {
      const response = await get(path);
      expect([400, 403, 404], path).toContain(response.status);
      expect(response.text, path).not.toContain('NAO_SERVIR');
      expect(response.text, path).not.toContain('"name"');
    }
  });

  it('a API, o /health e os outros métodos seguem como antes', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
    const me = await get('/v1/admin/me').expect(200);
    expect(me.body).toEqual({ email: OWNER });
    // A API continua com a política de quem só devolve JSON.
    expect(me.headers['content-security-policy']).toContain("default-src 'none'");
    expect(me.headers['content-security-policy']).not.toContain("script-src 'self'");
    await get('/v1/admin/nao-existe').expect(404);
    await get('/v1/admin/me', false).expect(401);
    const post = await request(app.getHttpServer())
      .post('/')
      .set('Cookie', cookie)
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(post.status).toBe(404);
    expect(post.text).not.toContain('Console de teste');
  });
});

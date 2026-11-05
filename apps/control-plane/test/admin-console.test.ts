import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSOLE_CSP } from '../src/admin/console-assets.js';
import { IAP_JWT_HEADER } from '../src/admin/iap-verifier.js';
import { createApp } from './support/create-app.js';
import { TestIap } from './support/iap-test-keys.js';
import { LogCapture } from './support/log-capture.js';

const AUDIENCE = '/projects/111111111111/locations/southamerica-east1/services/cp-admin';
const OWNER = 'responsavel@verax.example';
const STRANGER = 'outra-pessoa@verax.example';
const INDEX = '<!doctype html><title>Console de teste</title><div id="root"></div>';
const SCRIPT = 'console.log("teste");';

/**
 * As telas do console servidas pelo próprio `cp-admin` (`admin/console-assets.ts`), com uma pasta de build falsa
 * gerada no teste: o JWT do IAP em cada arquivo, a CSP das telas, o cache por tipo de arquivo, as rotas do app caindo
 * no `index.html`, e nada fora da pasta. A API e o `/health` continuam como antes. Um app por arquivo.
 */
describe('cp-admin: as telas do console no mesmo serviço', () => {
  const capture = new LogCapture();
  const iap = new TestIap();
  const root = mkdtempSync(join(tmpdir(), 'verax-console-'));
  let app: NestExpressApplication;

  function get(path: string, email: string | null = OWNER): request.Test {
    const test = request(app.getHttpServer()).get(path);
    return email === null ? test : test.set(IAP_JWT_HEADER, iap.token({ audience: AUDIENCE, email }));
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
      iapKeySource: iap,
      consoleRoot: root,
      env: { IAP_AUDIENCE: AUDIENCE, OWNER_PRINCIPALS: OWNER },
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('sem o JWT do IAP, nem a tela abre (401, com admin_auth_failed no log); de outra pessoa, 403', async () => {
    const before = capture.lines.length;
    const missing = await get('/', null).expect(401);
    expect(missing.body).toMatchObject({ code: 'unauthenticated' });
    expect(missing.text).not.toContain('Console de teste');
    const stranger = await get('/tabelas-de-preco', STRANGER).expect(403);
    expect(stranger.body).toMatchObject({ code: 'forbidden' });
    await get('/assets/index-abc123.js', null).expect(401);
    const reasons = capture
      .entries()
      .slice(before)
      .filter((entry) => entry['event'] === 'admin_auth_failed')
      .map((entry) => entry['reason']);
    expect(reasons).toEqual(['missing', 'not_owner', 'missing']);
    expect(capture.text).not.toContain(STRANGER);
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
    await get('/v1/admin/me', null).expect(401);
    const post = await request(app.getHttpServer())
      .post('/')
      .set(IAP_JWT_HEADER, iap.token({ audience: AUDIENCE, email: OWNER }))
      .set('Content-Type', 'application/json')
      .send('{}');
    expect(post.status).toBe(404);
    expect(post.text).not.toContain('Console de teste');
  });
});

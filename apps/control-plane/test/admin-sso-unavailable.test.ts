import { createHash, randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SSO_CLIENT_ID } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS } from '../src/firestore/collections.js';
import { MemoryDocumentStore } from '../src/firestore/memory-document-store.js';
import { MemoryAdminSecrets, newSsoSigningKeyPem, seedOwnerSession } from './support/admin-auth.js';
import { createApp } from './support/create-app.js';
import { FakeClock } from './support/fake-clock.js';

const CALLBACK = 'https://api-equipe.example.com/v1/auth/sso/callback';
const OWNER = 'responsavel@verax.example';

const opaque = (): string => randomBytes(32).toString('base64url');

function query(): Record<string, string> {
  return {
    response_type: 'code',
    client_id: SSO_CLIENT_ID,
    redirect_uri: CALLBACK,
    state: opaque(),
    nonce: opaque(),
    code_challenge: createHash('sha256').update(opaque()).digest('base64url'),
    code_challenge_method: 'S256',
  };
}

/**
 * A entrada única sem a chave de assinatura no cofre (`cp-admin-sso-signing-key` ainda vazio, ou fora do formato): nada
 * é emitido e tudo responde indisponível, sem derrubar o console; gravada a chave, passa a funcionar sem reiniciar.
 */
describe('cp-admin: entrada única sem a chave de assinatura', () => {
  const clock = new FakeClock();
  const documents = new MemoryDocumentStore();
  const secrets = new MemoryAdminSecrets();
  let app: NestExpressApplication;

  beforeAll(async () => {
    secrets.sso = undefined;
    app = await createApp({
      role: 'admin',
      nodeEnv: 'production',
      trustProxyHops: 1,
      documentStore: documents,
      clock,
      adminSecrets: secrets,
      env: {
        ADMIN_SECRETS_PROJECT_ID: 'projeto-exemplo',
        OWNER_PRINCIPALS: OWNER,
        SSO_ISSUER: 'https://admin.example.com',
        SSO_REDIRECT_URIS: CALLBACK,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('cofre vazio ou fora do formato: 503 no authorize (tela), no token e no JWKS; nenhum código', async () => {
    const cookie = await seedOwnerSession(documents, clock, OWNER);
    for (const value of [undefined, 'texto que não é chave']) {
      secrets.sso = value;
      const page = await request(app.getHttpServer())
        .get('/sso/authorize')
        .query(query())
        .set('Cookie', cookie);
      expect(page.status).toBe(503);
      expect(page.headers['location']).toBeUndefined();
      await request(app.getHttpServer()).get('/sso/jwks').expect(503);
      await request(app.getHttpServer())
        .post('/sso/token')
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(503);
    }
    expect(await documents.query(COLLECTIONS.adminSsoCodes)).toHaveLength(0);
    // O console continua no ar.
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/v1/admin/me').set('Cookie', cookie).expect(200);
  });

  it('gravada a chave, o mesmo processo passa a emitir', async () => {
    secrets.sso = newSsoSigningKeyPem();
    const cookie = await seedOwnerSession(documents, clock, OWNER);
    const response = await request(app.getHttpServer())
      .get('/sso/authorize')
      .query(query())
      .set('Cookie', cookie)
      .expect(303);
    expect(String(response.headers['location'])).toMatch(/^https:\/\/api-equipe\.example\.com\//);
    await request(app.getHttpServer()).get('/sso/jwks').expect(200);
  });
});

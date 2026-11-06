import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { fakeIdentityToken, TestGoogleIdentity } from '../../test/support/access-fakes.js';
import { FakeClock } from '../../test/support/fake-clock.js';
import { loadConfig } from '../common/config/load-config.js';
import {
  IdentityTokenVerifier,
  SERVERLESS_AUTHORIZATION_HEADER,
  selectValidatedCredential,
} from './identity-token.js';
import { allowedCallers, ownerActorOf } from './worker-caller.js';

const AUD = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const PUBLIC_SA = 'cp-public@demo-proj.iam.gserviceaccount.com';
const INVOKER = 'cp-invoker@demo-proj.iam.gserviceaccount.com';
const ADMIN_SA = 'cp-admin@demo-proj.iam.gserviceaccount.com';

describe('selectValidatedCredential (o cabeçalho que o Cloud Run conferiu)', () => {
  it('com os dois cabeçalhos, a escolha é o X-Serverless-Authorization, e o pedido é ambíguo (recusado)', () => {
    const selection = selectValidatedCredential({
      authorization: 'Bearer forjado',
      [SERVERLESS_AUTHORIZATION_HEADER]: 'Bearer verdadeiro',
    });
    expect(selection).toEqual({
      kind: 'ambiguous',
      header: SERVERLESS_AUTHORIZATION_HEADER,
      value: 'Bearer verdadeiro',
    });
  });

  it('com um só, ele; sem nenhum, falta', () => {
    expect(selectValidatedCredential({ authorization: 'Bearer a' })).toEqual({
      kind: 'single',
      header: 'authorization',
      value: 'Bearer a',
    });
    expect(selectValidatedCredential({ [SERVERLESS_AUTHORIZATION_HEADER]: 'Bearer b' })).toEqual({
      kind: 'single',
      header: SERVERLESS_AUTHORIZATION_HEADER,
      value: 'Bearer b',
    });
    expect(selectValidatedCredential({})).toEqual({ kind: 'missing' });
  });
});

describe('IdentityTokenVerifier', () => {
  const google = new TestGoogleIdentity();
  const clock = new FakeClock(new Date());
  const verifier = new IdentityTokenVerifier(google, clock);
  const later = (): number => Math.floor(clock.now().getTime() / 1000) + 3600;

  it('token assinado pelo Google no Authorization: assinatura, audiência e prazo conferidos', async () => {
    const result = await verifier.verify(
      'authorization',
      `Bearer ${google.token({ email: PUBLIC_SA, aud: AUD })}`,
      AUD,
    );
    expect(result).toMatchObject({ ok: true, claims: { email: PUBLIC_SA, aud: AUD } });
  });

  it.each([
    [
      'assinado por outra chave',
      () => google.token({ email: PUBLIC_SA, aud: AUD, signer: TestGoogleIdentity.otherSigner() }),
      'invalid',
    ],
    ['de outra audiência', () => google.token({ email: PUBLIC_SA, aud: 'https://outro.run.app' }), 'invalid'],
    [
      'vencido',
      () => {
        const now = Math.floor(Date.now() / 1000);
        return google.token({ email: PUBLIC_SA, aud: AUD, payload: { iat: now - 7200, exp: now - 3600 } });
      },
      'invalid',
    ],
    [
      'de outro emissor',
      () => google.token({ email: PUBLIC_SA, aud: AUD, payload: { iss: 'https://outro.example' } }),
      'invalid',
    ],
    [
      'com outro algoritmo',
      () => google.token({ email: PUBLIC_SA, aud: AUD, header: { alg: 'HS256' } }),
      'algorithm',
    ],
    [
      'com chave desconhecida',
      () => google.token({ email: PUBLIC_SA, aud: AUD, header: { kid: 'outra' } }),
      'unknown_key',
    ],
    [
      'com e-mail não verificado',
      () => google.token({ email: PUBLIC_SA, aud: AUD, payload: { email_verified: false } }),
      'claims',
    ],
  ])('Authorization %s → recusado', async (_case, build, reason) => {
    expect(await verifier.verify('authorization', `Bearer ${build()}`, AUD)).toEqual({ ok: false, reason });
  });

  it('assinatura removida só vale no X-Serverless-Authorization, onde o Cloud Run a remove depois de conferir', async () => {
    const stripped = fakeIdentityToken({ email: INVOKER, aud: AUD, exp: later() });
    expect(await verifier.verify(SERVERLESS_AUTHORIZATION_HEADER, `Bearer ${stripped}`, AUD)).toMatchObject({
      ok: true,
      claims: { email: INVOKER },
    });
    // O mesmo token no Authorization não tem como ter sido conferido sem a assinatura: recusado.
    expect(await verifier.verify('authorization', `Bearer ${stripped}`, AUD)).toEqual({
      ok: false,
      reason: 'signature_missing',
    });
    const [header, payload] = stripped.split('.');
    expect(await verifier.verify('authorization', `Bearer ${header}.${payload}`, AUD)).toMatchObject({
      ok: false,
    });
  });

  it('sem assinatura, a audiência e o prazo são conferidos pelo relógio do serviço', async () => {
    const now = Math.floor(clock.now().getTime() / 1000);
    const otherAudience = fakeIdentityToken({ email: INVOKER, aud: 'https://outro.run.app', exp: later() });
    const expired = fakeIdentityToken({ email: INVOKER, aud: AUD, exp: now - 1 });
    for (const value of [otherAudience, expired]) {
      expect(await verifier.verify(SERVERLESS_AUTHORIZATION_HEADER, `Bearer ${value}`, AUD)).toEqual({
        ok: false,
        reason: 'claims',
      });
    }
  });

  it.each([
    ['outro esquema', `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['palavra a mais', 'Bearer a.b.c d'],
    ['uma parte só', 'Bearer abc'],
    ['payload que não é JSON', 'Bearer YQ.bm9wZQ.c'],
    ['grande demais', `Bearer ${'a'.repeat(5000)}.b.c`],
  ])('recusa %s', async (_case, value) => {
    expect(await verifier.verify('authorization', value, AUD)).toMatchObject({ ok: false });
  });

  it('sem as chaves do Google, recusa (sem lançar)', async () => {
    const offline = new IdentityTokenVerifier({ keys: () => Promise.reject(new Error('sem rede')) }, clock);
    expect(
      await offline.verify('authorization', `Bearer ${google.token({ email: PUBLIC_SA, aud: AUD })}`, AUD),
    ).toEqual({ ok: false, reason: 'keys_unavailable' });
  });
});

describe('allowedCallers', () => {
  const config = loadConfig({
    ROLE: 'worker',
    NODE_ENV: 'test',
    WORKER_SA_EMAIL: INVOKER,
    SCHEDULER_SA_EMAIL: INVOKER,
    OWNER_PRINCIPALS: 'Dono@Exemplo.example',
    PUBLIC_SA_EMAIL: PUBLIC_SA,
    ADMIN_SA_EMAIL: ADMIN_SA,
  });

  it('separa as rotas: as tasks e o responsável num grupo, só o cp-public no outro', () => {
    expect([...allowedCallers(config, ['tasks'])].sort()).toEqual([INVOKER, 'dono@exemplo.example']);
    expect([...allowedCallers(config, ['public'])]).toEqual([PUBLIC_SA]);
    // O `resume` do provisionamento (CP-07): só o responsável, nem a cp-invoker nem o cp-public.
    expect([...allowedCallers(config, ['owner'])]).toEqual(['dono@exemplo.example']);
    // A conta do console só entra nas rotas marcadas com `console`, nunca nos passos nem na revelação.
    expect([...allowedCallers(config, ['owner', 'console'])].sort()).toEqual([
      ADMIN_SA,
      'dono@exemplo.example',
    ]);
    expect(allowedCallers(config, ['tasks']).has(ADMIN_SA)).toBe(false);
    expect(allowedCallers(config, ['public']).has(ADMIN_SA)).toBe(false);
    expect(allowedCallers(config, ['owner']).has(ADMIN_SA)).toBe(false);
  });

  it('sem a configuração, ninguém', () => {
    const empty = loadConfig({ ROLE: 'worker', NODE_ENV: 'test' });
    expect(allowedCallers(empty, ['tasks', 'public']).size).toBe(0);
  });
});

describe('ownerActorOf (quem age numa operação do responsável, para a auditoria)', () => {
  const config = loadConfig({
    ROLE: 'worker',
    NODE_ENV: 'test',
    OWNER_PRINCIPALS: 'Dono@Exemplo.example,socia@exemplo.example',
    ADMIN_SA_EMAIL: ADMIN_SA,
  });
  const requestFrom = (caller: string): Request => ({ workerCaller: caller }) as unknown as Request;

  it('o console age em nome do responsável do corpo, e só se ele estiver em OWNER_PRINCIPALS', () => {
    expect(ownerActorOf(requestFrom(ADMIN_SA), config, 'DONO@exemplo.example')).toBe(
      'owner:dono@exemplo.example',
    );
    expect(ownerActorOf(requestFrom(ADMIN_SA), config, undefined)).toBeUndefined();
    expect(ownerActorOf(requestFrom(ADMIN_SA), config, 'estranho@exemplo.example')).toBeUndefined();
  });

  it('o responsável direto age como ele mesmo: o corpo não escolhe o ator', () => {
    expect(ownerActorOf(requestFrom('dono@exemplo.example'), config, 'socia@exemplo.example')).toBe(
      'owner:dono@exemplo.example',
    );
    expect(ownerActorOf(requestFrom(INVOKER), config, 'dono@exemplo.example')).toBeUndefined();
  });
});

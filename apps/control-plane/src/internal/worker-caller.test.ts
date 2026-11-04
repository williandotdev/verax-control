import { describe, expect, it } from 'vitest';
import { fakeIdentityToken } from '../../test/support/access-fakes.js';
import { loadConfig } from '../common/config/load-config.js';
import { allowedCallers, readIdentityClaims } from './worker-caller.js';

const AUD = 'https://cp-worker-123456789012.southamerica-east1.run.app';
const EXP = 1_900_000_000;

describe('readIdentityClaims', () => {
  it('lê as declarações do token que o Cloud Run entrega (assinatura removida)', () => {
    const token = fakeIdentityToken({ email: 'cp-public@demo.iam.gserviceaccount.com', aud: AUD, exp: EXP });
    expect(readIdentityClaims(`Bearer ${token}`)).toEqual({
      iss: 'https://accounts.google.com',
      aud: AUD,
      email: 'cp-public@demo.iam.gserviceaccount.com',
      email_verified: true,
      exp: EXP,
    });
  });

  it.each([
    ['sem cabeçalho', undefined],
    ['outro esquema', `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['duas partes', 'Bearer a.b'],
    ['payload que não é JSON', 'Bearer a.bm9wZQ.c'],
    [
      'emissor que não é o Google',
      `Bearer ${fakeIdentityToken({ email: 'x@y.example', aud: AUD, exp: EXP, iss: 'https://outro.example' })}`,
    ],
    [
      'e-mail não verificado',
      `Bearer ${fakeIdentityToken({ email: 'x@y.example', aud: AUD, exp: EXP, emailVerified: false })}`,
    ],
    ['grande demais', `Bearer ${'a'.repeat(5000)}.b.c`],
  ])('recusa %s', (_case, header) => {
    expect(readIdentityClaims(header)).toBeUndefined();
  });
});

describe('allowedCallers', () => {
  const config = loadConfig({
    ROLE: 'worker',
    NODE_ENV: 'test',
    WORKER_SA_EMAIL: 'cp-invoker@demo-proj.iam.gserviceaccount.com',
    SCHEDULER_SA_EMAIL: 'cp-invoker@demo-proj.iam.gserviceaccount.com',
    OWNER_PRINCIPALS: 'Dono@Exemplo.example',
    PUBLIC_SA_EMAIL: 'cp-public@demo-proj.iam.gserviceaccount.com',
  });

  it('separa as rotas: as tasks e o responsável num grupo, só o cp-public no outro', () => {
    expect([...allowedCallers(config, ['tasks'])].sort()).toEqual([
      'cp-invoker@demo-proj.iam.gserviceaccount.com',
      'dono@exemplo.example',
    ]);
    expect([...allowedCallers(config, ['public'])]).toEqual(['cp-public@demo-proj.iam.gserviceaccount.com']);
  });

  it('sem a configuração, ninguém', () => {
    const empty = loadConfig({ ROLE: 'worker', NODE_ENV: 'test' });
    expect(allowedCallers(empty, ['tasks', 'public']).size).toBe(0);
  });
});

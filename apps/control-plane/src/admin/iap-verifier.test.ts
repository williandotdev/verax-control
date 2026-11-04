import { describe, expect, it } from 'vitest';
import { TestIap } from '../../test/support/iap-test-keys.js';
import { IapJwtVerifier } from './iap-verifier.js';

const AUDIENCE = '/projects/111111111111/locations/southamerica-east1/services/cp-admin';
const OWNER = 'responsavel@verax.example';

/** O verificador do JWT do IAP com uma chave ES256 gerada no teste (nada fala com o Google). */
describe('verificação do JWT do IAP', () => {
  const iap = new TestIap();
  const verifier = new IapJwtVerifier(iap, AUDIENCE, [OWNER]);

  it('aceita o token do IAP de um responsável e devolve o e-mail em minúsculas', async () => {
    expect(
      await verifier.verify(iap.token({ audience: AUDIENCE, email: 'Responsavel@Verax.Example' })),
    ).toEqual({
      ok: true,
      email: OWNER,
    });
  });

  it('recusa sem decodificar o que não tem forma de JWT: ausente, grande demais, fora do base64url, sem kid', async () => {
    expect(await verifier.verify(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifier.verify(['a', 'b'])).toEqual({ ok: false, reason: 'missing' });
    expect(await verifier.verify(`${'a'.repeat(4097)}.b.c`)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifier.verify('a.b c.d')).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifier.verify(`${Buffer.from('nao e json').toString('base64url')}.e30.sig`)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    const withoutKid = iap.token({ audience: AUDIENCE, email: OWNER, header: { kid: undefined } });
    expect(await verifier.verify(withoutKid)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('sem as chaves públicas (o Google fora do ar), recusa com keys_unavailable', async () => {
    const offline = new IapJwtVerifier({ keys: () => Promise.reject(new Error('sem rede')) }, AUDIENCE, [
      OWNER,
    ]);
    expect(await offline.verify(iap.token({ audience: AUDIENCE, email: OWNER }))).toEqual({
      ok: false,
      reason: 'keys_unavailable',
    });
  });

  it('token sem e-mail ou de quem não está na lista: not_owner', async () => {
    expect(await verifier.verify(iap.token({ audience: AUDIENCE, email: 'outra@verax.example' }))).toEqual({
      ok: false,
      reason: 'not_owner',
    });
    expect(
      await verifier.verify(iap.token({ audience: AUDIENCE, email: OWNER, payload: { email: 42 } })),
    ).toEqual({
      ok: false,
      reason: 'not_owner',
    });
  });
});

import { createHmac, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { SSO_CLIENT_ID, type SsoIdTokenClaims } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { ed25519PublicKey, ssoKeyId } from '../../common/config/sso.js';
import { type IdTokenExpectations, verifyIdToken } from './id-token.js';

/**
 * A conferência do token da entrada única contra os ataques conhecidos de JWT: assinatura com outra chave, `alg: none`,
 * HS256 com a chave pública como segredo, cabeçalho que aponta outra chave (`jku`, `jwk`, `kid` trocado), prazo, `iss`,
 * `aud`, `nonce`, `amr`, campos a mais e texto malformado. Os tokens são montados aqui com chaves geradas no teste (o
 * console de verdade assina no E2E, `test/sso-admin-master.test.ts`).
 */

const ISSUER = 'https://admin.example.com';
const NOW = new Date('2026-11-15T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);

const b64 = (value: unknown): string =>
  Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const opaque = (): string => randomBytes(32).toString('base64url');

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  const x = String(pair.publicKey.export({ format: 'jwk' }).x);
  return { privateKey: pair.privateKey, x, kid: ssoKeyId(x), publicKey: ed25519PublicKey(x) as KeyObject };
}

const CONSOLE = keyPair();
const ATTACKER = keyPair();
const NONCE = opaque();

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: SSO_CLIENT_ID,
    sub: 'a'.repeat(64),
    email: 'responsavel@verax.example',
    nonce: NONCE,
    iat: NOW_S,
    exp: NOW_S + 300,
    auth_time: NOW_S - 60,
    jti: opaque(),
    amr: ['pwd', 'otp'],
    ...overrides,
  } satisfies Partial<SsoIdTokenClaims> & Record<string, unknown>;
}

function signed(
  payload: Record<string, unknown> = claims(),
  header: Record<string, unknown> = { alg: 'EdDSA', typ: 'JWT', kid: CONSOLE.kid },
  key: KeyObject = CONSOLE.privateKey,
): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}

const expected: IdTokenExpectations = {
  publicKey: CONSOLE.publicKey,
  keyId: CONSOLE.kid,
  issuer: ISSUER,
  audience: SSO_CLIENT_ID,
  nonce: NONCE,
  now: NOW,
};

function reasonOf(token: string, overrides: Partial<IdTokenExpectations> = {}): string {
  const result = verifyIdToken(token, { ...expected, ...overrides });
  return result.ok ? 'ok' : result.reason;
}

describe('token de identidade da entrada única', () => {
  it('aceita o token do console, com as declarações', () => {
    const result = verifyIdToken(signed(), expected);
    expect(result.ok).toBe(true);
    expect(result.ok && result.claims.email).toBe('responsavel@verax.example');
  });

  it('assinado com outra chave Ed25519 (mesmo com o kid da fixada): recusado', () => {
    expect(
      reasonOf(signed(claims(), { alg: 'EdDSA', typ: 'JWT', kid: CONSOLE.kid }, ATTACKER.privateKey)),
    ).toBe('bad_signature');
    // E com o kid da chave do atacante: nem chega à assinatura.
    expect(
      reasonOf(signed(claims(), { alg: 'EdDSA', typ: 'JWT', kid: ATTACKER.kid }, ATTACKER.privateKey)),
    ).toBe('unknown_key');
  });

  it('`alg: none` (sem assinatura ou com ela vazia): recusado', () => {
    const header = b64({ alg: 'none', typ: 'JWT', kid: CONSOLE.kid });
    expect(reasonOf(`${header}.${b64(claims())}.`)).toBe('malformed');
    expect(reasonOf(`${header}.${b64(claims())}`)).toBe('malformed');
    expect(reasonOf(`${header}.${b64(claims())}.${b64('x')}`)).toBe('bad_header');
  });

  it('HS256 com a chave pública como segredo (a confusão de algoritmo): recusado', () => {
    for (const secret of [CONSOLE.x, Buffer.from(CONSOLE.x, 'base64url')]) {
      const header = b64({ alg: 'HS256', typ: 'JWT', kid: CONSOLE.kid });
      const input = `${header}.${b64(claims())}`;
      const mac = createHmac('sha256', secret).update(input).digest('base64url');
      expect(reasonOf(`${input}.${mac}`)).toBe('bad_header');
    }
    // Mesmo com o cabeçalho certo, um HMAC no lugar da assinatura não passa.
    const header = b64({ alg: 'EdDSA', typ: 'JWT', kid: CONSOLE.kid });
    const input = `${header}.${b64(claims())}`;
    const mac = createHmac('sha256', CONSOLE.x).update(input).digest('base64url');
    expect(reasonOf(`${input}.${mac}`)).toBe('bad_signature');
  });

  it('cabeçalho que aponta outra chave ou pede extensão (jku, jwk, x5u, crit, kid ausente): recusado', () => {
    const base = { alg: 'EdDSA', typ: 'JWT', kid: CONSOLE.kid };
    for (const extra of [
      { jku: 'https://evil.example/jwks' },
      { jwk: { kty: 'OKP', crv: 'Ed25519', x: ATTACKER.x } },
      { x5u: 'https://evil.example/cert' },
      { crit: ['exp'] },
    ]) {
      expect(reasonOf(signed(claims(), { ...base, ...extra })), JSON.stringify(extra)).toBe('bad_header');
    }
    expect(reasonOf(signed(claims(), { alg: 'EdDSA', typ: 'JWT' }))).toBe('bad_header');
    expect(reasonOf(signed(claims(), { alg: 'EdDSA', kid: CONSOLE.kid }))).toBe('bad_header');
    expect(reasonOf(signed(claims(), { alg: 'ES256', typ: 'JWT', kid: CONSOLE.kid }))).toBe('bad_header');
  });

  it('vencido, do futuro ou de vida longa demais: recusado', () => {
    expect(reasonOf(signed(claims({ iat: NOW_S - 400, exp: NOW_S - 100 })))).toBe('expired');
    expect(reasonOf(signed(claims({ iat: NOW_S + 120, exp: NOW_S + 300 })))).toBe('not_yet_valid');
    expect(reasonOf(signed(claims({ exp: NOW_S + 3600 })))).toBe('too_long_lived');
    expect(reasonOf(signed(claims({ exp: NOW_S })))).toBe('too_long_lived');
    // Dentro da folga de 30 s, ainda vale.
    expect(reasonOf(signed(claims({ iat: NOW_S - 310, exp: NOW_S - 10, auth_time: NOW_S - 400 })))).toBe(
      'ok',
    );
  });

  it('iss, aud (inclusive como lista), nonce ou amr errados: recusado', () => {
    expect(reasonOf(signed(claims({ iss: 'https://evil.example' })))).toBe('wrong_issuer');
    expect(reasonOf(signed(claims({ iss: `${ISSUER}/` })))).toBe('wrong_issuer');
    expect(reasonOf(signed(claims({ aud: 'outro-cliente' })))).toBe('wrong_audience');
    expect(reasonOf(signed(claims({ aud: [SSO_CLIENT_ID] })))).toBe('bad_claims');
    expect(reasonOf(signed(claims({ nonce: opaque() })))).toBe('wrong_nonce');
    expect(reasonOf(signed(claims({ amr: ['pwd'] })))).toBe('weak_authentication');
    expect(reasonOf(signed(claims({ amr: ['otp'] })))).toBe('weak_authentication');
    expect(reasonOf(signed(claims({ auth_time: NOW_S + 600 })))).toBe('bad_claims');
  });

  it('declaração a mais, faltando ou com tipo errado: recusado', () => {
    expect(reasonOf(signed(claims({ role: 'admin_verax' })))).toBe('bad_claims');
    const { email: _email, ...withoutEmail } = claims();
    expect(reasonOf(signed(withoutEmail))).toBe('bad_claims');
    expect(reasonOf(signed(claims({ exp: String(NOW_S + 300) })))).toBe('bad_claims');
    expect(reasonOf(signed(claims({ jti: 'curto' })))).toBe('bad_claims');
  });

  it('texto malformado: partes a mais, base64 com preenchimento, espaços, JSON que não é objeto, tamanho', () => {
    const token = signed();
    expect(reasonOf(`${token}.x`)).toBe('malformed');
    expect(reasonOf(`${token}=`)).toBe('malformed');
    expect(reasonOf(` ${token}`)).toBe('malformed');
    expect(reasonOf('a'.repeat(5000))).toBe('malformed');
    expect(reasonOf('')).toBe('malformed');
    const [header, payload] = token.split('.');
    const arrayPayload = b64([claims()]);
    const input = `${header}.${arrayPayload}`;
    expect(
      reasonOf(`${input}.${sign(null, Buffer.from(input), CONSOLE.privateKey).toString('base64url')}`),
    ).toBe('bad_claims');
    // Assinatura truncada.
    expect(reasonOf(`${header}.${payload}.${b64('curta')}`)).toBe('bad_signature');
  });

  it('o mesmo token com uma declaração trocada depois de assinado: recusado', () => {
    const [header, , signature] = signed().split('.');
    const forged = b64(claims({ email: 'outra-pessoa@verax.example' }));
    expect(reasonOf(`${header}.${forged}.${signature}`)).toBe('bad_signature');
  });
});

describe('a chave fixada no nó', () => {
  it('só uma chave pública Ed25519 de 32 bytes, no formato do JWKS', () => {
    expect(ed25519PublicKey(CONSOLE.x)?.type).toBe('public');
    for (const bad of [
      '',
      'curta',
      `${CONSOLE.x}=`,
      `${CONSOLE.x}A`,
      Buffer.alloc(31).toString('base64url'),
    ]) {
      expect(ed25519PublicKey(bad), bad).toBeUndefined();
    }
  });
});

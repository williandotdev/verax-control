import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_NODE_SYNC_AUDIENCE } from '../src/common/config/env.schema.js';
import { newEnrollmentSecret } from '../src/enrollment/enrollment.js';
import type { IdTokenKeySource } from '../src/internal/identity-token.js';
import {
  NodeIdentityVerifier,
  nodeSyncCredentialFromAuthorization,
  plausibleNodeIdentity,
} from '../src/node-sync/node-identity.js';
import { TestGoogleIdentity } from './support/access-fakes.js';
import { FakeClock } from './support/fake-clock.js';

const AUDIENCE = DEFAULT_NODE_SYNC_AUDIENCE;
const SA = 'vx-cliente-demo-a@projeto-dos-nos-demo.iam.gserviceaccount.com';
const SUB = '100000000000000000001';
const PROJECT = 'projeto-dos-nos-demo';
const INSTANCE = 'vx-cliente-demo-a';

function computeEngine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    google: {
      compute_engine: {
        project_id: PROJECT,
        project_number: 123456789012,
        zone: 'southamerica-east1-b',
        instance_id: '1234567890123456789',
        instance_name: INSTANCE,
        ...overrides,
      },
    },
  };
}

/** Um token do nó como o servidor de metadados entrega com `format=full`; `payload` estraga o que o teste quiser. */
function nodeToken(google: TestGoogleIdentity, payload: Record<string, unknown> = {}): string {
  return google.token({ email: SA, aud: AUDIENCE, payload: { sub: SUB, ...computeEngine(), ...payload } });
}

/** Um "Google" que troca de chave: a nova só aparece quando o verificador pede releitura. */
class RotatingKeys implements IdTokenKeySource {
  refreshes = 0;
  failing = false;

  constructor(
    private readonly before: TestGoogleIdentity,
    private readonly after: TestGoogleIdentity,
  ) {}

  async keys(refresh = false): Promise<Readonly<Record<string, string>>> {
    if (this.failing) throw new Error('certificados indisponíveis');
    const old = await this.before.keys();
    if (!refresh) return old;
    this.refreshes += 1;
    return { ...old, ...(await this.after.keys()) };
  }
}

/**
 * O token de identidade do nó gerenciado (`node-sync/node-identity.ts`): só assinado, pelas chaves do Google (com a
 * releitura numa rotação), o `aud` exato da rota, o `sub` de 21 dígitos, o prazo e as declarações do `format=full`.
 * As chaves e os tokens são gerados no teste; nada fala com o Google.
 */
describe('NodeIdentityVerifier (token do nó gerenciado)', () => {
  const google = new TestGoogleIdentity();
  const clock = new FakeClock(new Date());
  const verifier = new NodeIdentityVerifier(google, clock, AUDIENCE);

  it('aceita o token assinado do nó e devolve a conta, o projeto e o nome da VM', async () => {
    expect(await verifier.verify(nodeToken(google))).toEqual({
      ok: true,
      identity: { serviceAccountId: SUB, projectId: PROJECT, instanceName: INSTANCE },
    });
  });

  it('só assinado: a assinatura removida, vazia ou ausente é recusada', async () => {
    const [header, payload] = nodeToken(google).split('.');
    for (const token of [
      `${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`,
      `${header}.${payload}.`,
      `${header}.${payload}`,
    ]) {
      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        reason: expect.stringMatching(/signature_missing|malformed/) as unknown,
      });
    }
    expect(await verifier.verify(`${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`)).toEqual({
      ok: false,
      reason: 'signature_missing',
    });
  });

  it('outra audiência (até a mesma com barra no fim), outro emissor ou outra chave: recusado', async () => {
    for (const aud of [
      'https://conta.veraxsistemas.com.br/v1/node-enrollment/report',
      `${AUDIENCE}/`,
      'https://cp-worker-123456789012.southamerica-east1.run.app',
    ]) {
      const token = google.token({ email: SA, aud, payload: { sub: SUB, ...computeEngine() } });
      expect(await verifier.verify(token)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await verifier.verify(nodeToken(google, { iss: 'https://emissor.example' }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    const forged = google.token({
      email: SA,
      aud: AUDIENCE,
      payload: { sub: SUB, ...computeEngine() },
      signer: TestGoogleIdentity.otherSigner(),
    });
    expect(await verifier.verify(forged)).toEqual({ ok: false, reason: 'invalid' });
    expect(
      await verifier.verify(
        google.token({ email: SA, aud: AUDIENCE, header: { alg: 'HS256' }, payload: { sub: SUB } }),
      ),
    ).toEqual({ ok: false, reason: 'algorithm' });
    expect(
      await verifier.verify(
        google.token({ email: SA, aud: AUDIENCE, header: { kid: 'outra' }, payload: { sub: SUB } }),
      ),
    ).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('o sub tem 21 dígitos e o format=full traz o projeto e a VM', async () => {
    for (const sub of ['10000000000000000000', '1000000000000000000001', 'abcdefghijklmnopqrstu', 12345]) {
      expect(await verifier.verify(nodeToken(google, { sub }))).toEqual({ ok: false, reason: 'claims' });
    }
    // O format=standard (sem as declarações da VM) não serve.
    expect(await verifier.verify(nodeToken(google, { google: undefined }))).toEqual({
      ok: false,
      reason: 'claims',
    });
    expect(await verifier.verify(nodeToken(google, computeEngine({ instance_name: '' })))).toEqual({
      ok: false,
      reason: 'claims',
    });
  });

  it('vencido, emitido no futuro ou com vida de mais de 1 h: recusado', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifier.verify(nodeToken(google, { iat: now - 7200, exp: now - 3600 }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await verifier.verify(nodeToken(google, { iat: now + 3600, exp: now + 7200 }))).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await verifier.verify(nodeToken(google, { iat: now, exp: now + 4 * 3600 }))).toEqual({
      ok: false,
      reason: 'lifetime',
    });
    // O relógio do plano de controle também confere o prazo.
    const late = new NodeIdentityVerifier(
      google,
      new FakeClock(new Date(Date.now() + 2 * 3600_000)),
      AUDIENCE,
    );
    expect(await late.verify(nodeToken(google))).toEqual({ ok: false, reason: 'claims' });
  });

  it('rotação de chave: um kid novo relê as chaves uma vez; sem certificados, keys_unavailable', async () => {
    const next = new TestGoogleIdentity();
    const keys = new RotatingKeys(google, next);
    const rotating = new NodeIdentityVerifier(keys, clock, AUDIENCE);
    expect((await rotating.verify(nodeToken(next))).ok).toBe(true);
    expect(keys.refreshes).toBe(1);
    expect((await rotating.verify(nodeToken(google))).ok).toBe(true);
    expect(keys.refreshes).toBe(1);
    keys.failing = true;
    expect(await rotating.verify(nodeToken(google))).toEqual({ ok: false, reason: 'keys_unavailable' });
  });

  it('lixo e tamanho: malformed, sem decodificar nada grande', async () => {
    for (const token of [
      '',
      'a.b.c',
      'x'.repeat(5000),
      `${'a'.repeat(10)}.${'b'.repeat(10)}.${'c'.repeat(10)}`,
    ]) {
      const result = await verifier.verify(token);
      expect(result.ok).toBe(false);
    }
  });
});

describe('a credencial do nó no Authorization', () => {
  const google = new TestGoogleIdentity();

  it('a chave do nó (43 caracteres) ou um JWT assinado; o resto não é credencial', () => {
    const nodeKey = newEnrollmentSecret();
    expect(nodeSyncCredentialFromAuthorization(`Bearer ${nodeKey}`)).toEqual({ kind: 'node_key', nodeKey });
    const token = nodeToken(google);
    expect(nodeSyncCredentialFromAuthorization(`Bearer ${token}`)).toEqual({ kind: 'gcp_identity', token });
    expect(nodeSyncCredentialFromAuthorization(`bearer ${token}`)).toEqual({ kind: 'gcp_identity', token });
    const [header, payload] = token.split('.');
    for (const value of [
      undefined,
      ['Bearer a', 'Bearer b'],
      '',
      `Basic ${nodeKey}`,
      `Bearer ${nodeKey} extra`,
      `Bearer  ${nodeKey}`,
      'Bearer curta',
      `Bearer ${header}.${payload}`,
      `Bearer ${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`,
      `Bearer ${header}.${payload}.`,
      `Bearer ${header}.${payload}.sig.extra`,
      `Bearer ${'a'.repeat(4097)}`,
      `Bearer ${randomBytes(16).toString('base64')}`,
    ]) {
      expect(nodeSyncCredentialFromAuthorization(value)).toBeUndefined();
    }
  });

  it('a olhada barata do cp-public: aud, sub e prazo, sem a assinatura', () => {
    const now = new Date();
    expect(plausibleNodeIdentity(nodeToken(google), AUDIENCE, now)).toBe(true);
    expect(plausibleNodeIdentity(nodeToken(google), 'https://outra.example/v1/node-sync', now)).toBe(false);
    expect(plausibleNodeIdentity(nodeToken(google, { sub: '123' }), AUDIENCE, now)).toBe(false);
    expect(plausibleNodeIdentity(nodeToken(google), AUDIENCE, new Date(now.getTime() + 2 * 3600_000))).toBe(
      false,
    );
    const [header, payload] = nodeToken(google).split('.');
    expect(plausibleNodeIdentity(`${header}.${payload}.SIGNATURE_REMOVED_BY_GOOGLE`, AUDIENCE, now)).toBe(
      false,
    );
  });
});

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { NODE_SYNC_ENVELOPE_PATTERN } from '@verax/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CLOUDFLARE_OAUTH_SEAL_USES,
  CLOUDFLARE_OAUTH_TOKEN_MAX_LENGTH,
  type CloudflareOauthBinding,
  cloudflareOauthLabel,
  type CloudflareOauthTokens,
  CredentialVaultError,
  type EnvelopeKeySource,
  type EnvelopePublicKey,
  MAX_CIPHERTEXT_LENGTH,
  MAX_HYBRID_PLAINTEXT_BYTES,
  openCloudflareOauthCode,
  openCloudflareOauthTokens,
  openCloudflareOauthVerifier,
  openCredential,
  openEnvelope,
  sealCloudflareOauthCode,
  sealCloudflareOauthTokens,
  sealCloudflareOauthVerifier,
  sealCredential,
  sealEnvelope,
} from './index.js';

// Chaves e segredos gerados na hora: nenhum valor real, nada fixo no repositório.
const random = (bytes: number) => randomBytes(bytes).toString('base64url');
const binding = (): CloudflareOauthBinding => ({ tenantId: randomUUID(), subjectId: randomUUID() });
const tokens = (changes: Partial<CloudflareOauthTokens> = {}): CloudflareOauthTokens => ({
  accessToken: random(48),
  refreshToken: random(48),
  accessExpiresAt: new Date('2026-11-23T13:00:00.000Z'),
  ...changes,
});

function vaultError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof CredentialVaultError) return error.code;
    throw error;
  }
  throw new Error('a operação deveria ter falhado');
}

describe('cofre da conexão do Cloudflare por OAuth', () => {
  let publicV1: EnvelopePublicKey;
  let publicV2: EnvelopePublicKey;
  let public4096: EnvelopePublicKey;
  let keys: EnvelopeKeySource;

  beforeAll(() => {
    const pairs = [3072, 3072, 4096].map((modulusLength) => generateKeyPairSync('rsa', { modulusLength }));
    const [v1, v2, v3] = pairs;
    if (v1 === undefined || v2 === undefined || v3 === undefined) throw new Error('chaves de teste');
    publicV1 = { version: 1, key: v1.publicKey };
    publicV2 = { version: 2, key: v2.publicKey };
    public4096 = { version: 3, key: v3.publicKey };
    keys = { privateKey: (version) => pairs[version - 1]?.privateKey };
  }, 60_000);

  it('cifra e abre o verificador, o código e os tokens; o texto cifrado não mostra nada', () => {
    const subject = binding();
    const verifier = random(48);
    const code = `codigo.${random(24)}`;
    const pair = tokens();
    const sealed = [
      sealCloudflareOauthVerifier(publicV1, subject, verifier),
      sealCloudflareOauthCode(publicV1, subject, code),
      sealCloudflareOauthTokens(publicV1, subject, pair),
    ] as const;
    for (const envelope of sealed) {
      expect(NODE_SYNC_ENVELOPE_PATTERN.test(envelope)).toBe(true);
      for (const secret of [verifier, code, pair.accessToken, pair.refreshToken]) {
        expect(envelope).not.toContain(secret);
      }
    }
    expect(openCloudflareOauthVerifier(keys, subject, sealed[0])).toBe(verifier);
    expect(openCloudflareOauthCode(keys, subject, sealed[1])).toBe(code);
    expect(openCloudflareOauthTokens(keys, subject, sealed[2])).toEqual(pair);
  });

  it('tokens grandes (um JWT) usam o envelope híbrido e cabem na coluna; acima do teto, recusa', () => {
    const subject = binding();
    const big = tokens({ accessToken: 'a'.repeat(3500), refreshToken: 'r'.repeat(1500) });
    const envelope = sealCloudflareOauthTokens(public4096, subject, big);
    expect(envelope.length).toBeLessThanOrEqual(MAX_CIPHERTEXT_LENGTH);
    expect(openCloudflareOauthTokens(keys, subject, envelope)).toEqual(big);

    const half = 'a'.repeat(MAX_HYBRID_PLAINTEXT_BYTES / 2);
    expect(
      vaultError(() =>
        sealCloudflareOauthTokens(publicV1, subject, tokens({ accessToken: half, refreshToken: half })),
      ),
    ).toBe('plaintext_too_large');
    expect(
      vaultError(() =>
        sealCloudflareOauthTokens(
          publicV1,
          subject,
          tokens({ accessToken: 'a'.repeat(CLOUDFLARE_OAUTH_TOKEN_MAX_LENGTH + 1) }),
        ),
      ),
    ).toBe('secret_invalid');
  });

  it('a amarração: outro cliente, outra linha ou outro uso não abre', () => {
    const subject = binding();
    const envelope = sealCloudflareOauthTokens(publicV1, subject, tokens());
    for (const other of [
      { ...subject, tenantId: randomUUID() },
      { ...subject, subjectId: randomUUID() },
      { tenantId: subject.subjectId, subjectId: subject.tenantId },
    ]) {
      expect(vaultError(() => openCloudflareOauthTokens(keys, other, envelope))).toBe('decrypt_failed');
    }
    // O mesmo texto aberto como se fosse de outro uso.
    expect(vaultError(() => openCloudflareOauthCode(keys, subject, envelope))).toBe('decrypt_failed');
    expect(vaultError(() => openCloudflareOauthVerifier(keys, subject, envelope))).toBe('decrypt_failed');
    const code = sealCloudflareOauthCode(publicV1, subject, 'codigo-de-teste');
    expect(vaultError(() => openCloudflareOauthTokens(keys, subject, code))).toBe('decrypt_failed');
  });

  it('não se mistura com a credencial colada: um envelope não abre como o outro', () => {
    const tenantId = randomUUID();
    const cloudAccountId = randomUUID();
    const credential = {
      tenantId,
      cloudAccountId,
      kind: 'cloudflare_api_token',
      accountId: 'c'.repeat(32),
    } as const;
    const pasted = sealCredential(publicV1, credential, { t: random(30) }).ciphertext;
    const granted = sealCloudflareOauthCode(
      publicV1,
      { tenantId, subjectId: cloudAccountId },
      'codigo-de-teste',
    );
    expect(
      vaultError(() => openCloudflareOauthCode(keys, { tenantId, subjectId: cloudAccountId }, pasted)),
    ).toBe('decrypt_failed');
    expect(vaultError(() => openCredential(keys, credential, granted))).toBe('decrypt_failed');
  });

  it('o rótulo é exato, e amarração fora do formato é recusada antes de cifrar', () => {
    const subject = binding();
    for (const use of CLOUDFLARE_OAUTH_SEAL_USES) {
      expect(cloudflareOauthLabel(subject, use).toString('utf8')).toBe(
        `verax-cfoauth:v1:${subject.tenantId}:${subject.subjectId}:${use}`,
      );
    }
    for (const invalid of [
      { ...subject, tenantId: '' },
      { ...subject, subjectId: `${subject.subjectId}:tokens` },
      { ...subject, subjectId: subject.subjectId.toUpperCase() },
    ]) {
      expect(vaultError(() => sealCloudflareOauthTokens(publicV1, invalid, tokens()))).toBe(
        'binding_invalid',
      );
    }
    expect(vaultError(() => cloudflareOauthLabel(subject, 'outro' as never))).toBe('binding_invalid');
  });

  it('valor fora do formato é recusado ao cifrar, sem aparecer no erro', () => {
    const subject = binding();
    const refused = [
      () => sealCloudflareOauthVerifier(publicV1, subject, 'curto'),
      () => sealCloudflareOauthVerifier(publicV1, subject, 'v'.repeat(129)),
      () => sealCloudflareOauthCode(publicV1, subject, 'com espaço dentro'),
      () => sealCloudflareOauthTokens(publicV1, subject, tokens({ accessToken: 'linha\nquebrada-no-meio' })),
      () => sealCloudflareOauthTokens(publicV1, subject, tokens({ refreshToken: '' })),
      () => sealCloudflareOauthTokens(publicV1, subject, tokens({ accessExpiresAt: new Date(Number.NaN) })),
    ];
    for (const action of refused) expect(vaultError(action)).toBe('secret_invalid');
  });

  it('texto claro adulterado, versão ausente e híbrido no lugar do bloco do verificador falham fechado', () => {
    const subject = binding();
    const label = cloudflareOauthLabel(subject, 'tokens');
    for (const plaintext of ['não é json', '{}', '{"a":"x"}', JSON.stringify({ ...tokens(), z: 1 })]) {
      const forged = sealEnvelope(publicV1, label, Buffer.from(plaintext, 'utf8'));
      expect(vaultError(() => openCloudflareOauthTokens(keys, subject, forged))).toBe('payload_invalid');
    }
    const newer = sealCloudflareOauthTokens(publicV2, subject, tokens());
    expect(vaultError(() => openCloudflareOauthTokens({ privateKey: () => undefined }, subject, newer))).toBe(
      'key_version_missing',
    );
    const hybrid = sealEnvelope(
      publicV1,
      cloudflareOauthLabel(subject, 'verifier'),
      Buffer.from(JSON.stringify({ v: 'v'.repeat(400) }), 'utf8'),
    );
    expect(openEnvelope(keys, cloudflareOauthLabel(subject, 'verifier'), hybrid).length).toBeGreaterThan(0);
    expect(vaultError(() => openCloudflareOauthVerifier(keys, subject, hybrid))).toBe('decrypt_failed');
  });
});

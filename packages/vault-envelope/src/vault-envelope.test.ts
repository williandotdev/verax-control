import { generateKeyPairSync, type KeyObject, randomBytes, randomUUID } from 'node:crypto';
import { NODE_SYNC_ENVELOPE_PATTERN } from '@verax/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type CredentialBinding,
  CredentialVaultError,
  emailDigest,
  type EnvelopeKeySource,
  envelopeVersion,
  generateTemporaryPassword,
  MAX_CIPHERTEXT_LENGTH,
  MAX_PLAINTEXT_BYTES,
  oaepLabel,
  openCredential,
  openEnvelope,
  openUserPassword,
  publicKeyFingerprint,
  sealCredential,
  sealEnvelope,
  sealUserPassword,
  type UserPasswordBinding,
  userPasswordLabel,
  vaultPublicKeyFromPem,
} from './index.js';

// Chaves e segredos gerados na hora: nenhum valor real, nada fixo no repositório.
interface TestKey {
  publicKey: KeyObject;
  privateKey: KeyObject;
}
const rsa = (bits: number): TestKey => generateKeyPairSync('rsa', { modulusLength: bits });
const publicPem = (key: TestKey) => key.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keysOf = (entries: Record<number, TestKey>): EnvelopeKeySource => ({
  privateKey: (version) => entries[version]?.privateKey,
});
const cloudflareToken = () => randomBytes(30).toString('base64url');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const awsKeyId = () => `AKIA${Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('')}`;
const awsSecret = () => randomBytes(30).toString('base64');
const ulid = () =>
  `01JD${Array.from(randomBytes(22), (byte) => '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.charAt(byte % 32)).join('')}`;

function vaultError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof CredentialVaultError) return error.code;
    throw error;
  }
  throw new Error('a operação deveria ter falhado');
}

describe('envelope do cofre', () => {
  let v1: TestKey;
  let v2: TestKey;
  let cloudflare: CredentialBinding;

  beforeAll(() => {
    v1 = rsa(3072);
    v2 = rsa(3072);
    cloudflare = {
      tenantId: randomUUID(),
      cloudAccountId: randomUUID(),
      kind: 'cloudflare_api_token',
      accountId: 'a'.repeat(32),
    };
  });

  it('cifra com o PEM e a versão, e abre com a privada da versão', () => {
    const token = cloudflareToken();
    const sealed = sealCredential(vaultPublicKeyFromPem(publicPem(v1), 7), cloudflare, { t: token });
    expect(sealed.keyVersion).toBe(7);
    expect(sealed.ciphertext).toMatch(/^v7:[A-Za-z0-9+/]{512}$/);
    expect(sealed.ciphertext).not.toContain(token);
    // O formato do envelope é o que o contrato da sincronização aceita.
    expect(NODE_SYNC_ENVELOPE_PATTERN.test(sealed.ciphertext)).toBe(true);
    expect(envelopeVersion(sealed.ciphertext)).toBe(7);
    expect(openCredential(keysOf({ 7: v1 }), cloudflare, sealed.ciphertext)).toEqual({
      kind: 'cloudflare_api_token',
      payload: { t: token },
    });
    expect(vaultError(() => openCredential(keysOf({ 1: v1 }), cloudflare, sealed.ciphertext))).toBe(
      'key_version_missing',
    );
    expect(vaultError(() => openCredential(keysOf({ 7: v2 }), cloudflare, sealed.ciphertext))).toBe(
      'decrypt_failed',
    );
  });

  it('as três credenciais: AWS no bloco do RSA, GCP no envelope híbrido', () => {
    const publicKey = vaultPublicKeyFromPem(publicPem(v1), 1);
    const tenantId = randomUUID();
    const aws: CredentialBinding = {
      tenantId,
      cloudAccountId: randomUUID(),
      kind: 'aws_access_key',
      accountId: '111111111111',
    };
    const payload = { i: awsKeyId(), s: awsSecret() };
    const sealedAws = sealCredential(publicKey, aws, payload);
    expect(Buffer.from(sealedAws.ciphertext.slice(3), 'base64')).toHaveLength(384);
    expect(openCredential(keysOf({ 1: v1 }), aws, sealedAws.ciphertext).payload).toEqual(payload);

    const gcp: CredentialBinding = {
      tenantId,
      cloudAccountId: randomUUID(),
      kind: 'gcp_service_account_key',
      accountId: 'cliente-demo-a',
    };
    const gcpPayload = {
      p: 'cliente-demo-a',
      e: 'verax-control-reader@cliente-demo-a.iam.gserviceaccount.com',
      d: randomBytes(20).toString('hex'),
      k: generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    };
    const sealedGcp = sealCredential(publicKey, gcp, gcpPayload);
    expect(sealedGcp.ciphertext.length).toBeGreaterThan(384 * 2);
    expect(sealedGcp.ciphertext.length).toBeLessThanOrEqual(MAX_CIPHERTEXT_LENGTH);
    expect(NODE_SYNC_ENVELOPE_PATTERN.test(sealedGcp.ciphertext)).toBe(true);
    expect(openCredential(keysOf({ 1: v1 }), gcp, sealedGcp.ciphertext).payload).toEqual(gcpPayload);
    expect(
      vaultError(() =>
        openCredential(keysOf({ 1: v1 }), { ...gcp, cloudAccountId: randomUUID() }, sealedGcp.ciphertext),
      ),
    ).toBe('decrypt_failed');
  });

  it('a amarração vale: outro cliente, conta, tipo ou ID no provedor não abre', () => {
    const sealed = sealCredential(vaultPublicKeyFromPem(publicPem(v1), 1), cloudflare, {
      t: cloudflareToken(),
    });
    for (const binding of [
      { ...cloudflare, tenantId: randomUUID() },
      { ...cloudflare, cloudAccountId: randomUUID() },
      { ...cloudflare, accountId: 'b'.repeat(32) },
    ]) {
      expect(vaultError(() => openCredential(keysOf({ 1: v1 }), binding, sealed.ciphertext))).toBe(
        'decrypt_failed',
      );
    }
    expect(oaepLabel(cloudflare).toString('utf8')).toBe(
      `verax-cred:v1:${cloudflare.tenantId}:${cloudflare.cloudAccountId}:cloudflare_api_token:${'a'.repeat(32)}`,
    );
    expect(vaultError(() => oaepLabel({ ...cloudflare, tenantId: cloudflare.tenantId.toUpperCase() }))).toBe(
      'binding_invalid',
    );
  });

  it('o texto claro precisa ser o do tipo da amarração, antes de cifrar', () => {
    const publicKey = vaultPublicKeyFromPem(publicPem(v1), 1);
    for (const payload of [
      { t: 'curto' },
      { t: cloudflareToken(), extra: 1 },
      { i: awsKeyId(), s: awsSecret() },
    ]) {
      expect(vaultError(() => sealCredential(publicKey, cloudflare, payload as { t: string }))).toBe(
        'secret_invalid',
      );
    }
  });

  it('a chave pública: só a pública RSA de 3072 a 4096 bits, com versão válida', () => {
    expect(vaultError(() => vaultPublicKeyFromPem(publicPem(rsa(2048)), 1))).toBe('public_key_invalid');
    expect(
      vaultError(() =>
        vaultPublicKeyFromPem(v1.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 1),
      ),
    ).toBe('public_key_invalid');
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(
      vaultError(() =>
        vaultPublicKeyFromPem(ec.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 1),
      ),
    ).toBe('public_key_invalid');
    expect(vaultError(() => vaultPublicKeyFromPem('lixo', 1))).toBe('public_key_invalid');
    for (const version of [0, 1_000_000_000, 1.5]) {
      expect(vaultError(() => vaultPublicKeyFromPem(publicPem(v1), version))).toBe('public_key_invalid');
    }
    // A privada no lugar da pública também é recusada por quem cifra direto.
    expect(
      vaultError(() => sealEnvelope({ version: 1, key: v1.privateKey }, Buffer.from('x'), Buffer.from('y'))),
    ).toBe('public_key_invalid');
    expect(vaultPublicKeyFromPem(publicPem(rsa(4096)), 999_999_999).version).toBe(999_999_999);
  });

  it('impressão digital: SHA-256 do DER do SPKI, igual pelo PEM, pela pública e pela privada', () => {
    const fingerprint = publicKeyFingerprint(publicPem(v1));
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(publicKeyFingerprint(v1.publicKey)).toBe(fingerprint);
    expect(publicKeyFingerprint(v1.privateKey)).toBe(fingerprint);
    expect(publicKeyFingerprint(publicPem(v2))).not.toBe(fingerprint);
    expect(
      vaultError(() =>
        publicKeyFingerprint(v1.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
      ),
    ).toBe('public_key_invalid');
  });

  it('o envelope só de RSA recusa o texto maior que o bloco e não abre o híbrido', () => {
    const publicKey = vaultPublicKeyFromPem(publicPem(v1), 1);
    const label = Buffer.from('rótulo de teste', 'utf8');
    expect(
      vaultError(() =>
        sealEnvelope(publicKey, label, Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 0x41), { rsaOnly: true }),
      ),
    ).toBe('plaintext_too_large');
    const hybrid = sealEnvelope(publicKey, label, Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 0x41));
    expect(openEnvelope(keysOf({ 1: v1 }), label, hybrid)).toHaveLength(MAX_PLAINTEXT_BYTES + 1);
    expect(vaultError(() => openEnvelope(keysOf({ 1: v1 }), label, hybrid, { rsaOnly: true }))).toBe(
      'decrypt_failed',
    );
  });
});

describe('senha temporária do usuário criado pela Verax', () => {
  let key: TestKey;
  let binding: UserPasswordBinding;

  beforeAll(() => {
    key = rsa(3072);
    binding = { nodeTenantId: randomUUID(), requestId: ulid(), email: 'Pessoa@Cliente-Demo-A.example' };
  });

  it('cifra e abre a senha; o rótulo leva o hash do e-mail em minúsculas, nunca o endereço', () => {
    const password = generateTemporaryPassword();
    const envelope = sealUserPassword(vaultPublicKeyFromPem(publicPem(key), 3), binding, password);
    expect(envelope).toMatch(/^v3:[A-Za-z0-9+/]{512}$/);
    expect(NODE_SYNC_ENVELOPE_PATTERN.test(envelope)).toBe(true);
    expect(envelope).not.toContain(password);
    expect(openUserPassword(keysOf({ 3: key }), binding, envelope)).toBe(password);

    const label = userPasswordLabel(binding).toString('utf8');
    expect(label).toBe(
      `verax-user:v1:${binding.nodeTenantId}:${binding.requestId}:${emailDigest('pessoa@cliente-demo-a.example')}`,
    );
    expect(label.toLowerCase()).not.toContain('pessoa');
    expect(emailDigest('pessoa@cliente-demo-a.example')).toMatch(/^[0-9a-f]{64}$/);
    // O e-mail com outra caixa é o mesmo e-mail.
    expect(
      openUserPassword(keysOf({ 3: key }), { ...binding, email: 'pessoa@cliente-demo-a.example' }, envelope),
    ).toBe(password);
  });

  it('outro cliente, outro pedido ou outro e-mail não abre', () => {
    const envelope = sealUserPassword(
      vaultPublicKeyFromPem(publicPem(key), 1),
      binding,
      generateTemporaryPassword(),
    );
    for (const other of [
      { ...binding, nodeTenantId: randomUUID() },
      { ...binding, requestId: ulid() },
      { ...binding, email: 'outra@cliente-demo-a.example' },
    ]) {
      expect(vaultError(() => openUserPassword(keysOf({ 1: key }), other, envelope))).toBe('decrypt_failed');
    }
    // O envelope de usuário também não abre como credencial, nem o contrário.
    const credential: CredentialBinding = {
      tenantId: binding.nodeTenantId,
      cloudAccountId: randomUUID(),
      kind: 'cloudflare_api_token',
      accountId: 'a'.repeat(32),
    };
    expect(vaultError(() => openCredential(keysOf({ 1: key }), credential, envelope))).toBe('decrypt_failed');
    const sealed = sealCredential(vaultPublicKeyFromPem(publicPem(key), 1), credential, {
      t: cloudflareToken(),
    });
    expect(vaultError(() => openUserPassword(keysOf({ 1: key }), binding, sealed.ciphertext))).toBe(
      'decrypt_failed',
    );
  });

  it('amarração e senha fora do formato são recusadas antes de cifrar', () => {
    const publicKey = vaultPublicKeyFromPem(publicPem(key), 1);
    for (const other of [
      { ...binding, nodeTenantId: 'não-é-uuid' },
      { ...binding, requestId: 'curto' },
      { ...binding, email: 'não é e-mail' },
    ]) {
      expect(vaultError(() => sealUserPassword(publicKey, other, generateTemporaryPassword()))).toBe(
        'binding_invalid',
      );
    }
    for (const password of ['curta', 'com espaço no meio!!', 'x'.repeat(65), `${'x'.repeat(20)}\n`]) {
      expect(vaultError(() => sealUserPassword(publicKey, binding, password))).toBe('secret_invalid');
    }
  });

  it('a geradora: quatro grupos de cinco, sem caracteres ambíguos', () => {
    const passwords = Array.from({ length: 50 }, generateTemporaryPassword);
    for (const password of passwords) {
      const groups = password.split('-');
      expect(groups).toHaveLength(4);
      for (const group of groups) expect(group).toMatch(/^[A-HJ-NP-Za-km-z2-9]{5}$/);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
  });
});

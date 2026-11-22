import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
  generateTemporaryPassword,
  openCredential,
  openUserPassword,
  publicKeyFingerprint,
  sealCredential,
  sealUserPassword,
  vaultPublicKeyFromPem,
} from '@verax/vault-envelope';
import { beforeAll, describe, expect, it } from 'vitest';
import { parsePrivateKeys, parsePublicKey, type VaultKeyring } from './credential-keys.js';
import {
  AwsAccessKey,
  CloudflareToken,
  credentialBinding,
  GcpServiceAccountKey,
  open,
  reseal,
  seal,
} from './credential-vault.js';

/**
 * O envelope que o plano de controle cifra com o `@verax/vault-envelope` (só com o PEM da chave pública e a versão) é o
 * mesmo que o worker do nó abre com o `open` de sempre, e vice-versa. Chaves e segredos gerados na hora.
 */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const awsKeyId = () => `AKIA${Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('')}`;

describe('envelope do cofre entre o pacote e a API do nó', () => {
  let publicPem: string;
  let keyring: VaultKeyring;
  let nextKeyring: VaultKeyring;
  const tenantId = randomUUID();

  beforeAll(() => {
    const v1 = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const v2 = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const private64 = (key: typeof v1) =>
      Buffer.from(key.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    publicPem = v1.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    keyring = parsePrivateKeys(`1:${private64(v1)}`, 1);
    nextKeyring = parsePrivateKeys(`1:${private64(v1)}\n2:${private64(v2)}`, 2);
  });

  it('o token do Cloudflare cifrado pelo pacote abre no worker, e o da API abre pelo pacote', () => {
    const binding = credentialBinding(
      { id: randomUUID(), tenantId, provider: 'cloudflare', accountId: 'a'.repeat(32) },
      'cloudflare_api_token',
    );
    const token = randomBytes(30).toString('base64url');
    const sealed = sealCredential(vaultPublicKeyFromPem(publicPem, 1), binding, { t: token });
    const opened = open(keyring, binding, sealed.ciphertext);
    expect(opened).toBeInstanceOf(CloudflareToken);
    expect((opened as CloudflareToken).value()).toBe(token);

    const fromApi = seal(parsePublicKey(Buffer.from(publicPem).toString('base64'), 1), binding, opened);
    expect(openCredential(keyring, binding, fromApi.ciphertext)).toEqual({
      kind: 'cloudflare_api_token',
      payload: { t: token },
    });
    // A recifragem do worker também lê o envelope do pacote.
    const rekeyed = reseal(nextKeyring, binding, sealed.ciphertext);
    expect(rekeyed?.keyVersion).toBe(2);
    expect((open(nextKeyring, binding, rekeyed?.ciphertext ?? '') as CloudflareToken).value()).toBe(token);
  });

  it('as chaves de leitura da VM (AWS no bloco do RSA, GCP no híbrido) abrem no worker', () => {
    const publicKey = vaultPublicKeyFromPem(publicPem, 1);
    const aws = credentialBinding(
      { id: randomUUID(), tenantId, provider: 'aws', accountId: '111111111111' },
      'aws_access_key',
    );
    const awsPayload = { i: awsKeyId(), s: randomBytes(30).toString('base64') };
    const awsOpened = open(
      keyring,
      aws,
      sealCredential(publicKey, aws, awsPayload).ciphertext,
    ) as AwsAccessKey;
    expect(awsOpened).toBeInstanceOf(AwsAccessKey);
    expect([awsOpened.accessKeyId, awsOpened.secret()]).toEqual([awsPayload.i, awsPayload.s]);

    const gcp = credentialBinding(
      { id: randomUUID(), tenantId, provider: 'gcp', accountId: 'cliente-demo-a' },
      'gcp_service_account_key',
    );
    const gcpPayload = {
      p: 'cliente-demo-a',
      e: 'verax-control-reader@cliente-demo-a.iam.gserviceaccount.com',
      d: randomBytes(20).toString('hex'),
      k: generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    };
    const gcpOpened = open(
      keyring,
      gcp,
      sealCredential(publicKey, gcp, gcpPayload).ciphertext,
    ) as GcpServiceAccountKey;
    expect(gcpOpened).toBeInstanceOf(GcpServiceAccountKey);
    expect(gcpOpened.privateKey()).toBe(gcpPayload.k);
  });

  it('o chaveiro do worker abre a senha do usuário, e a impressão digital é a da chave corrente', () => {
    const binding = {
      nodeTenantId: tenantId,
      requestId: '01JD0000000000000000000001',
      email: 'pessoa@cliente-demo-a.example',
    };
    const password = generateTemporaryPassword();
    const envelope = sealUserPassword(vaultPublicKeyFromPem(publicPem, 1), binding, password);
    expect(openUserPassword(keyring, binding, envelope)).toBe(password);
    expect(publicKeyFingerprint(keyring.publicKey().key)).toBe(publicKeyFingerprint(publicPem));
  });
});

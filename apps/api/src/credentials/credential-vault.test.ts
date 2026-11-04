import {
  constants,
  generateKeyPairSync,
  type KeyObject,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { inspect } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import { REDACTED, scrubString } from '../common/logger/sanitize.js';
import {
  CredentialKeyError,
  parsePrivateKeys,
  parsePublicKey,
  VaultKeyring,
  type VaultPublicKey,
} from './credential-keys.js';
import {
  type CredentialBinding,
  CloudflareToken,
  CredentialVaultError,
  credentialBinding,
  envelopeVersion,
  MAX_PLAINTEXT_BYTES,
  oaepLabel,
  open,
  reseal,
  seal,
  StaticAwsCredentials,
} from './credential-vault.js';

// Chaves e segredos gerados na hora: nenhum valor real, nada fixo no repositório.
interface TestKey {
  publicKey: KeyObject;
  privateKey: KeyObject;
}
const rsa = (bits: number): TestKey => generateKeyPairSync('rsa', { modulusLength: bits });
const privatePem64 = (key: TestKey) =>
  Buffer.from(key.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const publicPem64 = (key: TestKey) =>
  Buffer.from(key.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
const awsSecret = () => randomBytes(30).toString('base64');
const cloudflareToken = () => randomBytes(30).toString('base64url');
const accessKeyId = (suffix = 'WXYZ') => `AKIA${'Q7'.repeat(6)}${suffix}`;

function vaultError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof CredentialVaultError) return error.code;
    throw error;
  }
  throw new Error('a operação deveria ter falhado');
}

describe('cofre de credenciais', () => {
  let v1: TestKey;
  let v2: TestKey;
  let publicV1: VaultPublicKey;
  let publicV2: VaultPublicKey;
  let onlyV1: VaultKeyring;
  let bothCurrentV2: VaultKeyring;
  let onlyV2: VaultKeyring;
  let aws: CredentialBinding;
  let cloudflare: CredentialBinding;

  beforeAll(() => {
    v1 = rsa(3072);
    v2 = rsa(3072);
    publicV1 = parsePublicKey(publicPem64(v1), 1);
    publicV2 = parsePublicKey(publicPem64(v2), 2);
    onlyV1 = parsePrivateKeys(`1:${privatePem64(v1)}`, 1);
    bothCurrentV2 = parsePrivateKeys(`1:${privatePem64(v1)},2:${privatePem64(v2)}`, 2);
    onlyV2 = parsePrivateKeys(`2:${privatePem64(v2)}`, 2);
    const tenantId = randomUUID();
    aws = credentialBinding(
      { id: randomUUID(), tenantId, provider: 'aws', accountId: '111111111111' },
      'aws_access_key',
    );
    cloudflare = credentialBinding(
      { id: randomUUID(), tenantId, provider: 'cloudflare', accountId: 'a'.repeat(32) },
      'cloudflare_api_token',
    );
  });

  it('cifra e abre a chave da AWS e o token do Cloudflare; o envelope leva a versão da chave', () => {
    const secret = awsSecret();
    const sealed = seal(publicV1, aws, new StaticAwsCredentials(accessKeyId(), secret));
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).toMatch(/^v1:[A-Za-z0-9+/]{512}$/);
    expect(sealed.ciphertext).not.toContain(secret);
    const opened = open(onlyV1, aws, sealed.ciphertext);
    expect(opened).toBeInstanceOf(StaticAwsCredentials);
    expect((opened as StaticAwsCredentials).identity()).toEqual({
      accessKeyId: accessKeyId(),
      secretAccessKey: secret,
    });
    expect((opened as StaticAwsCredentials).keyIdSuffix).toBe('WXYZ');

    const token = cloudflareToken();
    const sealedToken = seal(publicV1, cloudflare, new CloudflareToken(token));
    const openedToken = open(onlyV1, cloudflare, sealedToken.ciphertext);
    expect(openedToken).toBeInstanceOf(CloudflareToken);
    expect((openedToken as CloudflareToken).value()).toBe(token);
  });

  it('o mesmo segredo cifrado duas vezes dá textos diferentes (OAEP é aleatório)', () => {
    const credentials = new StaticAwsCredentials(accessKeyId(), awsSecret());
    expect(seal(publicV1, aws, credentials).ciphertext).not.toBe(seal(publicV1, aws, credentials).ciphertext);
  });

  it('a API não decifra: a chave pública não abre o texto e não entra no lugar das privadas', () => {
    const sealed = seal(publicV1, aws, new StaticAwsCredentials(accessKeyId(), awsSecret()));
    const body = Buffer.from(sealed.ciphertext.slice(3), 'base64');
    // O que a API tem é só a pública: o RSA não decifra com ela.
    expect(() =>
      privateDecrypt(
        {
          key: publicV1.key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
          oaepLabel: oaepLabel(aws),
        },
        body,
      ),
    ).toThrow();
    expect(() => new VaultKeyring(new Map([[1, publicV1.key]]), 1)).toThrow(CredentialKeyError);
    expect(() => parsePrivateKeys(`1:${publicPem64(v1)}`, 1)).toThrow(CredentialKeyError);
  });

  it('a linha copiada para outro cliente, outra conta, outro tipo ou outro ID no provedor não abre', () => {
    const sealed = seal(publicV1, aws, new StaticAwsCredentials(accessKeyId(), awsSecret()));
    const others: CredentialBinding[] = [
      { ...aws, tenantId: randomUUID() },
      { ...aws, cloudAccountId: randomUUID() },
      { ...aws, kind: 'cloudflare_api_token' },
      { ...aws, accountId: '222222222222' },
    ];
    for (const binding of others) {
      expect(vaultError(() => open(onlyV1, binding, sealed.ciphertext))).toBe('decrypt_failed');
    }
    // A amarração certa continua abrindo.
    expect(open(onlyV1, aws, sealed.ciphertext)).toBeInstanceOf(StaticAwsCredentials);
  });

  it('texto adulterado, cortado ou fora do envelope não abre', () => {
    const { ciphertext } = seal(publicV1, aws, new StaticAwsCredentials(accessKeyId(), awsSecret()));
    const body = Buffer.from(ciphertext.slice(3), 'base64');
    body[100] = (body[100] ?? 0) ^ 0x01;
    expect(vaultError(() => open(onlyV1, aws, `v1:${body.toString('base64')}`))).toBe('decrypt_failed');
    expect(vaultError(() => open(onlyV1, aws, ciphertext.slice(0, -8)))).toBe('decrypt_failed');
    for (const envelope of [
      ciphertext.slice(3),
      `v0:${ciphertext.slice(3)}`,
      `V1:${ciphertext.slice(3)}`,
      `v1:${ciphertext.slice(3)}\n`,
      `v1:${'A'.repeat(1100)}`,
      '',
    ]) {
      expect(vaultError(() => open(onlyV1, aws, envelope))).toBe('envelope_invalid');
    }
  });

  it('versão ausente falha fechado; o envelope que mente a versão também', () => {
    const { ciphertext } = seal(publicV1, aws, new StaticAwsCredentials(accessKeyId(), awsSecret()));
    expect(vaultError(() => open(onlyV2, aws, ciphertext))).toBe('key_version_missing');
    expect(vaultError(() => open(onlyV2, aws, ciphertext.replace(/^v1:/, 'v2:')))).toBe('decrypt_failed');
    expect(vaultError(() => open(onlyV1, aws, ciphertext.replace(/^v1:/, 'v9:')))).toBe(
      'key_version_missing',
    );
  });

  it('troca da v1 para a v2: recifra na corrente, e a linha nova abre sem a v1', () => {
    const secret = awsSecret();
    const old = seal(publicV1, aws, new StaticAwsCredentials(accessKeyId(), secret));
    const rekeyed = reseal(bothCurrentV2, aws, old.ciphertext);
    expect(rekeyed?.keyVersion).toBe(2);
    expect(envelopeVersion(rekeyed?.ciphertext ?? '')).toBe(2);
    const opened = open(onlyV2, aws, rekeyed?.ciphertext ?? '') as StaticAwsCredentials;
    expect(opened.identity().secretAccessKey).toBe(secret);
    // Já na corrente: nada a fazer. A pública da corrente é a da v2.
    expect(reseal(bothCurrentV2, aws, rekeyed?.ciphertext ?? '')).toBeNull();
    expect(bothCurrentV2.publicKey().version).toBe(2);
    expect(
      bothCurrentV2
        .publicKey()
        .key.export({ type: 'spki', format: 'der' })
        .equals(publicV2.key.export({ type: 'spki', format: 'der' })),
    ).toBe(true);
    // A recifragem também amarra: com outra conta, não abre nem recifra.
    expect(
      vaultError(() => reseal(bothCurrentV2, { ...aws, cloudAccountId: randomUUID() }, old.ciphertext)),
    ).toBe('decrypt_failed');
  });

  it('texto claro no limite: o RSA-3072 com OAEP-SHA256 cifra 318 bytes, não 319, e a maior credencial cabe', () => {
    const options = {
      key: publicV1.key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      oaepLabel: oaepLabel(aws),
    };
    expect(() => publicEncrypt(options, Buffer.alloc(MAX_PLAINTEXT_BYTES, 0x41))).not.toThrow();
    expect(() => publicEncrypt(options, Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 0x41))).toThrow();
    // A maior credencial aceita: o token de 255 caracteres (o JSON tem 263 bytes) e a chave da AWS (75 bytes).
    const longest = 'x'.repeat(255);
    expect(Buffer.byteLength(JSON.stringify({ t: longest }))).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
    const sealed = seal(publicV1, cloudflare, new CloudflareToken(longest));
    expect((open(onlyV1, cloudflare, sealed.ciphertext) as CloudflareToken).value()).toBe(longest);
    expect(Buffer.byteLength(JSON.stringify({ i: accessKeyId(), s: awsSecret() }))).toBe(75);
  });

  it('zod ao abrir: texto claro fora do formato do tipo não abre', () => {
    const encrypt = (binding: CredentialBinding, plaintext: string) =>
      `v1:${publicEncrypt(
        {
          key: publicV1.key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
          oaepLabel: oaepLabel(binding),
        },
        Buffer.from(plaintext, 'utf8'),
      ).toString('base64')}`;
    const secret = awsSecret();
    for (const plaintext of [
      JSON.stringify({ t: cloudflareToken() }),
      JSON.stringify({ i: accessKeyId(), s: secret, extra: 1 }),
      JSON.stringify({ i: `ASIA${'Q7'.repeat(8)}`, s: secret }),
      JSON.stringify({ i: accessKeyId(), s: `${secret}\nx` }),
      JSON.stringify([accessKeyId(), secret]),
      'não é JSON',
    ]) {
      expect(vaultError(() => open(onlyV1, aws, encrypt(aws, plaintext)))).toBe('payload_invalid');
    }
    expect(
      vaultError(() => open(onlyV1, cloudflare, encrypt(cloudflare, JSON.stringify({ t: 'curto demais' })))),
    ).toBe('payload_invalid');
  });

  it('segredo fora do formato é recusado antes de cifrar', () => {
    expect(vaultError(() => new StaticAwsCredentials(`ASIA${'Q7'.repeat(8)}`, awsSecret()))).toBe(
      'secret_invalid',
    );
    expect(vaultError(() => new StaticAwsCredentials(accessKeyId(), 'curto'))).toBe('secret_invalid');
    expect(vaultError(() => new StaticAwsCredentials(accessKeyId(), `${awsSecret().slice(1)}\n`))).toBe(
      'secret_invalid',
    );
    expect(vaultError(() => new CloudflareToken(`${cloudflareToken()} x`))).toBe('secret_invalid');
    expect(vaultError(() => new CloudflareToken('x'.repeat(256)))).toBe('secret_invalid');
  });

  it('o tipo da credencial é o do provedor da conta, e a amarração não aceita separador nem ID inválido', () => {
    const account = { id: randomUUID(), tenantId: randomUUID(), accountId: 'projeto-de-teste' };
    expect(vaultError(() => credentialBinding({ ...account, provider: 'gcp' }, 'aws_access_key'))).toBe(
      'binding_invalid',
    );
    expect(vaultError(() => credentialBinding({ ...account, provider: 'aws' }, 'cloudflare_api_token'))).toBe(
      'binding_invalid',
    );
    // Um token do Cloudflare não entra numa amarração da AWS.
    expect(vaultError(() => seal(publicV1, aws, new CloudflareToken(cloudflareToken())))).toBe(
      'binding_invalid',
    );
    for (const binding of [
      { ...aws, accountId: '1111:2222' },
      { ...aws, tenantId: 'não-é-uuid' },
      { ...aws, kind: 'outro' as CredentialBinding['kind'] },
    ]) {
      expect(vaultError(() => oaepLabel(binding))).toBe('binding_invalid');
    }
  });

  it('os invólucros não viram JSON, texto nem inspeção, e o segredo vivo some de qualquer texto de log', () => {
    const secret = awsSecret();
    const token = cloudflareToken();
    const credentials = new StaticAwsCredentials(accessKeyId(), secret);
    const cloudflareSecret = new CloudflareToken(token);
    const views = [
      JSON.stringify({ credentials, cloudflareSecret }),
      String(credentials),
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- o teste confere a interpolação
      `${cloudflareSecret}`,
      inspect({ credentials, cloudflareSecret }, { depth: 5, showHidden: true }),
      Object.keys(credentials).join(','),
    ];
    for (const view of views) {
      expect(view).not.toContain(secret);
      expect(view).not.toContain(token);
    }
    expect(JSON.stringify(credentials)).toBe('"[credencial da AWS]"');
    expect(String(cloudflareSecret)).toBe('[token do Cloudflare]');
    // Decifrado no processo, o segredo passa a ser ocultado pelo logger mesmo sem nome de campo.
    expect(scrubString(`a AWS recusou ${secret} e o Cloudflare ${token}`)).toBe(
      `a AWS recusou ${REDACTED} e o Cloudflare ${REDACTED}`,
    );
  });

  it('os erros do cofre levam só o código', () => {
    const secret = awsSecret();
    const { ciphertext } = seal(publicV1, aws, new StaticAwsCredentials(accessKeyId(), secret));
    for (const action of [
      () => open(onlyV2, aws, ciphertext),
      () => open(onlyV1, { ...aws, tenantId: randomUUID() }, ciphertext),
    ]) {
      try {
        action();
      } catch (error) {
        expect((error as Error).message).toMatch(/^cofre de credenciais: [a-z_]+$/);
        expect(inspect(error)).not.toContain(ciphertext.slice(3, 40));
      }
    }
  });
});

describe('chaves do cofre', () => {
  let key: TestKey;

  beforeAll(() => {
    key = rsa(3072);
  });

  function keyError(action: () => unknown): string {
    try {
      action();
    } catch (error) {
      if (error instanceof CredentialKeyError) return error.message;
      throw error;
    }
    throw new Error('a leitura da chave deveria ter falhado');
  }

  it('a chave pública da API: PEM em base64, RSA de 3072 a 4096 bits; recusa a privada no lugar dela', () => {
    expect(parsePublicKey(publicPem64(key), 7).version).toBe(7);
    expect(keyError(() => parsePublicKey(privatePem64(key), 1))).toBe(
      'a API recebe só a chave pública do cofre; a privada fica só no worker',
    );
    expect(keyError(() => parsePublicKey(publicPem64(rsa(2048)), 1))).toBe(
      'a chave RSA deve ter de 3072 a 4096 bits',
    );
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(keyError(() => parsePublicKey(publicPem64(ec), 1))).toBe('deve ser uma chave pública RSA');
    expect(keyError(() => parsePublicKey('não é base64', 1))).toBe('deve ser o PEM da chave em base64');
    expect(keyError(() => parsePublicKey(Buffer.from('lixo').toString('base64'), 1))).toBe(
      'deve ser uma chave pública em PEM (BEGIN PUBLIC KEY)',
    );
    expect(keyError(() => parsePublicKey(publicPem64(key), 0))).toBe(
      'a versão da chave deve ser um inteiro positivo',
    );
  });

  it('as privadas do worker: uma por versão, com a corrente entre elas, sem repetir versão', () => {
    const other = rsa(3072);
    const keyring = parsePrivateKeys(`3:${privatePem64(key)},5:${privatePem64(other)}`, 5);
    expect(keyring.versions).toEqual([3, 5]);
    expect(keyring.current).toBe(5);
    expect(keyring.privateKey(4)).toBeUndefined();
    expect(keyError(() => parsePrivateKeys(`3:${privatePem64(key)}`, 5))).toBe(
      'a versão corrente precisa estar entre as chaves privadas',
    );
    expect(keyError(() => parsePrivateKeys(`3:${privatePem64(key)},3:${privatePem64(other)}`, 3))).toBe(
      'a versão 3 aparece mais de uma vez',
    );
    expect(keyError(() => parsePrivateKeys(privatePem64(key), 1))).toBe(
      'cada item deve ser <versão>:<PEM da chave privada em base64>',
    );
    expect(keyError(() => parsePrivateKeys(`1:${privatePem64(rsa(2048))}`, 1))).toBe(
      'versão 1: a chave RSA deve ter de 3072 a 4096 bits',
    );
  });

  it('o chaveiro não vira JSON, texto nem inspeção', () => {
    const keyring = parsePrivateKeys(`1:${privatePem64(key)}`, 1);
    const pem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const body = pem.split('\n')[1] ?? '';
    for (const view of [
      JSON.stringify({ keyring }),
      String(keyring),
      inspect({ keyring }, { showHidden: true }),
    ]) {
      expect(view).not.toContain(body);
    }
    expect(JSON.stringify(keyring)).toBe('"[chaves privadas do cofre]"');
  });
});

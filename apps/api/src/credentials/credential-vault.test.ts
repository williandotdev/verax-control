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
  AwsAccessKey,
  type CredentialBinding,
  CloudflareToken,
  GcpServiceAccountKey,
  CREDENTIAL_KIND_PROVIDER,
  CredentialVaultError,
  credentialBinding,
  envelopeVersion,
  MAX_CIPHERTEXT_LENGTH,
  MAX_PLAINTEXT_BYTES,
  oaepLabel,
  open,
  reseal,
  seal,
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
const cloudflareToken = () => randomBytes(30).toString('base64url');
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const awsKeyId = () => `AKIA${Array.from(randomBytes(16), (byte) => BASE32.charAt(byte % 32)).join('')}`;
const awsSecret = () => randomBytes(30).toString('base64');
const gcpFields = () => ({
  projectId: 'cliente-demo-a',
  clientEmail: 'verax-control-reader@cliente-demo-a.iam.gserviceaccount.com',
  privateKeyId: randomBytes(20).toString('hex'),
  privateKey: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
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

describe('cofre de credenciais', () => {
  let v1: TestKey;
  let v2: TestKey;
  let publicV1: VaultPublicKey;
  let publicV2: VaultPublicKey;
  let onlyV1: VaultKeyring;
  let bothCurrentV2: VaultKeyring;
  let onlyV2: VaultKeyring;
  let cloudflare: CredentialBinding;

  beforeAll(() => {
    v1 = rsa(3072);
    v2 = rsa(3072);
    publicV1 = parsePublicKey(publicPem64(v1), 1);
    publicV2 = parsePublicKey(publicPem64(v2), 2);
    onlyV1 = parsePrivateKeys(`1:${privatePem64(v1)}`, 1);
    bothCurrentV2 = parsePrivateKeys(`1:${privatePem64(v1)}\n2:${privatePem64(v2)}`, 2);
    onlyV2 = parsePrivateKeys(`2:${privatePem64(v2)}`, 2);
    cloudflare = credentialBinding(
      { id: randomUUID(), tenantId: randomUUID(), provider: 'cloudflare', accountId: 'a'.repeat(32) },
      'cloudflare_api_token',
    );
  });

  it('cifra e abre o token do Cloudflare; o envelope leva a versão da chave', () => {
    const token = cloudflareToken();
    const sealed = seal(publicV1, cloudflare, new CloudflareToken(token));
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).toMatch(/^v1:[A-Za-z0-9+/]{512}$/);
    expect(sealed.ciphertext).not.toContain(token);
    const opened = open(onlyV1, cloudflare, sealed.ciphertext) as CloudflareToken;
    expect(opened).toBeInstanceOf(CloudflareToken);
    expect(opened.value()).toBe(token);
  });

  it('o mesmo segredo cifrado duas vezes dá textos diferentes (OAEP é aleatório)', () => {
    const token = new CloudflareToken(cloudflareToken());
    expect(seal(publicV1, cloudflare, token).ciphertext).not.toBe(
      seal(publicV1, cloudflare, token).ciphertext,
    );
  });

  it('a API não decifra: a chave pública não abre o texto e não entra no lugar das privadas', () => {
    const sealed = seal(publicV1, cloudflare, new CloudflareToken(cloudflareToken()));
    const body = Buffer.from(sealed.ciphertext.slice(3), 'base64');
    // O que a API tem é só a pública: o RSA não decifra com ela.
    expect(() =>
      privateDecrypt(
        {
          key: publicV1.key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
          oaepLabel: oaepLabel(cloudflare),
        },
        body,
      ),
    ).toThrow();
    expect(() => new VaultKeyring(new Map([[1, publicV1.key]]), 1)).toThrow(CredentialKeyError);
    expect(() => parsePrivateKeys(`1:${publicPem64(v1)}`, 1)).toThrow(CredentialKeyError);
  });

  it('a linha copiada para outro cliente, outra conta ou outro ID no provedor não abre', () => {
    const sealed = seal(publicV1, cloudflare, new CloudflareToken(cloudflareToken()));
    const others: CredentialBinding[] = [
      { ...cloudflare, tenantId: randomUUID() },
      { ...cloudflare, cloudAccountId: randomUUID() },
      { ...cloudflare, accountId: 'b'.repeat(32) },
    ];
    for (const binding of others) {
      expect(vaultError(() => open(onlyV1, binding, sealed.ciphertext))).toBe('decrypt_failed');
    }
    // A amarração certa continua abrindo.
    expect(open(onlyV1, cloudflare, sealed.ciphertext)).toBeInstanceOf(CloudflareToken);
  });

  it('texto adulterado, cortado ou fora do envelope não abre', () => {
    const { ciphertext } = seal(publicV1, cloudflare, new CloudflareToken(cloudflareToken()));
    const body = Buffer.from(ciphertext.slice(3), 'base64');
    body[100] = (body[100] ?? 0) ^ 0x01;
    expect(vaultError(() => open(onlyV1, cloudflare, `v1:${body.toString('base64')}`))).toBe(
      'decrypt_failed',
    );
    expect(vaultError(() => open(onlyV1, cloudflare, ciphertext.slice(0, -8)))).toBe('decrypt_failed');
    for (const envelope of [
      ciphertext.slice(3),
      `v0:${ciphertext.slice(3)}`,
      `V1:${ciphertext.slice(3)}`,
      `v1:${ciphertext.slice(3)}\n`,
      `v1:${'A'.repeat(8200)}`,
      '',
    ]) {
      expect(vaultError(() => open(onlyV1, cloudflare, envelope))).toBe('envelope_invalid');
    }
  });

  it('versão ausente falha fechado; o envelope que mente a versão também', () => {
    const { ciphertext } = seal(publicV1, cloudflare, new CloudflareToken(cloudflareToken()));
    expect(vaultError(() => open(onlyV2, cloudflare, ciphertext))).toBe('key_version_missing');
    expect(vaultError(() => open(onlyV2, cloudflare, ciphertext.replace(/^v1:/, 'v2:')))).toBe(
      'decrypt_failed',
    );
    expect(vaultError(() => open(onlyV1, cloudflare, ciphertext.replace(/^v1:/, 'v9:')))).toBe(
      'key_version_missing',
    );
  });

  it('troca da v1 para a v2: recifra na corrente, e a linha nova abre sem a v1', () => {
    const token = cloudflareToken();
    const old = seal(publicV1, cloudflare, new CloudflareToken(token));
    const rekeyed = reseal(bothCurrentV2, cloudflare, old.ciphertext);
    expect(rekeyed?.keyVersion).toBe(2);
    expect(envelopeVersion(rekeyed?.ciphertext ?? '')).toBe(2);
    expect((open(onlyV2, cloudflare, rekeyed?.ciphertext ?? '') as CloudflareToken).value()).toBe(token);
    // Já na corrente: nada a fazer. A pública da corrente é a da v2.
    expect(reseal(bothCurrentV2, cloudflare, rekeyed?.ciphertext ?? '')).toBeNull();
    expect(bothCurrentV2.publicKey().version).toBe(2);
    expect(
      bothCurrentV2
        .publicKey()
        .key.export({ type: 'spki', format: 'der' })
        .equals(publicV2.key.export({ type: 'spki', format: 'der' })),
    ).toBe(true);
    // A recifragem também amarra: com outra conta, não abre nem recifra.
    expect(
      vaultError(() =>
        reseal(bothCurrentV2, { ...cloudflare, cloudAccountId: randomUUID() }, old.ciphertext),
      ),
    ).toBe('decrypt_failed');
  });

  it('texto claro no limite: o RSA-3072 com OAEP-SHA256 cifra 318 bytes, não 319, e o maior token cabe', () => {
    const options = {
      key: publicV1.key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      oaepLabel: oaepLabel(cloudflare),
    };
    expect(() => publicEncrypt(options, Buffer.alloc(MAX_PLAINTEXT_BYTES, 0x41))).not.toThrow();
    expect(() => publicEncrypt(options, Buffer.alloc(MAX_PLAINTEXT_BYTES + 1, 0x41))).toThrow();
    // O maior token aceito: 255 caracteres e dois `=` (o JSON tem 265 bytes).
    const longest = `${'x'.repeat(255)}==`;
    expect(Buffer.byteLength(JSON.stringify({ t: longest }))).toBeLessThanOrEqual(MAX_PLAINTEXT_BYTES);
    const sealed = seal(publicV1, cloudflare, new CloudflareToken(longest));
    expect((open(onlyV1, cloudflare, sealed.ciphertext) as CloudflareToken).value()).toBe(longest);
  });

  it('zod ao abrir: texto claro fora do formato não abre, nem o de outro tipo', () => {
    const encrypt = (plaintext: string) =>
      `v1:${publicEncrypt(
        {
          key: publicV1.key,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
          oaepLabel: oaepLabel(cloudflare),
        },
        Buffer.from(plaintext, 'utf8'),
      ).toString('base64')}`;
    for (const plaintext of [
      JSON.stringify({ t: cloudflareToken(), extra: 1 }),
      JSON.stringify({ t: 'curto demais' }),
      JSON.stringify({ t: `${cloudflareToken()}\nx` }),
      // O formato do texto claro da chave da AWS, amarrado como token do Cloudflare: não abre.
      JSON.stringify({ i: awsKeyId(), s: awsSecret() }),
      JSON.stringify([cloudflareToken()]),
      'não é JSON',
    ]) {
      expect(vaultError(() => open(onlyV1, cloudflare, encrypt(plaintext)))).toBe('payload_invalid');
    }
  });

  it('segredo fora do formato é recusado antes de cifrar', () => {
    expect(vaultError(() => new CloudflareToken(`${cloudflareToken()} x`))).toBe('secret_invalid');
    expect(vaultError(() => new CloudflareToken('x'.repeat(256)))).toBe('secret_invalid');
    expect(vaultError(() => new CloudflareToken(`${cloudflareToken()}\n`))).toBe('secret_invalid');
  });

  it('formatos nos limites: de 20 a 255 caracteres no token, com até dois = no fim', () => {
    // Os formatos são os mesmos que `open` aplica ao texto decifrado (a régua é uma só).
    const bearerOf = (length: number) => 'aZ9._~+/-'.repeat(Math.ceil(length / 9)).slice(0, length);
    for (const token of [bearerOf(20), bearerOf(255), `${bearerOf(255)}==`, `${bearerOf(20)}=`]) {
      expect(new CloudflareToken(token).value()).toBe(token);
    }
    for (const token of [
      bearerOf(19),
      bearerOf(256),
      `${bearerOf(20)}===`,
      `${bearerOf(20)}=x`,
      `=${bearerOf(20)}`,
    ]) {
      expect(vaultError(() => new CloudflareToken(token))).toBe('secret_invalid');
    }
  });

  it('o tipo da credencial é o do provedor da conta', () => {
    expect(CREDENTIAL_KIND_PROVIDER).toEqual({
      cloudflare_api_token: 'cloudflare',
      aws_access_key: 'aws',
      gcp_service_account_key: 'gcp',
    });
    const account = { id: randomUUID(), tenantId: randomUUID(), accountId: '111122223333' };
    for (const provider of ['aws', 'gcp'] as const) {
      expect(vaultError(() => credentialBinding({ ...account, provider }, 'cloudflare_api_token'))).toBe(
        'binding_invalid',
      );
    }
    expect(vaultError(() => credentialBinding({ ...account, provider: 'gcp' }, 'aws_access_key'))).toBe(
      'binding_invalid',
    );
    expect(
      vaultError(() => credentialBinding({ ...account, provider: 'aws' }, 'gcp_service_account_key')),
    ).toBe('binding_invalid');
    for (const binding of [
      { ...cloudflare, accountId: 'aaaa:bbbb' },
      { ...cloudflare, tenantId: 'não-é-uuid' },
      { ...cloudflare, kind: 'outro' as CredentialBinding['kind'] },
    ]) {
      expect(vaultError(() => oaepLabel(binding))).toBe('binding_invalid');
    }
  });

  it('o invólucro não vira JSON, texto nem inspeção, e o segredo vivo some de qualquer texto de log', () => {
    const token = cloudflareToken();
    const cloudflareSecret = new CloudflareToken(token);
    const views = [
      JSON.stringify({ cloudflareSecret }),
      String(cloudflareSecret),
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions -- o teste confere a interpolação
      `${cloudflareSecret}`,
      inspect({ cloudflareSecret }, { depth: 5, showHidden: true }),
      Object.keys(cloudflareSecret).join(','),
    ];
    for (const view of views) expect(view).not.toContain(token);
    expect(JSON.stringify(cloudflareSecret)).toBe('"[token do Cloudflare]"');
    expect(String(cloudflareSecret)).toBe('[token do Cloudflare]');
    // Decifrado no processo, o segredo passa a ser ocultado pelo logger mesmo sem nome de campo.
    expect(scrubString(`o Cloudflare recusou ${token}`)).toBe(`o Cloudflare recusou ${REDACTED}`);
  });

  describe('as chaves de leitura da VM própria do cliente', () => {
    let aws: CredentialBinding;
    let gcp: CredentialBinding;

    beforeAll(() => {
      const tenantId = randomUUID();
      aws = credentialBinding(
        { id: randomUUID(), tenantId, provider: 'aws', accountId: '111111111111' },
        'aws_access_key',
      );
      gcp = credentialBinding(
        { id: randomUUID(), tenantId, provider: 'gcp', accountId: 'cliente-demo-a' },
        'gcp_service_account_key',
      );
    });

    it('a chave da AWS cabe no bloco do RSA e abre com o ID e o segredo', () => {
      const keyId = awsKeyId();
      const secret = awsSecret();
      const sealed = seal(publicV1, aws, new AwsAccessKey(keyId, secret));
      // Só o bloco do RSA-3072 (384 bytes), sem o envelope híbrido.
      expect(Buffer.from(sealed.ciphertext.slice(3), 'base64')).toHaveLength(384);
      const opened = open(onlyV1, aws, sealed.ciphertext);
      expect(opened).toBeInstanceOf(AwsAccessKey);
      expect((opened as AwsAccessKey).accessKeyId).toBe(keyId);
      expect((opened as AwsAccessKey).secret()).toBe(secret);
      // Amarrada a outra conta ou como token do Cloudflare, não abre.
      expect(vaultError(() => open(onlyV1, { ...aws, accountId: '222222222222' }, sealed.ciphertext))).toBe(
        'decrypt_failed',
      );
      expect(
        vaultError(() => open(onlyV1, { ...aws, kind: 'cloudflare_api_token' }, sealed.ciphertext)),
      ).toBe('decrypt_failed');
    });

    it('a chave da conta de serviço vai no envelope híbrido, que cabe na coluna, abre e é recifrado', () => {
      const fields = gcpFields();
      const sealed = seal(publicV1, gcp, new GcpServiceAccountKey(fields));
      expect(sealed.ciphertext).toMatch(/^v1:[A-Za-z0-9+/]+={0,2}$/);
      expect(sealed.ciphertext.length).toBeGreaterThan(384 * 2);
      expect(sealed.ciphertext.length).toBeLessThanOrEqual(MAX_CIPHERTEXT_LENGTH);
      const opened = open(onlyV1, gcp, sealed.ciphertext) as GcpServiceAccountKey;
      expect(opened).toBeInstanceOf(GcpServiceAccountKey);
      expect({
        projectId: opened.projectId,
        clientEmail: opened.clientEmail,
        privateKeyId: opened.privateKeyId,
        privateKey: opened.privateKey(),
      }).toEqual(fields);
      // Recifrada na v2, abre sem a v1; com a RSA-4096, o envelope continua na coluna.
      const resealed = reseal(bothCurrentV2, gcp, sealed.ciphertext);
      expect(resealed?.keyVersion).toBe(2);
      expect((open(onlyV2, gcp, resealed?.ciphertext ?? '') as GcpServiceAccountKey).privateKey()).toBe(
        fields.privateKey,
      );
      const big = rsa(4096);
      const sealed4096 = seal(
        parsePublicKey(publicPem64(big), 3),
        gcp,
        new GcpServiceAccountKey(gcpFields()),
      );
      expect(sealed4096.ciphertext.length).toBeLessThanOrEqual(MAX_CIPHERTEXT_LENGTH);
      expect(open(parsePrivateKeys(`3:${privatePem64(big)}`, 3), gcp, sealed4096.ciphertext)).toBeInstanceOf(
        GcpServiceAccountKey,
      );
    });

    it('o envelope híbrido adulterado, cortado ou amarrado a outra conta não abre', () => {
      const { ciphertext } = seal(publicV1, gcp, new GcpServiceAccountKey(gcpFields()));
      const body = Buffer.from(ciphertext.slice(3), 'base64');
      const flipped = (index: number) => {
        const copy = Buffer.from(body);
        copy[index] = (copy[index] ?? 0) ^ 0x01;
        return `v1:${copy.toString('base64')}`;
      };
      // A chave AES, o IV, a etiqueta e o texto: qualquer bit trocado falha fechado.
      for (const index of [10, 384 + 2, 384 + 12 + 3, body.length - 1]) {
        expect(vaultError(() => open(onlyV1, gcp, flipped(index)))).toBe('decrypt_failed');
      }
      expect(vaultError(() => open(onlyV1, gcp, `v1:${body.subarray(0, 384 + 20).toString('base64')}`))).toBe(
        'decrypt_failed',
      );
      expect(vaultError(() => open(onlyV1, { ...gcp, accountId: 'cliente-demo-b' }, ciphertext))).toBe(
        'decrypt_failed',
      );
      expect(vaultError(() => open(onlyV1, { ...gcp, cloudAccountId: randomUUID() }, ciphertext))).toBe(
        'decrypt_failed',
      );
    });

    it('segredos fora do formato são recusados antes de cifrar, e os invólucros não viram texto', () => {
      expect(vaultError(() => new AwsAccessKey(`ASIA${awsKeyId().slice(4)}`, awsSecret()))).toBe(
        'secret_invalid',
      );
      expect(vaultError(() => new AwsAccessKey(awsKeyId(), awsSecret().slice(1)))).toBe('secret_invalid');
      expect(vaultError(() => new GcpServiceAccountKey({ ...gcpFields(), privateKey: 'x' }))).toBe(
        'secret_invalid',
      );
      expect(
        vaultError(
          () =>
            new GcpServiceAccountKey({
              ...gcpFields(),
              clientEmail: 'service-1@gcp-sa-logging.iam.gserviceaccount.com',
            }),
        ),
      ).toBe('secret_invalid');
      const secret = awsSecret();
      const key = new AwsAccessKey(awsKeyId(), secret);
      const fields = gcpFields();
      const serviceAccount = new GcpServiceAccountKey(fields);
      const body = fields.privateKey.split('\n')[3] ?? '';
      expect(body.length).toBeGreaterThan(40);
      for (const view of [
        JSON.stringify({ key, serviceAccount }),
        String(key),
        String(serviceAccount),
        inspect({ key, serviceAccount }, { depth: 5, showHidden: true }),
      ]) {
        expect(view).not.toContain(secret);
        expect(view).not.toContain(body);
      }
      expect(scrubString(`a AWS recusou ${secret}`)).toBe(`a AWS recusou ${REDACTED}`);
    });
  });

  it('os erros do cofre levam só o código', () => {
    const { ciphertext } = seal(publicV1, cloudflare, new CloudflareToken(cloudflareToken()));
    for (const action of [
      () => open(onlyV2, cloudflare, ciphertext),
      () => open(onlyV1, { ...cloudflare, tenantId: randomUUID() }, ciphertext),
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
    // Uma versão por linha, como o start.sh escreve o arquivo; a linha em branco do fim é ignorada.
    const keyring = parsePrivateKeys(`3:${privatePem64(key)}\n5:${privatePem64(other)}\n`, 5);
    expect(keyring.versions).toEqual([3, 5]);
    expect(keyring.current).toBe(5);
    expect(keyring.privateKey(4)).toBeUndefined();
    expect(keyError(() => parsePrivateKeys(`3:${privatePem64(key)}`, 5))).toBe(
      'a versão corrente precisa estar entre as chaves privadas',
    );
    expect(keyError(() => parsePrivateKeys(`3:${privatePem64(key)}\n3:${privatePem64(other)}`, 3))).toBe(
      'a versão 3 aparece mais de uma vez',
    );
    expect(keyError(() => parsePrivateKeys(privatePem64(key), 1))).toBe(
      'cada linha deve ser <versão>:<PEM da chave privada em base64>',
    );
    expect(keyError(() => parsePrivateKeys(`1:${privatePem64(key)},2:${privatePem64(other)}`, 1))).toBe(
      'cada linha deve ser <versão>:<PEM da chave privada em base64>',
    );
    expect(keyError(() => parsePrivateKeys('\n\n', 1))).toBe('o arquivo das chaves privadas está vazio');
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

import { inspect } from 'node:util';
import type { GcpServiceAccountKeyFields } from '@verax/shared';
import {
  awsCredentialPayloadSchema,
  cloudflareCredentialPayloadSchema,
  type CredentialBinding,
  CREDENTIAL_KIND_PROVIDER,
  CredentialVaultError,
  type CredentialPayload,
  envelopeVersion,
  gcpCredentialPayloadSchema,
  type OpenedCredential,
  openCredential,
  type SealedCredential,
  sealCredential,
} from '@verax/vault-envelope';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import type { CloudCredentialKind, CloudProvider } from '../generated/prisma/enums.js';
import type { VaultKeyring, VaultPublicKey } from './credential-keys.js';

/**
 * Cofre de credenciais do nó (fase 2, PR-V1): o token só de leitura do Cloudflare e, só na VM própria do cliente
 * (`NODE_PLATFORM=vm`), a chave de acesso do usuário IAM de leitura da AWS e a chave da conta de serviço de leitura da
 * GCP (`docs/ARQUITETURA.md`, "Cofre de credenciais"). Nos nós da GCP, a AWS e a GCP são lidas sem chave, e a API
 * recusa os dois tipos.
 *
 * - `seal` cifra com a chave pública. É o que a API faz quando o admin cola a credencial: ela não tem a privada, então
 *   uma execução remota de código nela não abre o que já está guardado.
 * - `open` decifra com as chaves privadas e só existe no worker.
 * - O rótulo do OAEP (`oaepLabel`) amarra o texto ao cliente, à conta, ao tipo e ao ID da conta no provedor: uma linha
 *   copiada para outra conta ou outro cliente, ou trocada de tipo, não abre.
 * - O envelope é `v<versão da chave>:<base64>`. Versão que o worker não tem (desativada ou destruída) falha fechado.
 * - O texto claro é o mínimo, em JSON de chave curta (`{t}` no Cloudflare, `{i,s}` na AWS, `{p,e,d,k}` na GCP),
 *   conferido com zod ao abrir. Até 318 bytes (o que o RSA-3072 com OAEP-SHA256 cifra de uma vez), o base64 é só o
 *   bloco do RSA-OAEP. Maior que isso (a chave da conta de serviço da GCP, com o PEM da RSA-2048), o envelope é
 *   híbrido: uma chave AES-256-GCM aleatória cifrada com a RSA do nó (o mesmo rótulo do OAEP), o IV, a etiqueta e o
 *   texto cifrado, com o rótulo também como dado autenticado. O tamanho do bloco do RSA separa os dois; o formato do
 *   envelope (e o CHECK do banco) não muda.
 * - O que sai de `open` (e o que a API monta com o que foi colado) são invólucros que se recusam a virar JSON ou texto
 *   e registram o segredo no logger, que passa a ocultá-lo em qualquer linha (`registerLiveSecret`).
 *
 * Os erros levam só um código (`CredentialVaultError.code`), nunca o segredo, o texto cifrado ou a chave.
 *
 * O envelope em si (rótulo, cifra, formato e o texto claro de cada tipo) mora no `@verax/vault-envelope`, que o plano
 * de controle também usa para cifrar para o nó; aqui ficam os invólucros e as funções que a API e o worker chamam.
 */

export {
  CLOUDFLARE_API_TOKEN,
  CREDENTIAL_KIND_PROVIDER,
  type CredentialBinding,
  credentialBinding,
  CredentialVaultError,
  type CredentialVaultErrorCode,
  envelopeVersion,
  MAX_CIPHERTEXT_LENGTH,
  MAX_HYBRID_PLAINTEXT_BYTES,
  MAX_PLAINTEXT_BYTES,
  oaepLabel,
  type SealedCredential,
} from '@verax/vault-envelope';

/** O enum do banco e a lista do contrato andam juntos: um tipo novo no banco sem provedor aqui não compila. */
const _kindProviderOfDatabase: Readonly<Record<CloudCredentialKind, CloudProvider>> =
  CREDENTIAL_KIND_PROVIDER;

const HIDDEN_CLOUDFLARE = '[token do Cloudflare]';

/** Token só de leitura do Cloudflare. O valor só sai por `value()`, para o header da requisição. */
export class CloudflareToken {
  readonly #token: string;

  constructor(token: string) {
    if (!cloudflareCredentialPayloadSchema.safeParse({ t: token }).success)
      throw new CredentialVaultError('secret_invalid');
    registerLiveSecret(token);
    this.#token = token;
  }

  get kind(): 'cloudflare_api_token' {
    return 'cloudflare_api_token';
  }

  value(): string {
    return this.#token;
  }

  toJSON(): string {
    return HIDDEN_CLOUDFLARE;
  }

  toString(): string {
    return HIDDEN_CLOUDFLARE;
  }

  [inspect.custom](): string {
    return HIDDEN_CLOUDFLARE;
  }
}

const HIDDEN_AWS = '[chave de acesso da AWS]';

/**
 * Chave de acesso do usuário IAM de leitura (a VM própria do cliente). O ID da chave não é segredo (vai para o
 * `keyIdSuffix` e aparece no CloudTrail do cliente); o segredo só sai por `secret()`, para os clientes da AWS.
 */
export class AwsAccessKey {
  readonly accessKeyId: string;
  readonly #secret: string;

  constructor(accessKeyId: string, secretAccessKey: string) {
    if (!awsCredentialPayloadSchema.safeParse({ i: accessKeyId, s: secretAccessKey }).success) {
      throw new CredentialVaultError('secret_invalid');
    }
    registerLiveSecret(secretAccessKey);
    this.accessKeyId = accessKeyId;
    this.#secret = secretAccessKey;
  }

  get kind(): 'aws_access_key' {
    return 'aws_access_key';
  }

  secret(): string {
    return this.#secret;
  }

  toJSON(): string {
    return HIDDEN_AWS;
  }

  toString(): string {
    return HIDDEN_AWS;
  }

  [inspect.custom](): string {
    return HIDDEN_AWS;
  }
}

const HIDDEN_GCP = '[chave da conta de serviço da GCP]';

/**
 * Chave da conta de serviço de leitura da GCP (a VM própria do cliente). O projeto, o e-mail e o ID da chave não são
 * segredo; a chave privada só sai por `privateKey()`, para assinar o pedido do token ao Google.
 */
export class GcpServiceAccountKey {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKeyId: string;
  readonly #privateKey: string;

  constructor(fields: GcpServiceAccountKeyFields) {
    const parsed = gcpCredentialPayloadSchema.safeParse({
      p: fields.projectId,
      e: fields.clientEmail,
      d: fields.privateKeyId,
      k: fields.privateKey,
    });
    if (!parsed.success) throw new CredentialVaultError('secret_invalid');
    registerLiveSecret(fields.privateKey);
    this.projectId = fields.projectId;
    this.clientEmail = fields.clientEmail;
    this.privateKeyId = fields.privateKeyId;
    this.#privateKey = fields.privateKey;
  }

  get kind(): 'gcp_service_account_key' {
    return 'gcp_service_account_key';
  }

  privateKey(): string {
    return this.#privateKey;
  }

  toJSON(): string {
    return HIDDEN_GCP;
  }

  toString(): string {
    return HIDDEN_GCP;
  }

  [inspect.custom](): string {
    return HIDDEN_GCP;
  }
}

/** O que o cofre guarda. Um tipo novo de credencial entra aqui como mais um invólucro. */
export type VaultSecret = CloudflareToken | AwsAccessKey | GcpServiceAccountKey;

/** O valor secreto do invólucro: o que o logger oculta enquanto ele vale. */
function secretOf(credential: VaultSecret): string {
  if (credential instanceof AwsAccessKey) return credential.secret();
  if (credential instanceof GcpServiceAccountKey) return credential.privateKey();
  return credential.value();
}

/**
 * A API acabou de usar a credencial colada (conferir e cifrar): o logger deixa de guardar o valor dela
 * (`forgetLiveSecret`). Só a API chama, no fim da requisição; o worker mantém o que decifrou.
 */
export function releaseSecret(credential: VaultSecret): void {
  forgetLiveSecret(secretOf(credential));
}

function payloadOf(credential: VaultSecret): CredentialPayload {
  if (credential instanceof AwsAccessKey) {
    return { i: credential.accessKeyId, s: credential.secret() };
  }
  if (credential instanceof GcpServiceAccountKey) {
    return {
      p: credential.projectId,
      e: credential.clientEmail,
      d: credential.privateKeyId,
      k: credential.privateKey(),
    };
  }
  return { t: credential.value() };
}

/** O invólucro do texto claro já aberto e conferido pelo tipo da amarração. */
function secretFrom(opened: OpenedCredential): VaultSecret {
  switch (opened.kind) {
    case 'cloudflare_api_token':
      return new CloudflareToken(opened.payload.t);
    case 'aws_access_key':
      return new AwsAccessKey(opened.payload.i, opened.payload.s);
    case 'gcp_service_account_key':
      return new GcpServiceAccountKey({
        projectId: opened.payload.p,
        clientEmail: opened.payload.e,
        privateKeyId: opened.payload.d,
        privateKey: opened.payload.k,
      });
  }
}

/** Cifra a credencial com a chave pública do nó, amarrada à conta. */
export function seal(
  publicKey: VaultPublicKey,
  binding: CredentialBinding,
  credential: VaultSecret,
): SealedCredential {
  if (credential.kind !== binding.kind) throw new CredentialVaultError('binding_invalid');
  return sealCredential(publicKey, binding, payloadOf(credential));
}

/** Decifra a credencial (só o worker tem as chaves privadas). Qualquer divergência falha fechado. */
export function open(keyring: VaultKeyring, binding: CredentialBinding, ciphertext: string): VaultSecret {
  return secretFrom(openCredential(keyring, binding, ciphertext));
}

/**
 * Recifra com a versão corrente (tarefa `credential-rekey` do worker). Devolve `null` quando o texto já está na
 * versão corrente ou numa mais nova.
 */
export function reseal(
  keyring: VaultKeyring,
  binding: CredentialBinding,
  ciphertext: string,
): SealedCredential | null {
  if (envelopeVersion(ciphertext) >= keyring.current) return null;
  return seal(keyring.publicKey(), binding, open(keyring, binding, ciphertext));
}

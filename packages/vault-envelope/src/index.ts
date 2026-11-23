/**
 * O envelope do cofre de credenciais do nó, só para processos Node (usa `node:crypto`): a API e o worker do nó, e o
 * plano de controle, que cifra para o nó o que o responsável cadastra no console. O `@verax/shared` continua sem nada
 * disso, porque também vai para o navegador.
 */
export {
  CLOUDFLARE_OAUTH_SEAL_USES,
  CLOUDFLARE_OAUTH_TOKEN_MAX_LENGTH,
  type CloudflareOauthBinding,
  cloudflareOauthLabel,
  type CloudflareOauthSealUse,
  type CloudflareOauthTokens,
  openCloudflareOauthCode,
  openCloudflareOauthTokens,
  openCloudflareOauthVerifier,
  sealCloudflareOauthCode,
  sealCloudflareOauthTokens,
  sealCloudflareOauthVerifier,
} from './cloudflare-oauth.js';
export {
  CLOUDFLARE_API_TOKEN,
  type AwsCredentialPayload,
  awsCredentialPayloadSchema,
  type CloudflareCredentialPayload,
  cloudflareCredentialPayloadSchema,
  CREDENTIAL_KIND_PROVIDER,
  CREDENTIAL_PAYLOAD_SCHEMAS,
  type CredentialBinding,
  credentialBinding,
  type CredentialPayload,
  type GcpCredentialPayload,
  gcpCredentialPayloadSchema,
  oaepLabel,
  type OpenedCredential,
  openCredential,
  type SealedCredential,
  sealCredential,
} from './credential.js';
export {
  ENVELOPE_PATTERN,
  type EnvelopeKeySource,
  type EnvelopeOptions,
  envelopeVersion,
  MAX_CIPHERTEXT_LENGTH,
  MAX_HYBRID_PLAINTEXT_BYTES,
  MAX_PLAINTEXT_BYTES,
  openEnvelope,
  sealEnvelope,
} from './envelope.js';
export { CredentialVaultError, type CredentialVaultErrorCode } from './errors.js';
export {
  assertEnvelopePublicKey,
  type EnvelopePublicKey,
  isKeyVersion,
  isVaultRsaKey,
  MAX_KEY_BITS,
  MAX_KEY_VERSION,
  MIN_KEY_BITS,
  publicKeyFingerprint,
  vaultPublicKeyFromPem,
} from './public-key.js';
export { generateTemporaryPassword } from './temporary-password.js';
export {
  emailDigest,
  openUserPassword,
  sealUserPassword,
  type UserPasswordBinding,
  userPasswordLabel,
  userPasswordPayloadSchema,
} from './user-password.js';

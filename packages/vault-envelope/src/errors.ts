export type CredentialVaultErrorCode =
  | 'binding_invalid'
  | 'secret_invalid'
  | 'public_key_invalid'
  | 'plaintext_too_large'
  | 'envelope_invalid'
  | 'key_version_missing'
  | 'decrypt_failed'
  | 'payload_invalid';

/** Os erros do cofre levam só um código, nunca o segredo, o texto cifrado ou a chave. */
export class CredentialVaultError extends Error {
  constructor(readonly code: CredentialVaultErrorCode) {
    super(`cofre de credenciais: ${code}`);
    this.name = 'CredentialVaultError';
  }
}

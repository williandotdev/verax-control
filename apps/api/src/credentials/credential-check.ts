/**
 * Conferência de uma credencial colada no painel, na origem, antes de cifrar (fase 2). Cada tipo aceito tem a sua
 * (hoje só o token do Cloudflare, em `cloudflare/cloudflare-token-check.ts`); o recebimento genérico
 * (`credential-intake.service.ts`) trata as duas saídas abaixo do mesmo jeito para todos os tipos.
 *
 * Os erros levam só um código, nunca o segredo nem a mensagem da origem (que pode citar recursos da conta).
 */

/** O que a conferência devolve para guardar em claro, ao lado do texto cifrado. */
export interface CheckedCredential {
  /** Os 4 últimos caracteres do ID da credencial na origem (nunca do segredo). */
  keyIdSuffix: string;
  /** Criação na origem, quando ela informa. */
  issuedAt: Date | null;
  /** Validade na origem; null quando não vence. */
  expiresAt: Date | null;
}

/**
 * Por que a origem recusou a credencial (400 para o painel):
 * - `invalid`: a origem não reconhece o valor (ou não para esta conta);
 * - `inactive`: desativada na origem;
 * - `expired`: vencida;
 * - `not_yet_valid`: com data de início no futuro;
 * - `no_account_access`: válida, mas sem acesso de leitura à conta cadastrada.
 */
export type CredentialRejectionReason =
  'invalid' | 'inactive' | 'expired' | 'not_yet_valid' | 'no_account_access';

export class CredentialRejected extends Error {
  constructor(
    readonly reason: CredentialRejectionReason,
    /** Status HTTP da última resposta da origem, quando houve uma (só para o log). */
    readonly sourceStatus?: number,
  ) {
    super(`credencial recusada na origem: ${reason}`);
    this.name = 'CredentialRejected';
  }
}

/**
 * A origem não respondeu a tempo, respondeu erro do lado dela (5xx, limite de requisições) ou algo fora do formato
 * (503 para o painel: adianta tentar de novo). `code` é `timeout`, `network`, `bad_response` ou `http_<status>`.
 */
export class CredentialSourceUnavailable extends Error {
  constructor(readonly code: string) {
    super(`origem da credencial indisponível: ${code}`);
    this.name = 'CredentialSourceUnavailable';
  }
}

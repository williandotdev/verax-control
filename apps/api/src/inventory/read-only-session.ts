import { inspect } from 'node:util';

/** O formato de credencial que os clientes da AWS aceitam. */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/**
 * As credenciais temporárias de uma sessão no papel de leitura da conta do cliente. Quem entra no papel é o provedor
 * sem chave do worker (`aws/web-identity.ts`, `WebIdentityCredentials`: o token do Google trocado no STS por uma sessão
 * de 1 hora no `verax-control-reader`); o inventário (`inventory-job.ts`) usa o mesmo provedor, pelo
 * `credentialsFor(conta, região)`, e a mesma sessão da conferência da conexão.
 *
 * As credenciais nunca são logadas nem gravadas: o objeto que as carrega se recusa a virar JSON ou texto de log, e os
 * erros citam só o código da AWS.
 */

const HIDDEN = '[credenciais temporárias]';

export class TemporaryCredentials {
  readonly #identity: AwsCredentialIdentity;

  constructor(identity: AwsCredentialIdentity) {
    this.#identity = identity;
  }

  /** Para criar os clientes da AWS e nada mais. */
  identity(): AwsCredentialIdentity {
    return this.#identity;
  }

  get expiration(): Date | undefined {
    return this.#identity.expiration;
  }

  toJSON(): string {
    return HIDDEN;
  }

  toString(): string {
    return HIDDEN;
  }

  [inspect.custom](): string {
    return HIDDEN;
  }
}

/** Código do erro da AWS (ex.: AccessDenied), sem mensagem: a mensagem pode trazer ARNs e detalhes da requisição. */
export function awsErrorCode(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z0-9.]{1,64}$/.test(name) ? name : 'erro desconhecido';
}

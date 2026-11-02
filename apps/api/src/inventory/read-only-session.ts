import { inspect } from 'node:util';
import { AssumeRoleCommand, type STSClient } from '@aws-sdk/client-sts';

/** O formato de credencial que os clientes da AWS aceitam. */
export interface AwsCredentialIdentity {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration?: Date;
}

/**
 * Sessão no papel de leitura da conta do cliente (T5.9). O papel é sempre
 * `arn:aws:iam::<conta>:role/VeraxControlReadOnly`, derivado do ID da conta (o cadastro não escolhe papel), assumido
 * com o ExternalId da conta e por 15 minutos.
 *
 * As credenciais temporárias nunca são logadas nem gravadas: o objeto que as carrega se recusa a virar JSON ou texto
 * de log, e os erros citam só a conta e o código da AWS.
 */

export const READ_ONLY_ROLE = 'VeraxControlReadOnly';
export const SESSION_SECONDS = 15 * 60;
export const SESSION_NAME = 'verax-control-inventory';

const ACCOUNT_ID = /^\d{12}$/;
// Mesmo formato aceito pelo conector (T4.3), pelo Wazuh (T4.6) e pelo Prowler (T4.7).
const EXTERNAL_ID = /^[A-Za-z0-9+=,.@:/_-]{32,128}$/;
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

export class InventoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryError';
  }
}

/** Código do erro da AWS (ex.: AccessDenied), sem mensagem: a mensagem pode trazer ARNs e detalhes da requisição. */
export function awsErrorCode(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && /^[A-Za-z0-9.]{1,64}$/.test(name) ? name : 'erro desconhecido';
}

export async function assumeReadOnlyRole(
  target: { accountId: string; externalId: string },
  sts: Pick<STSClient, 'send'>,
): Promise<TemporaryCredentials> {
  if (!ACCOUNT_ID.test(target.accountId)) throw new InventoryError('conta fora do formato');
  if (!EXTERNAL_ID.test(target.externalId)) throw new InventoryError('ExternalId fora do formato');

  let response;
  try {
    response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: `arn:aws:iam::${target.accountId}:role/${READ_ONLY_ROLE}`,
        RoleSessionName: SESSION_NAME,
        ExternalId: target.externalId,
        DurationSeconds: SESSION_SECONDS,
      }),
    );
  } catch (error) {
    throw new InventoryError(
      `não foi possível assumir o papel de leitura na conta ${target.accountId} (${awsErrorCode(error)})`,
    );
  }

  const credentials = response.Credentials;
  if (
    credentials?.AccessKeyId === undefined ||
    credentials.SecretAccessKey === undefined ||
    credentials.SessionToken === undefined
  ) {
    throw new InventoryError(`a AWS não devolveu credenciais para a conta ${target.accountId}`);
  }
  return new TemporaryCredentials({
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
    expiration: credentials.Expiration,
  });
}

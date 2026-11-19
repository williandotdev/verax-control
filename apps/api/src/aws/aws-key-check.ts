import type { STSClient } from '@aws-sdk/client-sts';
import { z } from 'zod';
import {
  type CheckedCredential,
  CredentialRejected,
  CredentialSourceUnavailable,
} from '../credentials/credential-check.js';
import type { AwsAccessKey } from '../credentials/credential-vault.js';

/** O STS que não pode ser desligado (o mesmo do worker, `STS_FALLBACK_REGION`). Daqui não se importa o `web-identity.ts`,
 * que carregaria o SDK da AWS na API de todo nó. */
const STS_REGION = 'us-east-1';

function awsErrorName(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' ? name : '';
}

/** Orçamento da conferência, dentro da requisição de quem colou (o mesmo do Cloudflare). */
export const AWS_KEY_CHECK_TIMEOUT_MS = 5_000;

/** A chave que a AWS não reconhece ou cuja assinatura não confere (o segredo errado). */
const REJECTED_NAMES = new Set([
  'InvalidClientTokenId',
  'SignatureDoesNotMatch',
  'IncompleteSignature',
  'UnrecognizedClientException',
  'AccessDenied',
  'AccessDeniedException',
]);

const callerSchema = z.object({ Account: z.string(), Arn: z.string().max(2048) });

const AWS_PARTITIONS = new Set(['aws', 'aws-cn', 'aws-us-gov']);
/** Caminho e nome do usuário IAM: os caracteres que o IAM aceita, sem quantificador aninhado. */
const IAM_USER_PATH_AND_NAME = /^[\w+=,.@/-]{1,512}$/;

/**
 * O ARN de um usuário IAM da conta (`arn:<partição>:iam::<conta>:user/[<caminho>/]<nome>`), conferido parte a parte.
 * Nunca o root (`:root`), um papel ou uma sessão.
 */
export function isIamUserArn(arn: string, accountId: string): boolean {
  const parts = arn.split(':');
  if (parts.length !== 6) return false;
  const [prefix, partition = '', service, region, account, resource = ''] = parts;
  return (
    prefix === 'arn' &&
    AWS_PARTITIONS.has(partition) &&
    service === 'iam' &&
    region === '' &&
    account === accountId &&
    resource.startsWith('user/') &&
    IAM_USER_PATH_AND_NAME.test(resource.slice('user/'.length))
  );
}

/** O STS de uma chamada, com a chave colada (os testes trocam por um falso). */
export type StsWithKey = (region: string, key: AwsAccessKey) => Promise<Pick<STSClient, 'send'>>;

/** O STS de verdade, carregado só quando a primeira chave é conferida (o SDK não pesa na API dos outros nós). */
const sdkSts: StsWithKey = async (region, key) => {
  const { STSClient } = await import('@aws-sdk/client-sts');
  return new STSClient({
    region,
    maxAttempts: 1,
    requestHandler: { connectionTimeout: 3_000, requestTimeout: AWS_KEY_CHECK_TIMEOUT_MS },
    credentials: { accessKeyId: key.accessKeyId, secretAccessKey: key.secret() },
  });
};

/**
 * Conferência da chave de acesso colada no painel (VM própria do cliente), na memória da API, antes de cifrar: um
 * `GetCallerIdentity` com a chave, que não pode ser negado por política e não lê nada da conta. A chave precisa ser de
 * um usuário IAM da conta cadastrada:
 * - chave desconhecida, desativada ou com o segredo errado: `invalid`;
 * - de outra conta: `no_account_access`;
 * - do root da conta (ou de qualquer coisa que não seja um usuário IAM): `wrong_identity`. A chave do root dá acesso
 *   total e nunca é guardada.
 *
 * A leitura dos buckets e o resto da conferência ficam com o worker, no "Verificar" (`aws-check`), como no papel sem
 * chave. Só o código vai para o log; o segredo só assina a chamada.
 */
export class AwsAccessKeyCheck {
  constructor(private readonly sts: StsWithKey = sdkSts) {}

  async check(key: AwsAccessKey, accountId: string): Promise<CheckedCredential> {
    const { GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const client = await this.sts(STS_REGION, key);
    let response: unknown;
    try {
      response = await client.send(new GetCallerIdentityCommand({}), {
        abortSignal: AbortSignal.timeout(AWS_KEY_CHECK_TIMEOUT_MS),
      });
    } catch (error) {
      const name = awsErrorName(error).replace(/Exception$/, '');
      const status = (error as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata
        ?.httpStatusCode;
      const httpStatus = typeof status === 'number' ? status : undefined;
      if (REJECTED_NAMES.has(name) || REJECTED_NAMES.has(awsErrorName(error))) {
        throw new CredentialRejected('invalid', httpStatus);
      }
      if (name === 'TimeoutError' || name === 'AbortError') throw new CredentialSourceUnavailable('timeout');
      throw new CredentialSourceUnavailable(httpStatus === undefined ? 'network' : `http_${httpStatus}`);
    } finally {
      (client as { destroy?: () => void }).destroy?.();
    }
    const caller = callerSchema.safeParse(response);
    if (!caller.success) throw new CredentialSourceUnavailable('bad_response');
    if (caller.data.Account !== accountId) throw new CredentialRejected('no_account_access');
    if (!isIamUserArn(caller.data.Arn, accountId)) throw new CredentialRejected('wrong_identity');
    return { keyIdSuffix: key.accessKeyId.slice(-4), issuedAt: null, expiresAt: null };
  }
}

import type { AwsConnectionErrorCode } from '@verax/shared';

/**
 * A conferência de uma conta AWS pelo papel de leitura sem chave (fase 2; `docs/ARQUITETURA.md`, "Por que papel sem
 * chave", "Ciclo da conexão"). A tarefa `aws-check` do worker (`aws-check.ts`) a chama para cada "Verificar" pendente e
 * grava o resultado na conta; quem fala com a AWS é só a implementação desta interface.
 *
 * A real (PR-V5', `WebIdentityAwsConnectionChecker`) pede ao metadata da GCP o token do Google para o audience do nó,
 * troca no STS (`AssumeRoleWithWebIdentity`, sem credencial da AWS) pelo papel `/verax/verax-control-reader` da conta e
 * confere, nesta ordem: `GetCallerIdentity` (a conta da sessão é a cadastrada), `ListObjectsV2 MaxKeys=1` e
 * `GetObject Range=bytes=0-0` em cada bucket (prova a leitura e o KMS). Os erros da AWS viram os códigos de
 * `AWS_CONNECTION_ERROR_CODES`, sem a mensagem:
 * - `AccessDenied` no `AssumeRoleWithWebIdentity`: `trust_denied` (logo depois da criação da pilha, o IAM pode levar
 *   alguns segundos para valer: `retryable`);
 * - `InvalidIdentityToken`, `ExpiredToken`, `IDPRejectedClaim`: `token_invalid`;
 * - `IDPCommunicationError` e o metadata fora: `idp_unavailable` (`retryable`);
 * - `RegionDisabledException`: `region_disabled` (o worker tenta us-east-1 antes);
 * - a conta da sessão diferente da cadastrada: `account_mismatch`;
 * - `NoSuchBucket`: `bucket_missing`; `AccessDenied` no S3: `bucket_denied`; `KMS.*`/`AccessDenied` do KMS no
 *   `GetObject`: `kms_denied`;
 * - tempo esgotado, 5xx e limite: `aws_unavailable` (`retryable`).
 *
 * Nada da conferência vai para o log além do código; as credenciais da sessão ficam na memória do worker (o padrão de
 * `inventory/read-only-session.ts`).
 */

/** O que a conferência recebe: a conta cadastrada (o papel é derivado do ID) e os buckets de log dela. */
export interface AwsCheckTarget {
  /** O ID da linha da conta (nunca vai para a AWS). */
  readonly cloudAccountId: string;
  /** ID da conta AWS, 12 dígitos: o papel é `arn:aws:iam::<conta>:role/verax/verax-control-reader`. */
  readonly accountId: string;
  /** Regiões monitoradas; a primeira escolhe o endpoint regional do STS. */
  readonly regions: readonly string[];
  /** Nomes dos buckets de log cadastrados (CloudTrail, GuardDuty e WAF), sem repetir. */
  readonly buckets: readonly string[];
}

/**
 * O resultado: conectada, ou o código do erro e se vale tentar de novo. Um erro `retryable` dentro da janela de
 * tentativas deixa o pedido pendente para a próxima execução; fora dela, ou sem `retryable`, vira o erro da conta.
 */
export type AwsCheckOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AwsConnectionErrorCode; readonly retryable: boolean };

export interface AwsConnectionChecker {
  check(target: AwsCheckTarget, signal: AbortSignal): Promise<AwsCheckOutcome>;
}

/**
 * O que o worker usa até o PR-V5' (o provedor de web identity e a conferência real): responde na hora que este nó
 * ainda não confere a conexão (`check_unavailable`), sem tentar de novo e sem chamar a AWS nem o metadata. O painel
 * mostra o código com o que fazer; o "Verificar" funciona de ponta a ponta (pedido, tarefa, resultado na conta), e o
 * PR-V5' só troca esta classe na partida do worker (`worker.ts`).
 */
export class UnavailableAwsConnectionChecker implements AwsConnectionChecker {
  check(): Promise<AwsCheckOutcome> {
    return Promise.resolve({ ok: false, code: 'check_unavailable', retryable: false });
  }
}

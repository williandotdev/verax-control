import type { AwsConnectionErrorCode, AwsConnectionWarningCode, LogSource } from '@verax/shared';

/**
 * A conferência de uma conta AWS pelo papel de leitura sem chave (fase 2; `docs/ARQUITETURA.md`, "Por que papel sem
 * chave", "Ciclo da conexão"). A tarefa `aws-check` do worker (`aws-check.ts`) a chama para cada "Verificar" pendente
 * e, a cada 15 min, para as contas já verificadas, e grava o resultado na conta; quem fala com a AWS é só a
 * implementação desta interface.
 *
 * A real é a `WebIdentityAwsConnectionChecker` (PR-V5', `web-identity-checker.ts`): pede ao metadata da GCP o token do
 * Google para o audience do nó, troca no STS (`AssumeRoleWithWebIdentity`, sem credencial da AWS) pelo papel
 * `/verax/verax-control-reader` da conta e confere `GetCallerIdentity`, a leitura de cada bucket e, uma vez por dia, a
 * trilha, o export do GuardDuty e a permissão demais. O mapa dos erros da AWS para os códigos está lá.
 *
 * Nada da conferência vai para o log além do código; as credenciais da sessão ficam na memória do worker.
 */

/** O que a conferência recebe: a conta cadastrada (o papel é derivado do ID) e os buckets de log dela. */
export interface AwsCheckTarget {
  /** O ID da linha da conta (nunca vai para a AWS). */
  readonly cloudAccountId: string;
  /** ID da conta AWS, 12 dígitos: o papel é `arn:aws:iam::<conta>:role/verax/verax-control-reader`. */
  readonly accountId: string;
  /** Regiões monitoradas; a primeira escolhe o endpoint regional do STS e a região dos clientes da AWS. */
  readonly regions: readonly string[];
  /** O bucket de log cadastrado de cada fonte (null sem bucket). O mesmo bucket em duas fontes é lido uma vez. */
  readonly buckets: Readonly<Record<LogSource, string | null>>;
  /** Inclui as conferências diárias: a trilha, o export do GuardDuty e a permissão demais. */
  readonly daily: boolean;
}

/**
 * O resultado: conectada (com os avisos, se houver), ou o código do erro e se vale tentar de novo. Um erro `retryable`
 * dentro da janela de tentativas deixa o pedido pendente para uma próxima tentativa; fora dela, ou sem `retryable`,
 * vira o erro da conta.
 * - `warnings`: os avisos da própria conferência (o STS da região desligado, com a entrada por us-east-1);
 * - `daily`: os avisos das conferências diárias, só quando pedidas (`daily`) e concluídas. Ausente quando uma delas
 *   não pôde ser concluída por uma falha passageira (a tarefa tenta de novo na volta seguinte);
 * - `source`: num erro de bucket, a fonte do bucket (`bucket_denied:cloudtrail` na conta).
 */
export type AwsCheckOutcome =
  | {
      readonly ok: true;
      readonly warnings?: readonly AwsConnectionWarningCode[];
      readonly daily?: { readonly warnings: readonly AwsConnectionWarningCode[] };
    }
  | {
      readonly ok: false;
      readonly code: AwsConnectionErrorCode;
      readonly retryable: boolean;
      readonly source?: LogSource;
    };

export interface AwsConnectionChecker {
  check(target: AwsCheckTarget, signal: AbortSignal): Promise<AwsCheckOutcome>;
}

/**
 * O que o worker usa quando o nó não informa a própria identidade (`NODE_SA_UNIQUE_ID` fora do `worker.env`: o nó da
 * Verax e o ambiente local): responde na hora que este nó não confere a conexão (`check_unavailable`), sem tentar de
 * novo e sem chamar a AWS nem o metadata. O painel mostra o código com o que fazer.
 */
export class UnavailableAwsConnectionChecker implements AwsConnectionChecker {
  check(): Promise<AwsCheckOutcome> {
    return Promise.resolve({ ok: false, code: 'check_unavailable', retryable: false });
  }
}

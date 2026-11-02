import type { AwsSource, WazuhAwsAlert } from './wazuh-alert.js';

/**
 * Vínculo entre alerta e cliente (T5.2): o ponto crítico de isolamento do MVP, porque um Wazuh só atende todos os
 * clientes. Esta é a única função que decide de quem é um alerta.
 *
 * Regra: o alerta é do cliente quando **duas** origens independentes concordam.
 * 1. O bucket de onde o Wazuh leu o evento está cadastrado para aquela fonte, e só por esse cliente. O Wazuh lê cada
 *    bucket com o papel da conta que o cadastrou (T4.6), então o bucket diz de onde o evento veio.
 * 2. O evento cita uma única conta, cadastrada para o mesmo cliente. No CloudTrail, a conta é a da pasta
 *    `AWSLogs/<conta>` (fixada na leitura) e precisa ser uma das contas que cadastraram aquele bucket. No GuardDuty e
 *    no WAF, a conta vem do conteúdo do evento, que o cliente controla: um cliente que forjasse um evento com a conta
 *    de outro esbarra na regra 1.
 *
 * Na dúvida, o alerta não é de ninguém: vai para a fila sem dono, que só `admin_verax` vê, com o motivo.
 */

export interface RegisteredAwsAccount {
  tenantId: string;
  accountId: string;
  /** Buckets de log cadastrados no conector, por fonte (os mesmos da lista de contas do Wazuh, T4.6). */
  buckets: Partial<Record<AwsSource, string>>;
}

export type UnownedReason =
  /** Fora do formato esperado (inclusive um campo de conta inválido). */
  | 'invalid_alert'
  /** Não veio do módulo aws-s3 (ex.: alerta do próprio manager). */
  | 'not_aws'
  /** Bucket de origem não cadastrado para aquela fonte. */
  | 'unknown_source'
  /** O mesmo bucket cadastrado por clientes diferentes. */
  | 'ambiguous_source'
  /** O evento não cita conta. */
  | 'no_account'
  /** O evento cita contas diferentes. */
  | 'conflicting_accounts'
  /** A conta do evento não está cadastrada (ou está em mais de um cliente). */
  | 'unknown_account'
  /** A conta do evento não bate com quem cadastrou o bucket de origem. */
  | 'source_mismatch';

export type AlertOwner =
  | { owned: true; tenantId: string; accountId: string }
  | { owned: false; reason: UnownedReason; accounts: string[] };

interface BucketOwner {
  tenantId: string;
  accounts: ReadonlySet<string>;
}

const AMBIGUOUS = Symbol('ambíguo');

/** Cadastro de contas e buckets, montado a partir das contas conectadas (T3.3). */
export class AccountDirectory {
  private constructor(
    private readonly tenantByAccount: ReadonlyMap<string, string | typeof AMBIGUOUS>,
    private readonly ownerByBucket: ReadonlyMap<string, BucketOwner | typeof AMBIGUOUS>,
  ) {}

  static from(accounts: readonly RegisteredAwsAccount[]): AccountDirectory {
    const tenantByAccount = new Map<string, string | typeof AMBIGUOUS>();
    const ownerByBucket = new Map<string, BucketOwner | typeof AMBIGUOUS>();
    for (const { tenantId, accountId, buckets } of accounts) {
      const known = tenantByAccount.get(accountId);
      // A T3.3 impede a mesma conta em dois clientes; se acontecer, a conta não vale para nenhum.
      tenantByAccount.set(accountId, known === undefined || known === tenantId ? tenantId : AMBIGUOUS);

      for (const [source, bucket] of Object.entries(buckets)) {
        if (bucket === undefined) continue;
        const key = `${source}:${bucket}`;
        const owner = ownerByBucket.get(key);
        if (owner === undefined) {
          ownerByBucket.set(key, { tenantId, accounts: new Set([accountId]) });
        } else if (owner !== AMBIGUOUS && owner.tenantId === tenantId) {
          // Trilha da organização: várias contas do mesmo cliente com o mesmo bucket.
          ownerByBucket.set(key, { tenantId, accounts: new Set([...owner.accounts, accountId]) });
        } else {
          ownerByBucket.set(key, AMBIGUOUS);
        }
      }
    }
    return new AccountDirectory(tenantByAccount, ownerByBucket);
  }

  tenantOf(accountId: string): string | null {
    const tenant = this.tenantByAccount.get(accountId);
    return tenant === undefined || tenant === AMBIGUOUS ? null : tenant;
  }

  bucketOwner(source: AwsSource, bucket: string): BucketOwner | 'ambiguous' | null {
    const owner = this.ownerByBucket.get(`${source}:${bucket}`);
    if (owner === undefined) return null;
    return owner === AMBIGUOUS ? 'ambiguous' : owner;
  }
}

function unowned(reason: UnownedReason, accounts: string[] = []): AlertOwner {
  return { owned: false, reason, accounts };
}

export function resolveAlertOwner(alert: WazuhAwsAlert, directory: AccountDirectory): AlertOwner {
  if (alert.accounts === null) return unowned('invalid_alert');
  const accounts = alert.accounts;

  const bucketOwner = directory.bucketOwner(alert.source, alert.bucket);
  if (bucketOwner === null) return unowned('unknown_source', accounts);
  if (bucketOwner === 'ambiguous') return unowned('ambiguous_source', accounts);

  if (accounts.length === 0) return unowned('no_account');
  if (accounts.length > 1) return unowned('conflicting_accounts', accounts);
  const [accountId = ''] = accounts;

  const tenantId = directory.tenantOf(accountId);
  if (tenantId === null) return unowned('unknown_account', accounts);
  if (tenantId !== bucketOwner.tenantId) return unowned('source_mismatch', accounts);
  // No CloudTrail a pasta lida é a da conta que cadastrou o bucket (T4.6); outra conta ali é sinal de problema.
  if (alert.source === 'cloudtrail' && !bucketOwner.accounts.has(accountId)) {
    return unowned('source_mismatch', accounts);
  }
  return { owned: true, tenantId, accountId };
}

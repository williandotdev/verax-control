import type { AwsAccessKeyCheck } from '../aws/aws-key-check.js';
import type { CloudflareTokenCheck } from '../cloudflare/cloudflare-token-check.js';
import type { CheckedCredential } from '../credentials/credential-check.js';
import {
  AwsAccessKey,
  CloudflareToken,
  CredentialVaultError,
  GcpServiceAccountKey,
  type VaultSecret,
} from '../credentials/credential-vault.js';
import type { GcpServiceAccountKeyCheck } from '../gcp/gcp-key-check.js';

/** O que a conferência na origem usa da conta cadastrada no nó (nunca um valor do console). */
export interface CheckedSourceAccount {
  accountId: string;
  pubsubSubscription: string | null;
}

/**
 * A conferência na origem da credencial que veio do console, antes de guardá-la: a mesma do painel
 * (`credentials/credential-intake.service.ts`), que recusa com `CredentialRejected` e diz que a origem não respondeu com
 * `CredentialSourceUnavailable`. Roda no worker do nó, que sai pelo IP de saída dele (o token do Cloudflare costuma ter
 * filtro de IP).
 */
export interface SourceCredentialChecks {
  check(secret: VaultSecret, account: CheckedSourceAccount): Promise<CheckedCredential>;
}

/** As conferências do painel, por tipo de credencial. */
export function panelCredentialChecks(
  cloudflare: CloudflareTokenCheck,
  awsKeys: AwsAccessKeyCheck,
  gcpKeys: GcpServiceAccountKeyCheck,
): SourceCredentialChecks {
  return {
    check(secret, account) {
      if (secret instanceof CloudflareToken) return cloudflare.check(secret, account.accountId);
      if (secret instanceof AwsAccessKey) return awsKeys.check(secret, account.accountId);
      if (secret instanceof GcpServiceAccountKey) {
        // Sem assinatura cadastrada não há o que provar: quem chama recusa antes.
        if (account.pubsubSubscription === null) throw new CredentialVaultError('binding_invalid');
        return gcpKeys.check(secret, account.pubsubSubscription);
      }
      throw new CredentialVaultError('binding_invalid');
    },
  };
}

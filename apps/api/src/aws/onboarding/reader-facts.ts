import type { AuditService } from '../../common/audit/audit.service.js';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { AwsReaderFacts } from '../aws-connection-check.js';
import { requestAwsDiscovery } from '../discovery/discovery-runs.js';

/**
 * As tags do papel de leitura gravadas na conta (`awsTemplateVersion`, `awsCapabilities` e o horário da leitura), num
 * lugar só para quem as lê fora de um "Verificar": a conferência diária (`aws-check.ts`) e a tarefa `aws-discovery`
 * (`discovery/discovery-job.ts`), em toda descoberta e no "Tentar de novo" de uma fonte.
 */

/** O que a gravação precisa da conta: o que está gravado hoje, para saber se mudou. */
export interface ReaderFactsAccount {
  id: string;
  tenantId: string;
  awsTemplateVersion: number | null;
  awsCapabilities: readonly string[];
}

/** As mesmas capacidades, em qualquer ordem. */
function sameCapabilities(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((capability) => b.includes(capability));
}

/** As tags do papel dizem outra coisa que o gravado na conta (outra versão do template, outra lista de capacidades)? */
export function readerFactsChanged(
  account: Pick<ReaderFactsAccount, 'awsTemplateVersion' | 'awsCapabilities'>,
  facts: AwsReaderFacts,
): boolean {
  return (
    facts.templateVersion !== account.awsTemplateVersion ||
    !sameCapabilities(facts.capabilities, account.awsCapabilities)
  );
}

export interface RecordReaderFactsOptions {
  /**
   * Pede uma descoberta da conta quando as tags mudaram (o que o papel pode ler mudou). A própria descoberta não pede
   * outra: ela já roda com as tags que acabou de ler.
   */
  requestDiscovery: boolean;
}

/**
 * Grava as tags do papel lidas agora, na transação de quem chama e pelo escopo do cliente da conta. Sem mudança, só o
 * horário da leitura; com outra versão do template ou outras capacidades, a mudança entra na trilha do cliente
 * (`cloud_account.aws_template`, ator sistema) e, com `requestDiscovery`, a conta ganha uma descoberta nova. Devolve
 * se mudou. A conta que deixou de estar ativa não é tocada.
 */
export async function recordReaderFacts(
  tx: Prisma.TransactionClient,
  audit: AuditService,
  account: ReaderFactsAccount,
  facts: AwsReaderFacts,
  now: Date,
  { requestDiscovery }: RecordReaderFactsOptions,
): Promise<boolean> {
  const db = scopeToTenant(tx, account.tenantId);
  const { count } = await db.cloudAccount.updateMany({
    where: { id: account.id, provider: 'aws', status: 'active' },
    data: {
      awsTemplateVersion: facts.templateVersion,
      awsCapabilities: [...facts.capabilities],
      awsCapabilitiesCheckedAt: now,
    },
  });
  if (count === 0 || !readerFactsChanged(account, facts)) return false;
  if (requestDiscovery) {
    await requestAwsDiscovery(tx, {
      tenantId: account.tenantId,
      cloudAccountId: account.id,
      trigger: 'scheduled',
      now,
    });
  }
  await audit.write(tx, {
    actor: { type: 'system', tenantId: account.tenantId },
    action: 'cloud_account.aws_template',
    outcome: 'success',
    resourceType: 'cloud_account',
    resourceId: account.id,
    before: {
      awsTemplateVersion: account.awsTemplateVersion,
      awsCapabilities: [...account.awsCapabilities],
    },
    after: { awsTemplateVersion: facts.templateVersion, awsCapabilities: [...facts.capabilities] },
  });
  return true;
}

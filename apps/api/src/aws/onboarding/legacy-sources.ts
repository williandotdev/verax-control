import {
  AWS_SOURCE_GLOBAL_REGION,
  AWS_SOURCE_LEGACY_RESOURCE,
  type AwsSourceKind,
  LOG_SOURCES,
  type LogSource,
} from '@verax/shared';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Os buckets cadastrados antes do onboarding self-service (`cloudtrailBucket`, `guarddutyBucket` e `wafBucket` da conta)
 * como fontes (`AwsSource`, `origin = legacy`): uma linha por bucket, autorizada, com a coleta a partir do `ingestFrom`
 * da conta. As colunas continuam sendo a verdade (é delas que o Wazuh, a conferência da conexão e a medição leem); as
 * linhas são o espelho, para a tela das fontes mostrar tudo num lugar só.
 *
 * Este é o único lugar que mantém o espelho. Quem grava um bucket ou o `ingestFrom` chama `syncLegacyAwsSources` na
 * mesma transação: o cadastro pelo painel (`cloud-accounts.service.ts`), a sincronização com o plano de controle
 * (`control-plane-sync/apply-source.ts`) e a primeira verificação (`aws/aws-check.ts`). A migration
 * `20261124120000_aws_onboarding` criou as linhas das contas que já existiam.
 */

/** O tipo de fonte de cada bucket do cadastro. */
export const LEGACY_SOURCE_KIND = {
  cloudtrail: 'cloudtrail',
  guardduty: 'guardduty_export',
  waf: 'waf',
} as const satisfies Record<LogSource, AwsSourceKind>;

const BUCKET_COLUMN = {
  cloudtrail: 'cloudtrailBucket',
  guardduty: 'guarddutyBucket',
  waf: 'wafBucket',
} as const satisfies Record<LogSource, string>;

const sameDay = (a: Date | null, b: Date | null): boolean =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Deixa as linhas `legacy` da conta iguais aos buckets do cadastro: cria a do bucket novo, troca o bucket da que mudou
 * (a permissão volta a "por conferir": é outro bucket), acompanha o `ingestFrom` e apaga a do bucket tirado. `db` é o
 * cliente do banco no escopo do cliente da conta; outra conta, ou a de outro provedor, não muda nada.
 */
export async function syncLegacyAwsSources(
  db: Prisma.TransactionClient,
  cloudAccountId: string,
  now: Date = new Date(),
): Promise<void> {
  const account = await db.cloudAccount.findUnique({
    where: { id: cloudAccountId },
    select: {
      id: true,
      tenantId: true,
      provider: true,
      cloudtrailBucket: true,
      guarddutyBucket: true,
      wafBucket: true,
      ingestFrom: true,
    },
  });
  if (account === null || account.provider !== 'aws') return;
  const rows = await db.awsSource.findMany({
    where: { cloudAccountId, origin: 'legacy' },
    select: { id: true, kind: true, name: true, collectFrom: true },
  });
  for (const source of LOG_SOURCES) {
    const kind = LEGACY_SOURCE_KIND[source];
    const bucket = account[BUCKET_COLUMN[source]];
    const row = rows.find((candidate) => candidate.kind === kind);
    if (bucket === null) {
      if (row !== undefined) await db.awsSource.delete({ where: { id: row.id }, select: { id: true } });
      continue;
    }
    const details = { bucket, legacySource: source };
    if (row === undefined) {
      await db.awsSource.create({
        data: {
          tenantId: account.tenantId,
          cloudAccountId,
          kind,
          region: AWS_SOURCE_GLOBAL_REGION,
          resourceId: AWS_SOURCE_LEGACY_RESOURCE,
          name: bucket,
          details,
          method: 's3',
          availability: 'available',
          permission: 'unknown',
          origin: 'legacy',
          firstSeenAt: now,
          lastSeenAt: now,
          authorizedAt: now,
          collectFrom: account.ingestFrom,
          state: 'authorized',
          stateCode: 'awaiting_collector',
          stateSince: now,
        },
        select: { id: true },
      });
      continue;
    }
    const bucketChanged = row.name !== bucket;
    if (!bucketChanged && sameDay(row.collectFrom, account.ingestFrom)) continue;
    await db.awsSource.update({
      where: { id: row.id },
      data: {
        name: bucket,
        details,
        collectFrom: account.ingestFrom,
        lastSeenAt: now,
        // Outro bucket: a sondagem anterior era do bucket antigo, e a fonte volta a esperar o coletor.
        ...(bucketChanged && {
          permission: 'unknown',
          permissionDetail: null,
          permissionCheckedAt: null,
          state: 'authorized',
          stateCode: 'awaiting_collector',
          stateSince: now,
        }),
      },
      select: { id: true },
    });
  }
}

import { GetFindingsCommand } from '@aws-sdk/client-securityhub';
import { MITRE_TACTIC_NAMES } from '@verax/shared';
import type { FindingDraft } from '../../alerts/finding-draft.js';
import { at, ip } from '../../alerts/wazuh-alert.js';
import type { DiscoveryClients } from '../discovery/clients.js';
import {
  citedAccounts,
  isRecord,
  label,
  MAX_FINDING_RECORD_BYTES,
  recordBytes,
  region,
  resourceRef,
  timestamp,
} from './finding-fields.js';
import { AWS_FINDINGS_SOURCE, awsFindingKey } from './finding-keys.js';
import {
  type FindingsCaller,
  type FindingsPage,
  type FindingsWindow,
  INACTIVE,
  INVALID,
  nextTokenOf,
  type ParsedFinding,
  type ParseOutcome,
} from './finding-records.js';
import { AWS_FINDING_RULES, levelOfSeverity, securityHubSeverity } from './finding-rules.js';

/**
 * Security Hub pela API (tarefa `aws-findings`): `GetFindings` com o filtro `UpdatedAt` (`Start` e `End`), 100 por
 * página. O limite da AWS é de 3 chamadas por segundo (rajada de 6) por conta e região, e a tarefa espaça as chamadas.
 *
 * **O que é lido:** só os achados ativos (`RecordState = ACTIVE`) e ainda em aberto no fluxo de trabalho do próprio
 * Security Hub (`Workflow.Status` `NEW` ou `NOTIFIED`). O `SUPPRESSED` (alguém do cliente já decidiu que não é para
 * agir) e o `RESOLVED` (corrigido; é também o que o Security Hub dá ao controle que passou) ficam de fora. O achado que
 * muda para um desses estados só deixa de ser lido: nada é fechado sozinho no painel.
 *
 * **Sem duplicar o GuardDuty e o Inspector:** o Security Hub também recebe os achados desses dois serviços. Quando a
 * conta tem a fonte própria do serviço autorizada na mesma região do achado, o registro do Security Hub é pulado: o
 * achado já entra pelo coletor dele, com a chave dele. Sem a fonte autorizada (ou em outra região), ele entra por aqui.
 * Quem decide é a tarefa (`product`); aqui só se reconhece o produto.
 *
 * **Chave:** `Id` e `ProductArn` juntos identificam o achado (o `Id` sozinho pode se repetir entre produtos); como
 * quase nunca cabem, entram pelo resumo SHA-256. A chave não leva a região: com a agregação entre regiões ligada, o
 * mesmo achado lido pela região de origem e pela agregadora cai na mesma chave.
 */

export const SECURITY_HUB_PAGE_SIZE = 100;
/** O Security Hub aceita 3 chamadas por segundo por conta e região: uma a cada 350 ms fica abaixo. */
export const SECURITY_HUB_MIN_INTERVAL_MS = 350;

const OPEN_WORKFLOW: ReadonlySet<string> = new Set(['NEW', 'NOTIFIED']);
const TACTICS: ReadonlySet<string> = new Set(MITRE_TACTIC_NAMES);

export async function readSecurityHubPage(
  clients: DiscoveryClients,
  call: FindingsCaller,
  target: { region: string },
  window: FindingsWindow,
  token: string | null,
): Promise<FindingsPage> {
  const found = await call('securityhub:GetFindings', () =>
    clients.securityhub(target.region).send(
      new GetFindingsCommand({
        Filters: {
          UpdatedAt: [{ Start: window.since.toISOString(), End: window.before.toISOString() }],
          RecordState: [{ Comparison: 'EQUALS', Value: 'ACTIVE' }],
          WorkflowStatus: [
            { Comparison: 'EQUALS', Value: 'NEW' },
            { Comparison: 'EQUALS', Value: 'NOTIFIED' },
          ],
        },
        MaxResults: SECURITY_HUB_PAGE_SIZE,
        ...(token !== null && { NextToken: token }),
      }),
    ),
  );
  return {
    records: Array.isArray(found.Findings) ? found.Findings : [],
    nextToken: nextTokenOf(found.NextToken),
  };
}

/** O serviço com coletor próprio que gerou o achado, pelo ARN do produto (ou, sem ele reconhecido, pelo nome). */
function ownProduct(productArn: string, productName: string | undefined): 'guardduty' | 'inspector' | null {
  if (productArn.endsWith(':product/aws/guardduty') || productName === 'GuardDuty') return 'guardduty';
  if (productArn.endsWith(':product/aws/inspector') || productName === 'Inspector') return 'inspector';
  return null;
}

/** As táticas do MITRE ATT&CK dos tipos do achado (`TTPs/<tática>/…`, a taxonomia do ASFF). */
function tacticsOf(types: unknown): string[] {
  if (!Array.isArray(types)) return [];
  const tactics = new Set<string>();
  for (const type of types.slice(0, 50)) {
    if (typeof type !== 'string' || type.length > 256) continue;
    const [namespace, tactic] = type.split('/');
    if (namespace === 'TTPs' && tactic !== undefined && TACTICS.has(tactic)) tactics.add(tactic);
  }
  return [...tactics].sort();
}

/** Um achado do `GetFindings` (ASFF), conferido. */
export function parseSecurityHubFinding(raw: unknown, now: Date): ParseOutcome {
  const bytes = recordBytes(raw);
  if (bytes === null || bytes > MAX_FINDING_RECORD_BYTES || !isRecord(raw)) return INVALID;
  const id = label(raw['Id'], 1024);
  const productArn = label(raw['ProductArn'], 2048);
  const updatedAt = timestamp(raw['UpdatedAt'], now);
  if (id === undefined || productArn === undefined || updatedAt === undefined) return INVALID;
  // O filtro já pede só os ativos e em aberto; a conferência aqui não confia nele.
  const recordState = raw['RecordState'];
  const workflow = at(raw, 'Workflow', 'Status');
  if (recordState !== undefined && recordState !== 'ACTIVE') return INACTIVE;
  if (workflow !== undefined && (typeof workflow !== 'string' || !OPEN_WORKFLOW.has(workflow)))
    return INACTIVE;

  const productName = label(raw['ProductName'], 128);
  const controlId = label(at(raw, 'Compliance', 'SecurityControlId'), 64);
  const isControl = isRecord(raw['Compliance']);
  const rule = isControl ? AWS_FINDING_RULES.securityHubControl : AWS_FINDING_RULES.securityHubProduct;
  const sourceTitle = label(raw['Title'], 300);
  const prefix = isControl
    ? controlId === undefined
      ? rule.title
      : `${rule.title} (${controlId})`
    : productName === undefined
      ? rule.title
      : `${rule.title} (${productName})`;
  const title = sourceTitle === undefined ? prefix : `${prefix}: ${sourceTitle}`;
  const severity = securityHubSeverity(
    label(at(raw, 'Severity', 'Label'), 32),
    typeof at(raw, 'Severity', 'Normalized') === 'number'
      ? (at(raw, 'Severity', 'Normalized') as number)
      : undefined,
  );
  const ruleLevel = levelOfSeverity(severity);
  const findingRegion = region(raw['Region']);
  const product = ownProduct(productArn, productName);
  const firstType = Array.isArray(raw['Types']) ? label((raw['Types'] as unknown[])[0], 256) : undefined;

  const finding: ParsedFinding = {
    label: 'securityhub',
    nativeId: `${productArn}|${id}`,
    updatedAt,
    accounts: citedAccounts(raw['AwsAccountId']),
    bytes,
    ...(product !== null && { product: { kind: product, region: findingRegion } }),
    summary: { title, ruleId: rule.id, ruleLevel },
    drafts: (owner): FindingDraft[] => [
      {
        tenantId: owner.tenantId,
        accountId: owner.accountId,
        source: AWS_FINDINGS_SOURCE,
        sourceEventId: awsFindingKey(owner.accountId, 'securityhub', `${productArn}|${id}`),
        occurredAt: updatedAt,
        severity,
        ruleId: rule.id,
        ruleLevel,
        title,
        logSource: 'security_hub',
        // O controle reprovado, o tipo do achado ou quem o gerou: o que identifica o achado sem ser um link.
        eventName: controlId ?? firstType ?? label(raw['GeneratorId'], 256) ?? null,
        region: findingRegion ?? region(at(raw, 'Resources', 'Region')) ?? null,
        resource: resourceRef(at(raw, 'Resources', 'Id')) ?? null,
        actorUser: null,
        actorType: null,
        accessKeyId: null,
        sourceIp: ip(at(raw, 'Network', 'SourceIpV4')) ?? null,
        mitreTactics: tacticsOf(raw['Types']),
        mitreTechniques: [],
        revision: { lastSeenAt: updatedAt },
      },
    ],
  };
  return { ok: true, finding };
}

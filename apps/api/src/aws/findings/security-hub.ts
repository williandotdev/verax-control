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
 * **Sem duplicar o GuardDuty e o Inspector, e sem perder nada:** o Security Hub também recebe os achados desses dois
 * serviços. O registro dele só é pulado quando a fonte própria do serviço, na conta e na região do achado, está de fato
 * sendo coletada (`coveredByOwnCollector`); em qualquer outro caso, o achado entra por aqui. Na dúvida, um achado
 * repetido, nunca um achado perdido. Quem decide é a tarefa (`product`); aqui só se reconhece o produto.
 *
 * **Chave:** `Id` e `ProductArn` juntos identificam o achado (o `Id` sozinho pode se repetir entre produtos); como
 * quase nunca cabem, entram pelo resumo SHA-256. A chave não leva a região: com a agregação entre regiões ligada, o
 * mesmo achado lido pela região de origem e pela agregadora cai na mesma chave.
 */

export const SECURITY_HUB_PAGE_SIZE = 100;
/** O Security Hub aceita 3 chamadas por segundo por conta e região: uma a cada 350 ms fica abaixo. */
export const SECURITY_HUB_MIN_INTERVAL_MS = 350;

/**
 * Onde está o coletor próprio de um serviço (a fonte `guardduty` ou `inspector`) numa conta e região, quando a fonte
 * está de fato sendo coletada (autorização valendo e estado `collecting`): o começo do que ele lê (24 h antes do dia
 * da autorização) e até onde ele já leu uma janela inteira sem erro (null antes da primeira).
 */
export interface OwnCollectorCoverage {
  floor: Date;
  position: Date | null;
}

/**
 * O registro do Security Hub de um serviço com coletor próprio pode ser pulado? Só quando a fonte própria da conta e da
 * região do achado está de fato sendo coletada (`coverage`) e:
 * - o coletor dela já leu essa versão: o `UpdatedAt` do registro está entre o começo do que ele lê e a posição
 *   confirmada dele; ou
 * - o registro é recente: o `UpdatedAt` está na sobreposição que a janela seguinte do Security Hub relê (os últimos
 *   10 min da janela). O coletor próprio ainda vai lê-lo; se ele parar antes disso, a leitura seguinte do Security Hub
 *   traz o registro de novo, já fora deste caso, e ele entra por aqui.
 *
 * Em qualquer outro caso o registro é gravado pelo Security Hub: a fonte própria nunca autorizada, revogada, sumida
 * (`source_missing`: o detector apagado e trocado por outro, que precisa da própria autorização), com erro de
 * permissão ou de ingestão, ou ainda sem a primeira leitura; e o registro que o coletor próprio não alcança (mais
 * antigo do que ele lê, ou depois de onde ele parou e já fora da sobreposição). Assim o cursor do Security Hub nunca
 * passa por cima de um achado que ninguém leu. O custo é um achado repetido (um pela fonte própria, outro pelo
 * Security Hub) nas transições: é o preço aceito para nunca ficar um buraco.
 */
export function coveredByOwnCollector(
  coverage: OwnCollectorCoverage | undefined,
  updatedAt: Date,
  windowEnd: Date,
  overlapMs: number,
): boolean {
  if (coverage === undefined) return false;
  const { floor, position } = coverage;
  if (position !== null && updatedAt >= floor && updatedAt <= position) return true;
  return updatedAt.getTime() >= windowEnd.getTime() - overlapMs;
}

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

/**
 * As táticas do MITRE ATT&CK dos tipos do achado (`TTPs/<tática>/…`, a taxonomia do ASFF). Só o que o produto declarou: o
 * controle reprovado vem com `Software and Configuration Checks/…`, que é postura, e fica sem tática. A taxonomia não
 * traz técnica.
 */
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

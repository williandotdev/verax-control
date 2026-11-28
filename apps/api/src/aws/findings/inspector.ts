import { ListFindingsCommand } from '@aws-sdk/client-inspector2';
import type { FindingDraft } from '../../alerts/finding-draft.js';
import { at } from '../../alerts/wazuh-alert.js';
import type { DiscoveryClients } from '../discovery/clients.js';
import {
  citedAccounts,
  isRecord,
  label,
  MAX_FINDING_RECORD_BYTES,
  parseArn,
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
import {
  AWS_FINDING_RULES,
  type AwsFindingRule,
  inspectorSeverity,
  levelOfSeverity,
} from './finding-rules.js';

/**
 * Inspector pela API (tarefa `aws-findings`): `ListFindings` do Inspector2 com `filterCriteria.updatedAt` (início e fim
 * inclusivos) e `findingStatus = ACTIVE`, 100 por página.
 *
 * É a API, e não o Wazuh, que lê o Inspector porque as regras de fábrica do Wazuh não acusam a severidade `CRITICAL`:
 * aqui ela vira achado crítico. A vulnerabilidade (de pacote e no código) é risco mapeado, não ataque: não avisa por
 * e-mail alerta por alerta, não pinta o semáforo nem entra na lista padrão de alertas (`cases/vulnerability-finding.ts`,
 * decisão de 27/11/2026); fica na fila de vulnerabilidades e no filtro `type=vulnerability`. A porta alcançável de fora
 * (990512) é postura e segue como sempre. O achado fechado (`CLOSED`: corrigido) ou suprimido na origem deixa de ser
 * listado; nada é fechado sozinho no painel.
 *
 * **Chave:** o `findingArn` (`arn:aws:inspector2:<região>:<conta>:finding/<id>`), que cabe inteiro.
 */

export const INSPECTOR_PAGE_SIZE = 100;

/** Até onde o nome do pacote é lido; a coluna é menor, e a gravação corta sem juntar dois nomes. */
const MAX_PACKAGE_NAME = 512;

export async function readInspectorPage(
  clients: DiscoveryClients,
  call: FindingsCaller,
  target: { region: string },
  window: FindingsWindow,
  token: string | null,
): Promise<FindingsPage> {
  const found = await call('inspector2:ListFindings', () =>
    clients.inspector2(target.region).send(
      new ListFindingsCommand({
        filterCriteria: {
          updatedAt: [{ startInclusive: window.since, endInclusive: window.before }],
          findingStatus: [{ comparison: 'EQUALS', value: 'ACTIVE' }],
        },
        maxResults: INSPECTOR_PAGE_SIZE,
        ...(token !== null && { nextToken: token }),
      }),
    ),
  );
  return {
    records: Array.isArray(found.findings) ? found.findings : [],
    nextToken: nextTokenOf(found.nextToken),
  };
}

const RULES: Readonly<Record<string, AwsFindingRule>> = {
  PACKAGE_VULNERABILITY: AWS_FINDING_RULES.inspectorPackage,
  NETWORK_REACHABILITY: AWS_FINDING_RULES.inspectorNetwork,
  CODE_VULNERABILITY: AWS_FINDING_RULES.inspectorCode,
};

/** A porta (ou a faixa) e o protocolo alcançáveis, como `TCP/22` ou `TCP/8000-8080`. */
function reachablePort(raw: Record<string, unknown>): string | undefined {
  const begin = at(raw, 'networkReachabilityDetails', 'openPortRange', 'begin');
  const end = at(raw, 'networkReachabilityDetails', 'openPortRange', 'end');
  const protocol = label(at(raw, 'networkReachabilityDetails', 'protocol'), 16);
  if (typeof begin !== 'number' || !Number.isInteger(begin) || begin < 0 || begin > 65_535) return protocol;
  const range =
    typeof end === 'number' && Number.isInteger(end) && end > begin && end <= 65_535
      ? `${begin}-${end}`
      : String(begin);
  return protocol === undefined ? range : `${protocol}/${range}`;
}

/** Um achado do `ListFindings` do Inspector2, conferido. */
export function parseInspectorFinding(raw: unknown, now: Date): ParseOutcome {
  const bytes = recordBytes(raw);
  if (bytes === null || bytes > MAX_FINDING_RECORD_BYTES || !isRecord(raw)) return INVALID;
  const arn = label(raw['findingArn'], 1024);
  const updatedAt = timestamp(raw['updatedAt'], now) ?? timestamp(raw['lastObservedAt'], now);
  if (arn === undefined || parseArn(arn)?.service !== 'inspector2' || updatedAt === undefined) return INVALID;
  // O filtro já pede só os ativos; a conferência aqui não confia nele.
  if (raw['status'] !== undefined && raw['status'] !== 'ACTIVE') return INACTIVE;

  const type = label(raw['type'], 64);
  const rule = (type === undefined ? undefined : RULES[type]) ?? AWS_FINDING_RULES.inspectorPackage;
  const sourceTitle = label(raw['title'], 300);
  const title = sourceTitle === undefined ? rule.title : `${rule.title}: ${sourceTitle}`;
  const severity = inspectorSeverity(label(raw['severity'], 32));
  const ruleLevel = levelOfSeverity(severity);
  // O que identifica o achado sem ser um link: a vulnerabilidade (CVE), a porta alcançável ou o detector do código.
  const eventName =
    label(at(raw, 'packageVulnerabilityDetails', 'vulnerabilityId'), 128) ??
    (type === 'NETWORK_REACHABILITY' ? reachablePort(raw) : undefined) ??
    label(at(raw, 'codeVulnerabilityDetails', 'detectorName'), 256) ??
    type;
  // O primeiro pacote vulnerável (o mesmo que abre a lista no título): parte da chave do caso.
  const packageName = label(
    at(raw, 'packageVulnerabilityDetails', 'vulnerablePackages', 'name'),
    MAX_PACKAGE_NAME,
  );

  const finding: ParsedFinding = {
    label: 'inspector',
    nativeId: arn,
    updatedAt,
    accounts: citedAccounts(raw['awsAccountId']),
    bytes,
    summary: { title, ruleId: rule.id, ruleLevel },
    drafts: (owner): FindingDraft[] => [
      {
        tenantId: owner.tenantId,
        accountId: owner.accountId,
        source: AWS_FINDINGS_SOURCE,
        sourceEventId: awsFindingKey(owner.accountId, 'inspector', arn),
        occurredAt: updatedAt,
        severity,
        ruleId: rule.id,
        ruleLevel,
        title,
        logSource: 'inspector',
        eventName: eventName ?? null,
        region: region(at(raw, 'resources', 'region')) ?? region(parseArn(arn)?.region) ?? null,
        resource: resourceRef(at(raw, 'resources', 'id')) ?? null,
        actorUser: null,
        actorType: null,
        accessKeyId: null,
        sourceIp: null,
        // Uma vulnerabilidade (CVE), uma porta alcançável ou um trecho de código frágil é uma fraqueza, e não uma ação de
        // um atacante, que é o que o ATT&CK classifica. O Inspector não dá tática, e nenhuma é inventada aqui.
        mitreTactics: [],
        mitreTechniques: [],
        revision: { lastSeenAt: updatedAt },
        ...(packageName !== undefined && { group: packageName }),
      },
    ],
  };
  return { ok: true, finding };
}

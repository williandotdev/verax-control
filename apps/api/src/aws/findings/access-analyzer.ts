import { GetFindingV2Command, ListFindingsV2Command } from '@aws-sdk/client-accessanalyzer';
import type { FindingDraft } from '../../alerts/finding-draft.js';
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
  INACTIVE,
  INVALID,
  nextTokenOf,
  type ParsedFinding,
  type ParseOutcome,
} from './finding-records.js';
import {
  ACCESS_ANALYZER_RULE,
  accessAnalyzerClass,
  accessAnalyzerSeverity,
  levelOfSeverity,
} from './finding-rules.js';

/**
 * Access Analyzer pela API (tarefa `aws-findings`): os analisadores ativos da região (`ListAnalyzers`, na tarefa) e, de
 * cada analisador autorizado, `ListFindingsV2` com `status = ACTIVE`, 100 por página. A API não filtra por data: a
 * listagem é sempre inteira (com teto de páginas por execução e continuação), e só o achado novo ou com `updatedAt` mais
 * novo do que o gravado segue adiante. Do achado de acesso externo, o detalhe (`GetFindingV2`) diz se o acesso é
 * público; ele só é pedido para o achado que passou dessa comparação.
 *
 * Os achados daqui descrevem uma condição que continua valendo (um bucket aberto, um papel sem uso), não um evento: os
 * ativos entram todos, não só os atualizados desde a autorização. O arquivado ou resolvido na origem deixa de ser
 * listado; nada é fechado sozinho no painel.
 *
 * **Chave:** `<região>/<analisador>/<id>` (o ID do achado é único dentro do analisador).
 */

export const ACCESS_ANALYZER_PAGE_SIZE = 100;

export interface AccessAnalyzerTarget {
  region: string;
  /** O nome do analisador (o `resourceId` da fonte). */
  analyzerName: string;
  analyzerArn: string;
}

export async function readAccessAnalyzerPage(
  clients: DiscoveryClients,
  call: FindingsCaller,
  target: AccessAnalyzerTarget,
  token: string | null,
): Promise<FindingsPage> {
  const found = await call('access-analyzer:ListFindings', () =>
    clients.accessanalyzer(target.region).send(
      new ListFindingsV2Command({
        analyzerArn: target.analyzerArn,
        filter: { status: { eq: ['ACTIVE'] } },
        maxResults: ACCESS_ANALYZER_PAGE_SIZE,
        ...(token !== null && { nextToken: token }),
      }),
    ),
  );
  return {
    records: Array.isArray(found.findings) ? found.findings : [],
    nextToken: nextTokenOf(found.nextToken),
  };
}

/** O detalhe de um achado (`GetFindingV2`): de onde sai se o acesso externo é público. */
export async function readAccessAnalyzerDetail(
  clients: DiscoveryClients,
  call: FindingsCaller,
  target: AccessAnalyzerTarget,
  id: string,
): Promise<unknown> {
  return call('access-analyzer:GetFinding', () =>
    clients
      .accessanalyzer(target.region)
      .send(new GetFindingV2Command({ analyzerArn: target.analyzerArn, id })),
  );
}

/** O acesso externo é público? Basta um dos detalhes do achado dizer que sim. */
export function isPublicAccess(detail: unknown): boolean {
  if (!isRecord(detail) || !Array.isArray(detail['findingDetails'])) return false;
  return (detail['findingDetails'] as unknown[])
    .slice(0, 100)
    .some(
      (item) =>
        isRecord(item) &&
        isRecord(item['externalAccessDetails']) &&
        item['externalAccessDetails']['isPublic'] === true,
    );
}

/** O tipo do recurso em português, para o título; o que não está aqui fica como a AWS o chama. */
const RESOURCE_TYPES: Readonly<Record<string, string>> = {
  'AWS::S3::Bucket': 'bucket S3',
  'AWS::S3Express::DirectoryBucket': 'bucket de diretório do S3',
  'AWS::IAM::Role': 'papel IAM',
  'AWS::IAM::User': 'usuário IAM',
  'AWS::SQS::Queue': 'fila SQS',
  'AWS::SNS::Topic': 'tópico SNS',
  'AWS::Lambda::Function': 'função Lambda',
  'AWS::Lambda::LayerVersion': 'camada do Lambda',
  'AWS::KMS::Key': 'chave KMS',
  'AWS::SecretsManager::Secret': 'segredo do Secrets Manager',
  'AWS::EFS::FileSystem': 'sistema de arquivos EFS',
  'AWS::EC2::Snapshot': 'snapshot do EBS',
  'AWS::ECR::Repository': 'repositório ECR',
  'AWS::RDS::DBSnapshot': 'snapshot do RDS',
  'AWS::RDS::DBClusterSnapshot': 'snapshot de cluster do RDS',
  'AWS::DynamoDB::Table': 'tabela do DynamoDB',
  'AWS::DynamoDB::Stream': 'stream do DynamoDB',
};

/** O que está sem uso, para o título dos achados de acesso sem uso. */
const UNUSED_SUBJECTS: Readonly<Record<string, string>> = {
  UnusedIAMRole: 'papel IAM',
  UnusedIAMUserAccessKey: 'chave de acesso de usuário IAM',
  UnusedIAMUserPassword: 'senha de usuário IAM',
  UnusedPermission: 'permissões de identidade IAM',
};

/** Um achado do `ListFindingsV2`, conferido. O rascunho do acesso externo precisa do detalhe (`needsDetail`). */
export function parseAccessAnalyzerFinding(
  raw: unknown,
  target: AccessAnalyzerTarget,
  now: Date,
): ParseOutcome {
  const bytes = recordBytes(raw);
  if (bytes === null || bytes > MAX_FINDING_RECORD_BYTES || !isRecord(raw)) return INVALID;
  const id = label(raw['id'], 128);
  const updatedAt = timestamp(raw['updatedAt'], now);
  if (id === undefined || updatedAt === undefined) return INVALID;
  // O filtro já pede só os ativos; a conferência aqui não confia nele.
  if (raw['status'] !== undefined && raw['status'] !== 'ACTIVE') return INACTIVE;

  const findingType = label(raw['findingType'], 64);
  const resourceType = label(raw['resourceType'], 128);
  const resource = label(raw['resource'], 2048);
  const subject =
    (findingType === undefined ? undefined : UNUSED_SUBJECTS[findingType]) ??
    (resourceType === undefined ? undefined : (RESOURCE_TYPES[resourceType] ?? resourceType));
  const nativeId = `${target.region}/${target.analyzerName}/${id}`;
  const needsDetail = findingType === undefined || findingType === 'ExternalAccess';
  const describe = (isPublic: boolean) => {
    const kind = accessAnalyzerClass(findingType, isPublic);
    const rule = ACCESS_ANALYZER_RULE[kind];
    const severity = accessAnalyzerSeverity(kind);
    return {
      rule,
      severity,
      ruleLevel: levelOfSeverity(severity),
      title: subject === undefined ? rule.title : `${rule.title}: ${subject}`,
    };
  };
  // Sem o detalhe, o resumo da fila sem dono fica com a classe sem o "público".
  const base = describe(false);

  const finding: ParsedFinding = {
    label: 'access-analyzer',
    nativeId,
    updatedAt,
    accounts: citedAccounts(raw['resourceOwnerAccount']),
    bytes,
    needsDetail,
    summary: { title: base.title, ruleId: base.rule.id, ruleLevel: base.ruleLevel },
    drafts: (owner, detail): FindingDraft[] => {
      const described = describe(needsDetail && isPublicAccess(detail));
      return [
        {
          tenantId: owner.tenantId,
          accountId: owner.accountId,
          source: AWS_FINDINGS_SOURCE,
          sourceEventId: awsFindingKey(owner.accountId, 'access-analyzer', nativeId),
          occurredAt: updatedAt,
          severity: described.severity,
          ruleId: described.rule.id,
          ruleLevel: described.ruleLevel,
          title: described.title,
          logSource: 'access_analyzer',
          eventName: findingType ?? 'ExternalAccess',
          // Os recursos globais (IAM, S3) não têm região no ARN: vale a do analisador.
          region: region(parseArn(resource)?.region) ?? target.region,
          resource: resourceRef(resource) ?? null,
          actorUser: null,
          actorType: null,
          accessKeyId: null,
          sourceIp: null,
          mitreTactics: [],
          mitreTechniques: [],
          revision: { lastSeenAt: updatedAt },
        },
      ];
    },
  };
  return { ok: true, finding };
}

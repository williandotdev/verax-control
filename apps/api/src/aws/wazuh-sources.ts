import { createHash } from 'node:crypto';
import {
  AWS_MAX_AUTHORIZED_LOG_GROUPS,
  AWS_MAX_AUTHORIZED_S3_SOURCES,
  AWS_WAZUH_SOURCE_KINDS,
  type AwsSourceDetails,
  type AwsSourceState,
  bucketNameProblem,
  isAwsRegion,
  type WazuhSourceExclusionCode,
} from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { COLLECTING_TENANT } from '../tenants/tenant-status.js';
import { sourceDetails } from './onboarding/onboarding-view.js';

/**
 * As fontes da AWS que o Wazuh do nó lê (fase 2, PR-V4', e o onboarding self-service): o que o CLI `wazuh-sources`
 * imprime para o gerador da configuração do manager (`infra/wazuh/scripts/render-manager-config.py`, pelo
 * `infra/node/bin/wazuh-apply.sh`) e o que a tarefa `wazuh-config` do worker resume na geração. Nenhum valor é segredo:
 * o nó entra no papel de leitura de cada conta com o token que o Google assina para a conta de serviço dele, sem chave
 * nem ExternalId. O papel nunca vai na lista: o gerador o deriva do ID da conta.
 *
 * A lista sai das fontes autorizadas (`AwsSource`, com a autorização valendo) lidas de bucket ou do CloudWatch Logs,
 * das contas AWS ativas, de clientes ativos, que passaram pela verificação ao menos uma vez (`ingestFrom`). Só os tipos
 * que o Wazuh lê (`collector`): o balanceador (`elb_logs`) também é lido de bucket, mas pelo worker, e nem a lista nem a
 * saúde gravada pela tarefa `wazuh-config` sabem que ele existe (`wazuh-isolation.test.ts`).
 *
 * - **As linhas dos buckets do cadastro anterior** (`origin = legacy`, o espelho de `cloudtrailBucket` e dos outros
 *   dois; `onboarding/legacy-sources.ts`) entram sempre, como entravam: a conexão de agora não conta, e um erro
 *   passageiro ou o aviso que a própria coleta grava não tiram a conta do manager nem o reiniciam. A configuração que o
 *   gerador escreve para elas é, byte a byte, a de antes.
 * - **As fontes descobertas** entram enquanto o estado delas é da coleta (`WAZUH_COLLECTOR_STATES`). A que perdeu a
 *   permissão (`permission_error`) ou sumiu da conta (`source_missing`), estados que a descoberta grava, sai até voltar:
 *   no CloudWatch Logs, um grupo negado ou apagado faz o módulo parar a leitura de todos os grupos seguintes da mesma
 *   conta e região.
 * - Cada fonte lê só o que é dela: a pasta da conta e as regiões (a trilha de organização, com o ID da organização), o
 *   caminho de uma Web ACL, um grupo de logs por nome. A coleta começa no dia da autorização (`collectFrom`), sem
 *   histórico.
 *
 * A fonte que não dá para ler como está fica de fora da lista, com o motivo (`WazuhSourceExclusionCode`), em vez de
 * derrubar a lista inteira no gerador: um nome com caractere que o módulo recusa, uma região que ele não conhece, a
 * trilha de organização sem o ID da organização, um prefixo fora dos buckets do cadastro, o teto por conta e o grupo de
 * logs com o mesmo nome e região de outra conta do nó (o marcador do módulo não tem a conta).
 */

/** A versão do formato da lista. O gerador recusa uma que não conhece (`LIST_VERSION` nele). */
export const WAZUH_SOURCES_VERSION = 2;

/**
 * As regiões que o módulo aws-s3 do Wazuh 4.14.9 aceita (`aws_tools.ALL_REGIONS` na imagem; `WODLE_REGIONS` no
 * gerador). Com qualquer outra, o módulo para a leitura inteira da entrada, em todas as regiões.
 */
export const WAZUH_AWS_REGIONS = [
  'af-south-1',
  'ap-east-1',
  'ap-east-2',
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-south-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-southeast-3',
  'ap-southeast-4',
  'ap-southeast-5',
  'ap-southeast-7',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'il-central-1',
  'me-central-1',
  'me-south-1',
  'mx-central-1',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-gov-east-1',
  'us-gov-west-1',
  'us-west-1',
  'us-west-2',
] as const;
const SUPPORTED_REGIONS: ReadonlySet<string> = new Set(WAZUH_AWS_REGIONS);

/** Os formatos que o gerador confere de novo (as mesmas expressões nele; o contrato compara os dois lados). */
export const WAZUH_WEB_ACL = /^[A-Za-z0-9_-]{1,128}$/;
/** Cada pasta do prefixo antes de `AWSLogs/` (até `WAZUH_MAX_PREFIX_SEGMENTS`, e `WAZUH_MAX_PREFIX` caracteres ao todo). */
export const WAZUH_PREFIX_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;
export const WAZUH_MAX_PREFIX_SEGMENTS = 8;
export const WAZUH_MAX_PREFIX = 256;
export const WAZUH_LOG_GROUP = /^[A-Za-z0-9._/-]{1,512}$/;
export const WAZUH_ORGANIZATION_ID = /^o-[a-z0-9]{10,32}$/;
/** A "região" no caminho dos logs de uma Web ACL do CloudFront (`WAF_CLOUDFRONT_PATH_REGION` do catálogo). */
export const WAZUH_WAF_CLOUDFRONT = 'cloudfront';

/** O tráfego dos flow logs que entra: só o rejeitado (o aceito é descartado no módulo) ou tudo. */
export const WAZUH_FLOW_TRAFFIC = ['rejected', 'all'] as const;
export type WazuhFlowTraffic = (typeof WAZUH_FLOW_TRAFFIC)[number];
/**
 * O padrão de todo flow log autorizado: só o tráfego rejeitado. O aceito é a maior parte do volume, não diz nada
 * sozinho e contaria no volume contratado; descartado no módulo, nem chega ao analysisd (nem ao medidor de uso), como
 * as requisições liberadas do WAF. A lista e o gerador já aceitam `all` por fonte; a escolha no painel ainda não existe.
 */
export const WAZUH_FLOW_TRAFFIC_DEFAULT: WazuhFlowTraffic = 'rejected';

/** Os tipos de bucket do módulo que a lista usa. */
export type WazuhBucketType = 'cloudtrail' | 'vpcflow' | 'guardduty' | 'waf';

/**
 * Uma entrada de bucket da lista, com os campos nesta ordem. A do cadastro anterior leva só `legacy`; as descobertas,
 * os campos do tipo delas (o gerador recusa um campo fora do tipo).
 */
export interface WazuhS3Entry {
  type: WazuhBucketType;
  bucket: string;
  /** O `only_logs_after` do Wazuh (`2026-NOV-01`): o dia em que a coleta da fonte começa. */
  onlyLogsAfter: string;
  /** O bucket do cadastro anterior: a configuração de sempre. */
  legacy?: true;
  /** `cloudtrail`, `vpcflow` e `guardduty`: as regiões lidas, em ordem. */
  regions?: string[];
  /** `cloudtrail`: a trilha de organização (`AWSLogs/<organização>/<conta>/`). */
  organizationId?: string;
  /** `vpcflow`: o tráfego que entra. */
  traffic?: WazuhFlowTraffic;
  /** `waf`: a Web ACL e a região dela (ou `cloudfront`). */
  webAcl?: string;
  scope?: string;
  /** O prefixo antes de `AWSLogs/`, sem barra nas pontas (só nos buckets do cadastro anterior). */
  prefix?: string;
}

/** Os grupos do CloudWatch Logs de uma região com o mesmo início da coleta, em ordem de nome. */
export interface WazuhLogGroupsEntry {
  region: string;
  names: string[];
  onlyLogsAfter: string;
}

export interface WazuhAccount {
  accountId: string;
  /** A primeira região monitorada: a do STS e do S3 no profile da conta. */
  region: string;
  s3: WazuhS3Entry[];
  logGroups: WazuhLogGroupsEntry[];
}

export interface WazuhSourceList {
  version: typeof WAZUH_SOURCES_VERSION;
  accounts: WazuhAccount[];
}

/** Os estados de uma fonte descoberta em que ela é da coleta (entra na lista, ou está fora dela por um motivo daqui). */
export const WAZUH_COLLECTOR_STATES = [
  'authorized',
  'configuring',
  'waiting_events',
  'collecting',
  'stalled',
  'ingestion_error',
] as const satisfies readonly AwsSourceState[];

const WAZUH_METHODS = ['s3', 'cloudwatch'];
const WAZUH_KINDS: readonly string[] = AWS_WAZUH_SOURCE_KINDS;
const AUTHORIZED = {
  authorizedAt: { not: null },
  revokedAt: null,
  method: { in: WAZUH_METHODS },
  // A linha de um tipo do worker não chega nem a ser lida (e a conta que só tem delas não entra na busca).
  kind: { in: [...WAZUH_KINDS] },
};

/** O que a lista e a saúde da coleta leem de uma fonte. */
export const WAZUH_SOURCE_SELECT = {
  id: true,
  tenantId: true,
  cloudAccountId: true,
  kind: true,
  region: true,
  resourceId: true,
  name: true,
  details: true,
  method: true,
  origin: true,
  authorizedAt: true,
  collectFrom: true,
  state: true,
  stateCode: true,
  stateSince: true,
  lastSyncAt: true,
  lastEventAt: true,
  lastIngestedAt: true,
  lagSeconds: true,
} as const satisfies Prisma.AwsSourceSelect;
export type WazuhSourceRow = Prisma.AwsSourceGetPayload<{ select: typeof WAZUH_SOURCE_SELECT }>;

export const WAZUH_ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  regions: true,
  ingestFrom: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
  // O aviso da coleta, que só a tarefa wazuh-config grava; a conexão não entra (é da tarefa aws-check).
  collectionError: true,
  awsSources: {
    where: AUTHORIZED,
    select: WAZUH_SOURCE_SELECT,
    // A ordem em que os tetos e o conflito de nome decidem: a autorização mais antiga primeiro.
    orderBy: [{ authorizedAt: 'asc' }, { id: 'asc' }],
  },
  // As regiões habilitadas na conta, pela última descoberta que entrou nela: as de uma trilha de todas as regiões.
  awsDiscoveryRuns: {
    where: { status: { in: ['succeeded', 'partial'] } },
    select: { regions: true },
    orderBy: { finishedAt: 'desc' },
    take: 1,
  },
} as const satisfies Prisma.CloudAccountSelect;
export type WazuhAccountRow = Prisma.CloudAccountGetPayload<{ select: typeof WAZUH_ACCOUNT_SELECT }>;

/**
 * As contas AWS com fonte autorizada lida pelo Wazuh, numa busca de sistema (todos os clientes do nó), em ordem de ID:
 * a mesma lista dá sempre a mesma geração. `tenantIds`: só os testes, que dividem o banco com outras suítes.
 */
export function findWazuhSourceRows(
  db: Prisma.TransactionClient,
  tenantIds?: readonly string[],
): Promise<WazuhAccountRow[]> {
  return db.cloudAccount.findMany({
    where: {
      provider: 'aws',
      status: 'active',
      // Só cliente ativo (CE-02): o suspenso, cancelado ou em expurgo sai do manager.
      ...COLLECTING_TENANT,
      ingestFrom: { not: null },
      awsSources: { some: AUTHORIZED },
      ...(tenantIds !== undefined && { tenantId: { in: [...tenantIds] } }),
    },
    select: WAZUH_ACCOUNT_SELECT,
    orderBy: { accountId: 'asc' },
  });
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'] as const;

/** Uma data no formato do `only_logs_after` do Wazuh (`2026-NOV-01`), pelo dia em UTC. */
export function wazuhDate(day: Date): string {
  const month = MONTHS[day.getUTCMonth()] ?? 'JAN';
  return `${String(day.getUTCFullYear()).padStart(4, '0')}-${month}-${String(day.getUTCDate()).padStart(2, '0')}`;
}

// --- De cada fonte à entrada dela na lista e ao marcador do módulo ---

/**
 * Onde o módulo guarda o que já leu de uma fonte, para a saúde da coleta achar o marcador dela no sinal `progress`
 * (`infra/wazuh/scripts/export-aws-progress.py`). No banco `s3_cloudtrail.db` do módulo, cada tipo de bucket tem uma
 * tabela, e cada linha é um objeto lido:
 *
 * - `cloudtrail` e `vpcflow`: `bucket_path` (`<bucket>/<prefixo>/`), a conta da pasta e a região (os flow logs, também
 *   o ID do flow log). A linha do cadastro anterior não fixa regiões: vale qualquer uma daquela conta naquele bucket;
 * - `guardduty`: `bucket_path` e a conta da pasta, sem região. A do cadastro anterior lê o bucket inteiro (o export de
 *   um administrador delegado traz as contas membro): vale a linha de qualquer conta naquele bucket;
 * - `waf`: `bucket_path` é o bucket mais o caminho lido (`<bucket>/` no cadastro anterior, que lê da raiz; o caminho da
 *   Web ACL nas fontes descobertas), e a conta é a de quem leu (a do profile), que no bucket dividido do cadastro
 *   anterior é a de menor ID: vale a linha de qualquer conta com aquele caminho.
 *
 * O CloudWatch Logs fica em `aws_services.db`, por região, grupo e stream, sem a conta.
 */
export type WazuhMarkerRef =
  | {
      method: 's3';
      table: WazuhBucketType;
      bucketPath: string;
      /** A conta da pasta; null: qualquer conta. */
      accountId: string | null;
      /** As regiões da leitura; null: qualquer região (ou a tabela não tem região). */
      regions: readonly string[] | null;
      flowLogId: string | null;
    }
  | { method: 'cloudwatch'; region: string; logGroup: string };

/** O que a conferência de fonte parada precisa para listar a origem: o bucket e a pasta de cada região. */
export interface WazuhObjectPrefix {
  bucket: string;
  /** A pasta dos objetos de uma região (`…AWSLogs/[<organização>/]<conta>/<serviço>/<região>/`). */
  regionPrefix(region: string): string;
  /** O começo do nome dos objetos da fonte numa região (`<conta>_vpcflowlogs_<região>_<flow log>_`). */
  fileHead(region: string): string;
}

/** O que a coleta faz com uma fonte: entra na lista (com o marcador dela) ou fica de fora, com o motivo. */
export type WazuhSourceOutcome =
  | { included: true; marker: WazuhMarkerRef; objects: WazuhObjectPrefix | null }
  | { included: false; code: WazuhSourceExclusionCode };

export interface PlannedWazuhSource {
  row: WazuhSourceRow;
  /** O ID da conta AWS (12 dígitos). */
  accountId: string;
  /** A primeira região monitorada da conta: a de partida do S3. */
  homeRegion: string;
  outcome: WazuhSourceOutcome;
}

/**
 * Os donos (o cliente e a conta AWS) dos grupos do CloudWatch Logs que estão na lista, sem repetição. O evento de um
 * grupo chega ao indexer sem a conta e sem o grupo: só com um dono só, na lista que o manager de fato roda, dá para
 * dizer de quem ele é (`alerts/cloudwatch-ownership.ts`). O grupo que ficou de fora da lista não conta: o manager não
 * o lê.
 */
export function plannedLogGroupOwners(
  sources: readonly PlannedWazuhSource[],
): { tenantId: string; accountId: string }[] {
  const owners = new Map<string, { tenantId: string; accountId: string }>();
  for (const { row, accountId, outcome } of sources) {
    if (row.method !== 'cloudwatch' || !outcome.included) continue;
    owners.set(`${row.tenantId}:${accountId}`, { tenantId: row.tenantId, accountId });
  }
  return [...owners.values()];
}

export interface WazuhPlan {
  list: WazuhSourceList;
  /** As contas que estão na lista (as que o manager lê). */
  accounts: WazuhAccountRow[];
  /** Todas as fontes da coleta, na lista ou fora dela. */
  sources: PlannedWazuhSource[];
}

const AWS_LOGS_FOLDER = { cloudtrail: 'CloudTrail', vpcflow: 'vpcflowlogs', guardduty: 'GuardDuty' } as const;
const LEGACY_TYPE: Readonly<Record<string, WazuhBucketType>> = {
  cloudtrail: 'cloudtrail',
  guardduty_export: 'guardduty',
  waf: 'waf',
};

interface Draft {
  entry: WazuhS3Entry | null;
  logGroup: { region: string; name: string; onlyLogsAfter: string } | null;
  marker: WazuhMarkerRef;
  objects: WazuhObjectPrefix | null;
}

type Planned = { ok: true; draft: Draft } | { ok: false; code: WazuhSourceExclusionCode };
const excluded = (code: WazuhSourceExclusionCode): Planned => ({ ok: false, code });

function validBucket(bucket: string | undefined): bucket is string {
  return bucket !== undefined && bucketNameProblem(bucket) === null;
}

function supportedRegion(region: string): boolean {
  return isAwsRegion(region) && SUPPORTED_REGIONS.has(region);
}

/** O prefixo antes de `AWSLogs/`: só nos buckets do cadastro anterior (o papel os lê inteiros), e só o que o gerador aceita. */
function prefixOf(
  details: AwsSourceDetails,
  bucket: string,
  account: WazuhAccountRow,
): { ok: true; prefix: string | null } | { ok: false; code: WazuhSourceExclusionCode } {
  const prefix = details.customPrefix;
  if (prefix === undefined) return { ok: true, prefix: null };
  const legacy = [account.cloudtrailBucket, account.guarddutyBucket, account.wafBucket];
  if (!legacy.includes(bucket)) return { ok: false, code: 'custom_prefix_unsupported' };
  const parts = prefix.split('/');
  const valid =
    prefix.length <= WAZUH_MAX_PREFIX &&
    parts.length <= WAZUH_MAX_PREFIX_SEGMENTS &&
    parts.every((part) => WAZUH_PREFIX_SEGMENT.test(part) && part !== '.' && part !== '..');
  return valid ? { ok: true, prefix } : { ok: false, code: 'unsupported_name' };
}

/** As regiões de uma trilha: a dela ou, na de todas as regiões, as habilitadas na conta (as que o módulo aceita). */
function trailRegions(row: WazuhSourceRow, details: AwsSourceDetails, account: WazuhAccountRow): string[] {
  if (details.multiRegion !== true) return supportedRegion(row.region) ? [row.region] : [];
  const enabled = account.awsDiscoveryRuns[0]?.regions ?? [];
  // Sem as regiões da descoberta, as monitoradas da conta. A da trilha entra sempre.
  const regions = new Set([row.region, ...(enabled.length > 0 ? enabled : account.regions)]);
  return [...regions].filter(supportedRegion).sort();
}

function awsLogsObjects(
  bucket: string,
  prefix: string | null,
  organizationId: string | undefined,
  accountId: string,
  folder: string,
  flowLogId?: string,
): WazuhObjectPrefix {
  const custom = prefix === null ? '' : `${prefix}/`;
  const organization = organizationId === undefined ? '' : `${organizationId}/`;
  const head = `${custom}AWSLogs/${organization}${accountId}/${folder}/`;
  const tail = flowLogId === undefined ? '' : `${flowLogId}_`;
  return {
    bucket,
    regionPrefix: (region) => `${head}${region}/`,
    // O nome que a AWS dá ao objeto: `<conta>_<serviço>_<região>_[<flow log>_]<horário>_<sufixo>`.
    fileHead: (region) => `${accountId}_${folder}_${region}_${tail}`,
  };
}

/** A entrada e o marcador da linha de um bucket do cadastro anterior. */
function planLegacy(row: WazuhSourceRow, account: WazuhAccountRow): Planned {
  const type = LEGACY_TYPE[row.kind];
  const bucket = sourceDetails(row.details).bucket ?? row.name;
  // O início da coleta é o da conta; a linha o acompanha (`syncLegacyAwsSources`).
  const from = row.collectFrom ?? account.ingestFrom;
  if (type === undefined || !validBucket(bucket) || from === null) return excluded('invalid_details');
  if (type === 'waf' && !bucket.startsWith('aws-waf-logs-')) return excluded('invalid_details');
  return {
    ok: true,
    draft: {
      entry: { type, bucket, onlyLogsAfter: wazuhDate(from), legacy: true },
      logGroup: null,
      marker: {
        method: 's3',
        table: type,
        bucketPath: `${bucket}/`,
        accountId: type === 'cloudtrail' ? account.accountId : null,
        regions: null,
        flowLogId: null,
      },
      objects:
        type === 'cloudtrail'
          ? awsLogsObjects(bucket, null, undefined, account.accountId, AWS_LOGS_FOLDER.cloudtrail)
          : null,
    },
  };
}

/** A entrada e o marcador de uma fonte descoberta, ou o motivo de ela ficar de fora. */
function planDiscovered(row: WazuhSourceRow, account: WazuhAccountRow): Planned {
  const details = sourceDetails(row.details);
  if (row.collectFrom === null) return excluded('invalid_details');
  const onlyLogsAfter = wazuhDate(row.collectFrom);
  const accountId = account.accountId;

  if (row.kind === 'cloudwatch_log_group') {
    const name = details.logGroup ?? row.resourceId;
    if (!supportedRegion(row.region)) return excluded('region_unsupported');
    if (!WAZUH_LOG_GROUP.test(name)) return excluded('unsupported_name');
    return {
      ok: true,
      draft: {
        entry: null,
        logGroup: { region: row.region, name, onlyLogsAfter },
        marker: { method: 'cloudwatch', region: row.region, logGroup: name },
        objects: null,
      },
    };
  }

  const { bucket } = details;
  if (!validBucket(bucket)) return excluded('invalid_details');
  const custom = prefixOf(details, bucket, account);
  if (!custom.ok) return excluded(custom.code);
  const { prefix } = custom;
  const bucketPath = `${bucket}/${prefix === null ? '' : `${prefix}/`}`;
  const withPrefix = prefix === null ? {} : { prefix };

  switch (row.kind) {
    case 'cloudtrail': {
      const regions = trailRegions(row, details, account);
      if (regions.length === 0) return excluded('region_unsupported');
      const { organizationId } = details;
      // A trilha de organização grava em `AWSLogs/<organização>/<conta>/`: sem o ID, não há pasta para ler.
      if (details.organizationTrail === true && organizationId === undefined)
        return excluded('organization_id_unknown');
      if (organizationId !== undefined && !WAZUH_ORGANIZATION_ID.test(organizationId))
        return excluded('invalid_details');
      return {
        ok: true,
        draft: {
          entry: {
            type: 'cloudtrail',
            bucket,
            onlyLogsAfter,
            regions,
            ...(organizationId !== undefined && { organizationId }),
            ...withPrefix,
          },
          logGroup: null,
          marker: { method: 's3', table: 'cloudtrail', bucketPath, accountId, regions, flowLogId: null },
          objects: awsLogsObjects(bucket, prefix, organizationId, accountId, AWS_LOGS_FOLDER.cloudtrail),
        },
      };
    }
    case 'vpc_flow_logs': {
      if (!supportedRegion(row.region)) return excluded('region_unsupported');
      const flowLogId = details.flowLogId ?? row.resourceId;
      return {
        ok: true,
        draft: {
          entry: {
            type: 'vpcflow',
            bucket,
            onlyLogsAfter,
            regions: [row.region],
            traffic: WAZUH_FLOW_TRAFFIC_DEFAULT,
            ...withPrefix,
          },
          logGroup: null,
          marker: { method: 's3', table: 'vpcflow', bucketPath, accountId, regions: [row.region], flowLogId },
          objects: awsLogsObjects(bucket, prefix, undefined, accountId, AWS_LOGS_FOLDER.vpcflow, flowLogId),
        },
      };
    }
    case 'guardduty_export': {
      if (!supportedRegion(row.region)) return excluded('region_unsupported');
      return {
        ok: true,
        draft: {
          entry: { type: 'guardduty', bucket, onlyLogsAfter, regions: [row.region], ...withPrefix },
          logGroup: null,
          // A tabela do GuardDuty não guarda a região: o marcador é o da pasta da conta naquele bucket.
          marker: { method: 's3', table: 'guardduty', bucketPath, accountId, regions: null, flowLogId: null },
          objects: null,
        },
      };
    }
    case 'waf': {
      const webAcl = details.webAclName;
      if (webAcl === undefined || !bucket.startsWith('aws-waf-logs-')) return excluded('invalid_details');
      if (!WAZUH_WEB_ACL.test(webAcl)) return excluded('unsupported_name');
      const cloudfront = details.webAclScope === 'CLOUDFRONT';
      if (!cloudfront && !isAwsRegion(row.region)) return excluded('region_unsupported');
      const scope = cloudfront ? WAZUH_WAF_CLOUDFRONT : row.region;
      const path = `${prefix === null ? '' : `${prefix}/`}AWSLogs/${accountId}/WAFLogs/${scope}/${webAcl}/`;
      return {
        ok: true,
        draft: {
          entry: { type: 'waf', bucket, onlyLogsAfter, webAcl, scope, ...withPrefix },
          logGroup: null,
          marker: {
            method: 's3',
            table: 'waf',
            bucketPath: `${bucket}/${path}`,
            accountId: null,
            regions: null,
            flowLogId: null,
          },
          objects: null,
        },
      };
    }
    default:
      // Um tipo que o Wazuh não lê nunca chega até aqui (`collected`).
      return excluded('invalid_details');
  }
}

const LEGACY_ORDER: readonly WazuhBucketType[] = ['cloudtrail', 'guardduty', 'waf'];
const TYPE_ORDER: readonly WazuhBucketType[] = ['cloudtrail', 'vpcflow', 'guardduty', 'waf'];
const SEPARATOR = '\u0000';

/** A data do Wazuh (`2026-NOV-01`) num texto que ordena por dia (`2026-10-01`). */
function dayOrder(wazuh: string): string {
  const [year = '', month = '', day = ''] = wazuh.split('-');
  return `${year}-${String(MONTHS.indexOf(month as (typeof MONTHS)[number])).padStart(2, '0')}-${day}`;
}

/** A ordem das entradas de bucket de uma conta: as do cadastro anterior primeiro, depois por tipo e pelo resto. */
function entryOrder(entry: WazuhS3Entry): string {
  const position =
    entry.legacy === true ? `0${LEGACY_ORDER.indexOf(entry.type)}` : `1${TYPE_ORDER.indexOf(entry.type)}`;
  return [
    position,
    entry.bucket,
    entry.prefix ?? '',
    entry.organizationId ?? '',
    entry.scope ?? '',
    entry.webAcl ?? '',
    (entry.regions ?? []).join(','),
    dayOrder(entry.onlyLogsAfter),
    entry.traffic ?? '',
  ].join(SEPARATOR);
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A fonte é da coleta do Wazuh: só os tipos dele (a busca já os filtra; aqui, o plano não depende dela); a linha do cadastro
 * anterior, sempre; a descoberta, enquanto o estado é da coleta.
 */
function collected(row: WazuhSourceRow): boolean {
  if (!WAZUH_KINDS.includes(row.kind)) return false;
  if (row.origin === 'legacy') return true;
  return (WAZUH_COLLECTOR_STATES as readonly string[]).includes(row.state);
}

function plan(row: WazuhSourceRow, account: WazuhAccountRow): Planned {
  return row.origin === 'legacy' ? planLegacy(row, account) : planDiscovered(row, account);
}

/** De quem é cada nome de grupo em cada região do nó: da fonte com a autorização mais antiga. */
function claimLogGroups(rows: readonly WazuhAccountRow[]): Map<string, string> {
  const candidates = rows
    .flatMap((account) =>
      account.awsSources
        .filter((row) => row.kind === 'cloudwatch_log_group' && collected(row))
        .map((row) => ({ row, account })),
    )
    .sort(
      (a, b) =>
        (a.row.authorizedAt?.getTime() ?? 0) - (b.row.authorizedAt?.getTime() ?? 0) ||
        byText(a.row.id, b.row.id),
    );
  const claimed = new Map<string, string>();
  for (const { row, account } of candidates) {
    const planned = plan(row, account);
    if (!planned.ok || planned.draft.logGroup === null) continue;
    const key = `${planned.draft.logGroup.region}${SEPARATOR}${planned.draft.logGroup.name}`;
    if (!claimed.has(key)) claimed.set(key, row.id);
  }
  return claimed;
}

/**
 * A lista que o gerador recebe e o que a coleta faz com cada fonte, só com o que está nas linhas: a mesma entrada dá
 * sempre a mesma lista (e a mesma geração). Nada aqui depende do estado que a própria coleta grava (`configuring`,
 * `collecting`, o motivo de uma fonte de fora), para a lista não oscilar.
 */
export function planWazuhSources(rows: readonly WazuhAccountRow[]): WazuhPlan {
  const sources: PlannedWazuhSource[] = [];
  const accounts: WazuhAccountRow[] = [];
  const list: WazuhSourceList = { version: WAZUH_SOURCES_VERSION, accounts: [] };
  // O nome de um grupo numa região só entra uma vez no nó: o marcador do módulo não tem a conta.
  const claimed = claimLogGroups(rows);

  for (const account of rows) {
    // A API exige ao menos uma região; a busca já exige o início da coleta.
    const region = account.regions[0];
    if (region === undefined || account.ingestFrom === null) continue;
    const entries = new Map<string, WazuhS3Entry>();
    const groups = new Map<string, WazuhLogGroupsEntry>();
    let buckets = 0;
    let logGroups = 0;
    // As linhas do cadastro anterior primeiro: o teto nunca tira o que já era lido.
    const ordered = [...account.awsSources].sort(
      (a, b) => Number(b.origin === 'legacy') - Number(a.origin === 'legacy'),
    );
    for (const row of ordered) {
      if (!collected(row)) continue;
      const planned = plan(row, account);
      const outcome = ((): WazuhSourceOutcome => {
        if (!planned.ok) return { included: false, code: planned.code };
        const { draft } = planned;
        if (draft.logGroup !== null) {
          const { region: groupRegion, name, onlyLogsAfter } = draft.logGroup;
          if (claimed.get(`${groupRegion}${SEPARATOR}${name}`) !== row.id)
            return { included: false, code: 'log_group_name_conflict' };
          if (logGroups >= AWS_MAX_AUTHORIZED_LOG_GROUPS) return { included: false, code: 'source_limit' };
          logGroups += 1;
          const key = `${groupRegion}${SEPARATOR}${dayOrder(onlyLogsAfter)}`;
          const entry = groups.get(key) ?? { region: groupRegion, names: [], onlyLogsAfter };
          entry.names.push(name);
          groups.set(key, entry);
        } else if (draft.entry !== null) {
          if (buckets >= AWS_MAX_AUTHORIZED_S3_SOURCES) return { included: false, code: 'source_limit' };
          buckets += 1;
          // Duas fontes com a mesma leitura (dois flow logs da região no mesmo bucket) dão uma entrada só.
          entries.set(entryOrder(draft.entry), draft.entry);
        }
        return { included: true, marker: draft.marker, objects: draft.objects };
      })();
      sources.push({ row, accountId: account.accountId, homeRegion: region, outcome });
    }
    if (entries.size === 0 && groups.size === 0) continue;
    accounts.push(account);
    list.accounts.push({
      accountId: account.accountId,
      region,
      s3: [...entries.entries()].sort(([a], [b]) => byText(a, b)).map(([, entry]) => entry),
      logGroups: [...groups.entries()]
        .sort(([a], [b]) => byText(a, b))
        .map(([, entry]) => ({ ...entry, names: [...entry.names].sort(byText) })),
    });
  }
  return { list, accounts, sources };
}

/** A lista das contas, como o CLI a imprime (sem as fontes de fora nem os marcadores). */
export function toWazuhSources(rows: readonly WazuhAccountRow[]): WazuhSourceList {
  return planWazuhSources(rows).list;
}

/** A lista como o CLI a imprime: uma linha de JSON (o CLI acrescenta só a quebra de linha do fim). */
export function serializeWazuhSources(list: WazuhSourceList): string {
  return JSON.stringify(list);
}

/**
 * A geração: o SHA-256 da lista serializada. O `wazuh-apply.sh` calcula o mesmo da saída do CLI (sem a quebra de linha)
 * e o devolve no sinal `applied`; o worker compara os dois para saber se o resultado é da lista de agora.
 */
export function wazuhSourcesGeneration(serialized: string): string {
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

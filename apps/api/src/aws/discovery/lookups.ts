import { ListAnalyzersCommand } from '@aws-sdk/client-accessanalyzer';
import {
  DescribeTrailsCommand,
  GetEventSelectorsCommand,
  GetTrailStatusCommand,
} from '@aws-sdk/client-cloudtrail';
import { DescribeLogGroupsCommand, ListTagsForResourceCommand } from '@aws-sdk/client-cloudwatch-logs';
import {
  DescribeConfigurationRecordersCommand,
  DescribeConfigurationRecorderStatusCommand,
  DescribeDeliveryChannelsCommand,
} from '@aws-sdk/client-config-service';
import { DescribeFlowLogsCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import {
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  DescribePublishingDestinationCommand,
  GetDetectorCommand,
  ListDetectorsCommand,
  ListPublishingDestinationsCommand,
} from '@aws-sdk/client-guardduty';
import { GetAccountSummaryCommand } from '@aws-sdk/client-iam';
import { BatchGetAccountStatusCommand } from '@aws-sdk/client-inspector2';
import { DescribeDBClustersCommand, DescribeDBInstancesCommand } from '@aws-sdk/client-rds';
import { DescribeHubCommand } from '@aws-sdk/client-securityhub';
import { ListLoggingConfigurationsCommand, ListWebACLsCommand } from '@aws-sdk/client-wafv2';
import { hasAwsLogGroupReadTag, isAwsRegion } from '@verax/shared';
import type {
  AnalyzerFact,
  ConfigRecorderFact,
  DetectorFact,
  FlowLogFact,
  LoadBalancerFact,
  LogGroupFact,
  TrailFact,
  WebAclFact,
} from './catalogue.js';
import type { DiscoveryClients } from './clients.js';

/**
 * As leituras da descoberta, uma função por serviço: só chamadas `Describe*`, `Get*`, `List*` e `BatchGet*`, com teto de
 * páginas e de itens, devolvendo só nomes e configuração (nenhum conteúdo de log). Cada função lança o erro da AWS como
 * veio; quem isola a falha por serviço e região é a execução (`discovery.ts`).
 *
 * As chamadas, por serviço:
 * - CloudTrail: `DescribeTrails` por região (com as trilhas de outras regiões), `GetTrailStatus` e `GetEventSelectors`
 *   por trilha, na região dela;
 * - VPC: `DescribeFlowLogs` e `DescribeVpcs` por região;
 * - WAF: `ListWebACLs` e `ListLoggingConfigurations`, por região (escopo `REGIONAL`) e uma vez em us-east-1 (`CLOUDFRONT`);
 * - GuardDuty: `ListDetectors`, `GetDetector`, `ListPublishingDestinations` e `DescribePublishingDestination`;
 * - Security Hub: `DescribeHub`; Inspector: `BatchGetAccountStatus`; Access Analyzer: `ListAnalyzers`;
 * - CloudWatch Logs: `DescribeLogGroups` e, por grupo, `ListTagsForResource`;
 * - Config: `DescribeConfigurationRecorders`, `DescribeConfigurationRecorderStatus` e `DescribeDeliveryChannels`;
 * - Load balancers: `DescribeLoadBalancers` e `DescribeLoadBalancerAttributes`;
 * - RDS: `DescribeDBInstances` e `DescribeDBClusters`; IAM: `GetAccountSummary`.
 */

/** Tetos por região. O que passa disso fica de fora, e a execução registra `Truncated`. */
export const MAX_FLOW_LOGS = 500;
export const MAX_WEB_ACLS = 200;
export const MAX_LOG_GROUPS = 500;
export const MAX_LOAD_BALANCERS = 100;
export const MAX_DB_INSTANCES = 1000;
const MAX_DETECTORS = 10;
const MAX_ANALYZERS = 50;
/** Leituras por item (tags dos grupos, atributos dos load balancers) ao mesmo tempo, dentro de uma região. */
const ITEM_CONCURRENCY = 4;

const text = (value: unknown, max = 2048): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Executa `task` para cada item, no máximo `ITEM_CONCURRENCY` de cada vez, mantendo a ordem. */
async function mapLimited<T, R>(items: readonly T[], task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(ITEM_CONCURRENCY, items.length) }, worker));
  return results;
}

/** O resultado de uma leitura por item: o valor, ou o erro que a leitura deixou. */
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(call: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error };
  }
}

// --- CloudTrail ---

/** As trilhas que a região enxerga (as multirregionais aparecem em todas), sem o status. */
export async function listTrails(clients: DiscoveryClients, region: string): Promise<TrailFact[]> {
  const found = await clients
    .cloudtrail(region)
    .send(new DescribeTrailsCommand({ includeShadowTrails: true }));
  const trails: TrailFact[] = [];
  for (const trail of found.trailList ?? []) {
    const arn = text(trail.TrailARN, 512);
    const name = text(trail.Name, 256);
    if (arn === null || name === null) continue;
    const home = text(trail.HomeRegion, 32);
    trails.push({
      arn,
      name,
      homeRegion: home !== null && isAwsRegion(home) ? home : region,
      bucket: text(trail.S3BucketName, 63),
      keyPrefix: text(trail.S3KeyPrefix, 512),
      multiRegion: trail.IsMultiRegionTrail === true,
      organizationTrail: trail.IsOrganizationTrail === true,
      kmsKeyId: text(trail.KmsKeyId),
      logGroupArn: text(trail.CloudWatchLogsLogGroupArn),
      logging: null,
      managementEvents: null,
    });
  }
  return trails;
}

/** Se a trilha está gravando, na região dela. */
export async function trailLogging(clients: DiscoveryClients, trail: TrailFact): Promise<boolean> {
  const status = await clients
    .cloudtrail(trail.homeRegion)
    .send(new GetTrailStatusCommand({ Name: trail.arn }));
  return status.IsLogging === true;
}

/** Se a trilha grava os eventos de gerenciamento (pelos seletores clássicos ou pelos avançados). */
export async function trailManagementEvents(clients: DiscoveryClients, trail: TrailFact): Promise<boolean> {
  const found = await clients
    .cloudtrail(trail.homeRegion)
    .send(new GetEventSelectorsCommand({ TrailName: trail.arn }));
  const classic = found.EventSelectors ?? [];
  const advanced = found.AdvancedEventSelectors ?? [];
  if (classic.length === 0 && advanced.length === 0) return true;
  if (classic.some((selector) => selector.IncludeManagementEvents !== false)) return true;
  return advanced.some((selector) =>
    (selector.FieldSelectors ?? []).some(
      (field) => field.Field === 'eventCategory' && (field.Equals ?? []).includes('Management'),
    ),
  );
}

// --- VPC ---

export async function listFlowLogs(
  clients: DiscoveryClients,
  region: string,
): Promise<{ flowLogs: FlowLogFact[]; truncated: boolean }> {
  const ec2 = clients.ec2(region);
  const flowLogs: FlowLogFact[] = [];
  let token: string | undefined;
  do {
    const page = await ec2.send(new DescribeFlowLogsCommand({ NextToken: token, MaxResults: 1000 }));
    for (const flow of page.FlowLogs ?? []) {
      const id = text(flow.FlowLogId, 64);
      if (id === null) continue;
      flowLogs.push({
        id,
        attachedTo: text(flow.ResourceId, 64),
        trafficType: text(flow.TrafficType, 16),
        destinationType: text(flow.LogDestinationType, 32),
        destination: text(flow.LogDestination),
        logGroupName: text(flow.LogGroupName, 512),
        logFormat: text(flow.LogFormat, 4096),
        fileFormat: text(flow.DestinationOptions?.FileFormat, 16),
        hivePartitions: flow.DestinationOptions?.HiveCompatiblePartitions === true,
      });
    }
    token = page.NextToken;
  } while (token !== undefined && flowLogs.length < MAX_FLOW_LOGS);
  return {
    flowLogs: flowLogs.slice(0, MAX_FLOW_LOGS),
    truncated: token !== undefined || flowLogs.length > MAX_FLOW_LOGS,
  };
}

export async function countVpcs(clients: DiscoveryClients, region: string): Promise<number> {
  const ec2 = clients.ec2(region);
  let total = 0;
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await ec2.send(new DescribeVpcsCommand({ NextToken: token, MaxResults: 1000 }));
    total += (page.Vpcs ?? []).length;
    token = page.NextToken;
    pages += 1;
  } while (token !== undefined && pages < 5);
  return total;
}

// --- WAF ---

/** As Web ACLs de um escopo e o destino do log de cada uma (uma listagem de configurações de logging, não uma por ACL). */
export async function listWebAcls(
  clients: DiscoveryClients,
  region: string,
  scope: 'REGIONAL' | 'CLOUDFRONT',
): Promise<{ webAcls: WebAclFact[]; truncated: boolean }> {
  const waf = clients.wafv2(region);
  const acls: { id: string; name: string; arn: string }[] = [];
  let marker: string | undefined;
  do {
    const page = await waf.send(new ListWebACLsCommand({ Scope: scope, NextMarker: marker, Limit: 100 }));
    for (const acl of page.WebACLs ?? []) {
      const id = text(acl.Id, 64);
      const name = text(acl.Name, 128);
      const arn = text(acl.ARN);
      if (id !== null && name !== null && arn !== null) acls.push({ id, name, arn });
    }
    marker = (page.WebACLs ?? []).length === 0 ? undefined : page.NextMarker;
  } while (marker !== undefined && acls.length < MAX_WEB_ACLS);
  const truncated = marker !== undefined || acls.length > MAX_WEB_ACLS;
  if (acls.length === 0) return { webAcls: [], truncated };

  const destinations = new Map<string, string[]>();
  let next: string | undefined;
  let pages = 0;
  do {
    const page = await waf.send(
      new ListLoggingConfigurationsCommand({ Scope: scope, NextMarker: next, Limit: 100 }),
    );
    const configurations = page.LoggingConfigurations ?? [];
    for (const configuration of configurations) {
      const arn = text(configuration.ResourceArn);
      if (arn === null) continue;
      destinations.set(
        arn,
        (configuration.LogDestinationConfigs ?? []).flatMap((value) => {
          const destination = text(value);
          return destination === null ? [] : [destination];
        }),
      );
    }
    next = configurations.length === 0 ? undefined : page.NextMarker;
    pages += 1;
  } while (next !== undefined && pages < 5);
  return {
    webAcls: acls
      .slice(0, MAX_WEB_ACLS)
      .map((acl) => ({ ...acl, scope, destinations: destinations.get(acl.arn) ?? [] })),
    truncated,
  };
}

// --- GuardDuty ---

/**
 * Os detectores da região (um, na prática) com o estado e os destinos do export no S3. A leitura do detector ou dos
 * destinos recusada deixa o campo desconhecido, e o detector entra assim mesmo (`issues` leva o erro para o registro).
 */
export async function listDetectors(
  clients: DiscoveryClients,
  region: string,
): Promise<{ detectors: DetectorFact[]; issues: unknown[] }> {
  const guardduty = clients.guardduty(region);
  const listed = await guardduty.send(new ListDetectorsCommand({ MaxResults: 50 }));
  const ids = (listed.DetectorIds ?? [])
    .flatMap((id) => (text(id, 300) === null ? [] : [id]))
    .slice(0, MAX_DETECTORS);
  const detectors: DetectorFact[] = [];
  const issues: unknown[] = [];
  for (const id of ids) {
    const detector = await settle(() => guardduty.send(new GetDetectorCommand({ DetectorId: id })));
    if (!detector.ok) issues.push(detector.error);
    const destinations: DetectorFact['destinations'] = [];
    const published = await settle(() =>
      guardduty.send(new ListPublishingDestinationsCommand({ DetectorId: id, MaxResults: 50 })),
    );
    if (!published.ok) issues.push(published.error);
    else {
      for (const destination of published.value.Destinations ?? []) {
        const destinationId = text(destination.DestinationId, 300);
        if (destinationId === null || destination.DestinationType !== 'S3') continue;
        const described = await settle(() =>
          guardduty.send(
            new DescribePublishingDestinationCommand({ DetectorId: id, DestinationId: destinationId }),
          ),
        );
        if (!described.ok) {
          issues.push(described.error);
          continue;
        }
        destinations.push({
          id: destinationId,
          arn: text(described.value.DestinationProperties?.DestinationArn),
          kmsKeyArn: text(described.value.DestinationProperties?.KmsKeyArn),
          status: text(described.value.Status ?? destination.Status, 64),
        });
      }
    }
    detectors.push({
      id,
      enabled: detector.ok ? detector.value.Status === 'ENABLED' : null,
      destinations,
    });
  }
  return { detectors, issues };
}

// --- Security Hub, Inspector e Access Analyzer ---

/** O ARN do hub da região. A AWS responde com erro quando o Security Hub está desligado (quem chama decide). */
export async function describeHub(clients: DiscoveryClients, region: string): Promise<string | null> {
  const hub = await clients.securityhub(region).send(new DescribeHubCommand({}));
  return text(hub.HubArn);
}

/** Os erros com que a AWS diz que o Security Hub não está ligado na região. */
export const SECURITY_HUB_DISABLED_CODES: ReadonlySet<string> = new Set([
  'InvalidAccessException',
  'ResourceNotFoundException',
]);

/** O Inspector está ligado na conta, nesta região? */
export async function inspectorEnabled(clients: DiscoveryClients, region: string): Promise<boolean> {
  const status = await clients.inspector2(region).send(new BatchGetAccountStatusCommand({}));
  return (status.accounts ?? []).some((account) => account.state?.status === 'ENABLED');
}

export async function listAnalyzers(clients: DiscoveryClients, region: string): Promise<AnalyzerFact[]> {
  const found = await clients
    .accessanalyzer(region)
    .send(new ListAnalyzersCommand({ maxResults: MAX_ANALYZERS }));
  const analyzers: AnalyzerFact[] = [];
  for (const analyzer of found.analyzers ?? []) {
    const name = text(analyzer.name, 255);
    const arn = text(analyzer.arn);
    if (name === null || arn === null || analyzer.status !== 'ACTIVE') continue;
    analyzers.push({ name, arn, type: text(analyzer.type, 64) });
  }
  return analyzers;
}

// --- CloudWatch Logs ---

/** O ARN do grupo sem o `:*` do fim (o que o `ListTagsForResource` espera). */
function logGroupResourceArn(arn: string | null): string | null {
  if (arn === null) return null;
  return arn.endsWith(':*') ? arn.slice(0, -2) : arn;
}

export interface LogGroupsRead {
  groups: LogGroupFact[];
  truncated: boolean;
  /** A leitura das tags foi recusada (a partir daí, nenhum grupo é consultado): o erro, para o registro. */
  tagsDenied: unknown;
}

/**
 * Os grupos de logs da região (só os metadados: nome, tamanho guardado, retenção e chave) e, com `readTags`, a tag de
 * leitura de cada um. As tags custam uma chamada por grupo: na primeira recusa, a leitura das tags para (a permissão
 * falta para todos), e os grupos ficam com a tag desconhecida.
 */
export async function listLogGroups(
  clients: DiscoveryClients,
  region: string,
  readTags: boolean,
): Promise<LogGroupsRead> {
  const logs = clients.logs(region);
  const groups: LogGroupFact[] = [];
  let token: string | undefined;
  do {
    const page = await logs.send(new DescribeLogGroupsCommand({ nextToken: token, limit: 50 }));
    for (const group of page.logGroups ?? []) {
      const name = text(group.logGroupName, 512);
      if (name === null) continue;
      groups.push({
        name,
        arn: logGroupResourceArn(text(group.logGroupArn) ?? text(group.arn)),
        storedBytes: count(group.storedBytes),
        retentionDays: count(group.retentionInDays) || null,
        kmsKeyId: text(group.kmsKeyId),
        tagged: null,
      });
    }
    token = page.nextToken;
  } while (token !== undefined && groups.length < MAX_LOG_GROUPS);
  const read: LogGroupsRead = {
    groups: groups.slice(0, MAX_LOG_GROUPS),
    truncated: token !== undefined || groups.length > MAX_LOG_GROUPS,
    tagsDenied: undefined,
  };
  if (!readTags) return read;
  let denied = false;
  await mapLimited(read.groups, async (group) => {
    if (denied || group.arn === null) return;
    const tags = await settle(() =>
      logs.send(new ListTagsForResourceCommand({ resourceArn: group.arn as string })),
    );
    if (tags.ok) group.tagged = hasAwsLogGroupReadTag(tags.value.tags);
    else if (!denied) {
      denied = true;
      read.tagsDenied = tags.error;
    }
  });
  return read;
}

// --- Config ---

export async function listConfigRecorders(
  clients: DiscoveryClients,
  region: string,
): Promise<ConfigRecorderFact[]> {
  const config = clients.config(region);
  const recorders = await config.send(new DescribeConfigurationRecordersCommand({}));
  const names = (recorders.ConfigurationRecorders ?? []).flatMap((recorder) => {
    const name = text(recorder.name, 256);
    return name === null ? [] : [name];
  });
  if (names.length === 0) return [];
  const [status, channels] = await Promise.all([
    settle(() => config.send(new DescribeConfigurationRecorderStatusCommand({}))),
    settle(() => config.send(new DescribeDeliveryChannelsCommand({}))),
  ]);
  const recording = new Map<string, boolean>();
  if (status.ok) {
    for (const item of status.value.ConfigurationRecordersStatus ?? []) {
      if (item.name !== undefined) recording.set(item.name, item.recording === true);
    }
  }
  const channel = channels.ok ? (channels.value.DeliveryChannels ?? [])[0] : undefined;
  return names.map((name) => ({
    name,
    recording: recording.get(name) ?? null,
    bucket: text(channel?.s3BucketName, 63),
    keyPrefix: text(channel?.s3KeyPrefix, 512),
  }));
}

// --- Load balancers ---

const ACCESS_LOGS_ENABLED = 'access_logs.s3.enabled';
const ACCESS_LOGS_BUCKET = 'access_logs.s3.bucket';
const ACCESS_LOGS_PREFIX = 'access_logs.s3.prefix';

/** Os load balancers da região e, de cada um (até o teto), se o log de acesso no S3 está ligado e para onde vai. */
export async function listLoadBalancers(
  clients: DiscoveryClients,
  region: string,
): Promise<{ balancers: LoadBalancerFact[]; truncated: boolean; issues: unknown[] }> {
  const elb = clients.elbv2(region);
  const listed: Omit<LoadBalancerFact, 'accessLogs'>[] = [];
  let marker: string | undefined;
  do {
    const page = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker, PageSize: 400 }));
    for (const balancer of page.LoadBalancers ?? []) {
      const name = text(balancer.LoadBalancerName, 64);
      const arn = text(balancer.LoadBalancerArn);
      if (name === null || arn === null) continue;
      listed.push({ name, arn, internetFacing: balancer.Scheme === 'internet-facing' });
    }
    marker = page.NextMarker;
  } while (marker !== undefined && listed.length < MAX_LOAD_BALANCERS);
  const issues: unknown[] = [];
  const balancers = await mapLimited(listed.slice(0, MAX_LOAD_BALANCERS), async (balancer) => {
    const attributes = await settle(() =>
      elb.send(new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: balancer.arn })),
    );
    if (!attributes.ok) {
      issues.push(attributes.error);
      return { ...balancer, accessLogs: undefined };
    }
    const values = new Map<string, string>();
    for (const attribute of attributes.value.Attributes ?? []) {
      if (attribute.Key !== undefined && attribute.Value !== undefined)
        values.set(attribute.Key, attribute.Value);
    }
    const bucket = text(values.get(ACCESS_LOGS_BUCKET), 63);
    const enabled = values.get(ACCESS_LOGS_ENABLED) === 'true' && bucket !== null;
    return {
      ...balancer,
      accessLogs: enabled ? { bucket, prefix: text(values.get(ACCESS_LOGS_PREFIX), 512) } : null,
    };
  });
  return { balancers, truncated: marker !== undefined || listed.length > MAX_LOAD_BALANCERS, issues };
}

// --- RDS ---

export interface RdsCounts {
  instances: number;
  /** Com endereço público (`PubliclyAccessible`). */
  publicInstances: number;
  /** Sem cifragem do armazenamento. */
  unencrypted: number;
  truncated: boolean;
}

export async function countDbInstances(clients: DiscoveryClients, region: string): Promise<RdsCounts> {
  const rds = clients.rds(region);
  const counts: RdsCounts = { instances: 0, publicInstances: 0, unencrypted: 0, truncated: false };
  let marker: string | undefined;
  do {
    const page = await rds.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 }));
    for (const instance of page.DBInstances ?? []) {
      counts.instances += 1;
      if (instance.PubliclyAccessible === true) counts.publicInstances += 1;
      if (instance.StorageEncrypted !== true) counts.unencrypted += 1;
    }
    marker = page.Marker;
  } while (marker !== undefined && counts.instances < MAX_DB_INSTANCES);
  counts.truncated = marker !== undefined;
  return counts;
}

export async function countDbClusters(clients: DiscoveryClients, region: string): Promise<number> {
  const rds = clients.rds(region);
  let total = 0;
  let marker: string | undefined;
  let pages = 0;
  do {
    const page = await rds.send(new DescribeDBClustersCommand({ Marker: marker, MaxRecords: 100 }));
    total += (page.DBClusters ?? []).length;
    marker = page.Marker;
    pages += 1;
  } while (marker !== undefined && pages < 10);
  return total;
}

// --- IAM ---

/** O resumo da conta: quantos usuários IAM existem e se a root tem MFA. Uma chamada; os detalhes ficam no inventário. */
export async function iamSummary(
  clients: DiscoveryClients,
): Promise<{ users: number | null; rootMfaEnabled: boolean }> {
  const { SummaryMap: summary = {} } = await clients.iam().send(new GetAccountSummaryCommand({}));
  return { users: count(summary['Users']), rootMfaEnabled: summary['AccountMFAEnabled'] === 1 };
}

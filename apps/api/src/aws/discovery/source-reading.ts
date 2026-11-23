import {
  AWS_SOURCE_GLOBAL_REGION,
  AWS_SOURCE_NONE_RESOURCE,
  type AwsLogGroupCategory,
  type AwsSourceDetails,
  type AwsSourceKind,
  isAwsRegion,
} from '@verax/shared';
import { awsErrorName } from '../web-identity.js';
import {
  analyzerSource,
  type CatalogueContext,
  configSource,
  detectorSources,
  type DiscoveredSource,
  flowLogSource,
  inspectorSource,
  loadBalancerSource,
  logGroupSource,
  securityHubSource,
  trailSource,
  webAclSource,
} from './catalogue.js';
import type { DiscoveryClients } from './clients.js';
import {
  CLOUDFRONT_WAF_REGION,
  describeHub,
  inspectorEnabled,
  listAnalyzers,
  listConfigRecorders,
  listDetectors,
  listFlowLogs,
  listLoadBalancers,
  listTrails,
  listWebAcls,
  readLogGroup,
  SECURITY_HUB_DISABLED_CODES,
  trailLogging,
  trailManagementEvents,
} from './lookups.js';
import { rethrowFatal } from './probes.js';

/**
 * A releitura de uma fonte só (o "Tentar de novo" do painel; onboarding self-service): o que a AWS diz dela **agora**,
 * pelas mesmas leituras da descoberta (`lookups.ts`) e pela mesma classificação (`catalogue.ts`), só do tipo e da região
 * da fonte. O cliente pede a sondagem depois de mudar algo na conta dele (a tag no grupo, o destino do log da Web ACL
 * ou do flow log, a trilha); por isso nada do que está gravado na fonte decide: o destino, o prefixo, o formato, a tag e
 * o estado do serviço são lidos de novo, e a sondagem (`probes.ts`) roda sobre o que foi lido.
 *
 * O que a releitura usa do que está gravado é só a identidade da fonte (tipo, região e identificador) e, no grupo de
 * logs, quem a descoberta viu gravando nele (a trilha, o flow log ou a Web ACL), que só a descoberta inteira sabe.
 *
 * As chamadas, por tipo (as mesmas ações do IAM da descoberta):
 * - trilha: `DescribeTrails` na região dela, `GetTrailStatus` e `GetEventSelectors`;
 * - flow log: `DescribeFlowLogs` da região; Web ACL: `ListWebACLs` e `ListLoggingConfigurations` do escopo;
 * - GuardDuty (a API e o export): `ListDetectors`, `GetDetector`, `ListPublishingDestinations` e
 *   `DescribePublishingDestination`;
 * - Security Hub: `DescribeHub`; Inspector: `BatchGetAccountStatus`; Access Analyzer: `ListAnalyzers`;
 * - grupo de logs: `DescribeLogGroups` com o nome como prefixo e `ListTagsForResource` do grupo;
 * - Config e load balancer (ainda não coletados): as leituras deles na região.
 */

/** A identidade da fonte gravada e os detalhes dela (dos quais só a categoria do grupo de logs é aproveitada). */
export interface StoredSource {
  kind: AwsSourceKind;
  region: string;
  resourceId: string;
  details: AwsSourceDetails;
}

export type SourceReading =
  /** A fonte como está agora. */
  | { status: 'found'; source: DiscoveredSource }
  /**
   * A leitura terminou, e a fonte não está mais lá (apagada, desligada, ou o log foi para um destino que vira outro
   * tipo de fonte). Também a linha "desligado na conta", que é da conta inteira. Só a descoberta decide o que fazer.
   */
  | { status: 'absent' }
  /** A leitura não terminou (a listagem cortada, uma parte recusada): não dá para dizer. */
  | { status: 'unread' };

const ABSENT: SourceReading = { status: 'absent' };
const UNREAD: SourceReading = { status: 'unread' };
const found = (source: DiscoveredSource | null | undefined): SourceReading =>
  source == null ? ABSENT : { status: 'found', source };

type FedCategory = Extract<AwsLogGroupCategory, 'cloudtrail' | 'vpc_flow_logs' | 'waf'>;
const FED_CATEGORIES: readonly string[] = ['cloudtrail', 'vpc_flow_logs', 'waf'] satisfies FedCategory[];

/** Uma leitura que pode faltar (o status da trilha): o valor, ou null. O cancelamento e a sessão que caiu sobem. */
async function optional<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    rethrowFatal(error, signal);
    return null;
  }
}

/**
 * Lê a fonte de novo. Uma leitura recusada ou que falha sobe como erro (quem chama desfaz o pedido, sem mudar nada): a
 * releitura só responde `absent` quando a leitura que acharia a fonte terminou.
 */
export async function readSource(
  stored: StoredSource,
  context: CatalogueContext,
  clients: DiscoveryClients,
  signal: AbortSignal,
): Promise<SourceReading> {
  const { kind, region, resourceId } = stored;
  if (resourceId === AWS_SOURCE_NONE_RESOURCE && region === AWS_SOURCE_GLOBAL_REGION) return ABSENT;

  if (kind === 'waf') {
    // A Web ACL do CloudFront é global e fica em us-east-1.
    const cloudfront = region === AWS_SOURCE_GLOBAL_REGION;
    const home = cloudfront ? CLOUDFRONT_WAF_REGION : region;
    if (!isAwsRegion(home)) return UNREAD;
    const read = await listWebAcls(clients, home, cloudfront ? 'CLOUDFRONT' : 'REGIONAL');
    const acl = read.webAcls.find((candidate) => candidate.id === resourceId);
    if (acl === undefined) return read.truncated ? UNREAD : ABSENT;
    return found(webAclSource(acl, home, context));
  }
  if (!isAwsRegion(region)) return UNREAD;

  switch (kind) {
    case 'cloudtrail': {
      const trail = (await listTrails(clients, region)).find((candidate) => candidate.arn === resourceId);
      if (trail === undefined) return ABSENT;
      trail.logging = await optional(() => trailLogging(clients, trail), signal);
      trail.managementEvents = await optional(() => trailManagementEvents(clients, trail), signal);
      return found(trailSource(trail, context));
    }
    case 'vpc_flow_logs': {
      const read = await listFlowLogs(clients, region);
      const flow = read.flowLogs.find((candidate) => candidate.id === resourceId);
      if (flow === undefined) return read.truncated ? UNREAD : ABSENT;
      return found(flowLogSource(flow, region, context));
    }
    case 'guardduty':
    case 'guardduty_export': {
      const read = await listDetectors(clients, region);
      for (const issue of read.issues) rethrowFatal(issue, signal);
      const source = read.detectors
        .flatMap((detector) => detectorSources(detector, region, context))
        .find((candidate) => candidate.kind === kind && candidate.resourceId === resourceId);
      // Com uma leitura do detector recusada, o que ele exporta fica desconhecido.
      if (source === undefined) return read.issues.length > 0 ? UNREAD : ABSENT;
      return found(source);
    }
    case 'security_hub':
      try {
        return found(securityHubSource(region, await describeHub(clients, region)));
      } catch (error) {
        if (SECURITY_HUB_DISABLED_CODES.has(awsErrorName(error))) return ABSENT;
        throw error;
      }
    case 'inspector':
      return (await inspectorEnabled(clients, region)) ? found(inspectorSource(region)) : ABSENT;
    case 'access_analyzer': {
      const analyzer = (await listAnalyzers(clients, region)).find(
        (candidate) => candidate.name === resourceId,
      );
      return analyzer === undefined ? ABSENT : found(analyzerSource(analyzer, region));
    }
    case 'cloudwatch_log_group': {
      // Como na descoberta: com a capacidade dos grupos desligada, a tag não muda a resposta e não é lida.
      const readTags = context.capabilities === null || context.capabilities.includes('log-groups');
      const read = await readLogGroup(clients, region, resourceId, readTags);
      if (read === 'absent') return ABSENT;
      if (read === 'truncated') return UNREAD;
      const category = stored.details.category;
      const feeds =
        category !== undefined && FED_CATEGORIES.includes(category) ? (category as FedCategory) : undefined;
      const source = logGroupSource(read.group, region, feeds);
      if (read.tagsRefused) source.tagsRefused = true;
      return found(source);
    }
    case 'config': {
      const recorder = (await listConfigRecorders(clients, region)).find(
        (candidate) => candidate.name === resourceId,
      );
      return recorder === undefined ? ABSENT : found(configSource(recorder, region, context));
    }
    case 'elb_logs': {
      const read = await listLoadBalancers(clients, region);
      for (const issue of read.issues) rethrowFatal(issue, signal);
      const balancer = read.balancers.find((candidate) => candidate.name === resourceId);
      if (balancer === undefined) return read.truncated ? UNREAD : ABSENT;
      // Os atributos não lidos: não dá para dizer se o log de acesso continua ligado.
      if (balancer.accessLogs === undefined) return UNREAD;
      return found(loadBalancerSource(balancer, region, context));
    }
  }
}

import {
  AWS_DISCOVERY_MAX_ERRORS,
  AWS_SOURCE_GLOBAL_REGION,
  type AwsDiscoveryError,
  type AwsDiscoveryService,
  type AwsInfrastructureSummary,
  type AwsLogGroupCategory,
  type AwsReaderCapability,
  type AwsSourceKind,
  isAwsRegion,
  type LogBuckets,
} from '@verax/shared';
import {
  collectBuckets,
  collectInstances,
  collectSecurityGroups,
  enabledRegions,
} from '../../inventory/collectors.js';
import { bucketRisk } from '../../inventory/risk-rules.js';
import { AwsConnectionError, awsErrorName, STS_FALLBACK_REGION } from '../web-identity.js';
import {
  analyzerSource,
  type CatalogueContext,
  configSource,
  detectorSources,
  type DiscoveredSource,
  flowLogGroup,
  flowLogSource,
  inspectorSource,
  loadBalancerSource,
  type LogGroupFact,
  logGroupSource,
  NOT_ENABLED_KINDS,
  notEnabledSource,
  parseLogGroupArn,
  securityHubSource,
  type TrailFact,
  trailSource,
  webAclLogGroup,
  webAclSource,
} from './catalogue.js';
import type { DiscoveryClients } from './clients.js';
import {
  CLOUDFRONT_WAF_REGION,
  countDbClusters,
  countDbInstances,
  countVpcs,
  describeHub,
  iamSummary,
  inspectorEnabled,
  listAnalyzers,
  listConfigRecorders,
  listDetectors,
  listFlowLogs,
  listLoadBalancers,
  listLogGroups,
  listTrails,
  listWebAcls,
  SECURITY_HUB_DISABLED_CODES,
  trailLogging,
  trailManagementEvents,
} from './lookups.js';
import { probeInto, type ProbeResult } from './probes.js';
import { ReadOnlyViolation } from './read-only.js';

/**
 * A descoberta de uma conta AWS (onboarding self-service; `docs/ARQUITETURA.md`, "Onboarding AWS self-service"): as
 * regiões habilitadas, as fontes de log de cada uma, a permissão do papel para cada fonte e o retrato da infraestrutura.
 * Só leitura, pela sessão de leitura da conta, com a trava de `read-only.ts` em todo cliente. Sem banco: quem grava o
 * resultado é a tarefa (`discovery-job.ts` e `discovery-store.ts`).
 *
 * - **Regiões:** `DescribeRegions` (só as habilitadas). Recusado, valem as regiões monitoradas do cadastro. No máximo
 *   `REGION_CONCURRENCY` regiões ao mesmo tempo; as chamadas, somadas, passam pela fila dos clientes.
 * - **Cada leitura é isolada** por serviço e região: a permissão negada, a região opt-in que recusa a sessão, o limite
 *   de requisições e o tempo esgotado viram um registro em `errors` (`serviço × região × código`, só o nome do erro), e
 *   o resto segue. A execução com algum registro termina `partial`, que é um resultado válido. Só três coisas param
 *   tudo: o cancelamento, a sessão que caiu (`AwsConnectionError`) e a trava de só leitura.
 * - **Nada lido** (toda leitura recusada): `DiscoveryUnavailable`, e nada é gravado.
 * - **O que some:** uma fonte só é dada como sumida quando a leitura que a acharia terminou (`covered`); a região que
 *   falhou não apaga nem muda o que a descoberta anterior viu nela.
 * - **Sondagens:** depois do catálogo, a permissão de cada fonte (`probes.ts`).
 */

/** Regiões lidas ao mesmo tempo. */
export const REGION_CONCURRENCY = 4;
/** Regiões por execução (a AWS tem menos de 40). */
export const MAX_REGIONS = 64;

export interface DiscoveryTarget {
  /** O ID da conta AWS (12 dígitos). */
  accountId: string;
  /** As regiões monitoradas do cadastro: a primeira é a de partida, e todas valem se `DescribeRegions` for recusado. */
  regions: readonly string[];
  /** As capacidades do papel pelas tags; null quando não se sabe (template v1, ou a chave da VM própria). */
  capabilities: readonly AwsReaderCapability[] | null;
  /** O papel é de um template anterior: a fonte sem permissão ganha a nota de atualizar a pilha. */
  templateOutdated: boolean;
  /** Os buckets do cadastro anterior da conta. */
  legacyBuckets: LogBuckets;
}

export interface DiscoveryResult {
  /** As regiões lidas. */
  regions: string[];
  sources: DiscoveredSource[];
  /** Os escopos (`tipo:região`) cuja leitura terminou: só neles uma fonte que não apareceu é dada como sumida. */
  covered: string[];
  errors: AwsDiscoveryError[];
  summary: AwsInfrastructureSummary;
  /** As regiões com recurso ou fonte. */
  discoveredRegions: string[];
}

/** A descoberta não leu nada: nada é gravado, e a execução termina `failed` com o código. */
export class DiscoveryUnavailable extends Error {
  constructor(readonly code: string) {
    super(`descoberta da AWS: ${code}`);
    this.name = code;
  }
}

/** A chave de um escopo de leitura. */
export function scopeKey(kind: AwsSourceKind, region: string): string {
  return `${kind}:${region}`;
}

/** O nome do erro como vai para o registro: só letras, números e `_.:-`; o tempo esgotado tem um nome só. */
export function discoveryErrorCode(error: unknown): string {
  const name = awsErrorName(error);
  if (name === 'AbortError' || name === 'TimeoutError') return 'TimeoutError';
  return name.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 64) || 'Unknown';
}

/** As leituras de uma execução: o que deu certo, e o registro do que ficou de fora. */
class Reads {
  readonly errors: AwsDiscoveryError[] = [];
  readonly #seen = new Set<string>();
  succeeded = 0;

  constructor(private readonly signal: AbortSignal) {}

  /** O que nunca vira registro: o cancelamento, a sessão que caiu e a trava de só leitura. */
  fatal(error: unknown): void {
    if (this.signal.aborted) throw error;
    if (error instanceof ReadOnlyViolation || error instanceof AwsConnectionError) throw error;
  }

  note(service: AwsDiscoveryService, region: string, code: string): void {
    const key = `${service}|${region}|${code}`;
    if (this.#seen.has(key) || this.errors.length >= AWS_DISCOVERY_MAX_ERRORS) return;
    this.#seen.add(key);
    this.errors.push({ service, region, code });
  }

  /** Uma falha dentro de uma leitura que seguiu (a leitura de um item recusada). */
  issue(service: AwsDiscoveryService, region: string, error: unknown): void {
    this.fatal(error);
    this.note(service, region, discoveryErrorCode(error));
  }

  /**
   * Uma leitura isolada: o valor, ou null com o erro registrado. `expected` traduz o erro com que a AWS responde um
   * estado normal (o serviço desligado), que não é falha.
   */
  async read<T>(
    service: AwsDiscoveryService,
    region: string,
    call: () => Promise<T>,
    expected?: (name: string) => T | undefined,
  ): Promise<T | null> {
    try {
      const value = await call();
      this.succeeded += 1;
      return value;
    } catch (error) {
      this.fatal(error);
      const known = expected?.(awsErrorName(error));
      if (known !== undefined) {
        this.succeeded += 1;
        return known;
      }
      this.note(service, region, discoveryErrorCode(error));
      return null;
    }
  }
}

/** O que foi lido de uma região. Null em cada campo: a leitura dele falhou (e está no registro). */
interface RegionFacts {
  region: string;
  trails: TrailFact[] | null;
  flowLogs: Awaited<ReturnType<typeof listFlowLogs>> | null;
  vpcs: number | null;
  webAcls: Awaited<ReturnType<typeof listWebAcls>> | null;
  detectors: Awaited<ReturnType<typeof listDetectors>> | null;
  /** O ARN do hub; `disabled` com o Security Hub desligado. */
  hub: { arn: string | null } | 'disabled' | null;
  inspector: boolean | null;
  analyzers: Awaited<ReturnType<typeof listAnalyzers>> | null;
  logGroups: Awaited<ReturnType<typeof listLogGroups>> | null;
  recorders: Awaited<ReturnType<typeof listConfigRecorders>> | null;
  balancers: Awaited<ReturnType<typeof listLoadBalancers>> | null;
  dbInstances: Awaited<ReturnType<typeof countDbInstances>> | null;
  dbClusters: number | null;
  instances: Awaited<ReturnType<typeof collectInstances>> | null;
  securityGroups: Awaited<ReturnType<typeof collectSecurityGroups>> | null;
}

/** Executa `task` para cada item, no máximo `limit` de cada vez, mantendo a ordem. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** A soma do que foi lido; null se nenhuma região respondeu. */
function total<T>(items: readonly (T | null)[], value: (item: T) => number): number | null {
  const read = items.filter((item) => item !== null);
  return read.length === 0 ? null : read.reduce((sum, item) => sum + value(item), 0);
}

export interface DiscoverOptions {
  signal: AbortSignal;
  now: Date;
  regionConcurrency?: number;
}

export async function discoverAccount(
  target: DiscoveryTarget,
  clients: DiscoveryClients,
  { signal, now, regionConcurrency = REGION_CONCURRENCY }: DiscoverOptions,
): Promise<DiscoveryResult> {
  const reads = new Reads(signal);
  const context: CatalogueContext = {
    accountId: target.accountId,
    legacyBuckets: target.legacyBuckets,
    capabilities: target.capabilities,
  };
  const monitored = [...new Set(target.regions.filter(isAwsRegion))];
  const home = monitored[0] ?? STS_FALLBACK_REGION;

  // 1. As regiões habilitadas. Recusado, as monitoradas do cadastro.
  const enabled = await reads.read('regions', AWS_SOURCE_GLOBAL_REGION, () =>
    enabledRegions(clients.ec2(home)),
  );
  const listed = [...new Set((enabled ?? monitored).filter(isAwsRegion))].slice(0, MAX_REGIONS);
  const regions = listed.length > 0 ? listed : [home];

  // 2. Cada região, com as leituras dela isoladas uma da outra.
  const readTags = target.capabilities === null || target.capabilities.includes('log-groups');
  const facts = await mapLimited(regions, regionConcurrency, async (region): Promise<RegionFacts> => {
    signal.throwIfAborted();
    const [
      trails,
      flowLogs,
      vpcs,
      webAcls,
      detectors,
      hub,
      inspector,
      analyzers,
      logGroups,
      recorders,
      balancers,
      dbInstances,
      dbClusters,
      instances,
      securityGroups,
    ] = await Promise.all([
      reads.read('cloudtrail', region, () => listTrails(clients, region)),
      reads.read('flow_logs', region, () => listFlowLogs(clients, region)),
      reads.read('ec2', region, () => countVpcs(clients, region)),
      reads.read('waf', region, () => listWebAcls(clients, region, 'REGIONAL')),
      reads.read('guardduty', region, () => listDetectors(clients, region)),
      reads.read<RegionFacts['hub']>(
        'security_hub',
        region,
        async () => ({ arn: await describeHub(clients, region) }),
        (name) => (SECURITY_HUB_DISABLED_CODES.has(name) ? 'disabled' : undefined),
      ),
      reads.read('inspector', region, () => inspectorEnabled(clients, region)),
      reads.read('access_analyzer', region, () => listAnalyzers(clients, region)),
      reads.read('cloudwatch_logs', region, () => listLogGroups(clients, region, readTags)),
      reads.read('config', region, () => listConfigRecorders(clients, region)),
      reads.read('elb', region, () => listLoadBalancers(clients, region)),
      reads.read('rds', region, () => countDbInstances(clients, region)),
      reads.read('rds', region, () => countDbClusters(clients, region)),
      reads.read('ec2', region, () => collectInstances(clients.ec2(region), region)),
      reads.read('ec2', region, () => collectSecurityGroups(clients.ec2(region), region)),
    ]);
    for (const issue of detectors?.issues ?? []) reads.issue('guardduty', region, issue);
    for (const issue of balancers?.issues ?? []) reads.issue('elb', region, issue);
    if (logGroups?.tagsDenied !== undefined) reads.issue('cloudwatch_logs', region, logGroups.tagsDenied);
    if (flowLogs?.truncated === true) reads.note('flow_logs', region, 'Truncated');
    if (webAcls?.truncated === true) reads.note('waf', region, 'Truncated');
    if (logGroups?.truncated === true) reads.note('cloudwatch_logs', region, 'Truncated');
    if (balancers?.truncated === true) reads.note('elb', region, 'Truncated');
    if (dbInstances?.truncated === true) reads.note('rds', region, 'Truncated');
    if (instances?.truncated === true || securityGroups?.truncated === true)
      reads.note('ec2', region, 'Truncated');
    return {
      region,
      trails,
      flowLogs,
      vpcs,
      webAcls,
      detectors,
      hub,
      inspector,
      analyzers,
      logGroups,
      recorders,
      balancers,
      dbInstances,
      dbClusters,
      instances,
      securityGroups,
    };
  });

  // 3. O que é da conta inteira: as Web ACLs do CloudFront, o resumo do IAM e os buckets.
  const [cloudfront, iam, buckets] = await Promise.all([
    reads.read('waf', AWS_SOURCE_GLOBAL_REGION, () =>
      listWebAcls(clients, CLOUDFRONT_WAF_REGION, 'CLOUDFRONT'),
    ),
    reads.read('iam', AWS_SOURCE_GLOBAL_REGION, () => iamSummary(clients)),
    reads.read('s3', AWS_SOURCE_GLOBAL_REGION, () => collectBuckets((region) => clients.s3(region))),
  ]);
  if (cloudfront?.truncated === true) reads.note('waf', AWS_SOURCE_GLOBAL_REGION, 'Truncated');
  if (buckets?.truncated === true) reads.note('s3', AWS_SOURCE_GLOBAL_REGION, 'Truncated');

  // 4. As trilhas, cada uma uma vez (a multirregional aparece em toda região), com o status lido na região dela.
  const trails = new Map<string, TrailFact>();
  for (const region of facts) {
    for (const trail of region.trails ?? []) if (!trails.has(trail.arn)) trails.set(trail.arn, trail);
  }
  await mapLimited([...trails.values()], regionConcurrency, async (trail) => {
    trail.logging = await reads.read('cloudtrail', trail.homeRegion, () => trailLogging(clients, trail));
    trail.managementEvents = await reads.read('cloudtrail', trail.homeRegion, () =>
      trailManagementEvents(clients, trail),
    );
  });

  if (reads.succeeded === 0) throw new DiscoveryUnavailable('discovery_refused');

  // 5. O catálogo.
  const sources: DiscoveredSource[] = [];
  const covered = new Set<string>();
  /** Os grupos que alguém alimenta (a trilha, o flow log, a Web ACL), por região e nome. */
  const feeds = new Map<string, Extract<AwsLogGroupCategory, 'cloudtrail' | 'vpc_flow_logs' | 'waf'>>();
  const feed = (
    region: string,
    name: string,
    category: Extract<AwsLogGroupCategory, 'cloudtrail' | 'vpc_flow_logs' | 'waf'>,
  ): void => {
    if (isAwsRegion(region)) feeds.set(`${region}|${name}`, category);
  };

  for (const trail of trails.values()) {
    const source = trailSource(trail, context);
    if (source !== null) sources.push(source);
    const group = parseLogGroupArn(trail.logGroupArn);
    if (group !== null) feed(group.region, group.name, 'cloudtrail');
  }
  for (const region of facts) {
    const name = region.region;
    if (region.trails !== null) covered.add(scopeKey('cloudtrail', name));
    if (region.flowLogs !== null) {
      if (!region.flowLogs.truncated) covered.add(scopeKey('vpc_flow_logs', name));
      for (const flow of region.flowLogs.flowLogs) {
        const source = flowLogSource(flow, name, context);
        if (source !== null) sources.push(source);
        const group = flowLogGroup(flow);
        if (group !== null) feed(name, group, 'vpc_flow_logs');
      }
    }
    if (region.webAcls !== null) {
      if (!region.webAcls.truncated) covered.add(scopeKey('waf', name));
      for (const acl of region.webAcls.webAcls) {
        const source = webAclSource(acl, name, context);
        if (source !== null) sources.push(source);
        const group = webAclLogGroup(acl);
        if (group !== null) feed(group.region, group.name, 'waf');
      }
    }
    if (region.detectors !== null) {
      // Com uma leitura do detector recusada, o que ele exporta fica desconhecido: nada some por isso.
      if (region.detectors.issues.length === 0) {
        covered.add(scopeKey('guardduty', name));
        covered.add(scopeKey('guardduty_export', name));
      }
      for (const detector of region.detectors.detectors) {
        sources.push(...detectorSources(detector, name, context));
      }
    }
    if (region.hub !== null) {
      covered.add(scopeKey('security_hub', name));
      if (region.hub !== 'disabled') sources.push(securityHubSource(name, region.hub.arn));
    }
    if (region.inspector !== null) {
      covered.add(scopeKey('inspector', name));
      if (region.inspector) sources.push(inspectorSource(name));
    }
    if (region.analyzers !== null) {
      covered.add(scopeKey('access_analyzer', name));
      for (const analyzer of region.analyzers) sources.push(analyzerSource(analyzer, name));
    }
    if (region.recorders !== null) {
      covered.add(scopeKey('config', name));
      for (const recorder of region.recorders) sources.push(configSource(recorder, name, context));
    }
    if (region.balancers !== null) {
      if (!region.balancers.truncated && region.balancers.issues.length === 0) {
        covered.add(scopeKey('elb_logs', name));
      }
      for (const balancer of region.balancers.balancers) {
        const source = loadBalancerSource(balancer, name, context);
        if (source !== null) sources.push(source);
      }
    }
  }
  if (cloudfront !== null) {
    if (!cloudfront.truncated) covered.add(scopeKey('waf', AWS_SOURCE_GLOBAL_REGION));
    for (const acl of cloudfront.webAcls) {
      const source = webAclSource(acl, CLOUDFRONT_WAF_REGION, context);
      if (source !== null) sources.push(source);
      const group = webAclLogGroup(acl);
      if (group !== null) feed(group.region, group.name, 'waf');
    }
  }

  // Os grupos de logs: os listados e os que um serviço alimenta (mesmo com a listagem da região recusada).
  const groups = new Map<string, { region: string; group: LogGroupFact }>();
  for (const region of facts) {
    if (region.logGroups === null) continue;
    if (!region.logGroups.truncated) covered.add(scopeKey('cloudwatch_log_group', region.region));
    for (const group of region.logGroups.groups)
      groups.set(`${region.region}|${group.name}`, { region: region.region, group });
  }
  for (const key of feeds.keys()) {
    if (groups.has(key)) continue;
    const separator = key.indexOf('|');
    const region = key.slice(0, separator);
    const name = key.slice(separator + 1);
    groups.set(key, {
      region,
      group: { name, arn: null, storedBytes: null, retentionDays: null, kmsKeyId: null, tagged: null },
    });
  }
  for (const [key, { region, group }] of groups) sources.push(logGroupSource(group, region, feeds.get(key)));

  // O serviço desligado na conta inteira: uma linha por tipo, só quando toda região respondeu e nenhuma tem o serviço.
  const readOf: Record<(typeof NOT_ENABLED_KINDS)[number], (region: RegionFacts) => unknown> = {
    cloudtrail: (region) => region.trails,
    vpc_flow_logs: (region) => region.flowLogs,
    guardduty: (region) => region.detectors,
    security_hub: (region) => region.hub,
    inspector: (region) => region.inspector,
    access_analyzer: (region) => region.analyzers,
  };
  for (const kind of NOT_ENABLED_KINDS) {
    // Os flow logs que gravam no CloudWatch Logs não viram fonte deste tipo, mas existem.
    const exists =
      sources.some((source) => source.kind === kind) ||
      (kind === 'vpc_flow_logs' && facts.some((region) => (region.flowLogs?.flowLogs.length ?? 0) > 0));
    const allRead = facts.every((region) => readOf[kind](region) !== null);
    if (exists) covered.add(scopeKey(kind, AWS_SOURCE_GLOBAL_REGION));
    else if (allRead) {
      covered.add(scopeKey(kind, AWS_SOURCE_GLOBAL_REGION));
      sources.push(notEnabledSource(kind, regions));
    }
  }

  // 6. A permissão de cada fonte.
  const cache = new Map<string, ProbeResult>();
  await mapLimited(sources, regionConcurrency, async (source) => {
    signal.throwIfAborted();
    await probeInto(source, context, clients, {
      signal,
      now,
      cache,
      templateOutdated: target.templateOutdated,
    });
  });

  // 7. O retrato e as regiões com recurso ou fonte.
  const publicBuckets =
    buckets === null
      ? null
      : buckets.buckets.filter((bucket) => bucketRisk(bucket).reasons.includes('bucket_public')).length;
  const acls = [...facts.map((region) => region.webAcls), cloudfront];
  const summary: AwsInfrastructureSummary = {
    instances: total(
      facts.map((region) => region.instances),
      (read) => read.instances.length,
    ),
    publicInstances: total(
      facts.map((region) => region.instances),
      (read) =>
        read.instances.filter((instance) => instance.publicIp !== null && instance.state !== 'terminated')
          .length,
    ),
    securityGroups: total(
      facts.map((region) => region.securityGroups),
      (read) => read.groups.length,
    ),
    openSecurityGroups: total(
      facts.map((region) => region.securityGroups),
      (read) => read.groups.filter((group) => group.openToWorld.length > 0).length,
    ),
    buckets: buckets === null ? null : buckets.buckets.length,
    publicBuckets,
    iamUsers: iam === null ? null : iam.users,
    rootMfaEnabled: iam === null ? null : iam.rootMfaEnabled,
    rdsInstances: total(
      facts.map((region) => region.dbInstances),
      (read) => read.instances,
    ),
    rdsPublic: total(
      facts.map((region) => region.dbInstances),
      (read) => read.publicInstances,
    ),
    rdsUnencrypted: total(
      facts.map((region) => region.dbInstances),
      (read) => read.unencrypted,
    ),
    rdsClusters: total(
      facts.map((region) => region.dbClusters),
      (read) => read,
    ),
    loadBalancers: total(
      facts.map((region) => region.balancers),
      (read) => read.balancers.length,
    ),
    internetFacingLoadBalancers: total(
      facts.map((region) => region.balancers),
      (read) => read.balancers.filter((balancer) => balancer.internetFacing).length,
    ),
    vpcs: total(
      facts.map((region) => region.vpcs),
      (read) => read,
    ),
    webAcls: total(acls, (read) => read.webAcls.length),
    logGroups: total(
      facts.map((region) => region.logGroups),
      (read) => read.groups.length,
    ),
    trails: facts.some((region) => region.trails !== null) ? trails.size : null,
  };

  const withSources = new Set(
    sources
      .filter((source) => source.availability !== 'not_enabled' && source.region !== AWS_SOURCE_GLOBAL_REGION)
      .map((source) => source.region),
  );
  const discoveredRegions = facts
    .filter(
      (region) =>
        withSources.has(region.region) ||
        (region.instances?.instances.length ?? 0) > 0 ||
        (region.dbInstances?.instances ?? 0) > 0 ||
        (region.dbClusters ?? 0) > 0 ||
        (region.balancers?.balancers.length ?? 0) > 0,
    )
    .map((region) => region.region)
    .sort();

  return { regions, sources, covered: [...covered].sort(), errors: reads.errors, summary, discoveredRegions };
}

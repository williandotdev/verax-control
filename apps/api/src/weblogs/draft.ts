import { createHash } from 'node:crypto';
import { type FindingDraft, severityOfLevel } from '../alerts/finding-draft.js';
import {
  EVIDENCE_VERSION,
  MAX_EVIDENCE_CLIENTS,
  MAX_EVIDENCE_POINTERS,
  MAX_EVIDENCE_ROUTES,
  MAX_EVIDENCE_SAMPLES,
  sealEvidence,
  type WebEvidence,
} from './evidence.js';
import { MINUTE_MS } from './limits.js';
import { familiesOf } from './probes.js';
import { type EntryAt, loadHit, WEB_RULES, type WebHit, type WebRuleId } from './rules.js';
import { UA_FAMILIES, type UaFamily } from './user-agent.js';

/**
 * De detecção a achado. O formato é o do `FindingDraft`, com a fonte `alb` (`FINDING_SOURCES`), a
 * evidência (que o `FindingStore` grava com o achado) e a correlação (aceita, gravada só com os casos). Nada liga isto ao
 * `FindingStore` ainda.
 *
 * **Chave:** `aws/<conta>/alb:<sha40(regra|balanceador|cliente|host|rota|nível)>`; a versão é a hora cheia (UTC) da última
 * atividade, como nas correlações dos flow logs da VPC: um achado em aberto por atacante, e no máximo uma reincidência por
 * hora depois da triagem.
 *
 * **O nível entra na chave** (o desenho não o punha): no achado ainda não triado, o `FindingStore.recur` só avança o
 * `lastSeenAt` e não mexe na severidade. Com a mesma chave, quem começasse devagar (nível 7, sem e-mail) e passasse a 10 ou
 * 12 ficaria enterrado no achado médio. Assim, a escalada é um achado novo, com o aviso dela. A volta a um nível menor não
 * faz outro: por 24 h a atividade segue no achado mais alto (`WebLogEngine.peak`).
 */
export interface WebCorrelation {
  firstSeenAt: string;
  lastSeenAt: string;
  /**
   * `web:actor:<ip ou /64>` (só de cliente direto), `web:host:<host>:<classe>` (só com SNI casado com certificado) e
   * `web:alb:<id>` (contexto: sozinho não junta nada).
   */
  keys: string[];
}

export interface WebFindingDraft extends FindingDraft {
  logSource: 'alb';
  evidence: WebEvidence;
  correlation: WebCorrelation;
}

export interface WebSource {
  tenantId: string;
  accountId: string;
  region: string;
  /** `app/<nome>/<id>`. */
  loadBalancer: string;
}

export type WebClass = 'recon' | 'credential' | 'exploit';

const CLASS_OF: Readonly<Record<WebRuleId, WebClass>> = {
  '990400': 'recon',
  '990401': 'recon',
  '990402': 'recon',
  '990403': 'exploit',
  '990404': 'recon',
  '990405': 'credential',
  '990406': 'credential',
  '990407': 'credential',
};

const iso = (ms: number): string => new Date(ms).toISOString();
const hourOf = (ms: number): string => iso(Math.floor(ms / (60 * MINUTE_MS)) * 60 * MINUTE_MS);

/** A identidade do achado dentro da conta. */
export function webFindingKey(
  source: WebSource,
  parts: {
    rule: WebRuleId;
    client: string | null;
    host: string | null;
    route: string | null;
    /** O nível ou, no resumo, o dia. */
    extra: string;
  },
): string {
  const identity = [
    parts.rule,
    source.loadBalancer,
    parts.client ?? '',
    parts.host ?? '',
    parts.route ?? '',
    parts.extra,
  ].join('|');
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 40);
  return `aws/${source.accountId}/alb:${digest}`;
}

/** O que separa um achado do outro: o host só na 990403 e na 990407 (nas outras, trocar de host não faz outro achado). */
export function hitIdentity(hit: WebHit, level: number): Parameters<typeof webFindingKey>[1] {
  const byHost = hit.rule === '990403' || hit.rule === '990407';
  return {
    rule: hit.rule,
    client: hit.client?.key ?? (hit.clientClass === null ? null : `!${hit.clientClass}`),
    host: byHost ? hit.host : null,
    route: hit.route?.id ?? null,
    extra: String(level),
  };
}

function statusesOf(entries: readonly EntryAt[]): WebEvidence['statuses'] {
  const sums = new Map<string, number>();
  const add = (status: string, count: number): void => {
    if (count > 0) sums.set(status, (sums.get(status) ?? 0) + count);
  };
  for (const { entry } of entries) {
    add('2xx', entry.ok);
    add('3xx', entry.redirect);
    add('400', entry.s400);
    add('401', entry.s401);
    add('403', entry.s403);
    add('404', entry.s404);
    add('405', entry.s405);
    add('422', entry.s422);
    add('429', entry.s429);
    add('4xx', entry.s4xx);
    add('5xx', entry.s5xx);
    const known =
      entry.ok +
      entry.redirect +
      entry.errors +
      entry.s401 +
      entry.s422 +
      entry.s429 +
      entry.s4xx +
      entry.s5xx;
    add('-', entry.total - known);
  }
  return [...sums].map(([status, count]) => ({ status, count }));
}

function agentsOf(entries: readonly EntryAt[]): WebEvidence['userAgents'] {
  let low = 0;
  let high = 0;
  let sample: string | null = null;
  for (const { entry } of entries) {
    low |= entry.uaLow;
    high |= entry.uaHigh;
    sample ??= entry.detail?.userAgent ?? null;
  }
  const families = UA_FAMILIES.filter((_: UaFamily, i) =>
    i < 31 ? (low & (1 << i)) !== 0 : (high & (1 << (i - 31))) !== 0,
  );
  return { families, sample };
}

/** Evidência de uma detecção. */
export function evidenceOf(hit: WebHit): WebEvidence {
  loadHit(hit);
  if (hit.truncated) hit.notes.add('counts_are_floor');
  const routes = new Map<string, number>();
  const raw = [...hit.samples];
  for (const { entry } of hit.entries) {
    for (const [path, count] of entry.detail?.routes ?? []) routes.set(path, (routes.get(path) ?? 0) + count);
    raw.push(...(entry.detail?.samples ?? []));
  }
  raw.sort((a, b) => a.atMs - b.atMs || (a.path < b.path ? -1 : 1));
  // As da 990403 são a resposta que vazou: entram antes das outras.
  const own = new Set(hit.samples);
  const chosen = [...raw.filter((sample) => own.has(sample)), ...raw.filter((sample) => !own.has(sample))];
  const pointers = new Map<string, { objectKey: string; minute: string }>();
  for (const sample of chosen) {
    const minute = iso(Math.floor(sample.atMs / MINUTE_MS) * MINUTE_MS);
    pointers.set(`${sample.objectKey}|${minute}`, { objectKey: sample.objectKey, minute });
    if (pointers.size >= MAX_EVIDENCE_POINTERS) break;
  }
  const { requests, blocked } = hit.counters;
  return sealEvidence({
    version: EVIDENCE_VERSION,
    ruleId: hit.rule,
    windowFrom: iso(hit.fromMs),
    windowTo: iso(hit.toMs),
    firstSeenAt: iso(hit.firstMs),
    lastSeenAt: iso(hit.lastMs),
    client: hit.client?.key ?? null,
    clientClass: hit.clientClass,
    host: hit.host,
    route: hit.route?.label ?? null,
    routeKind: hit.route?.kind ?? null,
    routeSemantics: hit.route?.semantics ?? null,
    counters: hit.counters,
    blockedPercent: requests === 0 ? 0 : Math.min(100, Math.floor((100 * blocked) / requests)),
    statuses: statusesOf(hit.entries),
    probeFamilies: familiesOf(hit.families),
    routes: [...routes]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : 1))
      .slice(0, MAX_EVIDENCE_ROUTES),
    clients: hit.participants
      // Só cliente direto: a borda de uma CDN na lista viraria bloqueio de todo mundo que passa por ela.
      .filter(({ client }) => client.cls === 'direct')
      .slice(0, MAX_EVIDENCE_CLIENTS)
      .map(({ client, requests: total, count }) => ({ client: client.key, requests: total, count })),
    userAgents: agentsOf(hit.entries),
    samples: chosen.slice(0, MAX_EVIDENCE_SAMPLES).map((sample) => ({
      at: iso(sample.atMs),
      method: sample.method,
      path: sample.path,
      status: sample.status,
      bytes: sample.bytes,
    })),
    pointers: [...pointers.values()],
    truncated: hit.truncated,
    notes: [...hit.notes],
  });
}

/** As chaves por onde os casos (PR-10) vão juntar achados. */
export function correlationOf(
  source: WebSource,
  hit: Pick<WebHit, 'rule' | 'client' | 'host' | 'firstMs' | 'lastMs'>,
): WebCorrelation {
  const keys: string[] = [];
  if (hit.client?.cls === 'direct') keys.push(`web:actor:${hit.client.key}`);
  if (hit.host !== null) keys.push(`web:host:${hit.host}:${CLASS_OF[hit.rule]}`);
  keys.push(`web:alb:${source.loadBalancer.slice(source.loadBalancer.lastIndexOf('/') + 1)}`);
  return { firstSeenAt: iso(hit.firstMs), lastSeenAt: iso(hit.lastMs), keys };
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** O achado. `keyLevel` é o nível que entra na chave: o maior das últimas 24 h. */
export function toWebFindingDraft(source: WebSource, hit: WebHit, keyLevel = hit.level): WebFindingDraft {
  const key = webFindingKey(source, hitIdentity(hit, keyLevel));
  const version = hourOf(hit.lastMs);
  const rule = WEB_RULES[hit.rule];
  return {
    tenantId: source.tenantId,
    accountId: source.accountId,
    source: 'aws',
    sourceEventId: key,
    occurredAt: iso(hit.lastMs),
    severity: severityOfLevel(hit.level),
    ruleId: hit.rule,
    ruleLevel: hit.level,
    title: rule.title,
    logSource: 'alb',
    eventName: hit.eventName.slice(0, 256),
    region: source.region,
    resource: `alb:${source.loadBalancer}`,
    actorUser: null,
    actorType: null,
    accessKeyId: null,
    sourceIp: hit.client?.cls === 'direct' ? hit.client.ip : null,
    mitreTactics: unique(rule.tactics),
    mitreTechniques: unique(hit.techniques),
    recurrence: { lastSeenAt: version, chainKey: key, sourceEventId: `${key}@${version}` },
    evidence: evidenceOf(hit),
    correlation: correlationOf(source, hit),
  };
}

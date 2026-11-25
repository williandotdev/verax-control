import {
  type FindingDetail,
  type FindingEvidence,
  findingEvidenceSchema,
  type FindingWebEvidence,
  RAW_EVENT_RETENTION_DAYS,
} from '@verax/shared';

/**
 * A evidência dos achados dos logs do ALB na demonstração, uma por regra. Fictícia: endereços das faixas de documentação (RFC 5737 e
 * 3849), hosts de exemplo, caminhos já mascarados como o motor os guarda. Passa pelo schema do contrato.
 */

const MINUTE = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const NO_COUNTERS: FindingWebEvidence['counters'] = {
  requests: 0,
  blocked: 0,
  errors: 0,
  toolRequests: 0,
  probes: 0,
  distinctPaths: 0,
  attempts: 0,
  failures: 0,
  successes: 0,
  clients: 0,
  answered: 0,
};

/** O que muda de uma regra para outra; o resto é comum. */
function parts(finding: FindingDetail, at: number): Partial<FindingWebEvidence> {
  const ip = finding.actor.ip;
  switch (finding.ruleId) {
    case '990405':
      return {
        windowFrom: iso(at - 15 * MINUTE),
        windowTo: iso(at),
        firstSeenAt: iso(at - 70 * MINUTE),
        client: ip,
        clientClass: 'direct',
        host: 'api.exemplo.com.br',
        route: '/v1/entrar',
        routeKind: 'login',
        routeSemantics: 'declared',
        counters: {
          ...NO_COUNTERS,
          requests: 462,
          attempts: 448,
          failures: 447,
          successes: 1,
          distinctPaths: 2,
        },
        statuses: [
          { status: '401', count: 447 },
          { status: '2xx', count: 15 },
        ],
        routes: [
          { path: '/v1/entrar', count: 448 },
          { path: '/v1/clientes/{num}/preferencias', count: 14 },
        ],
        userAgents: { families: ['python'], sample: 'python-requests/2.32' },
        samples: Array.from({ length: 6 }, (_, index) => ({
          at: iso(at - (12 - index * 2) * MINUTE),
          method: 'POST',
          path: '/v1/entrar',
          status: index === 5 ? 200 : 401,
          bytes: index === 5 ? 1_284 : 212,
        })),
        pointers: [pointer('api-alb', at - 10 * MINUTE), pointer('api-alb', at - 5 * MINUTE)],
        notes: ['valid_account_possible', 'bytes_include_headers'],
      };
    case '990402':
      return {
        windowFrom: iso(at - 15 * MINUTE),
        windowTo: iso(at),
        firstSeenAt: iso(at - 22 * MINUTE),
        client: ip,
        clientClass: 'direct',
        host: 'api.exemplo.com.br',
        counters: {
          ...NO_COUNTERS,
          requests: 96,
          blocked: 31,
          errors: 60,
          toolRequests: 40,
          probes: 88,
          distinctPaths: 71,
        },
        blockedPercent: 32,
        statuses: [
          { status: '403', count: 31 },
          { status: '404', count: 60 },
          { status: '3xx', count: 5 },
        ],
        probeFamilies: ['env', 'git', 'wordpress', 'db_admin', 'cloud_keys'],
        routes: [
          { path: '/.env', count: 12 },
          { path: '/.git/config', count: 9 },
          { path: '/wp-login.php', count: 8 },
          { path: '/phpmyadmin/{token}/index.php', count: 6 },
          { path: '/backup/{num}/.aws/credentials', count: 4 },
        ],
        userAgents: {
          families: ['nuclei', 'chrome'],
          sample: 'Mozilla/5.0 (compatible; Nuclei - Open-source project)',
        },
        samples: [
          { at: iso(at - 9 * MINUTE), method: 'GET', path: '/.env', status: 404, bytes: 341 },
          { at: iso(at - 8 * MINUTE), method: 'GET', path: '/.git/config', status: 403, bytes: 520 },
          { at: iso(at - 7 * MINUTE), method: 'HEAD', path: '/wp-login.php', status: 404, bytes: 0 },
        ],
        pointers: [pointer('api-alb', at - 8 * MINUTE)],
      };
    case '990407':
      return {
        windowFrom: iso(at - 15 * MINUTE),
        windowTo: iso(at),
        firstSeenAt: iso(at - 35 * MINUTE),
        host: 'loja.exemplo.com.br',
        route: '/conta/entrar',
        routeKind: 'login',
        routeSemantics: 'observed',
        counters: {
          ...NO_COUNTERS,
          requests: 1_940,
          attempts: 1_912,
          failures: 1_905,
          successes: 7,
          clients: 212,
        },
        statuses: [
          { status: '422', count: 1_905 },
          { status: '3xx', count: 7 },
          { status: '2xx', count: 28 },
        ],
        clients: Array.from({ length: 20 }, (_, index) => ({
          client: index < 14 ? `198.51.100.${100 + index}` : `2001:db8:${(index + 10).toString(16)}::/64`,
          requests: 20 - Math.floor(index / 3),
          count: 19 - Math.floor(index / 3),
        })),
        userAgents: { families: ['chrome', 'firefox', 'safari'], sample: null },
        notes: ['counts_are_estimated', 'client_not_direct'],
      };
    default:
      return {
        windowFrom: `${iso(at).slice(0, 10)}T00:00:00.000Z`,
        windowTo: iso(Date.parse(`${iso(at).slice(0, 10)}T00:00:00.000Z`) + 24 * 60 * MINUTE),
        firstSeenAt: iso(at),
        lastSeenAt: iso(at + 4 * 60 * MINUTE),
        counters: {
          ...NO_COUNTERS,
          requests: 1_306,
          errors: 402,
          toolRequests: 118,
          probes: 731,
          clients: 47,
        },
        probeFamilies: ['env', 'git', 'wordpress', 'php_rce', 'device', 'remote_access'],
        clients: Array.from({ length: 20 }, (_, index) => ({
          client: index % 5 === 4 ? `2001:db8:${(index + 40).toString(16)}::/64` : `203.0.113.${140 + index}`,
          requests: 120 - index * 5,
          count: 80 - index * 3,
        })),
      };
  }
}

function pointer(balancer: string, ms: number): FindingWebEvidence['pointers'][number] {
  const minute = Math.floor(ms / MINUTE) * MINUTE;
  const at = iso(minute);
  const day = at.slice(0, 10).split('-');
  const stamp = `${day.join('')}T${at.slice(11, 13)}${at.slice(14, 16)}Z`;
  return {
    objectKey: `AWSLogs/111122223333/elasticloadbalancing/sa-east-1/${day.join('/')}/111122223333_elasticloadbalancing_sa-east-1_app.${balancer}.50dc6c495c0c9101_${stamp}_203.0.113.250_1a2b3c4d.log.gz`,
    minute: at,
  };
}

/** A evidência de um achado da demonstração, como a API a devolve; sem as amostras, depois do prazo delas. */
export function demoFindingEvidence(finding: FindingDetail, now: number = Date.now()): FindingEvidence {
  if (finding.source !== 'alb') return { evidence: null, samplesPurgedAt: null };
  const at = Date.parse(finding.occurredAt);
  const evidence: FindingWebEvidence = {
    version: 1,
    ruleId: finding.ruleId,
    windowFrom: iso(at - 15 * MINUTE),
    windowTo: iso(at),
    firstSeenAt: iso(at - 15 * MINUTE),
    lastSeenAt: iso(at),
    client: null,
    clientClass: null,
    host: null,
    route: null,
    routeKind: null,
    routeSemantics: null,
    counters: NO_COUNTERS,
    blockedPercent: 0,
    statuses: [],
    probeFamilies: [],
    routes: [],
    clients: [],
    userAgents: { families: [], sample: null },
    samples: [],
    pointers: [],
    truncated: false,
    notes: [],
    ...parts(finding, at),
  };
  const purgedAt = at + RAW_EVENT_RETENTION_DAYS * 24 * 60 * MINUTE;
  const purged = purgedAt < now;
  return findingEvidenceSchema.parse({
    evidence: purged
      ? { ...evidence, samples: [], pointers: [], userAgents: { ...evidence.userAgents, sample: null } }
      : evidence,
    samplesPurgedAt: purged ? iso(purgedAt) : null,
  });
}

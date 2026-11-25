import type { ProviderRanges } from '../../src/weblogs/data/proxy-ranges.js';
import {
  WebLogEngine,
  type EngineOptions,
  type EvaluateInput,
  type OpenResult,
} from '../../src/weblogs/engine.js';

/** Linhas e objetos de log do ALB, só com dado fictício (contas 111111111111 e 222222222222, RFC 5737 e 3849). */

export const ACCOUNT = '111111111111';
export const REGION = 'sa-east-1';
export const LB = 'app/loja/0123456789abcdef';
/** Um horário redondo: o fim do slot de referência dos testes. */
export const T0 = Date.UTC(2026, 10, 24, 12, 0, 0);
export const SLOT = 5 * 60_000;

/** Faixas fictícias no lugar das oficiais: nenhuma delas é de CDN de verdade. */
export const TEST_RANGES: readonly ProviderRanges[] = [
  {
    provider: 'cloudflare',
    source: 'teste',
    generatedAt: '2026-11-01T00:00:00.000Z',
    ranges: ['203.0.113.0/25', '2001:db8:cf00::/40'],
  },
  {
    provider: 'cloudfront',
    source: 'teste',
    generatedAt: '2026-11-01T00:00:00.000Z',
    ranges: ['203.0.113.128/25'],
  },
];

export interface LineSpec {
  type?: string;
  time?: number | string;
  lb?: string;
  client?: string;
  port?: number;
  status?: number | '-';
  target?: number | '-';
  sent?: number | string;
  method?: string;
  /** O caminho com a query; o host da URL é sempre o mesmo. */
  path?: string;
  request?: string;
  userAgent?: string;
  trace?: string;
  domain?: string;
  actions?: string;
  redirect?: string;
  fields?: 29 | 30 | 36;
}

const BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export function albLine(spec: LineSpec = {}): string {
  const time =
    typeof spec.time === 'string'
      ? spec.time
      : new Date(spec.time ?? T0 - 60_000).toISOString().replace('Z', '000Z');
  const status = spec.status ?? 200;
  const target = spec.target ?? status;
  const request =
    spec.request ?? `${spec.method ?? 'GET'} https://loja.exemplo.com.br:443${spec.path ?? '/'} HTTP/2.0`;
  const head = [
    spec.type ?? 'h2',
    time,
    spec.lb ?? LB,
    `${spec.client ?? '192.0.2.10'}:${spec.port ?? 44321}`,
    target === '-' ? '-' : '10.0.1.20:8080',
    '0.001',
    '0.020',
    '0.000',
    String(status),
    String(target),
    '512',
    String(spec.sent ?? 5120),
    `"${request}"`,
    `"${spec.userAgent ?? BROWSER}"`,
    'TLS_AES_128_GCM_SHA256',
    'TLSv1.3',
    `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/loja/0123456789abcdef`,
    `"${spec.trace ?? 'Root=1-67890abc-0123456789abcdef01234567'}"`,
    `"${spec.domain ?? 'loja.exemplo.com.br'}"`,
    `"arn:aws:acm:${REGION}:${ACCOUNT}:certificate/00000000-0000-4000-8000-000000000000"`,
    '1',
    time,
    `"${spec.actions ?? 'waf,forward'}"`,
    `"${spec.redirect ?? '-'}"`,
    '"-"',
    '"10.0.1.20:8080"',
    `"${String(target)}"`,
    '"-"',
    '"-"',
  ];
  const fields = spec.fields ?? 29;
  if (fields >= 30) head.push('TID_0123456789abcdef0123456789abcdef');
  if (fields >= 36) head.push('"-"', '"-"', '"-"', '-', '-', '"-"');
  return head.join(' ');
}

const compact = (ms: number): string =>
  `${new Date(ms).toISOString().slice(0, 16).replaceAll('-', '').replaceAll(':', '')}Z`;

export function objectKey(
  endMs: number,
  options: {
    account?: string;
    region?: string;
    lb?: string;
    prefix?: string;
    random?: string;
    node?: string;
  } = {},
): string {
  const account = options.account ?? ACCOUNT;
  const region = options.region ?? REGION;
  const [, name = '', id = ''] = (options.lb ?? LB).split('/');
  const day = new Date(endMs).toISOString().slice(0, 10).replaceAll('-', '/');
  const prefix = options.prefix === undefined || options.prefix === '' ? '' : `${options.prefix}/`;
  return (
    `${prefix}AWSLogs/${account}/elasticloadbalancing/${region}/${day}/` +
    `${account}_elasticloadbalancing_${region}_app.${name}.${id}_${compact(endMs)}_${options.node ?? '10.0.1.5'}_${options.random ?? 'abc123'}.log.gz`
  );
}

export class Harness {
  readonly engine: WebLogEngine;

  constructor(options: Partial<EngineOptions> = {}) {
    this.engine = new WebLogEngine({
      source: {
        tenantId: '00000000-0000-4000-8000-000000000001',
        accountId: ACCOUNT,
        region: REGION,
        loadBalancer: LB,
      },
      hashKey: new Uint8Array(16).fill(7),
      now: T0,
      ranges: TEST_RANGES,
      ...options,
    });
  }

  /** Lê as linhas no arquivo que termina em `endMs`. */
  feed(lines: readonly LineSpec[], endMs = T0, now = endMs + 60_000): Extract<OpenResult, { ok: true }> {
    const object = this.engine.openObject(objectKey(endMs), now);
    if (!object.ok) throw new Error(object.reason);
    for (const line of lines) this.engine.ingest(object, albLine({ time: endMs - 60_000, ...line }));
    return object;
  }

  evaluate(now = T0 + 60_000, extra: Partial<EvaluateInput> = {}): ReturnType<WebLogEngine['evaluate']> {
    return this.engine.evaluate({ now, ...extra });
  }
}

/** Um JWT fictício, montado na hora (o repositório não guarda nem token de mentira). */
export function fakeJwt(): string {
  const part = (text: string): string => Buffer.from(text).toString('base64url');
  return [
    part('{"alg":"HS256"}'),
    part('{"sub":"0000000000"}'),
    part('assinatura ficticia, 32 bytes !!'),
  ].join('.');
}

/** `count` cópias, com o que muda por índice. */
export function times<T>(count: number, spec: (i: number) => T): T[] {
  return Array.from({ length: count }, (_, i) => spec(i));
}

/** Gerador determinístico (mulberry32). */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

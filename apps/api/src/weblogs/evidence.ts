import { z } from 'zod';
import { every, isDigit, isLower, isPrintable } from './ascii.js';
import { CLIENT_CLASSES } from './client-class.js';
import { isMaskedPath } from './path.js';
import { PROBE_FAMILIES } from './probes.js';
import { WEB_ROUTE_KINDS } from './routes.js';
import { isUaSample, UA_FAMILIES } from './user-agent.js';

/**
 * Evidência de um achado de ataque web: o que fica no lugar da linha de log, que nunca é guardada (D2). Estrita e com
 * teto (16 KB): contagens, caminhos mascarados, amostras e ponteiros para o objeto no bucket **do cliente**, onde a linha
 * original está.
 *
 * O schema é também a última barreira: um caminho fora do formato mascarado, um texto com caractere de controle ou um
 * campo a mais não passam, e o achado sai sem aquele pedaço em vez de sair com ele.
 */
export const EVIDENCE_VERSION = 1;
export const MAX_EVIDENCE_BYTES = 16 * 1024;
export const MAX_EVIDENCE_ROUTES = 10;
export const MAX_EVIDENCE_CLIENTS = 20;
export const MAX_EVIDENCE_SAMPLES = 10;
export const MAX_EVIDENCE_POINTERS = 5;

export const WEB_METHODS = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
  'OTHER',
] as const;
export type WebMethod = (typeof WEB_METHODS)[number];

const METHODS: ReadonlySet<string> = new Set(WEB_METHODS);
export const methodOf = (method: string | null): WebMethod =>
  method !== null && METHODS.has(method) ? (method as WebMethod) : 'OTHER';

/** O que o leitor precisa saber para não ler a contagem como exata, ou o achado como certeza. */
export const EVIDENCE_NOTES = [
  /** Contagens são piso: um teto de memória ou um corte foi atingido. */
  'counts_are_floor',
  /** Objeto que chegou depois do fechamento da janela, avaliado sozinho. */
  'late_object',
  /** 95% ou mais barrado pelo WAF, e o que passou não atinge a regra sozinho. */
  'held_by_waf',
  /** Endereço com cara de NAT: os limites valeram cinco vezes. */
  'nat_like',
  /** Rota sem semântica conhecida: só o volume foi avaliado. */
  'volume_only',
  /** `T1078` é uma possibilidade, não uma constatação. */
  'valid_account_possible',
  /** O endereço é de proxy, CDN ou rede privada, ou não dá para saber: nenhum IP é apontado. */
  'client_not_direct',
  /** O balanceador conta os cabeçalhos em `bytes`. */
  'bytes_include_headers',
] as const;
export type EvidenceNote = (typeof EVIDENCE_NOTES)[number];

const instant = z.iso.datetime();
const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const isHostChar = (code: number): boolean =>
  isLower(code) || isDigit(code) || code === 45 || code === 46 || code === 95;
const host = z
  .string()
  .max(253)
  .refine((value) => every(value, isHostChar));
/** IPv4, IPv6 ou o /64: algarismo, hexadecimal, `.`, `:` e `/`. */
const address = z
  .string()
  .max(49)
  .refine((value) =>
    every(
      value,
      (code) => isDigit(code) || (code >= 97 && code <= 102) || code === 46 || code === 58 || code === 47,
    ),
  );
const maskedPath = z.string().refine(isMaskedPath);

export const webSampleSchema = z.strictObject({
  at: instant,
  method: z.enum(WEB_METHODS),
  path: maskedPath,
  status: z.int().min(0).max(999),
  bytes: count,
});
export type WebSample = z.infer<typeof webSampleSchema>;

export const webEvidenceSchema = z.strictObject({
  version: z.literal(EVIDENCE_VERSION),
  ruleId: z.string().refine((value) => value.length === 6 && every(value, isDigit)),
  windowFrom: instant,
  windowTo: instant,
  firstSeenAt: instant,
  lastSeenAt: instant,
  /** O endereço (IPv4) ou o /64; null quando não é `direct` ou quando o achado é de mais de um. */
  client: address.nullable(),
  clientClass: z.enum(CLIENT_CLASSES).nullable(),
  host: host.nullable(),
  /** A rota de login, mascarada ou a declarada pelo cliente. */
  route: z.string().max(256).refine(isRouteLabel).nullable(),
  routeKind: z.enum(WEB_ROUTE_KINDS).nullable(),
  routeSemantics: z.enum(['declared', 'observed', 'unknown']).nullable(),
  counters: z.strictObject({
    requests: count,
    blocked: count,
    errors: count,
    toolRequests: count,
    probes: count,
    distinctPaths: count,
    attempts: count,
    failures: count,
    successes: count,
    clients: count,
    answered: count,
  }),
  blockedPercent: z.int().min(0).max(100),
  statuses: z.array(z.strictObject({ status: z.string().max(5), count })).max(12),
  probeFamilies: z.array(z.enum(PROBE_FAMILIES)).max(PROBE_FAMILIES.length),
  routes: z.array(z.strictObject({ path: maskedPath, count })).max(MAX_EVIDENCE_ROUTES),
  clients: z.array(z.strictObject({ client: address, requests: count, count })).max(MAX_EVIDENCE_CLIENTS),
  userAgents: z.strictObject({
    families: z.array(z.enum(UA_FAMILIES)).max(UA_FAMILIES.length),
    sample: z.string().refine(isUaSample).nullable(),
  }),
  samples: z.array(webSampleSchema).max(MAX_EVIDENCE_SAMPLES),
  pointers: z
    .array(
      z.strictObject({
        objectKey: z
          .string()
          .max(512)
          .refine((value) => every(value, isPrintable)),
        minute: instant,
      }),
    )
    .max(MAX_EVIDENCE_POINTERS),
  truncated: z.boolean(),
  notes: z.array(z.enum(EVIDENCE_NOTES)).max(EVIDENCE_NOTES.length),
});
export type WebEvidence = z.infer<typeof webEvidenceSchema>;

/** O rótulo de uma rota: o caminho mascarado ou o declarado (com `*`). */
function isRouteLabel(text: string): boolean {
  return isMaskedPath(text.split('*').join('x'));
}

/**
 * Evidência pronta para gravar. O item de lista que não passa no schema sai (a amostra, a rota, o ponteiro). Se o resto não
 * passa, é erro de programação: lança, em vez de gravar o que não devia. O tamanho (`MAX_EVIDENCE_BYTES`) vem dos tetos do
 * próprio schema, e um teste o confere com a maior evidência possível.
 */
export function sealEvidence(draft: WebEvidence): WebEvidence {
  const shape = webEvidenceSchema.shape;
  return webEvidenceSchema.parse({
    ...draft,
    routes: draft.routes.filter((item) => shape.routes.element.safeParse(item).success),
    clients: draft.clients.filter((item) => shape.clients.element.safeParse(item).success),
    samples: draft.samples.filter((item) => webSampleSchema.safeParse(item).success),
    pointers: draft.pointers.filter((item) => shape.pointers.element.safeParse(item).success),
    userAgents: {
      families: draft.userAgents.families,
      sample: shape.userAgents.shape.sample.safeParse(draft.userAgents.sample).success
        ? draft.userAgents.sample
        : null,
    },
  });
}

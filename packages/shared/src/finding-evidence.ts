import { z } from 'zod';

/**
 * A evidência de um achado que não tem evento bruto guardado (os ataques web pelos logs de acesso do ALB):
 * `GET /v1/findings/:id/evidence`. Contagens, caminhos mascarados, amostras e ponteiros para o objeto no bucket do próprio
 * cliente; nunca a linha de log, a query nem o `Referer`.
 *
 * Rota à parte do detalhe do achado: o contrato do detalhe é estrito, e um campo novo nele derrubaria a tela inteira de um
 * painel de antes. O painel novo num nó de antes recebe 404 e mostra o achado sem a evidência.
 *
 * Estrito nos campos e nos tetos, aberto nos códigos (famílias, notas, classes): um código novo do nó não derruba a
 * evidência num painel de antes, que só não tem o texto dele. Mudança de forma é outra `version`.
 */

/** Quanto texto a evidência pode ter, em bytes UTF-8 do JSON. */
export const MAX_FINDING_EVIDENCE_BYTES = 16 * 1024;

const instant = z.iso.datetime();
const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
/** Um código do dicionário do motor: minúsculas, algarismos e `_`. */
const code = z.string().regex(/^[a-z0-9_]{1,32}$/);
/** Texto de uma linha, só ASCII visível: nada que vire controle, bidi ou homóglifo na tela. */
const asciiText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[\x20-\x7e]*$/);
/** Um IPv4, um IPv6 ou um /64. */
const address = z.string().regex(/^[0-9a-f.:/]{1,49}$/);
/** Um caminho mascarado (ou a rota declarada, com `*`): sem query, sem maiúscula, com os marcadores entre chaves. */
const maskedPath = z.string().regex(/^\/[a-z0-9._~{}*/-]{0,255}$/);

export const findingEvidenceSampleSchema = z.strictObject({
  at: instant,
  method: z.string().regex(/^[A-Z]{1,10}$/),
  path: maskedPath,
  status: z.int().min(0).max(999),
  bytes: count,
});
export type FindingEvidenceSample = z.infer<typeof findingEvidenceSampleSchema>;

export const findingEvidencePointerSchema = z.strictObject({
  /** A chave do objeto no bucket do cliente, onde a linha original está. */
  objectKey: asciiText(512),
  minute: instant,
});
export type FindingEvidencePointer = z.infer<typeof findingEvidencePointerSchema>;

export const findingWebEvidenceSchema = z.strictObject({
  version: z.literal(1),
  ruleId: z.string().regex(/^\d{6}$/),
  /** A janela das contagens. */
  windowFrom: instant,
  windowTo: instant,
  /** A atividade do achado inteiro, desde a primeira detecção. */
  firstSeenAt: instant,
  lastSeenAt: instant,
  /** O endereço (IPv4) ou o /64; null quando o cliente não é direto ou o achado é de mais de um. */
  client: address.nullable(),
  clientClass: code.nullable(),
  host: z
    .string()
    .regex(/^[a-z0-9._-]{1,253}$/)
    .nullable(),
  route: maskedPath.nullable(),
  routeKind: code.nullable(),
  routeSemantics: code.nullable(),
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
  statuses: z.array(z.strictObject({ status: asciiText(5), count })).max(12),
  probeFamilies: z.array(code).max(32),
  routes: z.array(z.strictObject({ path: maskedPath, count })).max(10),
  clients: z.array(z.strictObject({ client: address, requests: count, count })).max(20),
  userAgents: z.strictObject({
    families: z.array(code).max(64),
    /** Uma amostra mascarada do User-Agent; sai com as outras amostras. */
    sample: asciiText(120).nullable(),
  }),
  samples: z.array(findingEvidenceSampleSchema).max(10),
  pointers: z.array(findingEvidencePointerSchema).max(5),
  /** As contagens são um piso: um teto de memória foi atingido. */
  truncated: z.boolean(),
  notes: z.array(code).max(32),
});
export type FindingWebEvidence = z.infer<typeof findingWebEvidenceSchema>;

export const findingEvidenceSchema = z.strictObject({
  /** Null: o achado não tem evidência própria (ele tem, ou teve, o evento bruto). */
  evidence: findingWebEvidenceSchema.nullable(),
  /** Quando as amostras e os ponteiros saíram (`RAW_EVENT_RETENTION_DAYS`); null enquanto ficam, ou sem evidência. */
  samplesPurgedAt: instant.nullable(),
});
export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;

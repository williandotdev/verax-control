import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ULID_PATTERN } from '../common/ulid.js';

/**
 * Credenciais da página de status (plano §2.3 e §3): um valor aleatório de 256 bits que só o cliente tem (no cookie
 * `__session` ou no link do e-mail do plano B), e no Firestore só o SHA-256 dele, como id de `statusTokens/{id}`. Quem
 * lê o banco não consegue se passar pelo cliente; quem rouba o `cs_` da URL de sucesso não consegue nada depois da
 * revelação (o `claim` recusa).
 */
export const STATUS_TOKEN_KINDS = ['cookie', 'email_reveal'] as const;
export type StatusTokenKind = (typeof STATUS_TOKEN_KINDS)[number];

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Validade de cada tipo: 7 dias o cookie (a página de status), 24 h o link de uso único do e-mail. */
export const STATUS_TOKEN_TTL_MS: Readonly<Record<StatusTokenKind, number>> = {
  cookie: 7 * DAY_MS,
  email_reveal: DAY_MS,
};

/** O cookie se chama `__session` porque é o único que o Firebase Hosting repassa ao Cloud Run (plano §2.4). */
export const STATUS_COOKIE_NAME = '__session';
/** Só as rotas da página de status recebem o cookie. */
export const STATUS_COOKIE_PATH = '/v1/public/status';

/** 32 bytes aleatórios em base64url: 43 caracteres de `[A-Za-z0-9_-]`. */
const RANDOM_BYTES = 32;
export const statusTokenValueSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Um valor novo para o cliente (cookie ou link do e-mail); só o hash vai ao Firestore. */
export function newStatusTokenValue(): string {
  return randomBytes(RANDOM_BYTES).toString('base64url');
}

/** O id do documento em `statusTokens`: SHA-256 em hexadecimal do valor que o cliente tem. */
export function statusTokenId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Documento `statusTokens/{sha256}` (plano §3): de quem é, de que tipo, até quando e se já foi usado. */
export const statusTokenDocumentSchema = z.strictObject({
  tenantId: z.string().regex(ULID_PATTERN),
  kind: z.enum(STATUS_TOKEN_KINDS),
  createdAt: z.date(),
  /** Campo do TTL do Firestore (collections.ts); a leitura também confere, porque o TTL apaga com até 24 h de atraso. */
  expiresAt: z.date(),
  /** Só o `email_reveal`: o link vale uma revelação. O cookie continua servindo à página depois dela. */
  usedAt: z.date().optional(),
});
export type StatusTokenDocument = z.infer<typeof statusTokenDocumentSchema>;

/**
 * Formato do cookie: `v1.<valor>.<HMAC-SHA256 em base64url>`, com a `COOKIE_KEY`. A assinatura deixa recusar um
 * cookie forjado ou alterado sem ler o Firestore e prende o cookie à chave: trocar a `COOKIE_KEY` invalida todos.
 */
const COOKIE_VERSION = 'v1';
const MAC_CONTEXT = 'verax-status-cookie:v1:';
const cookieValueSchema = z
  .string()
  .length(COOKIE_VERSION.length + 1 + 43 + 1 + 43)
  .regex(/^v1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);

function mac(value: string, key: string): string {
  return createHmac('sha256', key).update(`${MAC_CONTEXT}${value}`, 'utf8').digest('base64url');
}

export function signStatusCookie(value: string, key: string): string {
  return `${COOKIE_VERSION}.${value}.${mac(value, key)}`;
}

/** O valor de dentro de um cookie assinado com esta chave, ou `undefined` (formato errado, alterado, outra chave). */
export function verifyStatusCookie(cookie: string, key: string): string | undefined {
  if (!cookieValueSchema.safeParse(cookie).success) return undefined;
  const [, value = '', received = ''] = cookie.split('.');
  const expected = Buffer.from(mac(value, key), 'utf8');
  const actual = Buffer.from(received, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? value : undefined;
}

/**
 * Os valores do cookie `__session` no cabeçalho `Cookie` (pode haver mais de um: o navegador manda primeiro o de
 * caminho mais específico). Sem decodificação: o valor assinado só tem caracteres que não precisam dela.
 */
export function statusCookiesFrom(header: string | undefined): string[] {
  if (header === undefined || header.length > 8192) return [];
  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== STATUS_COOKIE_NAME) continue;
    values.push(part.slice(separator + 1).trim());
  }
  return values;
}

/** O valor do primeiro cookie `__session` com assinatura válida, ou `undefined`. */
export function readStatusCookie(header: string | undefined, key: string): string | undefined {
  for (const cookie of statusCookiesFrom(header)) {
    const value = verifyStatusCookie(cookie, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

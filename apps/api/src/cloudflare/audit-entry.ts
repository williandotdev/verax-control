import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Entrada da auditoria v2 do Cloudflare (`GET /accounts/{account_id}/logs/audit`), como a API devolve em `result`.
 * Toda entrada é entrada externa e não confiável (regra 6): passa pelo zod uma a uma, e só os campos que as regras e
 * o achado usam ficam. Texto grande demais é cortado, não recusado: senão bastaria um User-Agent enorme para o evento
 * inteiro virar "inválido" e escapar das regras. O tamanho total da página já é limitado pelo cliente HTTP.
 *
 * Campos (todos opcionais na documentação; aqui o `id` e o `action.time` são obrigatórios, porque sem eles não há
 * chave do achado nem cursor):
 * - `id` (até 32 caracteres) e `account{id,name}`;
 * - `action{type,result,time,description}`;
 * - `actor{id,type,context,email,ip_address,token_id,token_name}`;
 * - `resource{id,product,type,scope,request,response}`: `request` e `response` são JSON livre, lidos pelas regras e
 *   descartados (nada do evento bruto é gravado);
 * - `raw{method,uri,status_code,cf_ray_id,user_agent}` e `zone{id,name}`.
 *
 * O Cloudflare pode mandar `null` num campo ausente: os opcionais aceitam os dois.
 */

const text = (max: number) => z.string().transform((value) => value.slice(0, max));
const optionalText = (max: number) =>
  text(max)
    .nullish()
    .transform((value) => value ?? undefined);

/** ID da entrada: até 64 caracteres visíveis (a documentação diz até 32), sem espaço nem controle. */
const entryIdSchema = z.string().regex(/^[\x21-\x7e]{1,64}$/);

/** JSON livre de `resource.request` e `resource.response`. Às vezes pode vir como texto com o JSON dentro. */
const freeJson = z.unknown().transform((value) => (typeof value === 'string' ? parseJsonText(value) : value));

/** Até onde um corpo em texto é lido como JSON. */
const MAX_JSON_TEXT = 64 * 1024;

function parseJsonText(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.length > MAX_JSON_TEXT || !(trimmed.startsWith('{') || trimmed.startsWith('[')))
    return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export const auditEntrySchema = z.object({
  id: entryIdSchema,
  account: z
    .object({ id: optionalText(64), name: optionalText(256) })
    .nullish()
    .transform((value) => value ?? undefined),
  action: z.object({
    description: optionalText(256),
    result: optionalText(32),
    time: z.iso.datetime({ offset: true }),
    type: optionalText(32),
  }),
  actor: z
    .object({
      id: optionalText(64),
      context: optionalText(32),
      email: optionalText(320),
      ip_address: optionalText(64),
      token_id: optionalText(64),
      token_name: optionalText(256),
      type: optionalText(32),
    })
    .nullish()
    .transform((value) => value ?? undefined),
  raw: z
    .object({
      cf_ray_id: optionalText(64),
      method: optionalText(16),
      status_code: z
        .number()
        .int()
        .nullish()
        .transform((value) => value ?? undefined),
      uri: optionalText(2048),
      user_agent: optionalText(512),
    })
    .nullish()
    .transform((value) => value ?? undefined),
  resource: z
    .object({
      id: optionalText(256),
      product: optionalText(128),
      type: optionalText(128),
      request: freeJson,
      response: freeJson,
    })
    .nullish()
    .transform((value) => value ?? undefined),
  zone: z
    .object({ id: optionalText(64), name: optionalText(253) })
    .nullish()
    .transform((value) => value ?? undefined),
});

export type AuditEntry = z.infer<typeof auditEntrySchema>;

export type ParsedAuditEntry = { ok: true; entry: AuditEntry } | { ok: false; id: string | null };

/** Valida uma entrada. A inválida devolve o `id`, quando ele mesmo é aproveitável, para a fila sem dono. */
export function parseAuditEntry(value: unknown): ParsedAuditEntry {
  const parsed = auditEntrySchema.safeParse(value);
  if (parsed.success) return { ok: true, entry: parsed.data };
  const id = typeof value === 'object' && value !== null ? (value as { id?: unknown }).id : undefined;
  return { ok: false, id: entryIdSchema.safeParse(id).success ? (id as string) : null };
}

/** ID da conta do Cloudflare: 32 hexadecimais minúsculos, conferido sem regex. */
export function isCloudflareAccountId(value: string | undefined): value is string {
  if (value?.length !== 32) return false;
  for (const char of value) {
    if (!((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f'))) return false;
  }
  return true;
}

/** Até onde cabe na chave única do achado (`sourceEventId`, 128). */
const MAX_EVENT_ID = 128;

/**
 * Chave do evento no achado e na fila sem dono: `cf/<conta>/<id da entrada>` (até 100 caracteres). A conta é a do
 * cadastro: a chave é única no banco inteiro, e um ID repetido noutra conta não apaga o achado de ninguém.
 */
export function cloudflareEventId(accountId: string, entryId: string): string {
  return `cf/${accountId}/${entryId}`.slice(0, MAX_EVENT_ID);
}

/** Entrada sem `id` aproveitável: o resumo do conteúdo, para reler a mesma entrada cair na mesma chave. */
export function invalidEntryId(accountId: string, value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? 'undefined';
  } catch {
    json = 'unserializable';
  }
  const digest = createHash('sha256').update(json).digest('hex').slice(0, 40);
  return `cf/${accountId}/invalido:${digest}`;
}

/**
 * Caminho da API chamado (`raw.uri`) em partes: sem a query, sem esquema e host, e sem o prefixo da versão
 * (`/client/v4`, da API pública, e `/api/v4`, o que o painel usa). Nenhuma regex: só cortes de texto.
 */
export function pathSegments(entry: { raw?: { uri?: string | undefined } | undefined }): string[] {
  let path = entry.raw?.uri ?? '';
  for (const separator of ['?', '#']) {
    const at = path.indexOf(separator);
    if (at >= 0) path = path.slice(0, at);
  }
  if (path.startsWith('https://') || path.startsWith('http://')) {
    try {
      path = new URL(path).pathname;
    } catch {
      return [];
    }
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  const [first, second] = segments;
  if ((first === 'client' || first === 'api') && second === 'v4') segments.splice(0, 2);
  return segments;
}

/**
 * O caminho casa com o padrão: partes separadas por `/`; `*` casa uma parte qualquer; `a|b` casa uma das palavras;
 * `**` no fim casa o resto (zero ou mais partes). As palavras fixas comparam sem diferenciar maiúsculas.
 */
export function pathMatches(segments: readonly string[], pattern: string): boolean {
  const parts = pattern.split('/');
  for (const [index, part] of parts.entries()) {
    if (part === '**') return true;
    const segment = segments[index];
    if (segment === undefined) return false;
    if (part !== '*' && !part.split('|').includes(segment.toLowerCase())) return false;
  }
  return parts.length === segments.length;
}

export type HttpVerb = 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'GET' | 'OTHER';

/**
 * O método da chamada: o `raw.method` ou, sem ele, o tipo da ação (`create`, `update`, `delete`, `view`). Sem nenhum
 * dos dois, `OTHER`, que nenhuma regra de mudança aceita.
 */
export function verbOf(entry: {
  raw?: { method?: string | undefined } | undefined;
  action: { type?: string | undefined };
}): HttpVerb {
  const method = entry.raw?.method?.toUpperCase();
  if (
    method === 'POST' ||
    method === 'PUT' ||
    method === 'PATCH' ||
    method === 'DELETE' ||
    method === 'GET'
  ) {
    return method;
  }
  switch (entry.action.type?.toLowerCase()) {
    case 'create':
      return 'POST';
    case 'update':
      return 'PATCH';
    case 'delete':
      return 'DELETE';
    case 'view':
      return 'GET';
    default:
      return 'OTHER';
  }
}

/**
 * A ação aconteceu: o resultado não é `failure` e, quando há o status HTTP, ele não é de erro. As regras de mudança só
 * contam o que de fato mudou (a auditoria v2 não registra as respostas 4xx, mas o campo existe).
 */
export function succeeded(entry: {
  raw?: { status_code?: number | undefined } | undefined;
  action: { result?: string | undefined };
}): boolean {
  if (entry.action.result?.toLowerCase() === 'failure') return false;
  const status = entry.raw?.status_code;
  return status === undefined || status < 400;
}

/**
 * Campo de um JSON livre, por caminho, sem supor o formato. Só lê chaves próprias do objeto (`Object.hasOwn`): um
 * caminho com `__proto__` ou `constructor` não alcança o protótipo. Só leitura; nada é gravado no objeto.
 */
export function field(value: unknown, ...keys: string[]): unknown {
  const [key, ...rest] = keys;
  if (key === undefined) return value;
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, key)) {
    return undefined;
  }
  return field((value as Record<string, unknown>)[key], ...rest);
}

/** Lista de um JSON livre (vazia quando não é lista). */
export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** O corpo da requisição (`resource.request`), e o resultado da resposta quando a API o embrulha em `result`. */
export function requestOf(entry: Pick<AuditEntry, 'resource'>): unknown {
  return entry.resource?.request;
}

export function responseOf(entry: Pick<AuditEntry, 'resource'>): unknown {
  const response = entry.resource?.response;
  return field(response, 'result') ?? response;
}

/** IP de quem agiu, quando é um IP de verdade. */
export function actorIp(entry: Pick<AuditEntry, 'actor'>): string | null {
  const ip = entry.actor?.ip_address;
  return ip !== undefined && isIP(ip) !== 0 ? ip : null;
}

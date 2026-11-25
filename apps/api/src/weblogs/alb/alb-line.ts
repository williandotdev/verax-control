import { decimal, every, isAlnum, isAlpha } from '../ascii.js';

/**
 * Uma linha do log de acesso do ALB, por varredura de caracteres (nenhuma regex sobre a entrada).
 *
 * **Dois pedaços, com confiança diferente.** Os campos 1 a 12 (tipo, horário, balanceador, cliente, status, bytes) vêm
 * antes de qualquer texto que o atacante controla e são lidos da esquerda. Depois deles há quatro textos escolhidos por
 * quem faz a requisição (URL, User-Agent, trace id e URL de redirecionamento), e a AWS não documenta como escapa aspas
 * dentro deles. Um User-Agent com aspas poderia fabricar os campos seguintes: um `domain_name` falso, ou um
 * `actions_executed` terminando em `waf`, que rebaixaria o achado. Por isso a cauda só vale se **não houver outra leitura
 * possível**: toda aspa na fronteira de um campo, nenhuma barra invertida, os campos 15 a 29 com a forma conhecida e
 * **uma só** sequência `<prioridade> <horário> "<ações>"` na linha (a cauda verdadeira vem sempre depois do texto
 * injetado, e aí seriam duas).
 *
 * **Linha ambígua não é descartada** (seria o jeito mais fácil de sumir: uma aspa no User-Agent). Ela é analisada pelo
 * pedaço confiável, sem host e sem `blocked`: o que se perde só pode deixar o achado mais alto, nunca mais baixo.
 * `malformed` é só a linha cujo pedaço confiável não serve.
 *
 * A URL é lida só até o `?`: a query string não sai daqui. O trace id, a URL de redirecionamento e os campos depois do
 * 29º (a documentação manda tolerar campos novos) nem são guardados. O `Host` da URL também não: é do atacante; o host
 * que vale é o `domain_name`, que só existe quando o SNI casou com um certificado do balanceador.
 */
export interface AlbLine {
  /** `http`, `https`, `h2`, `grpcs`, `ws` ou `wss`. */
  type: string;
  timeMs: number;
  /** `app/<nome>/<id>`. */
  loadBalancer: string;
  clientIp: string;
  /** 0 quando o campo é `-`. */
  elbStatus: number;
  targetStatus: number;
  /** Bytes enviados ao cliente, com os cabeçalhos (a AWS não separa o corpo). */
  sentBytes: number;
  /** null na requisição malformada que o balanceador registra como `-`. */
  method: string | null;
  /** O caminho como veio, sem a query e sem decodificar, até 2048 caracteres; null sem caminho. */
  path: string | null;
  hasQuery: boolean;
  /**
   * Até 512 caracteres, como veio; vazio quando `-`. Na linha ambígua pode ser um pedaço da query (uma aspa na URL desloca
   * os campos): serve para achar a família, e nunca para mostrar.
   */
  userAgent: string;
  /** Só o SNI que casou com um certificado, em minúsculas; null sem ele (e na linha ambígua). */
  domainName: string | null;
  /** A última ação executada foi `waf`: a requisição parou no WAF. */
  blocked: boolean;
  /** A cauda tem mais de uma leitura: host e bloqueio não foram usados. */
  ambiguous: boolean;
}

export const MAX_LINE_CHARS = 64 * 1024;
export const MAX_PATH_READ = 2048;
export const MAX_USER_AGENT_READ = 512;

const SPACE = 32;
const QUOTE = 34;
const HASH = 35;
const SLASH = 47;
const QUESTION = 63;

/** Inteiro de `count` algarismos a partir de `at`, ou -1. */
function digits(text: string, at: number, count: number): number {
  let value = 0;
  for (let i = at; i < at + count; i += 1) {
    const digit = text.charCodeAt(i) - 48;
    if (!(digit >= 0 && digit <= 9)) return -1;
    value = value * 10 + digit;
  }
  return value;
}

/** `2026-11-24T10:00:00.123456Z` em milissegundos, ou -1. */
export function parseTime(text: string): number {
  const size = text.length;
  if (size < 20 || size > 30 || text.charCodeAt(size - 1) !== 90) return -1;
  if (text[4] !== '-' || text[7] !== '-' || text[10] !== 'T' || text[13] !== ':' || text[16] !== ':')
    return -1;
  const year = digits(text, 0, 4);
  const month = digits(text, 5, 2);
  const day = digits(text, 8, 2);
  const hour = digits(text, 11, 2);
  const minute = digits(text, 14, 2);
  const second = digits(text, 17, 2);
  if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return -1;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 60) return -1;
  let millis = 0;
  if (size > 20) {
    if (text.charCodeAt(19) !== 46) return -1;
    let scale = 100;
    for (let i = 20; i < size - 1; i += 1) {
      const digit = text.charCodeAt(i) - 48;
      if (!(digit >= 0 && digit <= 9)) return -1;
      millis += digit * Math.floor(scale);
      scale /= 10;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis);
}

/** Código HTTP de três algarismos; 0 para `-`; -1 se não for nada disso. */
function parseStatus(text: string): number {
  if (text === '-') return 0;
  return text.length === 3 ? decimal(text, 3) : -1;
}

/** O endereço de `cliente:porta`: a porta é o que vem depois do **último** dois-pontos (IPv6 sem colchetes). */
function hostOfPort(text: string): string | null {
  const colon = text.lastIndexOf(':');
  if (colon <= 0 || decimal(text.slice(colon + 1), 5) < 0) return null;
  const host = text.slice(0, colon);
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

interface RequestPart {
  method: string | null;
  path: string | null;
  hasQuery: boolean;
}

const NO_REQUEST: RequestPart = { method: null, path: null, hasQuery: false };

/** Método fora do comum, longo demais para guardar: a requisição é analisada do mesmo jeito. */
export const ODD_METHOD = 'OTHER';

/**
 * Método e caminho, a partir da posição depois da aspa. Lê só até o espaço (uma URL não tem espaço cru) ou a aspa do
 * fim, então não depende de achar a fronteira certa do campo. Método estranho não é motivo para perder o caminho (há
 * servidor que trata método desconhecido como GET); só o `-` sozinho é a requisição malformada.
 */
function readRequest(line: string, from: number): RequestPart {
  const gap = line.indexOf(' ', from);
  if (gap <= from) return NO_REQUEST;
  const method = gap - from > 32 ? ODD_METHOD : line.slice(from, gap);
  if (method === '-') return NO_REQUEST;
  const url = gap + 1;
  let end = line.indexOf(' ', url);
  if (end < 0) end = line.length;
  // A URL sem versão do protocolo termina na própria aspa.
  if (end > url && line.charCodeAt(end - 1) === QUOTE) end -= 1;

  let start = url;
  if (line.charCodeAt(url) !== SLASH) {
    let scheme = url;
    while (scheme < end && isAlpha(line.charCodeAt(scheme))) scheme += 1;
    // `OPTIONS *`, `CONNECT host:443`: sem caminho.
    if (scheme === url || !line.startsWith('://', scheme)) return { method, path: null, hasQuery: false };
    start = scheme + 3;
    while (start < end && line.charCodeAt(start) !== SLASH && line.charCodeAt(start) !== QUESTION) start += 1;
    // `https://host` e `https://host?x=1`: a raiz.
    if (start >= end) return { method, path: '/', hasQuery: false };
    if (line.charCodeAt(start) === QUESTION) return { method, path: '/', hasQuery: true };
  }
  let stop = start;
  while (stop < end && line.charCodeAt(stop) !== QUESTION && line.charCodeAt(stop) !== HASH) stop += 1;
  return {
    method,
    path: line.slice(start, Math.min(stop, start + MAX_PATH_READ)),
    hasQuery: stop < end && line.charCodeAt(stop) === QUESTION,
  };
}

const isDomainChar = (code: number): boolean => isAlnum(code) || code === 45 || code === 46 || code === 95;

/** O SNI em minúsculas, se tem forma de nome de host. */
function domainOf(text: string): string | null {
  if (text === '-' || text.length > 253 || !every(text, isDomainChar)) return null;
  return text.toLowerCase();
}

interface Tail {
  domain: string;
  actions: string;
}

/** Uma linha legítima tem cerca de 22 campos na cauda; mais que isto é injeção. */
const MAX_TAIL_FIELDS = 64;
/** Começo e fim de cada campo da cauda. Reusados a cada linha (nada aqui é assíncrono). */
const starts = new Int32Array(MAX_TAIL_FIELDS);
const ends = new Int32Array(MAX_TAIL_FIELDS);
const quotedAt = new Uint8Array(MAX_TAIL_FIELDS);

/** O campo é `-` ou um inteiro de até 6 algarismos. */
function isPriority(line: string, from: number, to: number): boolean {
  if (to - from === 1 && line.charCodeAt(from) === 45) return true;
  return to - from >= 1 && to - from <= 6 && digits(line, from, to - from) >= 0;
}

/** Os campos 15 em diante, se a leitura é a única possível; null se há dúvida. */
function readTail(line: string, from: number): Tail | null {
  let count = 0;
  let at = from;
  while (at < line.length) {
    if (count === MAX_TAIL_FIELDS) return null;
    if (line.charCodeAt(at) === QUOTE) {
      const close = line.indexOf('"', at + 1);
      if (close < 0) return null;
      if (close + 1 < line.length && line.charCodeAt(close + 1) !== SPACE) return null;
      starts[count] = at + 1;
      ends[count] = close;
      quotedAt[count] = 1;
      at = close + 2;
    } else {
      let end = at;
      while (end < line.length && line.charCodeAt(end) !== SPACE) {
        if (line.charCodeAt(end) === QUOTE) return null;
        end += 1;
      }
      if (end === at) return null;
      starts[count] = at;
      ends[count] = end;
      quotedAt[count] = 0;
      at = end + 1;
    }
    count += 1;
  }
  // 15 cifra, 16 protocolo, 17 target group, 18 "trace", 19 "domínio", 20 "certificado", 21 prioridade, 22 horário,
  // 23 "ações", 24 "redirecionamento", 25 "erro", 26 "alvos", 27 "status dos alvos", 28 "classificação", 29 "motivo".
  if (count < 15) return null;
  for (let i = 0; i < 15; i += 1) {
    const unquoted = i < 3 || i === 6 || i === 7;
    if ((quotedAt[i] === 0) !== unquoted) return null;
  }
  let anchors = 0;
  for (let i = 0; i + 2 < count; i += 1) {
    if (quotedAt[i] === 1 || quotedAt[i + 1] === 1 || quotedAt[i + 2] === 0) continue;
    if (!isPriority(line, starts[i] ?? 0, ends[i] ?? 0)) continue;
    if (parseTime(line.slice(starts[i + 1], ends[i + 1])) < 0) continue;
    if (i !== 6) return null;
    anchors += 1;
  }
  if (anchors !== 1) return null;
  return { domain: line.slice(starts[4], ends[4]), actions: line.slice(starts[8], ends[8]) };
}

/** A linha, ou null se nem o pedaço confiável serve (`malformed`). */
export function parseAlbLine(line: string): AlbLine | null {
  if (line.length > MAX_LINE_CHARS) return null;
  // Os 12 primeiros campos, separados por um espaço e sem aspas.
  let at = 0;
  let type = '';
  let loadBalancer = '';
  let clientIp: string | null = null;
  let timeMs = -1;
  let elbStatus = -1;
  let targetStatus = -1;
  let sentBytes = -1;
  for (let field = 1; field <= 12; field += 1) {
    const end = line.indexOf(' ', at);
    if (end < 0 || end - at > 256) return null;
    if (field === 1) type = line.slice(at, end);
    else if (field === 2) timeMs = parseTime(line.slice(at, end));
    else if (field === 3) loadBalancer = line.slice(at, end);
    else if (field === 4) clientIp = hostOfPort(line.slice(at, end));
    else if (field === 9) elbStatus = parseStatus(line.slice(at, end));
    else if (field === 10) targetStatus = parseStatus(line.slice(at, end));
    else if (field === 12) sentBytes = decimal(line.slice(at, end));
    at = end + 1;
  }
  if (type.length > 8 || !every(type, isAlnum)) return null;
  if (timeMs < 0 || clientIp === null || elbStatus < 0 || targetStatus < 0 || sentBytes < 0) return null;
  if (line.charCodeAt(at) !== QUOTE) return null;

  const request = readRequest(line, at + 1);
  const base = {
    type,
    timeMs,
    loadBalancer,
    clientIp,
    elbStatus,
    targetStatus,
    sentBytes,
    method: request.method,
    path: request.path,
    hasQuery: request.hasQuery,
  };

  // `"<requisição>" "<user agent>" <cauda>`
  const requestEnd = line.indexOf('"', at + 1);
  const agentStart = requestEnd + 3;
  const opened =
    requestEnd > 0 && line.charCodeAt(requestEnd + 1) === SPACE && line.charCodeAt(requestEnd + 2) === QUOTE;
  const agentEnd = opened ? line.indexOf('"', agentStart) : -1;
  const agent =
    agentEnd < 0 ? '' : line.slice(agentStart, Math.min(agentEnd, agentStart + MAX_USER_AGENT_READ));
  const userAgent = agent === '-' ? '' : agent;
  const closed = agentEnd > 0 && line.charCodeAt(agentEnd + 1) === SPACE;
  // A barra invertida pode ser o escape de uma aspa: com ela, a fronteira dos campos é incerta.
  const tail = closed && !line.includes('\\') ? readTail(line, agentEnd + 2) : null;
  if (tail === null) return { ...base, userAgent, domainName: null, blocked: false, ambiguous: true };
  const comma = tail.actions.lastIndexOf(',');
  return {
    ...base,
    userAgent,
    domainName: domainOf(tail.domain),
    blocked: tail.actions.slice(comma + 1) === 'waf',
    ambiguous: false,
  };
}

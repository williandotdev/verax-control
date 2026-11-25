/**
 * Máscara de segredo e de dado pessoal nas URLs do evento bruto (o WAF, os logs de acesso): `httpRequest.uri`,
 * `httpRequest.args`, `Referer`, `Location` e o que mais carrega uma URL com query. Sai mascarado só o VALOR que é, ou
 * parece, segredo ou dado pessoal; os nomes dos parâmetros, a estrutura e o ataque (SQL injection, XSS, travessia de
 * diretório) seguem legíveis para o analista.
 *
 * O que é mascarado:
 * - o valor do parâmetro com nome de segredo (`token`, `code`, `senha`, `session`, `X-Amz-Signature`...), inteiro; se ele
 *   parece um ataque, o marcador diz qual, sem mostrar o valor;
 * - o valor do parâmetro com nome de dado pessoal (`email`, `cpf`, `telefone`...), inteiro; se ele parece um ataque, só
 *   os pedaços abaixo saem, e o resto fica visível;
 * - em qualquer valor, nome ou caminho: e-mail, CPF e CNPJ (com ou sem pontuação, e o CNPJ com letras), celular com o
 *   55, cartão (Luhn), JWT, UUID, valor longo e aleatório, `usuario:senha@` de URL e os pares `nome=valor` ou
 *   `"nome":"valor"` aninhados (a URL dentro da URL, o JSON num parâmetro, `;jsessionid=` no caminho);
 * - o trecho que não decodifica (`%` solto, bytes que não são UTF-8), que pode esconder qualquer coisa: fecha mascarado.
 *   A codificação em camadas (até 3), o `%uXXXX` e o UTF-8 mais longo que o preciso (`%c0%af`) são decodificados.
 *
 * Tudo é varredura de caracteres em tempo linear, sem expressão regular sobre o texto hostil, com o tamanho limitado.
 *
 * Limites conhecidos (a máscara reduz a exposição; não é prova de que nada pessoal sobra):
 * - segredo sem nome, com menos de 20 caracteres, ou só de letras, não tem como ser visto (`/convite/abcdefgh`); nem
 *   nome de pessoa, endereço ou texto livre num parâmetro de nome neutro (`q=`, `busca=`);
 * - no texto solto (um SQL, um HTML), o valor de `senha=` sem aspas vai até o primeiro espaço, vírgula ou parêntese; e
 *   os escapes de HTML e de JavaScript (`&#64;`, `\u0040`) não são abertos;
 * - o contrário também acontece: um id aleatório que não é segredo, um número de 11 ou 14 dígitos ou um literal
 *   hexadecimal longo de um ataque sai mascarado; o resto do ataque continua visível;
 * - o corpo da requisição não está no log do WAF, e os trechos de `matchedData` são vistos um a um, sem o nome do
 *   parâmetro.
 */

export const REDACTED = '[removido]';
export const TRUNCATED = '[truncado]';
/** Maior texto varrido; o que passa disso é cortado num separador. */
export const MAX_URL_LENGTH = 16_384;
/** Camadas de codificação abertas; um valor com mais que isto é mascarado. */
const MAX_DECODE_LAYERS = 3;
/** Nome de parâmetro que vale a pena olhar (do fim para trás, se for maior). */
const MAX_NAME_LENGTH = 128;

/** Por que o trecho saiu: o marcador diz, e nunca leva nada do valor. O maior vale quando dois se juntam. */
const Mask = { None: 0, Value: 1, Traversal: 2, Xss: 3, Sql: 4, Undecodable: 5 } as const;
type Mask = (typeof Mask)[keyof typeof Mask];
const MARKERS: readonly string[] = [
  '',
  REDACTED,
  '[removido: parece travessia de diretório]',
  '[removido: parece XSS]',
  '[removido: parece SQL injection]',
  '[removido: codificação inválida]',
];

// ---- caracteres ----

const isDigit = (c: number) => c >= 48 && c <= 57;
const isUpper = (c: number) => c >= 65 && c <= 90;
const isLower = (c: number) => c >= 97 && c <= 122;
const isLetter = (c: number) => isUpper(c) || isLower(c);
const isAlnum = (c: number) => isDigit(c) || isLetter(c);
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 160;
const AMP = 38;
const AT = 64;
const BACKSLASH = 92;
const COLON = 58;
const DASH = 45;
const DOT = 46;
const EQUALS = 61;
const HASH = 35;
const PERCENT = 37;
const PLUS = 43;
const QUESTION = 63;
const SEMICOLON = 59;
const SLASH = 47;
const isQuote = (c: number) => c === 34 || c === 39 || c === 96;
const isAngle = (c: number) => c === 60 || c === 62;

/** Valor de um dígito hexadecimal, ou -1. */
function hexValue(c: number): number {
  if (isDigit(c)) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

// ---- nomes de parâmetro ----

const words = (list: string): readonly string[] => list.split(' ');

/** Palavra inteira do nome que diz que o valor é segredo. */
const SECRET_WORDS = new Set(
  words(
    'auth authentication authorization autenticacao autorizacao assinatura bearer card cartao chave ' +
      'code codigo cookie credencial credential csrf cvc cvv hmac jwt key mfa oauth otp pass passphrase ' +
      'passwd password pin psw pwd secret segredo senha sess sessao session sid sig signature ticket ' +
      'token totp xsrf',
  ),
);
/** Pedaço do nome (só letras e números, em minúsculas) que já basta: os nomes colados (`PHPSESSID`, `userpassword`). */
const SECRET_PARTS = words(
  'accesscode accesskey apikey authcode authkey cookie credential passwd password privatekey samlre ' +
    'secret senha sessaoid sessid sessionid signature token',
);
const PERSONAL_WORDS = new Set(
  words(
    'birth birthdate birthday cel celular cep cnh cnpj cpf dob email endereco firstname fone fullname ' +
      'iban lastname mail mobile nascimento nome passaporte passport phone pis pix rg sobrenome ssn ' +
      'surname tel telefone telephone whatsapp',
  ),
);
const PERSONAL_PARTS = words('celular cnpj email firstname fullname lastname telefone phonenumber whatsapp');

/**
 * As palavras do nome, em minúsculas e sem acento: separadas pelo que não é letra, pela troca de minúscula para
 * maiúscula (`accessToken`) e pelos números (`senha2`), e o nome colado.
 */
function nameWords(name: string): { words: string[]; compact: string } {
  const text = name.slice(-MAX_NAME_LENGTH).normalize('NFD');
  const found: string[] = [];
  let word = '';
  let compact = '';
  let previousLower = false;
  const close = () => {
    if (word !== '') found.push(word);
    word = '';
  };
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    // Os acentos, soltos da letra pela normalização, não separam a palavra.
    if (c >= 0x300 && c <= 0x36f) continue;
    if (!isLetter(c)) {
      close();
      if (isDigit(c)) compact += text[i];
      previousLower = false;
      continue;
    }
    if (isUpper(c) && previousLower) close();
    const lower = String.fromCharCode(c | 32);
    word += lower;
    compact += lower;
    previousLower = isLower(c);
  }
  close();
  return { words: found, compact };
}

export type SensitiveName = 'secret' | 'personal';

/** O nome diz que o valor é segredo ou dado pessoal? */
export function sensitiveName(name: string): SensitiveName | null {
  const { words: own, compact } = nameWords(name);
  const anyWord = (set: ReadonlySet<string>) =>
    own.some((word) => set.has(word) || (word.endsWith('s') && set.has(word.slice(0, -1))));
  if (anyWord(SECRET_WORDS) || SECRET_PARTS.some((part) => compact.includes(part))) return 'secret';
  if (anyWord(PERSONAL_WORDS) || PERSONAL_PARTS.some((part) => compact.includes(part))) return 'personal';
  return null;
}

// ---- decodificação ----

/** Um texto e de onde veio cada caractere dele no texto original (`from` incluso, `to` fora). */
interface Layer {
  text: string;
  from: number[];
  to: number[];
}

function rawLayer(raw: string, start: number, end: number): Layer {
  const from: number[] = [];
  const to: number[] = [];
  for (let i = start; i < end; i += 1) {
    from.push(i);
    to.push(i + 1);
  }
  return { text: raw.slice(start, end), from, to };
}

interface Decoded {
  layer: Layer;
  /** Alguma sequência foi decodificada. */
  changed: boolean;
  /** Posições (no texto decodificado) do que não decodifica. */
  invalid: number[];
}

/** O byte `%XX` na posição, ou -1. */
function byteAt(text: string, index: number): number {
  if (text.charCodeAt(index) !== PERCENT) return -1;
  const high = hexValue(text.charCodeAt(index + 1));
  const low = hexValue(text.charCodeAt(index + 2));
  return high < 0 || low < 0 ? -1 : high * 16 + low;
}

/** O caractere UTF-8 que começa no `%XX` da posição (mais longo que o preciso também vale), ou null. */
function utf8At(text: string, index: number): { code: number; length: number } | null {
  const lead = byteAt(text, index);
  if (lead < 0) return null;
  if (lead < 0x80) return { code: lead, length: 3 };
  const extra =
    lead >= 0xc0 && lead < 0xe0 ? 1 : lead >= 0xe0 && lead < 0xf0 ? 2 : lead >= 0xf0 && lead < 0xf8 ? 3 : 0;
  if (extra === 0) return null;
  let code = lead & (0x3f >> extra);
  for (let i = 1; i <= extra; i += 1) {
    const next = byteAt(text, index + i * 3);
    if (next < 0x80 || next > 0xbf) return null;
    code = code * 64 + (next & 0x3f);
  }
  if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null;
  return { code, length: (extra + 1) * 3 };
}

/** O `%uXXXX` (de IIS) na posição, ou -1. */
function unicodeEscapeAt(text: string, index: number): number {
  if ((text.charCodeAt(index + 1) | 32) !== 117) return -1;
  let code = 0;
  for (let i = 2; i < 6; i += 1) {
    const digit = hexValue(text.charCodeAt(index + i));
    if (digit < 0) return -1;
    code = code * 16 + digit;
  }
  return code;
}

function decode({ text, from, to }: Layer): Decoded {
  const out: Layer = { text: '', from: [], to: [] };
  const chars: string[] = [];
  const invalid: number[] = [];
  let changed = false;
  const emit = (char: string, start: number, length: number) => {
    for (const unit of char.length === 1 ? [char] : char.split('')) {
      chars.push(unit);
      out.from.push(from[start] as number);
      out.to.push(to[start + length - 1] as number);
    }
  };
  for (let i = 0; i < text.length;) {
    if (text.charCodeAt(i) !== PERCENT) {
      emit(text.charAt(i), i, 1);
      i += 1;
      continue;
    }
    const escape = unicodeEscapeAt(text, i);
    const utf8 = escape < 0 ? utf8At(text, i) : null;
    if (escape >= 0) {
      emit(String.fromCharCode(escape), i, 6);
      i += 6;
      changed = true;
    } else if (utf8 !== null) {
      emit(String.fromCodePoint(utf8.code), i, utf8.length);
      i += utf8.length;
      changed = true;
    } else {
      invalid.push(chars.length);
      emit('%', i, 1);
      i += 1;
    }
  }
  out.text = chars.join('');
  return { layer: out, changed, invalid };
}

/** O texto com os escapes que decodificam trocados por nulos, no mesmo tamanho: eles separam, e nunca fazem parte. */
function withoutEscapes(text: string): string {
  const parts: string[] = [];
  for (let i = 0; i < text.length;) {
    const length =
      text.charCodeAt(i) !== PERCENT ? 0 : unicodeEscapeAt(text, i) >= 0 ? 6 : (utf8At(text, i)?.length ?? 0);
    parts.push(length > 0 ? '\u0000'.repeat(length) : text.charAt(i));
    i += Math.max(1, length);
  }
  return parts.join('');
}

/** Todas as camadas do trecho, da crua à mais aberta; `tooDeep` se ainda sobrou codificação. */
function layersOf(raw: string, start: number, end: number) {
  const layers: Layer[] = [rawLayer(raw, start, end)];
  let invalid: number[] = [];
  let tooDeep = false;
  for (let depth = 0; depth <= MAX_DECODE_LAYERS; depth += 1) {
    const decoded = decode(layers[layers.length - 1] as Layer);
    // Só a primeira camada precisa decodificar inteira: o `%` que sobra depois dela é um `%` de verdade (`100%25`).
    if (depth === 0) invalid = decoded.invalid;
    if (!decoded.changed && (depth > 0 || decoded.invalid.length === 0)) break;
    if (depth === MAX_DECODE_LAYERS) {
      tooDeep = decoded.changed;
      break;
    }
    layers.push(decoded.layer);
    if (!decoded.changed) break;
  }
  return { layers, invalid, tooDeep };
}

// ---- ataque ----

const SQL_SIGNS = [
  "' or",
  '" or',
  "' and",
  '" and',
  "'='",
  "'--",
  ' or 1=',
  ' and 1=',
  'union select',
  'union all select',
  'insert into',
  'drop table',
  'sleep(',
  'benchmark(',
  'waitfor delay',
  'information_schema',
  '; --',
  ';--',
  '/**/',
] as const;
const XSS_SIGNS = [
  '<script',
  '<svg',
  '<img',
  '<iframe',
  '<body',
  'javascript:',
  'onerror=',
  'onload=',
  '</',
] as const;
const TRAVERSAL_SIGNS = ['../', '..\\', '/etc/passwd', '\\win.ini'] as const;

/** O trecho parece um ataque? (Só palavras fixas, na camada mais aberta, com o `+` como espaço.) */
function attackIn(layers: readonly Pick<Layer, 'text'>[]): Mask {
  const text = (layers.at(-1)?.text ?? '').replaceAll('+', ' ').toLowerCase();
  if (XSS_SIGNS.some((sign) => text.includes(sign))) return Mask.Xss;
  if (SQL_SIGNS.some((sign) => text.includes(sign))) return Mask.Sql;
  if (text.includes('select ') && text.includes(' from ')) return Mask.Sql;
  if (TRAVERSAL_SIGNS.some((sign) => text.includes(sign))) return Mask.Traversal;
  return Mask.None;
}

// ---- o que é mascarado dentro de um valor ----

type Mark = (start: number, end: number, mask: Mask) => void;

const isNameChar = (c: number) =>
  isAlnum(c) || c === 95 || c === DASH || c === DOT || c === 91 || c === 93 || c === 36 || c > 160;
/** Entre o nome e o `=`: o espaço, as aspas do JSON e a barra que as escapa. */
const isGlue = (c: number) => isSpace(c) || c === PLUS || isQuote(c) || c === BACKSLASH;
const SCHEME_WORDS = new Set(['basic', 'bearer', 'digest', 'token', 'apikey']);

/** Fim do valor solto (sem aspas) num texto. */
function bareEnd(text: string, start: number): number {
  let i = start;
  for (; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (isSpace(c) || isQuote(c) || isAngle(c) || c === PLUS || c === AMP || c === SEMICOLON || c === 44)
      break;
    if (c === 41 || c === 93 || c === 125 || c === 124) break;
  }
  return i;
}

/** Fim do valor entre aspas que começa em `start` (depois da aspa): a aspa igual, não escapada; sem ela, o fim. */
function quotedEnd(text: string, start: number, quote: number, escaped: boolean): number {
  for (let i = start; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (escaped && c === BACKSLASH && text.charCodeAt(i + 1) === quote) return i;
    if (escaped) continue;
    if (c === BACKSLASH) i += 1;
    else if (c === quote) return i;
  }
  return text.length;
}

/** Entre o `=` e o valor: o espaço e o resto do operador (`==`, `=>`, `=~`). */
const isAssignGap = (c: number) => isSpace(c) || c === PLUS || c === EQUALS || c === 62 || c === 126;

/**
 * Começo e fim do valor de um par achado num texto, depois do `=` ou do `:`. O valor sem aspas acaba num separador, que
 * pode ainda estar codificado: ele só vale na camada mais aberta (`final`). Nas outras, null.
 */
function textValue(text: string, after: number, final: boolean): { start: number; end: number } | null {
  let start = after;
  while (start < text.length && isAssignGap(text.charCodeAt(start))) start += 1;
  const escaped = text.charCodeAt(start) === BACKSLASH;
  const quote = text.charCodeAt(escaped ? start + 1 : start);
  if (isQuote(quote)) {
    const inside = start + (escaped ? 2 : 1);
    return { start: inside, end: quotedEnd(text, inside, quote, escaped) };
  }
  if (!final) return null;
  let end = bareEnd(text, start);
  // `Authorization: Bearer abc`: a credencial é a palavra seguinte.
  if (SCHEME_WORDS.has(text.slice(start, Math.min(end, start + 8)).toLowerCase())) {
    let next = end;
    while (next < text.length && isAssignGap(text.charCodeAt(next))) next += 1;
    end = bareEnd(text, next);
  }
  return { start, end };
}

/**
 * Os pares aninhados: `nome=valor` e `nome:valor` com nome sensível. Depois de `?`, `&`, `;`, `#`, `/` ou no começo, é
 * uma URL: o valor vai até o próximo `&` (no caminho, até a `/`). No meio de um texto, o valor acaba nas aspas ou no
 * espaço, e o resto (o ataque) fica visível.
 */
function markPairs(text: string, inPath: boolean, final: boolean, mark: Mark): void {
  let nameStart = -1;
  let nameEnd = -1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (isNameChar(c)) {
      if (nameEnd !== i) nameStart = i;
      nameEnd = i + 1;
      continue;
    }
    if (c !== EQUALS && c !== COLON) {
      if (!isGlue(c) || i - nameEnd > 8) nameStart = -1;
      continue;
    }
    const start = nameStart;
    nameStart = -1;
    if (start < 0 || (c === COLON && text.charCodeAt(i + 1) === SLASH)) continue;
    if (sensitiveName(text.slice(Math.max(start, nameEnd - MAX_NAME_LENGTH), nameEnd)) === null) continue;
    const before = start === 0 ? AMP : text.charCodeAt(start - 1);
    let value: { start: number; end: number } | null;
    if ([AMP, QUESTION, SEMICOLON, HASH, SLASH].includes(before)) {
      let end = i + 1;
      while (
        end < text.length &&
        text.charCodeAt(end) !== AMP &&
        !(inPath && text.charCodeAt(end) === SLASH)
      ) {
        end += 1;
      }
      value = { start: i + 1, end };
    } else {
      value = textValue(text, i + 1, final);
    }
    if (value === null || value.end <= value.start) continue;
    const attack = attackIn([{ text: text.slice(value.start, value.end) }]);
    mark(value.start, value.end, attack === Mask.None ? Mask.Value : attack);
    // O par seguinte começa depois deste valor: cada caractere é visto uma vez.
    i = value.end - 1;
  }
}

/** `//usuario:senha@host`: o que vem antes da `@` sai; o host fica. Devolve as `@` que são de URL, e não de e-mail. */
function markUserinfo(text: string, mark: Mark): ReadonlySet<number> {
  const found = new Set<number>();
  for (let i = text.indexOf('//'); i >= 0;) {
    const start = i + 2;
    let end = start;
    let at = -1;
    for (; end < text.length; end += 1) {
      const c = text.charCodeAt(end);
      if (c === SLASH || c === QUESTION || c === HASH || c === BACKSLASH) break;
      if (isSpace(c) || isQuote(c) || isAngle(c)) break;
      if (c === AT) at = end;
    }
    if (at > start) {
      mark(start, at, Mask.Value);
      found.add(at);
    }
    i = text.indexOf('//', end);
  }
  return found;
}

const isLocalChar = (c: number) => isAlnum(c) || c === DOT || c === 95 || c === DASH || c > 160;
const isDomainChar = (c: number) => isAlnum(c) || c === DOT || c === DASH || c > 160;

function markEmails(text: string, inUrl: ReadonlySet<number>, mark: Mark): void {
  let floor = 0;
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    let start = at;
    // Um `+` só (`ana+loja@`): o resto, numa query, é espaço (`1+UNION+SELECT+a@b.example`).
    for (let plus = 0; start > floor; start -= 1) {
      const c = text.charCodeAt(start - 1);
      if (c === PLUS) plus += 1;
      if (plus > 1 || (c !== PLUS && !isLocalChar(c))) break;
    }
    floor = at + 1;
    let end = at + 1;
    while (end < text.length && isDomainChar(text.charCodeAt(end))) end += 1;
    // O ponto final da frase não é do domínio.
    while (end > at + 1 && !isAlnum(text.charCodeAt(end - 1)) && text.charCodeAt(end - 1) <= 160) end -= 1;
    let lastDot = end - 1;
    while (lastDot > at && text.charCodeAt(lastDot) !== DOT) lastDot -= 1;
    const label = lastDot > at + 1 ? text.slice(lastDot + 1, Math.min(end, lastDot + 3)) : '';
    const hasDomain = label.length === 2 && isLetter(label.charCodeAt(0)) && isLetter(label.charCodeAt(1));
    if (start < at && hasDomain && !inUrl.has(at)) mark(start, end, Mask.Value);
  }
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) digit = digit > 4 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

const distinctChars = (text: string) => new Set(text).size;

/** CNPJ com letras (de julho de 2026 em diante): 12 letras maiúsculas ou números e 2 dígitos verificadores. */
function isAlphanumericCnpj(piece: string): boolean {
  if (piece.length !== 14) return false;
  for (let i = 0; i < 14; i += 1) {
    const c = piece.charCodeAt(i);
    if (!isDigit(c) && (i >= 12 || !isUpper(c))) return false;
  }
  const digit = (length: number) => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += (piece.charCodeAt(i) - 48) * (((length - 1 - i) % 8) + 2);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return digit(12) === piece.charCodeAt(12) - 48 && digit(13) === piece.charCodeAt(13) - 48;
}

/** Números só de dígitos que parecem documento, cartão ou celular. */
function isPersonalNumber(digits: string): boolean {
  const { length } = digits;
  if (length === 11 || length === 14) return true;
  if (length === 13 && digits.startsWith('55')) return true;
  if (length >= 13 && length <= 19 && luhnValid(digits) && distinctChars(digits) > 1) return true;
  return length >= 15 && distinctChars(digits) >= 4;
}

/** Um pedaço só de letras e números, com o separador que veio antes dele (0 se não foi um só). */
interface Piece {
  start: number;
  end: number;
  joiner: number;
  digits: boolean;
  hex: boolean;
  /** Letras e números misturados (pelo menos duas trocas): o tamanho; senão, zero. */
  weight: number;
  /** Não é palavra nem número: mistura letras e números, ou maiúsculas e minúsculas fora do lugar. */
  irregular: boolean;
}

function piecesOf(text: string): Piece[] {
  const pieces: Piece[] = [];
  for (let i = 0; i < text.length;) {
    if (!isAlnum(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    let switches = 0;
    let uppers = 0;
    let lowers = 0;
    let hex = true;
    for (; i < text.length && isAlnum(text.charCodeAt(i)); i += 1) {
      const c = text.charCodeAt(i);
      if (isUpper(c)) uppers += 1;
      else if (isLower(c)) lowers += 1;
      if (hexValue(c) < 0) hex = false;
      if (i > start && isDigit(c) !== isDigit(text.charCodeAt(i - 1))) switches += 1;
    }
    const size = i - start;
    const capitalized = uppers === 1 && isUpper(text.charCodeAt(start));
    const last = pieces[pieces.length - 1];
    pieces.push({
      start,
      end: i,
      joiner: last !== undefined && start - last.end === 1 ? text.charCodeAt(start - 1) : 0,
      digits: uppers + lowers === 0,
      hex,
      weight: switches >= 2 ? size : 0,
      irregular: switches > 0 || (uppers > 0 && lowers > 0 && !(capitalized && lowers === size - 1)),
    });
  }
  return pieces;
}

/** Os tamanhos e separadores de um número formatado: CPF, CNPJ (com ou sem letras). */
const FORMATTED = [
  { sizes: [3, 3, 3, 2], joiners: ['.', '.', '-/'], letters: false },
  { sizes: [9, 2], joiners: ['-/'], letters: false },
  { sizes: [2, 3, 3, 4, 2], joiners: ['.', '.', '/', '-'], letters: true },
  { sizes: [8, 4, 2], joiners: ['/', '-'], letters: true },
  { sizes: [12, 2], joiners: ['-'], letters: false },
] as const;

/** O fim do número formatado que começa no pedaço, ou -1. */
function formattedNumberEnd(text: string, pieces: readonly Piece[], index: number): number {
  for (const { sizes, joiners, letters } of FORMATTED) {
    const fits = sizes.every((size, offset) => {
      const piece = pieces[index + offset];
      if (piece === undefined || piece.end - piece.start !== size) return false;
      if (offset > 0 && !(joiners[offset - 1] as string).includes(String.fromCharCode(piece.joiner)))
        return false;
      if (piece.digits) return true;
      if (!letters || offset === sizes.length - 1) return false;
      for (let i = piece.start; i < piece.end; i += 1) if (isLower(text.charCodeAt(i))) return false;
      return true;
    });
    if (fits) return (pieces[index + sizes.length - 1] as Piece).end;
  }
  return -1;
}

const UUID_SIZES = [8, 4, 4, 4, 12] as const;

function isUuidAt(pieces: readonly Piece[], index: number): boolean {
  return UUID_SIZES.every((size, offset) => {
    const piece = pieces[index + offset];
    return (
      piece !== undefined &&
      piece.hex &&
      piece.end - piece.start === size &&
      (offset === 0 || piece.joiner === DASH)
    );
  });
}

/** Os separadores de um valor aleatório (base64, base64url): o valor segue depois deles. */
const isTokenJoiner = (c: number) =>
  c === DASH || c === 95 || c === PLUS || c === SLASH || c === EQUALS || c === 126;

/** Menor JWT: o cabeçalho `{"alg":"none"}` já passa disto. */
const JWT_MIN_LENGTH = 16;
const isJwtChar = (c: number, inPath: boolean) =>
  isAlnum(c) || c === DOT || (isTokenJoiner(c) && !(inPath && c === SLASH));

/** Documentos, cartões, JWT, UUID e valores longos e aleatórios. */
function markTokens(text: string, inPath: boolean, mark: Mark): void {
  const pieces = piecesOf(text);
  let jwtEnd = 0;
  for (const [index, piece] of pieces.entries()) {
    const value = text.slice(piece.start, piece.end);
    const formatted = formattedNumberEnd(text, pieces, index);
    if (formatted > 0) mark(piece.start, formatted, Mask.Value);
    if (isUuidAt(pieces, index)) mark(piece.start, (pieces[index + 4] as Piece).end, Mask.Value);
    if ((piece.digits && isPersonalNumber(value)) || isAlphanumericCnpj(value)) {
      mark(piece.start, piece.end, Mask.Value);
    }
    // Um documento colado em letras (`cpf12345678909`): a sequência de dígitos conta sozinha.
    if (!piece.digits) markDigitRuns(text, piece, mark);
    if (value.startsWith('eyJ') && piece.start >= jwtEnd) {
      jwtEnd = piece.end;
      while (jwtEnd < text.length && isJwtChar(text.charCodeAt(jwtEnd), inPath)) jwtEnd += 1;
      if (jwtEnd - piece.start >= JWT_MIN_LENGTH) mark(piece.start, jwtEnd, Mask.Value);
    }
  }
  markRandom(text, pieces, mark);
}

function markDigitRuns(text: string, piece: Piece, mark: Mark): void {
  for (let i = piece.start; i < piece.end;) {
    if (!isDigit(text.charCodeAt(i))) {
      i += 1;
      continue;
    }
    const start = i;
    while (i < piece.end && isDigit(text.charCodeAt(i))) i += 1;
    if (isPersonalNumber(text.slice(start, i))) mark(start, i, Mask.Value);
  }
}

/** Tamanho mínimo, e o quanto dele tem de ser de pedaços misturados, para um valor contar como aleatório. */
const RANDOM_MIN_LENGTH = 20;
const RANDOM_MIN_WEIGHT = 16;
const RANDOM_MIN_SHARE = 0.6;
const RANDOM_MIN_DISTINCT = 8;

/** O trecho entre dois pedaços, com os vizinhos ligados que não são palavra nem número (as pontas do base64). Devolve o último. */
function markWithEdges(
  text: string,
  pieces: readonly Piece[],
  first: number,
  last: number,
  mark: Mark,
): number {
  let from = first;
  let to = last;
  while (from > 0 && isTokenJoiner((pieces[from] as Piece).joiner) && (pieces[from - 1] as Piece).irregular)
    from -= 1;
  for (;;) {
    const next = pieces[to + 1];
    if (next === undefined || !isTokenJoiner(next.joiner) || !next.irregular) break;
    to += 1;
  }
  let { end } = pieces[to] as Piece;
  while (text.charCodeAt(end) === EQUALS) end += 1;
  mark((pieces[from] as Piece).start, end, Mask.Value);
  return to;
}

/**
 * Valores longos e aleatórios: um pedaço misturado de 20 ou mais, ou vários ligados por um separador só, com pelo menos
 * 60% de pedaços misturados. Palavras ligadas (`information_schema`, `1+UNION+ALL+SELECT`) não têm pedaço misturado.
 */
function markRandom(text: string, pieces: readonly Piece[], mark: Mark): void {
  let first = -1;
  let last = -1;
  let weight = 0;
  let length = 0;
  let lengthAtLast = 0;
  // O pedaço até onde o último trecho já foi marcado: nenhum é visto duas vezes.
  let coveredTo = -1;
  const close = () => {
    if (first >= 0) {
      const { start } = pieces[first] as Piece;
      const { end } = pieces[last] as Piece;
      const random =
        end - start >= RANDOM_MIN_LENGTH &&
        weight >= RANDOM_MIN_WEIGHT &&
        weight / lengthAtLast >= RANDOM_MIN_SHARE &&
        distinctChars(text.slice(start, end)) >= RANDOM_MIN_DISTINCT;
      if (random) markWithEdges(text, pieces, first, last, mark);
    }
    first = -1;
    weight = 0;
    length = 0;
  };
  for (const [index, piece] of pieces.entries()) {
    const size = piece.end - piece.start;
    if (first >= 0 && !isTokenJoiner(piece.joiner)) close();
    const alone = piece.weight >= RANDOM_MIN_LENGTH && index > coveredTo;
    if (alone && distinctChars(text.slice(piece.start, piece.end)) >= RANDOM_MIN_DISTINCT) {
      coveredTo = markWithEdges(text, pieces, index, index, mark);
    }
    if (first < 0 && piece.weight === 0) continue;
    if (first < 0) first = index;
    length += size;
    weight += piece.weight;
    if (piece.weight > 0) {
      last = index;
      lengthAtLast = length;
    } else if (length - lengthAtLast > weight) {
      // Palavras demais depois do último pedaço misturado: o que vier é outro trecho.
      close();
    }
  }
  close();
}

/** O trecho sem espaço, aspas ou `<>` (no caminho, sem `/`) em volta do que não decodifica. */
function markInvalid(text: string, invalid: readonly number[], inPath: boolean, mark: Mark): void {
  if (invalid.length === 0) return;
  const bad = new Set(invalid);
  let start = 0;
  let hasBad = false;
  for (let i = 0; i <= text.length; i += 1) {
    const c = i < text.length ? text.charCodeAt(i) : 32;
    if (isSpace(c) || isQuote(c) || isAngle(c) || c === PLUS || (inPath && c === SLASH)) {
      if (hasBad) mark(start, i, Mask.Undecodable);
      start = i + 1;
      hasBad = false;
    } else if (bad.has(i)) {
      hasBad = true;
    }
  }
}

// ---- o texto inteiro ----

/** Um texto em que se marcam trechos; no fim, cada trecho marcado vira um marcador. */
class Masker {
  private readonly marks: Uint8Array;

  constructor(private readonly raw: string) {
    this.marks = new Uint8Array(raw.length);
  }

  mark(start: number, end: number, mask: Mask): void {
    for (let i = start; i < end; i += 1) {
      if (mask > (this.marks[i] as number)) this.marks[i] = mask;
    }
  }

  /** Um valor solto (ou o caminho): o que parece segredo ou dado pessoal sai. */
  scan(start: number, end: number, inPath = false): void {
    if (end <= start) return;
    const { layers, invalid, tooDeep } = layersOf(this.raw, start, end);
    if (tooDeep) {
      // No caminho, só o segmento que não abre; um valor, inteiro.
      const slash = inPath ? this.raw.indexOf('/', start) : -1;
      if (slash < 0 || slash >= end) this.mark(start, end, Mask.Undecodable);
      else this.segments(start, end);
      return;
    }
    for (const [depth, layer] of layers.entries()) {
      const mark: Mark = (from, to, mask) =>
        this.mark(layer.from[from] as number, layer.to[to - 1] as number, mask);
      const final = depth === layers.length - 1;
      markPairs(layer.text, inPath, final, mark);
      const inUrl = markUserinfo(layer.text, mark);
      // Nas camadas ainda codificadas, os números dos escapes (`%20`) não são parte do valor.
      const text = final ? layer.text : withoutEscapes(layer.text);
      markEmails(text, inUrl, mark);
      markTokens(text, inPath, mark);
      if (depth === 1) markInvalid(layer.text, invalid, inPath, mark);
    }
  }

  private segments(start: number, end: number): void {
    for (let segment = start; segment < end;) {
      let stop = this.raw.indexOf('/', segment);
      if (stop < 0 || stop > end) stop = end;
      this.scan(segment, stop, true);
      segment = stop + 1;
    }
  }

  /** A query: cada `nome=valor` entre `&`. */
  query(start: number, end: number): void {
    // O próximo `=` só é procurado de novo depois de passar por ele.
    let equals = -1;
    for (let unit = start; unit <= end;) {
      let stop = this.raw.indexOf('&', unit);
      if (stop < 0 || stop > end) stop = end;
      if (equals < unit) {
        equals = this.raw.indexOf('=', unit);
        if (equals < 0) equals = this.raw.length;
      }
      if (equals >= stop) this.scan(unit, stop);
      else this.pair(unit, equals, stop);
      unit = stop + 1;
    }
  }

  private pair(start: number, equals: number, end: number): void {
    this.scan(start, equals);
    const name = layersOf(this.raw, start, equals);
    const kinds = name.layers.map((layer) => sensitiveName(layer.text));
    // Um nome que não decodifica pode ser qualquer um.
    const unknown = name.tooDeep || name.invalid.length > 0;
    if (unknown) this.mark(equals + 1, end, Mask.Undecodable);
    if (kinds.includes('secret')) {
      const attack = attackIn(layersOf(this.raw, equals + 1, end).layers);
      this.mark(equals + 1, end, attack === Mask.None ? Mask.Value : attack);
    } else if (
      kinds.includes('personal') &&
      attackIn(layersOf(this.raw, equals + 1, end).layers) === Mask.None
    ) {
      this.mark(equals + 1, end, Mask.Value);
    } else {
      this.scan(equals + 1, end);
    }
  }

  result(): string {
    let out = '';
    for (let i = 0; i < this.raw.length;) {
      const start = i;
      let mask = this.marks[i] as number;
      const masked = mask !== Mask.None;
      while (i < this.raw.length && ((this.marks[i] as number) !== Mask.None) === masked) {
        mask = Math.max(mask, this.marks[i] as number);
        i += 1;
      }
      out += masked ? (MARKERS[mask] as string) : this.raw.slice(start, i);
    }
    return out;
  }
}

/** Corta o texto longo demais no último separador antes do limite: o que ficaria pela metade não sai. */
function bounded(text: string): { text: string; suffix: string } {
  if (text.length <= MAX_URL_LENGTH) return { text, suffix: '' };
  let end = MAX_URL_LENGTH;
  while (end > 0) {
    const c = text.charCodeAt(end);
    if (c === AMP || c === SLASH || isSpace(c)) break;
    end -= 1;
  }
  return { text: text.slice(0, end), suffix: TRUNCATED };
}

/** Uma query (`httpRequest.args`): `a=1&token=x` vira `a=1&token=[removido]`. */
export function maskQuery(value: string): string {
  const { text, suffix } = bounded(value);
  const masker = new Masker(text);
  masker.query(0, text.length);
  return masker.result() + suffix;
}

/** Uma URL, um caminho ou uma linha de requisição (`httpRequest.uri`, `Referer`, `Location`). */
export function maskUrl(value: string): string {
  const { text, suffix } = bounded(value);
  const masker = new Masker(text);
  const question = text.indexOf('?');
  const pathEnd = question < 0 ? text.length : question;
  masker.scan(0, pathEnd, true);
  if (question >= 0) masker.query(question + 1, text.length);
  return masker.result() + suffix;
}

const startsAsUrl = (text: string) =>
  text.startsWith('/') || text.startsWith('http://') || text.startsWith('https://');

/** O trecho é uma URL com query (`/` antes do `?` e `=` depois), ou com `usuario:senha@`? */
function carriesUrl(text: string): boolean {
  const question = text.indexOf('?');
  if (question >= 0 && text.lastIndexOf('/', question) >= 0 && text.indexOf('=', question) > 0) return true;
  const scheme = text.indexOf('://');
  return scheme >= 0 && text.indexOf('@', scheme) > 0;
}

/**
 * Um texto qualquer do evento: se ele é uma URL com query, sai mascarado inteiro; se só cita uma, sai mascarada a URL
 * (até o espaço, as aspas ou o `<>`), e o resto do texto fica como está.
 */
export function maskEmbeddedUrls(value: string): string {
  if (!value.includes('/') || (!value.includes('?') && !value.includes('@'))) return value;
  if (startsAsUrl(value)) return carriesUrl(value) ? maskUrl(value) : value;
  let out = '';
  for (let i = 0; i < value.length;) {
    const start = i;
    const delimiter = isUrlDelimiter(value.charCodeAt(i));
    while (i < value.length && isUrlDelimiter(value.charCodeAt(i)) === delimiter) i += 1;
    const part = value.slice(start, i);
    out += !delimiter && carriesUrl(part) ? maskUrl(part) : part;
  }
  return out;
}

const isUrlDelimiter = (c: number) => isSpace(c) || isQuote(c) || isAngle(c);

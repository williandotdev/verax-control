import { every, hexValue, isAlnum, isAlpha, isDigit, isHex, isLower, isUpper } from './ascii.js';

/**
 * O caminho de uma requisição, em duas formas:
 *
 * - **normalizada**, só na memória, para casar com as listas de sondas e de rotas de login: decodificada uma vez,
 *   minúscula, `\` como `/`, sem barra repetida, `.`/`..` resolvidos, e cada segmento sem parâmetro de matriz
 *   (`;jsessionid=...`), sem espaço ou ponto no fim e cortado no NUL e no `?` ou `#` codificado. O caminho **continua** depois
 *   deles: cortá-lo ali faria `/%3F/../.env` parecer a página inicial, e há servidor que entrega o `/.env`;
 * - **mascarada**, a única que sai do motor: até 8 segmentos e 256 caracteres, com o que pode ser dado pessoal, segredo ou
 *   texto do atacante trocado por `{num}`, `{uuid}`, `{hex}`, `{email}` ou `{token}`. Na dúvida, mascara: um caminho
 *   ilegível custa menos que um token de redefinição de senha gravado.
 *
 * A query string nem chega aqui (`alb-line.ts` corta no `?`).
 *
 * **Limite:** um nome próprio num segmento comum (`/fulano-de-tal`) não é reconhecível e passa, se não vier depois de uma
 * palavra de pessoa (`/usuarios/<x>`) ou de segredo (`/reset/<x>`).
 */
export interface NormalPath {
  /** Minúsculos: é o que se compara. */
  segments: readonly string[];
  /** Com as maiúsculas de origem: é o que se mascara (a entropia depende delas). */
  cased: readonly string[];
  /** Os que vieram depois de um `?` ou `#` codificado: podem ser uma query, e saem mascarados inteiros. */
  hidden: readonly boolean[];
}

const MAX_SEGMENTS = 64;
export const MAX_MASKED_SEGMENTS = 8;
export const MAX_MASKED_CHARS = 256;

/** Decodifica `%XX` uma vez; a sequência inválida fica como está. Cada byte vira um caractere (latin1). */
export function decodeOnce(text: string): string {
  const first = text.indexOf('%');
  if (first < 0) return text;
  let out = text.slice(0, first);
  let i = first;
  while (i < text.length) {
    if (text.charCodeAt(i) === 37 && i + 2 < text.length) {
      const high = hexValue(text.charCodeAt(i + 1));
      const low = hexValue(text.charCodeAt(i + 2));
      if (high >= 0 && low >= 0) {
        out += String.fromCharCode(high * 16 + low);
        i += 3;
        continue;
      }
    }
    out += text.charAt(i);
    i += 1;
  }
  return out;
}

/** Corta o segmento no `;`, NUL, `?` ou `#` e tira espaço e ponto do fim (o Windows os ignora), menos em `.` e `..`. */
function cleanSegment(segment: string): string {
  let end = 0;
  while (end < segment.length && !isCut(segment.charCodeAt(end))) end += 1;
  let start = 0;
  while (start < end && segment.charCodeAt(start) <= 32) start += 1;
  while (end > start && segment.charCodeAt(end - 1) <= 32) end -= 1;
  const text = segment.slice(start, end);
  if (text === '.' || text === '..') return text;
  let stop = text.length;
  while (stop > 0 && (text.charCodeAt(stop - 1) === 46 || text.charCodeAt(stop - 1) <= 32)) stop -= 1;
  return text.slice(0, stop);
}

const isQueryMark = (code: number): boolean => code === 63 || code === 35;
const isCut = (code: number): boolean => code === 59 || code === 0 || isQueryMark(code);

export function normalizePath(raw: string): NormalPath {
  const text = decodeOnce(raw);
  const cased: string[] = [];
  const hidden: boolean[] = [];
  let afterQuery = false;
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    const code = i < text.length ? text.charCodeAt(i) : 47;
    if (code !== 47 && code !== 92) {
      afterQuery ||= isQueryMark(code);
      continue;
    }
    const segment = cleanSegment(text.slice(start, i));
    start = i + 1;
    if (segment === '..') {
      cased.pop();
      hidden.pop();
    } else if (segment !== '' && segment !== '.' && cased.length < MAX_SEGMENTS) {
      cased.push(segment);
      hidden.push(afterQuery);
    }
  }
  return { cased, hidden, segments: cased.map((segment) => segment.toLowerCase()) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Máscara
// ---------------------------------------------------------------------------------------------------------------------

/** O que pode vir depois delas é segredo ou identificador de pessoa, até o fim do caminho. */
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'reset',
  'forgot',
  'recover',
  'recovery',
  'recuperar',
  'redefinir',
  'esqueci',
  'verify',
  'verification',
  'verificar',
  'confirm',
  'confirmation',
  'confirmar',
  'activate',
  'activation',
  'ativar',
  'invite',
  'invites',
  'invitation',
  'invitations',
  'convite',
  'convites',
  'magic',
  'magiclink',
  'unsubscribe',
  'descadastrar',
  'token',
  'tokens',
  'otp',
  'code',
  'codigo',
  'share',
  'shared',
  'key',
  'keys',
  'apikey',
  'secret',
  'secrets',
  'session',
  'sessions',
  'ticket',
  'password',
  'passwords',
  'senha',
  'sso',
]);

/** O segmento logo depois delas identifica uma pessoa. */
const PERSON_WORDS: ReadonlySet<string> = new Set([
  'u',
  'user',
  'users',
  'usuario',
  'usuarios',
  'profile',
  'profiles',
  'perfil',
  'account',
  'accounts',
  'conta',
  'contas',
  'customer',
  'customers',
  'cliente',
  'clientes',
  'member',
  'members',
  'pessoa',
  'pessoas',
  'patient',
  'patients',
  'paciente',
  'pacientes',
  'aluno',
  'alunos',
  'cpf',
  'cnpj',
  'email',
  'emails',
  'phone',
  'telefone',
]);

/**
 * As mesmas palavras coladas noutra (`resetPassword`, `verifyEmail`, `getUser`): o segmento sem separador não se divide em
 * palavras, e um token curto depois dele passaria legível. Mascarar a mais (`presets`) é o lado barato do erro.
 */
const SECRET_STEMS = [
  'reset',
  'passw',
  'senha',
  'recover',
  'recuper',
  'redefin',
  'token',
  'verif',
  'confirm',
  'activat',
  'invit',
  'convite',
  'magic',
  'secret',
  'unsubscri',
  'descadastr',
  'apikey',
  'forgot',
] as const;
const PERSON_STEMS = ['user', 'usuario', 'customer', 'cliente', 'cpf', 'cnpj', 'email'] as const;

/** Palavras de rota que continuam legíveis depois das de cima. */
const ROUTE_WORDS: ReadonlySet<string> = new Set([
  ...SECRET_WORDS,
  ...PERSON_WORDS,
  'api',
  'auth',
  'oauth',
  'oauth2',
  'login',
  'logout',
  'logon',
  'signin',
  'signup',
  'register',
  'new',
  'edit',
  'set',
  'update',
  'create',
  'delete',
  'list',
  'search',
  'index',
  'request',
  'resend',
  'send',
  'status',
  'check',
  'validate',
  'callback',
  'refresh',
  'revoke',
  'introspect',
  'authorize',
  'done',
  'complete',
  'success',
  'error',
  'me',
  'mfa',
  'totp',
  'sms',
  'settings',
  'config',
  'public',
]);

const isSegmentChar = (code: number): boolean =>
  isAlnum(code) || code === 45 || code === 46 || code === 95 || code === 126;
const isSeparator = (code: number): boolean => code === 45 || code === 46 || code === 95 || code === 126;

/** As palavras do segmento (`reset-password`, `confirm.php`), em minúsculas. */
function words(segment: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i <= segment.length; i += 1) {
    if (i < segment.length && !isSeparator(segment.charCodeAt(i))) continue;
    if (i > start) out.push(segment.slice(start, i));
    start = i + 1;
  }
  return out;
}

const hasWord = (segment: string, set: ReadonlySet<string>, stems: readonly string[]): boolean =>
  words(segment).some((word) => set.has(word)) || stems.some((stem) => segment.includes(stem));

/** `v1`, `v10`: versão de API, legível em qualquer contexto. */
const isVersion = (segment: string): boolean =>
  segment.length <= 3 && segment.startsWith('v') && every(segment.slice(1), isDigit);

function isUuid(text: string): boolean {
  if (text.length !== 36) return false;
  for (let i = 0; i < 36; i += 1) {
    const dash = i === 8 || i === 13 || i === 18 || i === 23;
    if (dash ? text.charCodeAt(i) !== 45 : !isHex(text.charCodeAt(i))) return false;
  }
  return true;
}

interface Shape {
  digits: number;
  lower: number;
  upper: number;
  /** Minúscula seguida de maiúscula ou o contrário, e letra colada em algarismo: aleatoriedade. */
  flips: number;
}

function shapeOf(text: string): Shape {
  const shape: Shape = { digits: 0, lower: 0, upper: 0, flips: 0 };
  let previous = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    const kind = isDigit(code) ? 1 : isLower(code) ? 2 : isUpper(code) ? 3 : 0;
    if (kind === 1) shape.digits += 1;
    else if (kind === 2) shape.lower += 1;
    else if (kind === 3) shape.upper += 1;
    if (kind !== 0 && previous !== 0 && kind !== previous) shape.flips += 1;
    previous = kind;
  }
  return shape;
}

/** Um pedaço sem separador que parece aleatório. */
function isRandomPiece(piece: string): boolean {
  if (piece.length >= 20) return true;
  const { digits, lower, upper, flips } = shapeOf(piece);
  if (piece.length >= 6 && digits > 0 && lower > 0 && upper > 0) return true;
  return piece.length >= 10 && digits >= 2 && lower + upper >= 2 && flips >= 2;
}

/**
 * Troca por `{num}` cada grupo de algarismos com 5 ou mais (CPF, CNPJ, telefone, data, protocolo), contando os separados
 * por um único `.`, `-` ou `_`.
 */
function maskDigitGroups(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (!isDigit(text.charCodeAt(i))) {
      out += text.charAt(i);
      i += 1;
      continue;
    }
    let end = i;
    let digits = 0;
    while (end < text.length) {
      if (isDigit(text.charCodeAt(end))) {
        digits += 1;
        end += 1;
      } else if (isSeparator(text.charCodeAt(end)) && isDigit(text.charCodeAt(end + 1) || 0)) {
        end += 1;
      } else {
        break;
      }
    }
    out += digits >= 5 ? '{num}' : text.slice(i, end);
    i = end;
  }
  return out;
}

/** Um segmento, já decodificado, sem olhar os vizinhos. */
function maskAlone(segment: string): string {
  if (segment.includes('@')) return '{email}';
  // Fora do conjunto: `%` que sobrou (codificação dupla), `=`, `&`, `:`, chaves, não ASCII, controle, bidi.
  if (!every(segment, isSegmentChar)) return '{token}';
  if (every(segment, isDigit)) return '{num}';
  if (isUuid(segment)) return '{uuid}';
  if (segment.startsWith('eyJ') && segment.length >= 10) return '{token}';
  if (segment.length > 64) return '{token}';
  const hexOnly = every(segment, isHex);
  if (hexOnly && segment.length >= 16) return '{hex}';
  const pieces = words(segment);
  if (pieces.some(isRandomPiece)) {
    // `app.3f9a8c1d.js` fica legível; o resto que tem pedaço aleatório, não.
    return hexOnly ? '{hex}' : '{token}';
  }
  if (segment.length >= 20) {
    const { digits, lower, upper, flips } = shapeOf(segment);
    if (digits >= 3 && flips >= 4) return '{token}';
    if (upper >= 3 && lower >= 3 && flips >= 4) return '{token}';
  }
  const masked: string[] = [];
  let start = 0;
  for (let i = 0; i <= segment.length; i += 1) {
    if (i < segment.length && !isSeparator(segment.charCodeAt(i))) continue;
    const piece = segment.slice(start, i);
    const hex = piece.length >= 8 && every(piece, isHex) && !every(piece, isDigit) && !every(piece, isAlpha);
    masked.push(hex ? '{hex}' : piece, i < segment.length ? segment.charAt(i) : '');
    start = i + 1;
  }
  return maskDigitGroups(masked.join('')).toLowerCase();
}

/** Forma mascarada: `/api/v1/clientes/{token}/pedidos/{num}`. */
export function maskPath(path: NormalPath): string {
  const out: string[] = [];
  let secret = false;
  let person = false;
  const count = Math.min(path.cased.length, MAX_MASKED_SEGMENTS);
  for (let i = 0; i < count; i += 1) {
    const lower = path.segments[i] ?? '';
    const readable = ROUTE_WORDS.has(lower) || isVersion(lower) || isRouteName(lower);
    let masked = maskAlone(path.cased[i] ?? '');
    if (path.hidden[i] === true) masked = '{token}';
    else if ((secret || person) && !readable && !masked.startsWith('{')) masked = '{token}';
    // Pessoa vale só para o segmento seguinte; segredo, até o fim (o Django põe dois: `/reset/<uid>/<token>/`).
    person = hasWord(lower, PERSON_WORDS, PERSON_STEMS);
    secret ||= hasWord(lower, SECRET_WORDS, SECRET_STEMS);
    out.push(masked);
  }
  if (path.cased.length > MAX_MASKED_SEGMENTS) out.push('{etc}');
  let total = 0;
  const kept: string[] = [];
  for (const segment of out) {
    total += segment.length + 1;
    if (total > MAX_MASKED_CHARS - 6) {
      kept.push('{etc}');
      break;
    }
    kept.push(segment);
  }
  return `/${kept.join('/')}`;
}

/** Todas as palavras do segmento são de rota (`set-password`, `reset.php`). */
function isRouteName(segment: string): boolean {
  const all = words(segment);
  const last = all.at(-1) ?? '';
  const named = SCRIPT_WORDS.has(last) ? all.slice(0, -1) : all;
  return named.length > 0 && named.every((word) => ROUTE_WORDS.has(word));
}

const SCRIPT_WORDS: ReadonlySet<string> = new Set([
  'php',
  'asp',
  'aspx',
  'jsp',
  'do',
  'action',
  'cgi',
  'html',
  'json',
]);

/** O segmento é um script que recebe o resto do caminho (PATH_INFO): `/login.php/qualquer-coisa` é `/login.php`. */
const SCRIPT_SUFFIXES = ['.php', '.asp', '.aspx', '.jsp', '.jspx', '.cgi', '.do', '.action', '.ashx'];

/** Os segmentos até o primeiro script, inclusive: o que vem depois é texto livre de quem pede. */
export function upToScript(segments: readonly string[]): readonly string[] {
  const at = segments.findIndex((segment) => SCRIPT_SUFFIXES.some((suffix) => segment.endsWith(suffix)));
  return at < 0 || at === segments.length - 1 ? segments : segments.slice(0, at + 1);
}

/** O caminho mascarado só tem letra minúscula, algarismo, `. _ ~ - /` e os marcadores entre chaves. */
export function isMaskedPath(text: string): boolean {
  if (text.length === 0 || text.length > MAX_MASKED_CHARS || text.charCodeAt(0) !== 47) return false;
  return every(
    text,
    (code) =>
      isLower(code) || isDigit(code) || isSeparator(code) || code === 47 || code === 123 || code === 125,
  );
}

import { every, isAlnum, isDigit, isLower, isPrintable, isUpper } from './ascii.js';

/**
 * User-Agent: família de um dicionário fechado e, só para a evidência, uma amostra limpa de até 120 caracteres ASCII.
 *
 * O User-Agent é escolhido por quem pede: **nunca isenta ninguém** ("sou o Googlebot", "sou o monitor"). Ele só acusa
 * (990401), conta (valores distintos) ou descreve. Uma ferramenta de ataque com o User-Agent trocado não aparece aqui; as
 * outras regras não dependem dele.
 */

/**
 * Ferramentas de ataque (990401): a lista do desenho de 24/11/2026. `curl`, `python-requests` e `Go-http-client` sozinhos
 * nunca contam. O `ffuf` se identifica pelo nome por extenso.
 */
export const TOOL_FAMILIES = [
  'sqlmap',
  'nikto',
  'nuclei',
  'wpscan',
  'ffuf',
  'gobuster',
  'dirbuster',
  'feroxbuster',
  'wfuzz',
  'acunetix',
  'nessus',
  'openvas',
  'zgrab',
  'masscan',
  'hydra',
  'arachni',
] as const;
export type ToolFamily = (typeof TOOL_FAMILIES)[number];

/** Ferramentas de lista de palavras: a técnica é a T1595.003. */
export const WORDLIST_TOOLS: ReadonlySet<ToolFamily> = new Set([
  'ffuf',
  'gobuster',
  'dirbuster',
  'feroxbuster',
  'wfuzz',
]);

const TOOL_ALIASES: readonly (readonly [string, ToolFamily])[] = [
  ...TOOL_FAMILIES.map((tool) => [tool, tool] as const),
  ['fuzz faster u fool', 'ffuf'],
];

/** As outras famílias, na ordem em que são tentadas (a primeira que casa vale). */
const FAMILY_HINTS = [
  ['googlebot', 'googlebot'],
  ['bingbot', 'bingbot'],
  ['curl/', 'curl'],
  ['wget/', 'wget'],
  ['python', 'python'],
  ['go-http-client', 'go'],
  ['okhttp', 'okhttp'],
  ['java', 'java'],
  ['node', 'node'],
  ['axios', 'node'],
  ['php', 'php'],
  ['postman', 'postman'],
  ['bot', 'other_bot'],
  ['crawler', 'other_bot'],
  ['spider', 'other_bot'],
  ['edg/', 'edge'],
  ['firefox/', 'firefox'],
  ['chrome/', 'chrome'],
  ['safari/', 'safari'],
] as const;

export const OTHER_FAMILIES = [
  'googlebot',
  'bingbot',
  'curl',
  'wget',
  'python',
  'go',
  'okhttp',
  'java',
  'node',
  'php',
  'postman',
  'other_bot',
  'edge',
  'firefox',
  'chrome',
  'safari',
  'empty',
  'other',
] as const;
export type OtherFamily = (typeof OTHER_FAMILIES)[number];
export const UA_FAMILIES = [...TOOL_FAMILIES, ...OTHER_FAMILIES] as const;
export type UaFamily = (typeof UA_FAMILIES)[number];

/** A palavra aparece inteira (sem letra colada): `hydra` casa `(Hydra)`, e não `hydrangea`. */
function hasToken(text: string, token: string): boolean {
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) {
    const before = at === 0 ? 0 : text.charCodeAt(at - 1);
    const after = at + token.length < text.length ? text.charCodeAt(at + token.length) : 0;
    if (!isLower(before) && !isLower(after)) return true;
  }
  return false;
}

export interface UaInfo {
  tool: ToolFamily | null;
  family: UaFamily;
}

export function classifyUserAgent(userAgent: string): UaInfo {
  if (userAgent === '') return { tool: null, family: 'empty' };
  const text = userAgent.toLowerCase();
  for (const [token, tool] of TOOL_ALIASES) if (hasToken(text, token)) return { tool, family: tool };
  for (const [hint, family] of FAMILY_HINTS) if (text.includes(hint)) return { tool: null, family };
  return { tool: null, family: 'other' };
}

export const MAX_UA_SAMPLE = 120;

/** O que pode aparecer na amostra: letra, algarismo, espaço e `. _ / : ; ( ) , -` (e as chaves dos marcadores). */
const SAMPLE_PUNCTUATION: ReadonlySet<number> = new Set([...' ._/:;(),-'].map((char) => char.charCodeAt(0)));
const isSampleChar = (code: number): boolean => isAlnum(code) || SAMPLE_PUNCTUATION.has(code);
const isBreak = (code: number): boolean =>
  code === 32 || code === 40 || code === 41 || code === 59 || code === 44;

function maskWord(word: string): string {
  if (word.includes('@')) return '{email}';
  const lower = word.toLowerCase();
  if (lower.includes('://') || lower.startsWith('www.')) return '{url}';
  // Par `chave=valor` é como um segredo ou um pedaço de query viria parar aqui.
  if (lower.includes('=') || lower.includes('?') || lower.includes('&') || lower.includes('%'))
    return '{token}';
  let digits = 0;
  let run = 0;
  let longest = 0;
  let upper = 0;
  let small = 0;
  let dash = false;
  for (let i = 0; i < word.length; i += 1) {
    const code = word.charCodeAt(i);
    if (isDigit(code)) {
      digits += 1;
      run += 1;
      longest = Math.max(longest, run);
      continue;
    }
    run = 0;
    if (isUpper(code)) upper += 1;
    else if (isLower(code)) small += 1;
    else if (code === 45) dash = true;
  }
  if (longest >= 9 || (digits >= 9 && dash && upper + small === 0)) return '{num}';
  if (lower.startsWith('eyj') && word.length >= 10) return '{token}';
  if (word.length >= 20 && digits >= 2 && upper + small >= 2 && !word.includes('/')) return '{token}';
  if (word.length >= 32) return '{token}';
  return word;
}

/**
 * Amostra para a evidência: só ASCII imprimível (controle, bidi e o resto saem), e-mail, URL e o que parece segredo
 * mascarados, sem caractere que comece fórmula de planilha ou marcação.
 */
export function sampleUserAgent(userAgent: string): string | null {
  let ascii = '';
  for (let i = 0; i < userAgent.length; i += 1) {
    const code = userAgent.charCodeAt(i);
    ascii += isPrintable(code) ? userAgent.charAt(i) : ' ';
  }
  let out = '';
  let start = 0;
  for (let i = 0; i <= ascii.length; i += 1) {
    const code = i < ascii.length ? ascii.charCodeAt(i) : 32;
    if (!isBreak(code)) continue;
    const word = i > start ? maskWord(ascii.slice(start, i)) : '';
    if (word.startsWith('{')) out += MARKERS.has(word) ? word : '';
    else for (const char of word) if (isSampleChar(char.charCodeAt(0))) out += char;
    if (i < ascii.length) out += ascii.charAt(i);
    start = i + 1;
  }
  const text = collapse(out).slice(0, MAX_UA_SAMPLE).trim();
  return text === '' ? null : text;
}

const MARKERS: ReadonlySet<string> = new Set(['{email}', '{url}', '{token}', '{num}']);

/** Um espaço só entre as palavras. */
function collapse(text: string): string {
  let out = '';
  for (const char of text) if (char !== ' ' || !out.endsWith(' ')) out += char;
  return out.trim();
}

/** O texto tem só o que a amostra pode ter. */
export function isUaSample(text: string): boolean {
  return (
    text.length <= MAX_UA_SAMPLE && every(text, (code) => isSampleChar(code) || code === 123 || code === 125)
  );
}

import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import ts from 'typescript';

/**
 * Impressão digital (fingerprint) de cada regra de detecção (Cobertura de detecção, UC-1). A homologação de um cenário
 * fica presa à fingerprint das regras dele: regra mudada volta a `em_teste` (`effectiveScenarioState`, em
 * `@verax/shared`).
 *
 * Módulo de build e de teste: funções puras, sem ler disco (quem chama passa o texto dos arquivos). A API em execução
 * não o carrega; o `typescript` (dependência de desenvolvimento) só é usado aqui, para achar os imports de um módulo.
 *
 * - Regra do Wazuh da Verax (XML): o elemento `<rule>` canonizado (sem comentários, espaços normalizados, atributos em
 *   ordem) mais a fingerprint das regras mães (`if_sid`, `if_matched_sid`): a mãe local entra pelo conteúdo, a de
 *   fábrica pela imagem do manager. O modelo `verax_reader_rules.xml.tmpl` entra antes de receber o IP do nó.
 * - Regra de fábrica do Wazuh: o ID mais a imagem do manager fixada no compose (com o digest). Trocar a versão do Wazuh
 *   muda a fingerprint de todas.
 * - Regra do worker (TS): os metadados da regra mais o texto do módulo dela e de todos os imports relativos, em fecho.
 *   Conservador: mexer no módulo muda a fingerprint de todas as regras dele.
 */

export type RuleFingerprint = `sha256:${string}`;

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const fingerprintOf = (value: unknown): RuleFingerprint => `sha256:${sha256(JSON.stringify(value))}`;

/** Quebra de linha do Windows vira a do Unix: o mesmo commit dá o mesmo hash em qualquer checkout. */
const unixText = (text: string): string => text.split('\r\n').join('\n');

const isSpace = (char: string): boolean => char === ' ' || char === '\n' || char === '\r' || char === '\t';

/** Junta qualquer sequência de espaços num espaço só e tira das pontas. */
function collapseSpaces(text: string): string {
  let out = '';
  let pending = false;
  for (const char of text) {
    if (isSpace(char)) {
      pending = out.length > 0;
      continue;
    }
    if (pending) out += ' ';
    pending = false;
    out += char;
  }
  return out;
}

/** Um pedaço do XML: abertura (com os atributos), fechamento ou texto. */
type XmlToken =
  | { type: 'open'; name: string; attributes: [string, string][]; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

/** Tira os comentários `<!-- ... -->`. Um comentário sem fim é erro (o arquivo está quebrado). */
function withoutComments(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const start = text.indexOf('<!--', from);
    if (start === -1) return out + text.slice(from);
    const end = text.indexOf('-->', start + 4);
    if (end === -1) throw new Error('comentário XML sem fim');
    out += text.slice(from, start);
    from = end + 3;
  }
}

/** Os atributos de uma tag (`nome="valor"` ou `nome='valor'`), em ordem de nome. */
function parseAttributes(source: string): [string, string][] {
  const attributes: [string, string][] = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && isSpace(source.charAt(index))) index += 1;
    if (index >= source.length) break;
    const equals = source.indexOf('=', index);
    if (equals === -1) throw new Error('atributo XML sem valor');
    const name = source.slice(index, equals).trim();
    let quoteAt = equals + 1;
    while (quoteAt < source.length && isSpace(source.charAt(quoteAt))) quoteAt += 1;
    const quote = source.charAt(quoteAt);
    if (quote !== '"' && quote !== "'") throw new Error('atributo XML sem aspas');
    const end = source.indexOf(quote, quoteAt + 1);
    if (end === -1) throw new Error('atributo XML sem fim');
    attributes.push([name, collapseSpaces(source.slice(quoteAt + 1, end))]);
    index = end + 1;
  }
  return attributes.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Os pedaços do XML, sem comentários, declarações nem texto vazio. Basta para as regras do Wazuh (sem CDATA). */
export function xmlTokens(text: string): XmlToken[] {
  const source = withoutComments(unixText(text));
  const tokens: XmlToken[] = [];
  let index = 0;
  while (index < source.length) {
    const open = source.indexOf('<', index);
    const textEnd = open === -1 ? source.length : open;
    const chunk = collapseSpaces(source.slice(index, textEnd));
    if (chunk.length > 0) tokens.push({ type: 'text', text: chunk });
    if (open === -1) break;
    const close = source.indexOf('>', open);
    if (close === -1) throw new Error('tag XML sem fim');
    const inner = source.slice(open + 1, close).trim();
    index = close + 1;
    if (inner.startsWith('?') || inner.startsWith('!')) continue;
    if (inner.startsWith('/')) {
      tokens.push({ type: 'close', name: inner.slice(1).trim() });
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    let nameEnd = 0;
    while (nameEnd < body.length && !isSpace(body.charAt(nameEnd))) nameEnd += 1;
    tokens.push({
      type: 'open',
      name: body.slice(0, nameEnd),
      attributes: parseAttributes(body.slice(nameEnd)),
      selfClosing,
    });
  }
  return tokens;
}

const tokenText = (token: XmlToken): string => {
  if (token.type === 'text') return token.text;
  if (token.type === 'close') return `</${token.name}>`;
  const attributes = token.attributes.map(([name, value]) => ` ${name}="${value}"`).join('');
  return `<${token.name}${attributes}${token.selfClosing ? '/' : ''}>`;
};

/** Uma regra de um arquivo XML da Verax, canonizada, com as mães que ela cita. */
export interface XmlRule {
  id: string;
  level: number;
  /** A forma canônica do elemento `<rule>` inteiro. */
  canonical: string;
  /** IDs de `if_sid` e `if_matched_sid`. */
  parents: string[];
  /** IDs de `<mitre><id>`. */
  techniques: string[];
}

/** As regras de um arquivo XML de regras do Wazuh. */
export function xmlRules(text: string): XmlRule[] {
  const tokens = xmlTokens(text);
  const rules: XmlRule[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    const token = tokens[start];
    if (token?.type !== 'open' || token.name !== 'rule' || token.selfClosing) continue;
    let depth = 0;
    let end = start;
    for (; end < tokens.length; end += 1) {
      const current = tokens[end];
      if (current?.type === 'open' && current.name === 'rule' && !current.selfClosing) depth += 1;
      if (current?.type === 'close' && current.name === 'rule') depth -= 1;
      if (depth === 0) break;
    }
    if (depth !== 0) throw new Error('regra XML sem fim');
    const body = tokens.slice(start, end + 1);
    const attribute = (name: string) => token.attributes.find(([key]) => key === name)?.[1] ?? '';
    const childTexts = (name: string): string[] =>
      body.flatMap((item, at) => {
        const next = body[at + 1];
        return item.type === 'open' && item.name === name && next?.type === 'text' ? [next.text] : [];
      });
    rules.push({
      id: attribute('id'),
      level: Number(attribute('level')),
      canonical: body.map(tokenText).join('\n'),
      parents: [...childTexts('if_sid'), ...childTexts('if_matched_sid')]
        .flatMap((value) => value.split(','))
        .flatMap((value) => value.split(' '))
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
      techniques: childTexts('id').filter((value) => value.startsWith('T')),
    });
    start = end;
  }
  return rules;
}

/** Fingerprint de uma regra de fábrica do Wazuh: o ID e a imagem do manager (com o digest). */
export function builtinRuleFingerprint(ruleId: string, managerImage: string): RuleFingerprint {
  return fingerprintOf({ kind: 'wazuh-builtin', ruleId, managerImage });
}

/**
 * Fingerprint de cada regra dos arquivos XML da Verax. A mãe local entra pela fingerprint dela (em fecho); a que não
 * está nos arquivos é de fábrica e entra pela imagem do manager.
 */
export function xmlRuleFingerprints(
  files: readonly { name: string; text: string }[],
  managerImage: string,
): Map<string, RuleFingerprint> {
  const rules = new Map<string, XmlRule>();
  for (const file of files) {
    for (const rule of xmlRules(file.text)) {
      if (rules.has(rule.id)) throw new Error(`regra XML repetida: ${rule.id}`);
      rules.set(rule.id, rule);
    }
  }
  const done = new Map<string, RuleFingerprint>();
  const visiting = new Set<string>();
  const of = (id: string): RuleFingerprint => {
    const known = done.get(id);
    if (known !== undefined) return known;
    const rule = rules.get(id);
    if (rule === undefined) return builtinRuleFingerprint(id, managerImage);
    if (visiting.has(id)) throw new Error(`regras XML em ciclo: ${id}`);
    visiting.add(id);
    const parents = [...new Set(rule.parents)].sort().map((parent) => [parent, of(parent)]);
    visiting.delete(id);
    const result = fingerprintOf({ kind: 'wazuh-verax', rule: rule.canonical, parents });
    done.set(id, result);
    return result;
  };
  return new Map([...rules.keys()].map((id) => [id, of(id)]));
}

/** Um módulo TS do repositório: caminho relativo à raiz (com `/`) e texto. */
export interface SourceModule {
  path: string;
  text: string;
}

/** O caminho do import relativo, de `.js` para `.ts` (a API é ESM e importa com a extensão `.js`). */
function resolveImport(from: string, specifier: string, read: (path: string) => string | undefined): string {
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = base.endsWith('.js')
    ? [`${base.slice(0, -3)}.ts`, base]
    : [base, `${base}.ts`, `${base}/index.ts`];
  const found = candidates.find((candidate) => read(candidate) !== undefined);
  if (found === undefined) throw new Error(`import não encontrado: ${specifier} em ${from}`);
  return found;
}

/**
 * O módulo e o fecho dos imports relativos dele, em ordem de caminho. Os imports de pacote (`@verax/shared`, `zod`)
 * ficam de fora: mudam pelo lockfile, não pela regra.
 */
export function moduleClosure(
  entries: readonly string[],
  read: (path: string) => string | undefined,
): SourceModule[] {
  const seen = new Map<string, string>();
  const pending = [...entries];
  while (pending.length > 0) {
    const path = pending.pop() ?? '';
    if (seen.has(path)) continue;
    const raw = read(path);
    if (raw === undefined) throw new Error(`módulo não encontrado: ${path}`);
    const text = unixText(raw);
    seen.set(path, text);
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      if (imported.fileName.startsWith('./') || imported.fileName.startsWith('../')) {
        pending.push(resolveImport(path, imported.fileName, read));
      }
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, text]) => ({ path, text }));
}

/** Os metadados de uma regra do worker que entram na fingerprint (os que a tabela dela tiver). */
export interface WorkerRuleMetadata {
  id: string;
  level?: number;
  title: string;
  tactics?: readonly string[];
  techniques?: readonly string[];
}

/** Fingerprint de uma regra do worker: metadados mais o fecho dos módulos. */
export function workerRuleFingerprint(
  meta: WorkerRuleMetadata,
  modules: readonly SourceModule[],
): RuleFingerprint {
  return fingerprintOf({
    kind: 'worker',
    meta: {
      id: meta.id,
      level: meta.level ?? null,
      title: meta.title,
      tactics: meta.tactics ?? [],
      techniques: meta.techniques ?? [],
    },
    modules: modules.map((module) => [module.path, sha256(module.text)]),
  });
}

/**
 * Fingerprint de um repasse do provedor que leva o ID de uma regra de fábrica (o GuardDuty, 8030x): a imagem do
 * manager (o caminho pelo bucket) mais o fecho dos módulos que montam o achado pela API (a mesma regra, a severidade e
 * o MITRE).
 */
export function relayRuleFingerprint(
  ruleId: string,
  managerImage: string,
  modules: readonly SourceModule[],
): RuleFingerprint {
  return fingerprintOf({
    kind: 'provider-relay',
    ruleId,
    managerImage,
    modules: modules.map((module) => [module.path, sha256(module.text)]),
  });
}

/** A imagem do manager do Wazuh fixada no compose (`wazuh/wazuh-manager:<versão>@sha256:<digest>`), a mesma em todos. */
export function managerImageOf(compose: string): string {
  const marker = 'image: wazuh/wazuh-manager:';
  const images = new Set<string>();
  for (let at = compose.indexOf(marker); at !== -1; at = compose.indexOf(marker, at + 1)) {
    const start = at + 'image: '.length;
    let end = start;
    while (end < compose.length && !isSpace(compose.charAt(end))) end += 1;
    images.add(compose.slice(start, end));
  }
  const [image, ...others] = [...images];
  if (image === undefined || others.length > 0 || !image.includes('@sha256:')) {
    throw new Error('imagem do manager do Wazuh ausente, sem digest ou diferente entre os serviços');
  }
  return image;
}

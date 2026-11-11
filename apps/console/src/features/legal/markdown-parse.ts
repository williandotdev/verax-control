/**
 * A prévia do Markdown dos textos legais, sem pacote novo e sem HTML cru: o texto vira uma árvore de blocos e trechos,
 * e o React desenha cada um como elemento (todo texto escapado, nada de `innerHTML`). Cobre o que um texto legal usa:
 * títulos (`#` a `######`), parágrafos, listas com `-`, `*`, `+` ou `1.`, citação (`>`), linha (`---`), negrito
 * (`**`), itálico (`*` ou `_`), código (`` ` ``), quebra de linha (dois espaços ou `\` no fim) e links. Link só com
 * `https:`, `http:`, `mailto:`, `/` ou `#`; outro endereço (como `javascript:`) fica como texto. O que a prévia não
 * conhece (tabela, HTML, lista dentro de lista) aparece como texto: o site tem o próprio renderizador e estilo.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'break' }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'heading'; level: number; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; start: number; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'rule' };

const SAFE_LINK = /^(https?:\/\/|mailto:|\/|#)/i;
const PUNCTUATION = '\\`*_{}[]()#+-.!>';

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

/** Junta textos vizinhos (o escape e os marcadores sem par deixam o texto em pedaços). */
function merge(nodes: Inline[]): Inline[] {
  const merged: Inline[] = [];
  for (const node of nodes) {
    const last = merged.at(-1);
    if (node.type === 'text' && last?.type === 'text') last.text += node.text;
    else merged.push(node);
  }
  return merged;
}

/** Os trechos de uma linha (ou de várias, já juntas com `\n`). Varre caractere a caractere, sem retrocesso. */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let index = 0;
  const pushText = (value: string): void => {
    if (value !== '') nodes.push({ type: 'text', text: value });
  };
  while (index < text.length) {
    const char = text[index] ?? '';
    const next = text[index + 1];
    if (char === '\\' && next !== undefined && PUNCTUATION.includes(next)) {
      pushText(next);
      index += 2;
      continue;
    }
    if (char === '\\' && next === '\n') {
      nodes.push({ type: 'break' });
      index += 2;
      continue;
    }
    if (char === '\n') {
      // Dois espaços antes da quebra: quebra de linha; senão, a linha continua o parágrafo.
      nodes.splice(0, nodes.length, ...merge(nodes));
      const last = nodes.at(-1);
      if (last?.type === 'text' && last.text.endsWith('  ')) {
        last.text = last.text.trimEnd();
        nodes.push({ type: 'break' });
      } else {
        pushText(' ');
      }
      index += 1;
      continue;
    }
    if (char === '`') {
      const close = text.indexOf('`', index + 1);
      if (close > index + 1) {
        nodes.push({ type: 'code', text: text.slice(index + 1, close) });
        index = close + 1;
        continue;
      }
    }
    if (char === '*' && next === '*') {
      const close = text.indexOf('**', index + 2);
      if (close > index + 2) {
        nodes.push({ type: 'strong', children: parseInline(text.slice(index + 2, close)) });
        index = close + 2;
        continue;
      }
    }
    if ((char === '*' || char === '_') && next !== undefined && next !== ' ' && next !== char) {
      // `_` só abre itálico fora de palavra (`nome_de_arquivo` fica como está).
      const opens = char === '*' || !isWordChar(text[index - 1]);
      const close = text.indexOf(char, index + 1);
      const closes = close > index + 1 && (char === '*' || !isWordChar(text[close + 1]));
      if (opens && closes && text[close - 1] !== ' ') {
        nodes.push({ type: 'em', children: parseInline(text.slice(index + 1, close)) });
        index = close + 1;
        continue;
      }
    }
    if (char === '[') {
      const middle = text.indexOf('](', index + 1);
      const close = middle < 0 ? -1 : text.indexOf(')', middle + 2);
      if (middle > index && close > middle + 2 && !text.slice(index + 1, middle).includes('\n')) {
        const href = text.slice(middle + 2, close).trim();
        const label = parseInline(text.slice(index + 1, middle));
        if (SAFE_LINK.test(href) && !/\s/.test(href)) {
          nodes.push({ type: 'link', href, children: label });
        } else {
          nodes.push(...label);
        }
        index = close + 1;
        continue;
      }
    }
    pushText(char);
    index += 1;
  }
  return merge(nodes);
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UNORDERED = /^ {0,3}[-*+]\s+(.*)$/;
const ORDERED = /^ {0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** `---`, `***` ou `___` (três ou mais do mesmo, com espaços no meio, se quiser). */
function isRule(line: string): boolean {
  const compact = line.replaceAll(' ', '');
  const first = compact[0];
  return (
    compact.length >= 3 &&
    (first === '-' || first === '*' || first === '_') &&
    [...compact].every((char) => char === first)
  );
}

/** Os blocos do texto, na ordem. */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let index = 0;
  const startsBlock = (line: string): boolean =>
    HEADING.test(line) || isRule(line) || UNORDERED.test(line) || ORDERED.test(line) || QUOTE.test(line);

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        level: heading[1]?.length ?? 1,
        children: parseInline((heading[2] ?? '').trim()),
      });
      index += 1;
      continue;
    }
    if (isRule(line)) {
      blocks.push({ type: 'rule' });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index] ?? '')) {
        quoted.push(QUOTE.exec(lines[index] ?? '')?.[1] ?? '');
        index += 1;
      }
      blocks.push({ type: 'quote', children: parseInline(quoted.join('\n')) });
      continue;
    }
    const firstOrdered = ORDERED.exec(line);
    if (firstOrdered !== null || UNORDERED.test(line)) {
      const ordered = firstOrdered !== null;
      const marker = ordered ? ORDERED : UNORDERED;
      const items: string[][] = [];
      while (index < lines.length) {
        const current = lines[index] ?? '';
        const item = marker.exec(current);
        if (item !== null) {
          items.push([(ordered ? item[2] : item[1]) ?? '']);
        } else if (!isBlank(current) && /^\s{2,}\S/.test(current) && items.length > 0) {
          // Continuação recuada do item anterior.
          items.at(-1)?.push(current.trim());
        } else if (isBlank(current) && marker.test(lines[index + 1] ?? '')) {
          // Linha em branco entre itens da mesma lista.
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({
        type: 'list',
        ordered,
        start: ordered ? Number(firstOrdered[1] ?? '1') : 1,
        items: items.map((parts) => parseInline(parts.join('\n'))),
      });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && !isBlank(lines[index] ?? '') && !startsBlock(lines[index] ?? '')) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    if (paragraph.length === 0) {
      // Uma linha que parece bloco mas não casou com nenhum (não acontece com as expressões acima): vira texto.
      paragraph.push(line);
      index += 1;
    }
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
  }
  return blocks;
}

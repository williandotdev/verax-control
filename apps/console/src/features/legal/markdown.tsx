import { createElement, type ReactNode } from 'react';
import { type Inline, parseMarkdown } from './markdown-parse';

/** O desenho da prévia (o texto já em blocos e trechos por `markdown-parse.ts`): cada nó vira um elemento do React. */
function renderInline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'break':
        return <br key={index} />;
      case 'strong':
        return <strong key={index}>{renderInline(node.children)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(node.children)}</em>;
      case 'code':
        return (
          <code key={index} className="rounded bg-foreground/5 px-1 font-mono text-[0.9em]">
            {node.text}
          </code>
        );
      case 'link': {
        const external = /^https?:/i.test(node.href);
        return (
          <a
            key={index}
            href={node.href}
            className="text-primary underline underline-offset-2"
            {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          >
            {renderInline(node.children)}
          </a>
        );
      }
    }
  });
}

const HEADING_CLASSES = ['text-xl', 'text-lg', 'text-base', 'text-base', 'text-sm', 'text-sm'];

/**
 * A prévia desenhada. Os títulos descem um nível (`#` vira `h2`, e assim por diante até `h6`): a página do console já
 * tem o seu `h1`, e a hierarquia continua certa para o leitor de tela.
 */
export function MarkdownPreview({ source }: { source: string }) {
  const blocks = parseMarkdown(source);
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading': {
            const level = Math.min(block.level + 1, 6);
            return createElement(
              `h${level}`,
              {
                key: index,
                className: `${HEADING_CLASSES[block.level - 1] ?? 'text-sm'} font-semibold pt-2`,
              },
              renderInline(block.children),
            );
          }
          case 'paragraph':
            return <p key={index}>{renderInline(block.children)}</p>;
          case 'quote':
            return (
              <blockquote key={index} className="border-l-4 border-border-strong pl-3 text-muted-foreground">
                {renderInline(block.children)}
              </blockquote>
            );
          case 'rule':
            return <hr key={index} className="border-border" />;
          case 'list': {
            const items = block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>);
            return block.ordered ? (
              <ol key={index} start={block.start} className="list-decimal space-y-1 pl-6">
                {items}
              </ol>
            ) : (
              <ul key={index} className="list-disc space-y-1 pl-6">
                {items}
              </ul>
            );
          }
        }
      })}
    </div>
  );
}

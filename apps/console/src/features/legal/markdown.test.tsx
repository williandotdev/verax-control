import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from './markdown';
import { parseInline, parseMarkdown } from './markdown-parse';

describe('prévia do Markdown dos textos legais', () => {
  it('blocos: títulos, parágrafo de várias linhas, listas, citação e linha', () => {
    const blocks = parseMarkdown(
      [
        '# Termos de uso',
        '',
        'Primeira linha',
        'continua aqui.',
        '',
        '- um',
        '- dois',
        '  com continuação',
        '',
        '3. três',
        '4. quatro',
        '',
        '> citação',
        '',
        '---',
      ].join('\r\n'),
    );
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'list',
      'quote',
      'rule',
    ]);
    expect(blocks[1]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', text: 'Primeira linha continua aqui.' }],
    });
    expect(blocks[2]).toMatchObject({
      ordered: false,
      items: [[{ text: 'um' }], [{ text: 'dois com continuação' }]],
    });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 3 });
  });

  it('trechos: negrito, itálico, código, escape e quebra de linha; nome_com_traço fica como está', () => {
    expect(parseInline('**forte** e *leve* e `x` e \\*literal\\* e nome_de_arquivo')).toEqual([
      { type: 'strong', children: [{ type: 'text', text: 'forte' }] },
      { type: 'text', text: ' e ' },
      { type: 'em', children: [{ type: 'text', text: 'leve' }] },
      { type: 'text', text: ' e ' },
      { type: 'code', text: 'x' },
      { type: 'text', text: ' e *literal* e nome_de_arquivo' },
    ]);
    expect(parseInline('linha  \noutra')).toEqual([
      { type: 'text', text: 'linha' },
      { type: 'break' },
      { type: 'text', text: 'outra' },
    ]);
  });

  it('links: só https, http, mailto e caminhos; javascript: vira texto', () => {
    expect(parseInline('[site](https://veraxsistemas.com.br) [x](javascript:void)')).toEqual([
      { type: 'link', href: 'https://veraxsistemas.com.br', children: [{ type: 'text', text: 'site' }] },
      { type: 'text', text: ' x' },
    ]);
    expect(parseInline('[e-mail](mailto:privacidade@verax.example)')[0]).toMatchObject({ type: 'link' });
  });

  it('desenha sem HTML cru: uma tag no texto aparece como texto, e o título desce um nível', () => {
    render(<MarkdownPreview source={'# Título\n\n<img src=x onerror=alert(1)> **ok**'} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Título' })).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('ok').tagName).toBe('STRONG');
  });
});

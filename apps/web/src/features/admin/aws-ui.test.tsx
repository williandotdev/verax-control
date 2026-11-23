import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ScrollTable } from './aws-ui';

/** O código das telas da conta AWS (`aws-*.tsx`), como texto: para conferir que toda tabela passa pelo quadro. */
const SOURCES = import.meta.glob<string>('./aws-*.tsx', { query: '?raw', import: 'default', eager: true });

describe('quadro de tabela que rola de lado', () => {
  const table = (caption: string) => (
    <ScrollTable caption={caption} className="bg-surface" tableClassName="min-w-[64rem] text-sm">
      <thead>
        <tr>
          <th scope="col">Fonte</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>CloudTrail</td>
        </tr>
      </tbody>
    </ScrollTable>
  );

  it('é uma região com o nome da tabela, que recebe o foco do teclado com o contorno à vista', async () => {
    const user = userEvent.setup();
    render(table('Saúde da coleta de cada fonte autorizada'));
    const frame = screen.getByRole('region', { name: 'Tabela: Saúde da coleta de cada fonte autorizada' });
    expect(frame).toHaveAttribute('tabindex', '0');
    expect(frame).toHaveClass('overflow-x-auto', 'focus-visible:outline-2', 'focus-visible:outline-ring');
    // As classes de quem usa entram junto das do quadro.
    expect(frame).toHaveClass('bg-surface', 'border');
    // A tabela fica dentro do quadro, com o mesmo nome na legenda (só para o leitor de tela).
    const inner = within(frame).getByRole('table', { name: 'Saúde da coleta de cada fonte autorizada' });
    expect(inner).toHaveClass('w-full', 'min-w-[64rem]', 'text-sm');
    expect(within(inner).getByText('Saúde da coleta de cada fonte autorizada')).toHaveClass('sr-only');
    // Uma tabela só de texto não tem outro ponto de foco: o Tab para no quadro.
    expect(within(frame).queryByRole('button')).not.toBeInTheDocument();
    await user.tab();
    expect(frame).toHaveFocus();
  });

  it('duas tabelas na mesma tela: cada quadro com o nome da tabela dele', () => {
    render(
      <>
        {table('O que a descoberta não conseguiu ler')}
        {table('Saúde da coleta de cada fonte autorizada')}
      </>,
    );
    const names = screen.getAllByRole('region').map((frame) => frame.getAttribute('aria-label'));
    expect(names).toEqual([
      'Tabela: O que a descoberta não conseguiu ler',
      'Tabela: Saúde da coleta de cada fonte autorizada',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('toda tabela das telas da conta AWS passa pelo quadro: nenhuma monta a própria tabela ou o próprio quadro', () => {
    const files = Object.entries(SOURCES);
    // As telas estão mesmo sendo lidas (as duas com tabela entre elas).
    expect(files.map(([path]) => path)).toEqual(
      expect.arrayContaining(['./aws-discovery-results.tsx', './aws-source-monitor.tsx', './aws-ui.tsx']),
    );
    const own = files
      .filter(([path]) => path !== './aws-ui.tsx' && !path.endsWith('.test.tsx'))
      .filter(
        ([, code]) =>
          code.includes('<table') || code.includes('overflow-x-') || code.includes('overflow-auto'),
      )
      .map(([path]) => path);
    expect(own).toEqual([]);
    const users = files.filter(([, code]) => code.includes('<ScrollTable')).map(([path]) => path);
    expect(users).toEqual(
      expect.arrayContaining(['./aws-discovery-results.tsx', './aws-source-monitor.tsx']),
    );
  });
});

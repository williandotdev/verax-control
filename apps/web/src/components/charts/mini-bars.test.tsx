import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MiniBars } from './mini-bars';

const VALUES = [0, 2, 0, 5, 1];
const LABELS = ['10:00', '11:00', '12:00', '13:00', '14:00'];

function renderBars(values: readonly number[] = VALUES) {
  return render(
    <MiniBars
      title="Achados por hora"
      values={values}
      labels={LABELS}
      unit={{ one: 'achado', many: 'achados' }}
    />,
  );
}

describe('MiniBars', () => {
  it('uma coluna por hora com valor (o zero não desenha nada), o resumo no nome acessível e a hora atual em destaque', () => {
    const { container } = renderBars();
    expect(
      screen.getByRole('img', {
        name: 'Achados por hora: 8 achados no total; a hora com mais foi a das 13:00, com 5. Use as setas para ver cada hora.',
      }),
    ).toBeInTheDocument();
    const bars = Array.from(container.querySelectorAll('path[data-bar]'));
    expect(bars.map((bar) => bar.getAttribute('data-bar'))).toEqual(['1', '3', '4']);
    // Tinta neutra; a hora atual (a última) na tinta principal. Nunca cor de severidade.
    expect(bars.map((bar) => bar.getAttribute('class'))).toEqual([
      'fill-foreground/50',
      'fill-foreground/50',
      'fill-foreground',
    ]);
  });

  it('as setas e o Home/End escolhem a hora, anunciada ao leitor de tela', async () => {
    const { container } = renderBars();
    const chart = screen.getByRole('img');
    await userEvent.tab();
    expect(chart).toHaveFocus();
    expect(screen.getByText('14:00: 1 achado.')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByText('13:00: 5 achados.')).toBeInTheDocument();
    expect(container.querySelector('path[data-bar="3"]')).toHaveClass('fill-foreground');
    expect(container.querySelector('path[data-bar="4"]')).toHaveClass('fill-foreground/50');
    await userEvent.keyboard('{Home}');
    expect(screen.getByText('10:00: 0 achados.')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByText('10:00: 0 achados.')).toBeInTheDocument();
    await userEvent.keyboard('{End}');
    expect(screen.getByText('14:00: 1 achado.')).toBeInTheDocument();
    fireEvent.blur(chart);
    expect(screen.queryByText(/: \d+ achados?\.$/)).toBeNull();
  });

  it('a tabela de "Ver tabela" tem cada hora, da mais recente à mais antiga', () => {
    renderBars();
    const table = screen.getByRole('table', { name: 'Achados por hora', hidden: true });
    const rows = within(table).getAllByRole('row', { hidden: true });
    expect(rows.map((row) => row.textContent)).toEqual([
      'HoraAchados',
      '14:001',
      '13:005',
      '12:000',
      '11:002',
      '10:000',
    ]);
  });

  it('sem nada no período: só a linha de base, e o nome diz que não houve nada', () => {
    const { container } = renderBars([0, 0, 0, 0, 0]);
    expect(screen.getByRole('img', { name: 'Achados por hora: nenhum achado.' })).toBeInTheDocument();
    expect(container.querySelectorAll('path[data-bar]')).toHaveLength(0);
  });
});

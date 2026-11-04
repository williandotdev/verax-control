import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CircleDot } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { INK_RAMP } from './chart-utils';
import { PieChart, type PieSlice } from './pie-chart';

const slice = (key: string, label: string, value: number, step: 0 | 1 | 2 | 3): PieSlice => ({
  key,
  label,
  value,
  ...INK_RAMP[step],
});

const SLICES: readonly PieSlice[] = [
  { ...slice('new', 'Novo', 15, 0), icon: CircleDot },
  slice('investigating', 'Em análise', 4, 1),
  slice('legitimate', 'Legítimo', 1, 2),
  slice('resolved', 'Resolvido', 0, 3),
];

function renderPie(slices: readonly PieSlice[] = SLICES) {
  return render(
    <PieChart
      title="Achados por status"
      slices={slices}
      unit={{ one: 'achado', many: 'achados' }}
      columns={{ category: 'Status', value: 'Achados' }}
      empty="Nenhum achado no período."
    />,
  );
}

const svgTexts = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('svg text')).map((text) => text.textContent);
const announced = () => document.querySelector('[aria-live="polite"]')?.textContent;

describe('PieChart', () => {
  it('uma fatia por parte com valor, na ordem dada, e o resumo no nome acessível', () => {
    const { container } = renderPie();
    expect(
      screen.getByRole('img', {
        name: 'Achados por status: Novo, 15 achados (75%); Em análise, 4 achados (20%); Legítimo, 1 achado (5%); Resolvido, 0 achados (0%). Use as setas para ver cada fatia.',
      }),
    ).toBeInTheDocument();
    // A parte zerada não é desenhada.
    const drawn = Array.from(container.querySelectorAll('[data-slice]'));
    expect(drawn.map((element) => element.getAttribute('data-slice'))).toEqual([
      'new',
      'investigating',
      'legitimate',
    ]);
    expect(drawn[0]).toHaveClass('fill-foreground', 'stroke-surface');
  });

  it('a legenda é a tabela dos números: nome, quantidade e percentual de cada parte, inclusive a zerada', () => {
    renderPie();
    const table = screen.getByRole('table', { name: 'Achados por status' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Status', 'Achados', 'Percentual']);
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map((row) => row.textContent),
    ).toEqual(['Novo1575%', 'Em análise420%', 'Legítimo15%', 'Resolvido00%']);
    // Amostra da mesma cor da fatia e o ícone do status ao lado do nome.
    const first = within(table).getByRole('rowheader', { name: 'Novo' });
    expect(first.querySelector('.bg-foreground')).not.toBeNull();
    expect(first.querySelectorAll('svg')).toHaveLength(1);
  });

  it('o percentual vai dentro da fatia só quando cabe', () => {
    const { container } = renderPie();
    expect(svgTexts(container)).toEqual(['75%', '20%']);
  });

  it('percentuais pequenos com uma casa e números no formato brasileiro', () => {
    renderPie([slice('a', 'Novo', 1234, 0), slice('b', 'Resolvido', 40, 1)]);
    const table = screen.getByRole('table', { name: 'Achados por status' });
    expect(within(table).getByText('1.234')).toBeInTheDocument();
    expect(within(table).getByText('3,1%')).toBeInTheDocument();
  });

  it('uma parte só vira o círculo inteiro, com 100% no centro', () => {
    const { container } = renderPie([slice('new', 'Novo', 7, 0), slice('resolved', 'Resolvido', 0, 3)]);
    expect(container.querySelectorAll('circle[data-slice]')).toHaveLength(1);
    expect(container.querySelectorAll('path[data-slice]')).toHaveLength(0);
    expect(svgTexts(container)).toEqual(['100%']);
  });

  it('sem nenhum achado: o aviso de vazio, sem gráfico nem tabela', () => {
    renderPie(SLICES.map((item) => ({ ...item, value: 0 })));
    expect(screen.getByText('Nenhum achado no período.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('as setas percorrem as fatias com valor, com a dica, o destaque na legenda e o anúncio', async () => {
    renderPie();
    await userEvent.tab();
    expect(screen.getByRole('img', { name: /Achados por status/ })).toHaveFocus();
    expect(announced()).toBe('Novo: 15 achados, 75% do total.');
    expect(screen.getByText('15 achados')).toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: 'Novo' }).closest('tr')).toHaveAttribute('data-active');
    await userEvent.keyboard('{ArrowRight}');
    expect(announced()).toBe('Em análise: 4 achados, 20% do total.');
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    // A parte zerada não tem fatia: a seta para na última desenhada.
    expect(announced()).toBe('Legítimo: 1 achado, 5% do total.');
    await userEvent.keyboard('{Home}');
    expect(announced()).toBe('Novo: 15 achados, 75% do total.');
    await userEvent.keyboard('{End}');
    expect(announced()).toBe('Legítimo: 1 achado, 5% do total.');
    await userEvent.tab();
    expect(announced()).toBe('');
  });

  it('o mouse sobre uma fatia (ou a linha dela na legenda) mostra a dica; sair do gráfico a esconde', () => {
    const { container } = renderPie();
    const investigating = container.querySelector('[data-slice="investigating"]') as Element;
    fireEvent.pointerEnter(investigating, { pointerType: 'mouse' });
    expect(announced()).toBe('Em análise: 4 achados, 20% do total.');
    expect(investigating.getAttribute('style')).toContain('translate');
    fireEvent.pointerLeave(screen.getByRole('img', { name: /Achados por status/ }), { pointerType: 'mouse' });
    expect(announced()).toBe('');
    fireEvent.pointerEnter(screen.getByRole('rowheader', { name: 'Legítimo' }).closest('tr') as Element);
    expect(announced()).toBe('Legítimo: 1 achado, 5% do total.');
  });
});

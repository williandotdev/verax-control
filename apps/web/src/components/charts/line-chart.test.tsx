import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Info, OctagonAlert } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { LineChart, type LineRow, type LineSeries } from './line-chart';

type Key = 'critical' | 'low';

const SERIES: readonly LineSeries<Key>[] = [
  {
    key: 'critical',
    label: 'Crítico',
    stroke: 'stroke-critical',
    fill: 'fill-critical',
    swatch: 'bg-critical',
    icon: OctagonAlert,
    iconClass: 'text-critical',
  },
  { key: 'low', label: 'Baixo', stroke: 'stroke-low', fill: 'fill-low', swatch: 'bg-low', icon: Info },
];

const ROWS: readonly LineRow<Key>[] = [
  { date: '2026-10-31', critical: 0, low: 2 },
  { date: '2026-11-01', critical: 3, low: 1 },
  { date: '2026-11-02', critical: 1, low: 0 },
  { date: '2026-11-03', critical: 0, low: 1 },
  { date: '2026-11-04', critical: 4, low: 1 },
];

function renderChart(rows: readonly LineRow<Key>[] = ROWS) {
  return render(
    <LineChart
      title="Achados por dia"
      rows={rows}
      series={SERIES}
      unit={{ one: 'achado', many: 'achados' }}
      empty="Nenhum achado no período."
    />,
  );
}

const svgTexts = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('svg text')).map((text) => text.textContent);

describe('LineChart', () => {
  it('desenha uma linha por série, com a legenda, o eixo em pt-BR e o resumo no nome acessível', () => {
    const { container } = renderChart();
    expect(
      screen.getByRole('img', {
        name: 'Achados por dia, de 31/10/2026 a 04/11/2026: 13 achados no total; o dia com mais achados foi 04/11/2026, com 5. Use as setas para ver cada dia.',
      }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('path[data-series]')).toHaveLength(2);
    // Legenda sempre presente: a chave de linha, o ícone e o nome de cada série.
    const legend = screen.getAllByRole('listitem');
    expect(legend.map((item) => item.textContent)).toEqual(['Crítico', 'Baixo']);
    expect(legend[0]?.querySelectorAll('svg')).toHaveLength(1);
    // Primeira e última data no eixo, contagens redondas a partir do zero.
    expect(svgTexts(container)).toEqual(expect.arrayContaining(['31/10', '04/11', '0', '4']));
  });

  it('põe o nome no fim de cada linha quando não encosta em outro', () => {
    const { container } = renderChart();
    expect(svgTexts(container)).toEqual(expect.arrayContaining(['Crítico', 'Baixo']));
    // O fim das linhas com rótulo ganha o marcador.
    expect(container.querySelectorAll('circle[data-marker]')).toHaveLength(2);
  });

  it('linhas que terminam juntas ficam sem rótulo no fim (a legenda e a dica identificam)', () => {
    const { container } = renderChart([...ROWS.slice(0, 4), { date: '2026-11-04', critical: 1, low: 1 }]);
    expect(svgTexts(container)).not.toContain('Crítico');
    expect(svgTexts(container)).not.toContain('Baixo');
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Crítico', 'Baixo']);
  });

  it('números grandes no formato brasileiro, no eixo e na tabela', async () => {
    const { container } = renderChart([
      { date: '2026-11-03', critical: 1500, low: 20 },
      { date: '2026-11-04', critical: 900, low: 1234 },
    ]);
    expect(svgTexts(container)).toEqual(expect.arrayContaining(['1.000', '1.500']));
    await userEvent.click(screen.getByText('Ver tabela'));
    expect(
      within(screen.getByRole('table', { name: 'Achados por dia' })).getByText('1.234'),
    ).toBeInTheDocument();
  });

  it('as setas do teclado mostram cada dia, com a dica e o anúncio para o leitor de tela', async () => {
    renderChart();
    await userEvent.tab();
    expect(screen.getByRole('img', { name: /Achados por dia/ })).toHaveFocus();
    // Ao receber o foco, a dica abre no dia mais recente.
    expect(screen.getByText('04/11/2026: Crítico 4, Baixo 1; total 5 achados.')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByText('03/11/2026: Crítico 0, Baixo 1; total 1 achado.')).toBeInTheDocument();
    // A dica visível (o leitor de tela fica com o anúncio).
    const tip = screen.getAllByText('03/11/2026').find((element) => element.closest('[aria-hidden="true"]'));
    expect(tip?.closest('[aria-hidden="true"]')).toHaveTextContent('03/11/20260Crítico1BaixoTotal 1');
    await userEvent.keyboard('{Home}');
    expect(screen.getByText('31/10/2026: Crítico 0, Baixo 2; total 2 achados.')).toBeInTheDocument();
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByText('31/10/2026: Crítico 0, Baixo 2; total 2 achados.')).toBeInTheDocument();
    await userEvent.keyboard('{End}');
    expect(screen.getByText('04/11/2026: Crítico 4, Baixo 1; total 5 achados.')).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.queryByText(/^04\/11\/2026:/)).not.toBeInTheDocument();
  });

  it('o mouse mostra o dia mais perto do ponteiro e a dica sai quando ele sai do gráfico', () => {
    renderChart();
    const chart = screen.getByRole('img', { name: /Achados por dia/ });
    chart.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 640, height: 208 });
    fireEvent.pointerMove(chart, { clientX: 0, pointerType: 'mouse' });
    expect(screen.getByText('31/10/2026: Crítico 0, Baixo 2; total 2 achados.')).toBeInTheDocument();
    fireEvent.pointerMove(chart, { clientX: 640, pointerType: 'mouse' });
    expect(screen.getByText('04/11/2026: Crítico 4, Baixo 1; total 5 achados.')).toBeInTheDocument();
    fireEvent.pointerLeave(chart, { pointerType: 'mouse' });
    expect(screen.queryByText(/^04\/11\/2026:/)).not.toBeInTheDocument();
  });

  it('a tabela de "Ver tabela" tem os mesmos números, do dia mais recente ao mais antigo', async () => {
    renderChart();
    await userEvent.click(screen.getByText('Ver tabela'));
    const table = screen.getByRole('table', { name: 'Achados por dia' });
    const rows = within(table).getAllByRole('row');
    expect(rows[0]).toHaveTextContent('DiaCríticoBaixo');
    expect(rows.slice(1).map((row) => row.textContent)).toEqual([
      '04/11/202641',
      '03/11/202601',
      '02/11/202610',
      '01/11/202631',
      '31/10/202602',
    ]);
    expect(screen.getByRole('region', { name: 'Tabela: Achados por dia' })).toHaveAttribute('tabindex', '0');
  });

  it('um dia só: pontos no lugar das linhas, com a data no meio', () => {
    const { container } = renderChart([{ date: '2026-11-04', critical: 2, low: 1 }]);
    expect(
      screen.getByRole('img', { name: 'Achados por dia, em 04/11/2026: 3 achados.' }),
    ).toBeInTheDocument();
    expect(container.querySelectorAll('path[data-series]')).toHaveLength(0);
    expect(container.querySelectorAll('circle[data-marker]')).toHaveLength(2);
    expect(svgTexts(container)).toContain('04/11');
  });

  it.each([
    ['sem dias', []],
    [
      'sem nenhum achado',
      [
        { date: '2026-11-03', critical: 0, low: 0 },
        { date: '2026-11-04', critical: 0, low: 0 },
      ],
    ],
  ])('%s: o aviso de vazio, sem gráfico nem tabela', (_, rows: readonly LineRow<Key>[]) => {
    renderChart(rows);
    expect(screen.getByText('Nenhum achado no período.')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByText('Ver tabela')).not.toBeInTheDocument();
  });
});

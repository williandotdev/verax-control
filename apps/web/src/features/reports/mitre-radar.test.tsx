import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MITRE_TACTICS, type MitreTactic } from '@verax/shared';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { TACTIC_LABELS } from './labels';
import { MitreRadar } from './mitre-radar';

const tactic = (name: string, data: Partial<MitreTactic> = {}): MitreTactic => ({
  id: MITRE_TACTICS.find((item) => item.name === name)?.id ?? 'TA9999',
  name,
  findings: 0,
  incidents: 0,
  techniques: [],
  ...data,
});

/** As 14 táticas, com as dadas no lugar delas. */
const matrix = (...given: MitreTactic[]): MitreTactic[] =>
  MITRE_TACTICS.map(({ name }) => given.find((item) => item.name === name) ?? tactic(name));

const SEEN = matrix(
  tactic('Reconnaissance', {
    findings: 1_500,
    incidents: 2,
    techniques: [{ id: 'T1595', findings: 1_500 }],
  }),
  tactic('Defense Evasion', {
    findings: 490,
    incidents: 1,
    techniques: [
      { id: 'T1562.008', findings: 300 },
      { id: 'T1070', findings: 120 },
      { id: 'T1562.001', findings: 60 },
      { id: 'T1562', findings: 10 },
    ],
  }),
  tactic('Impact', { findings: 9 }),
  // Sem alerta no período, mas com incidente: continua no percurso e na dica.
  tactic('Collection', { incidents: 1 }),
  tactic('Discovery', { findings: 1, techniques: [{ id: 'T1580', findings: 1 }] }),
);

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

const href = (item: MitreTactic) => `/lista?tatica=${item.id}`;

function renderRadar(tactics: readonly MitreTactic[]) {
  const router = createMemoryRouter(
    [
      { path: '/', element: <MitreRadar tactics={tactics} tacticHref={href} /> },
      { path: '/lista', element: <Where /> },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

const chart = () => screen.getByRole('group', { name: /^Gráfico de radar das táticas do MITRE ATT&CK/ });
const axis = (name: string) => {
  const element = chart().querySelector<SVGElement>(`[data-axis="${tactic(name).id}"]`);
  if (!element) throw new Error(`sem o eixo de ${name}`);
  return element;
};
const tip = () => document.querySelector('[data-spider-tip]');

describe('gráfico do MITRE ATT&CK', () => {
  it('diz quantas táticas têm alerta e as maiores, com a contagem e o percentual', () => {
    renderRadar(SEEN);
    expect(chart()).toHaveAccessibleName(
      'Gráfico de radar das táticas do MITRE ATT&CK: 4 de 14 com alertas. As maiores: Reconhecimento, 1.500 alertas (75%); ' +
        'Evasão de defesas, 490 alertas (25%); Impacto, 9 alertas (menos de 1%). ' +
        'Use as setas para percorrer as táticas e Enter para ver os alertas da tática.',
    );
    expect(
      screen.getByText(
        'Participação de cada tática no período. Um alerta com duas táticas conta nas duas. Escala ampliada perto do centro, para as participações pequenas aparecerem.',
      ),
    ).toBeInTheDocument();
  });

  it('os 14 eixos na ordem da cadeia de ataque, com o nome em português', () => {
    renderRadar(SEEN);
    const axes = [...chart().querySelectorAll('[data-axis]')];
    expect(axes.map((element) => element.getAttribute('data-axis'))).toEqual(
      MITRE_TACTICS.map(({ id }) => id),
    );
    for (const [index, { id, name }] of MITRE_TACTICS.entries()) {
      expect(axes[index]?.getAttribute('aria-label')?.startsWith(`${TACTIC_LABELS[name]} (${id}): `)).toBe(
        true,
      );
      // O texto desenhado é o nome inteiro, em uma ou duas linhas.
      expect(
        [...(axes[index]?.querySelectorAll('tspan') ?? [])].map((line) => line.textContent).join(' '),
      ).toBe(TACTIC_LABELS[name]);
    }
  });

  it('o nome falado traz tudo o que a dica mostra: alertas, percentual, incidentes e técnicas', () => {
    renderRadar(SEEN);
    expect(axis('Defense Evasion')).toHaveAccessibleName(
      'Evasão de defesas (TA0005): 490 alertas (25% do total), 1 incidente. Técnicas mais vistas: T1562.008, T1070 e T1562.001.',
    );
    expect(axis('Discovery')).toHaveAccessibleName(
      'Descoberta (TA0007): 1 alerta (menos de 1% do total), 0 incidentes. Técnicas mais vistas: T1580.',
    );
    expect(axis('Collection')).toHaveAccessibleName('Coleta (TA0009): 0 alertas, 1 incidente.');
  });

  it('só a tática com alerta é link, no gráfico e na lista; sem `tacticHref`, nenhuma é', () => {
    const view = renderRadar(SEEN);
    expect(within(chart()).getAllByRole('link')).toHaveLength(4);
    expect(axis('Defense Evasion')).toHaveAttribute('href', '/lista?tatica=TA0005');
    expect(axis('Collection')).not.toHaveAttribute('href');
    expect(axis('Collection')).toHaveAttribute('role', 'img');
    const list = screen.getByRole('list', { name: 'Táticas com alertas' });
    expect(within(list).getAllByRole('link')).toHaveLength(4);
    view.unmount();

    const plain = render(
      <RouterProvider router={createMemoryRouter([{ path: '/', element: <MitreRadar tactics={SEEN} /> }])} />,
    );
    expect(plain.queryAllByRole('link')).toHaveLength(0);
    expect(chart()).toHaveAccessibleName(/Use as setas para percorrer as táticas\.$/);
    expect(
      within(screen.getByRole('list', { name: 'Táticas com alertas' })).getAllByRole('listitem'),
    ).toHaveLength(4);
  });

  it('a lista: só as táticas com alerta, da maior para a menor, com tudo o que as caixas tinham', () => {
    renderRadar(SEEN);
    const items = within(screen.getByRole('list', { name: 'Táticas com alertas' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Reconhecimento TA0043 · 2 incidentes · T1595 1.500 alertas 75%',
      'Evasão de defesas TA0005 · 1 incidente · T1562.008 490 alertas 25%',
      'Impacto TA0040 · 0 incidentes 9 alertas <1%',
      'Descoberta TA0007 · 0 incidentes · T1580 1 alerta <1%',
    ]);
  });

  it('a série é uma só, com um ponto por tática com alerta; a zerada não ganha ponto', () => {
    renderRadar(SEEN);
    expect(chart().querySelectorAll('[data-series]')).toHaveLength(1);
    expect(axis('Reconnaissance').querySelector('[data-dot]')).not.toBeNull();
    expect(axis('Defense Evasion').querySelector('[data-dot]')).not.toBeNull();
    // Menos de 1%: ainda tem ponto, afastado do centro.
    expect(axis('Impact').querySelector('[data-dot]')).not.toBeNull();
    expect(chart().querySelectorAll('[data-dot]')).toHaveLength(4);
    expect(axis('Collection').querySelector('[data-dot]')).toBeNull();
    // Os percentuais dos anéis.
    for (const ring of ['5%', '25%', '50%', '100%'])
      expect(within(chart()).getByText(ring)).toBeInTheDocument();
  });

  it('nenhum alerta com tática: nada de gráfico nem de lista', () => {
    const { container } = renderRadar(matrix(tactic('Collection', { incidents: 1 })));
    expect(container).toBeEmptyDOMElement();
  });

  it('tática sem tradução: o nome que veio, e o gráfico segue inteiro', () => {
    const tactics = [...SEEN.slice(0, 13), tactic('Brand New Tactic', { findings: 4 })];
    renderRadar(tactics);
    expect(chart().querySelector('[data-axis="TA9999"]')).toHaveAccessibleName(
      /^Brand New Tactic \(TA9999\): 4 alertas/,
    );
    expect(screen.getByRole('link', { name: /^Brand New Tactic TA9999/ })).toBeInTheDocument();
  });

  it('o mouse mostra a dica no nome e no ponto; sair esconde, e o clique abre a lista da tática', async () => {
    const user = userEvent.setup();
    renderRadar(SEEN);
    const [label, point] = [
      axis('Defense Evasion').querySelector('rect') as SVGElement,
      axis('Defense Evasion').querySelector('circle') as SVGElement,
    ];
    await user.hover(label);
    expect(tip()).toHaveTextContent(
      'Evasão de defesas TA000525% · 490 alertas · 1 incidenteTécnicas: T1562.008 (300) T1070 (120) T1562.001 (60)',
    );
    expect(axis('Defense Evasion')).toHaveAttribute('data-active', 'true');
    await user.unhover(label);
    expect(tip()).toBeNull();
    await user.hover(point);
    expect(tip()).toHaveTextContent('Evasão de defesas');
    // A tática zerada também tem dica, sem link.
    await user.hover(axis('Collection').querySelector('rect') as SVGElement);
    expect(tip()).toHaveTextContent('Coleta TA00090% · 0 alertas · 1 incidente');
    await user.click(point);
    expect(await screen.findByTestId('where')).toHaveTextContent('/lista?tatica=TA0005');
  });

  it('teclado: uma parada só (a primeira tática com alerta), as setas dão a volta com a dica, Esc fecha e Enter abre', async () => {
    const user = userEvent.setup();
    renderRadar(SEEN);
    const stops = () =>
      [...chart().querySelectorAll('[data-axis]')].filter(
        (element) => element.getAttribute('tabindex') === '0',
      );
    expect(stops()).toEqual([axis('Reconnaissance')]);

    await user.tab();
    expect(axis('Reconnaissance')).toHaveFocus();
    expect(tip()).toHaveTextContent('Reconhecimento TA0043');
    await user.keyboard('{ArrowRight}');
    expect(axis('Resource Development')).toHaveFocus();
    expect(stops()).toEqual([axis('Resource Development')]);
    // Tática sem alerta: Enter não leva a lugar nenhum.
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('where')).toBeNull();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(axis('Impact')).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(axis('Reconnaissance')).toHaveFocus();
    await user.keyboard('{End}');
    expect(axis('Impact')).toHaveFocus();
    await user.keyboard('{Home}{ArrowUp}');
    expect(axis('Impact')).toHaveFocus();
    expect(tip()).toHaveTextContent('Impacto TA0040');

    await user.keyboard('{Escape}');
    expect(tip()).toBeNull();
    expect(axis('Impact')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(tip()).toHaveTextContent('Exfiltração TA0010');
    await user.keyboard('{End}{Enter}');
    expect(await screen.findByTestId('where')).toHaveTextContent('/lista?tatica=TA0040');
  });

  it('Esc também fecha a dica do mouse; sair do gráfico com o foco esconde a dica', async () => {
    const user = userEvent.setup();
    renderRadar(SEEN);
    await user.hover(axis('Impact').querySelector('rect') as SVGElement);
    expect(tip()).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(tip()).toBeNull();

    await user.tab();
    expect(tip()).not.toBeNull();
    await user.tab();
    expect(tip()).toBeNull();
    expect(screen.getByRole('link', { name: /^Reconhecimento TA0043/ })).toHaveFocus();
  });

  it('no toque, o primeiro toque mostra a dica (e a fala); o segundo, na mesma tática, abre', async () => {
    const user = userEvent.setup();
    const { container } = renderRadar(SEEN);
    const live = container.querySelector('[aria-live="polite"]');
    const label = (name: string) => axis(name).querySelector('rect') as SVGElement;

    await user.pointer({ keys: '[TouchA]', target: label('Defense Evasion') });
    expect(tip()).toHaveTextContent('Evasão de defesas');
    expect(tip()).toHaveTextContent('Toque de novo para ver os alertas.');
    expect(live).toHaveTextContent(/^Evasão de defesas \(TA0005\): 490 alertas/);
    expect(screen.queryByTestId('where')).toBeNull();

    // Outra tática: troca a dica, sem abrir. A zerada não oferece o segundo toque, e dois toques nela não abrem nada.
    await user.pointer({ keys: '[TouchA]', target: label('Collection') });
    await user.pointer({ keys: '[TouchA]', target: label('Collection') });
    expect(tip()).toHaveTextContent('Coleta');
    expect(tip()).not.toHaveTextContent('Toque de novo');
    expect(screen.queryByTestId('where')).toBeNull();

    // Tocar fora fecha e desarma: o próximo toque mostra a dica de novo.
    await user.pointer({ keys: '[TouchA]', target: label('Defense Evasion') });
    fireEvent.pointerDown(document.body);
    expect(tip()).toBeNull();
    await user.pointer({ keys: '[TouchA]', target: label('Defense Evasion') });
    expect(tip()).not.toBeNull();
    expect(screen.queryByTestId('where')).toBeNull();

    await user.pointer({ keys: '[TouchA]', target: label('Defense Evasion') });
    expect(await screen.findByTestId('where')).toHaveTextContent('/lista?tatica=TA0005');
  });

  it('depois de um toque, o clique do mouse em outra tática abre direto (aparelho com os dois)', async () => {
    const user = userEvent.setup();
    renderRadar(SEEN);
    await user.pointer({ keys: '[TouchA]', target: axis('Impact').querySelector('rect') as SVGElement });
    expect(screen.queryByTestId('where')).toBeNull();
    await user.click(axis('Defense Evasion').querySelector('rect') as SVGElement);
    expect(await screen.findByTestId('where')).toHaveTextContent('/lista?tatica=TA0005');
  });
});

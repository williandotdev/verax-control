import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNTRY_POINTS, WORLD_MAP_WIDTH } from './world-map-data';
import { WorldMap } from './world-map';
import { type CountryTraffic, pulsePhase, type WorldTraffic } from './world-map-model';

const none = { requests: 0, blocked: 0, flagged: 0 };
const country = (code: string, requests: number, extra: Partial<CountryTraffic> = {}): CountryTraffic => ({
  code,
  requests,
  blocked: 0,
  flagged: 0,
  recentRequests: 0,
  recentFlagged: 0,
  ...extra,
});

const COUNTRIES = [
  country('US', 250, { recentRequests: 4 }),
  country('BR', 600, { blocked: 1, recentRequests: 30 }),
  country('RU', 100, { blocked: 20, flagged: 45, recentRequests: 7, recentFlagged: 1 }),
];

const traffic = (extra: Partial<WorldTraffic> = {}): WorldTraffic => ({
  // Horário local: os textos mostram a hora do navegador.
  generatedAt: new Date(2026, 10, 24, 14, 30).toISOString(),
  windowHours: 24,
  recentMinutes: 15,
  countries: COUNTRIES,
  unknown: { requests: 20, blocked: 0, flagged: 1 },
  throughProxy: { requests: 25, blocked: 0, flagged: 0 },
  internal: { requests: 5, blocked: 0, flagged: 0 },
  ...extra,
});

const renderMap = (data: WorldTraffic = traffic(), userId = 'pessoa-a') =>
  render(<WorldMap traffic={data} userId={userId} />);

/** Responde ao `prefers-reduced-motion` como pedido; o resto, como o setup padrão (nada casa). */
function mockReducedMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('reduced-motion') ? reduce : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

/** O jsdom não mede nada: o mapa fica com 960 px, a largura de reserva, a partir do canto da tela. */
function mockMapBox() {
  vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 960,
    height: 393.6,
    right: 960,
    bottom: 393.6,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

/** Onde fica o ponto de um país na tela do teste. */
const at = (code: string, dx = 0) => {
  const [x, y] = COUNTRY_POINTS[code] ?? [NaN, NaN];
  return { clientX: (x * 960) / WORLD_MAP_WIDTH + dx, clientY: (y * 960) / WORLD_MAP_WIDTH };
};

afterEach(() => {
  vi.restoreAllMocks();
});

const map = () => screen.getByRole('group', { name: /^Mapa de origens/ });
const dot = (name: string) =>
  within(map()).getByRole('img', { name: (label) => label.startsWith(`${name}:`) });
const tip = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-map-tip]');
const pulses = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[data-pulse]')].map((pulse) => pulse.dataset['pulse']);

describe('mapa de origens', () => {
  it('diz o resumo por extenso: total da janela (com o que está fora do mapa), países, suspeitas e bloqueadas', () => {
    renderMap();
    const headline = screen.getByText('1.000 requisições').closest('p');
    expect(headline).toHaveTextContent(
      '1.000 requisições nas últimas 24 horas, de 3 países identificados: 46 suspeitas (1 país marcado) e 21 bloqueadas.',
    );
    expect(screen.getByText('Atualizado às 14:30')).toBeInTheDocument();
    expect(map()).toHaveAccessibleName(
      'Mapa de origens nas últimas 24 horas: 3 países no mapa; com mais requisições, Brasil (60%), Estados Unidos (25%) e ' +
        'Rússia (10%). Use as setas para percorrer os países, do maior volume ao menor.',
    );
  });

  it('cada ponto diz o país e todos os números; o suspeito tem outra forma e outra cor, com anel', () => {
    renderMap();
    expect(within(map()).getAllByRole('img')).toHaveLength(3);
    expect(dot('Brasil')).toHaveAccessibleName(
      'Brasil: 600 requisições, 60% do total; 1 bloqueada, 0 suspeitas; 30 nos últimos 15 minutos',
    );
    expect(dot('Rússia')).toHaveAccessibleName(
      'Rússia: 100 requisições, 10% do total; 20 bloqueadas, 45 suspeitas; 7 nos últimos 15 minutos (1 suspeita)',
    );
    // Comum: círculo na tinta neutra, sem anel.
    const ordinary = dot('Brasil').querySelector('[data-dot]');
    expect(ordinary?.tagName).toBe('circle');
    expect(ordinary).toHaveClass('fill-muted-foreground');
    expect(dot('Brasil').querySelector('[data-flagged-ring]')).toBeNull();
    // Suspeito: octógono na cor do crítico, com o anel.
    const suspect = dot('Rússia').querySelector('[data-dot]');
    expect(suspect?.tagName).toBe('polygon');
    expect(suspect?.getAttribute('points')?.split(' ')).toHaveLength(8);
    expect(suspect).toHaveClass('fill-critical');
    expect(dot('Rússia').querySelector('[data-flagged-ring]')).not.toBeNull();
  });

  it('sem requisição recente, o ponto diz "nenhuma"', () => {
    renderMap(traffic({ countries: [country('BR', 2, { flagged: 1 })], recentMinutes: 1, windowHours: 1 }));
    expect(dot('Brasil')).toHaveAccessibleName(
      'Brasil: 2 requisições, 3,8% do total; 0 bloqueadas, 1 suspeita; nenhuma no último minuto',
    );
    expect(screen.getByText('52 requisições').closest('p')).toHaveTextContent(
      '52 requisições na última hora, de 1 país identificado: 2 suspeitas e nenhuma bloqueada.',
    );
  });

  it('poucas suspeitas não marcam o país: o ponto e a dica são os comuns, e o número continua à vista', async () => {
    mockMapBox();
    mockReducedMotion(false);
    const user = userEvent.setup();
    const { container } = renderMap(
      traffic({
        countries: [country('BR', 10_000, { flagged: 49, recentRequests: 9, recentFlagged: 3 })],
        unknown: none,
      }),
    );
    expect(dot('Brasil').querySelector('[data-dot]')?.tagName).toBe('circle');
    expect(dot('Brasil')).toHaveAccessibleName(
      'Brasil: 10.000 requisições, 99% do total; 0 bloqueadas, 49 suspeitas; 9 nos últimos 15 minutos (3 suspeitas)',
    );
    expect(container.querySelector('[data-pulse="BR"]')?.className).toContain('text-muted-foreground');
    expect(screen.queryByText(/com muitas requisições suspeitas/)).not.toBeInTheDocument();
    await user.pointer({ target: map(), coords: at('BR') });
    expect(tip(container)).toHaveTextContent('Suspeitas49');
    expect(tip(container)?.querySelector('svg')).toBeNull();
    expect(screen.getByText('49 suspeitas').closest('p')).toHaveTextContent(
      /: 49 suspeitas e nenhuma bloqueada.$/,
    );
  });

  it('a nota diz a partir de quanto o país é marcado, na janela que o mapa mostra', () => {
    const { rerender } = renderMap();
    expect(
      screen.getByText(
        /o país só é marcado com 50 ou mais suspeitas na janela, ou com 10 ou mais que sejam pelo menos 1% das requisições dele\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Muitas requisições suspeitas')).toBeInTheDocument();
    rerender(<WorldMap traffic={traffic({ windowHours: 168 })} userId="pessoa-a" />);
    expect(screen.getByText(/com 350 ou mais suspeitas na janela, ou com 70 ou mais/)).toBeInTheDocument();
  });

  it('a janela de dias é dita em dias, no resumo, no nome do mapa e na tabela', () => {
    renderMap(traffic({ windowHours: 168 }));
    expect(screen.getByText('1.000 requisições').closest('p')).toHaveTextContent(
      /^1\.000 requisições nos últimos 7 dias, de 3 países/,
    );
    expect(map()).toHaveAccessibleName(/^Mapa de origens nos últimos 7 dias: 3 países no mapa/);
    expect(screen.getByText(/^Ver em tabela/)).toHaveTextContent('Origem das requisições nos últimos 7 dias');
  });

  it('com a hora do último intervalo completo, o "agora" é dito até ela: no ponto, na dica, na legenda e na tabela', async () => {
    mockMapBox();
    mockReducedMotion(false);
    const user = userEvent.setup();
    const { container } = renderMap(traffic({ recentUntil: new Date(2026, 10, 24, 14, 20).toISOString() }));
    expect(screen.getByText(/^Atualizado às 14:30/)).toHaveTextContent(
      'Atualizado às 14:30, com os logs completos até 14:20',
    );
    expect(dot('Estados Unidos')).toHaveAccessibleName(/; 4 nos 15 minutos até 14:20$/);
    expect(screen.getByText('Onda: requisições nos 15 minutos até 14:20')).toBeInTheDocument();
    await user.pointer({ target: map(), coords: at('RU', 6) });
    expect(tip(container)).toHaveTextContent('15 min até 14:207 (1 suspeita)');
    expect(screen.getByRole('columnheader', { name: '15 min até 14:20', hidden: true })).toBeInTheDocument();
  });

  it('um minuto só, até a hora do último intervalo completo', () => {
    renderMap(traffic({ recentMinutes: 1, recentUntil: new Date(2026, 10, 24, 14, 20).toISOString() }));
    expect(dot('Brasil')).toHaveAccessibleName(/; 30 no minuto até 14:20$/);
  });

  it('diz quanto da origem desconhecida pode ser de uma CDN; sem nada disso, não diz', () => {
    const { rerender } = renderMap(traffic({ unverified: 12 }));
    expect(
      screen.getByText(
        'Da origem desconhecida, 12 requisições vieram de endereço público que pode ser do visitante ou de uma CDN.',
      ),
    ).toBeInTheDocument();
    rerender(<WorldMap traffic={traffic({ unverified: 1 })} userId="pessoa-a" />);
    expect(screen.getByText(/^Da origem desconhecida, 1 requisição veio de endereço/)).toBeInTheDocument();
    rerender(<WorldMap traffic={traffic({ unverified: 0 })} userId="pessoa-a" />);
    expect(screen.queryByText(/^Da origem desconhecida/)).not.toBeInTheDocument();
  });

  it('o menor é desenhado por cima do maior, e o raio acompanha o volume', () => {
    renderMap();
    const codes = within(map())
      .getAllByRole('img')
      .map((item) => item.getAttribute('data-country'));
    expect(codes).toEqual(['BR', 'US', 'RU']);
    const radius = (name: string) => Number(dot(name).querySelector('[data-dot]')?.getAttribute('r'));
    expect(radius('Brasil')).toBeGreaterThan(radius('Estados Unidos'));
  });

  it('a terra é um desenho só, sem texto nem fronteira, escondido do leitor de tela', () => {
    const { container } = renderMap();
    const land = container.querySelector('[data-land]');
    expect(land).toHaveAttribute('fill-rule', 'evenodd');
    expect(land?.closest('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('[data-land]')).toHaveLength(1);
  });
});

describe('animação', () => {
  it('pulsa só quem teve requisição agora; a onda sai na cor do crítico só com suspeita agora', () => {
    mockReducedMotion(false);
    const { container } = renderMap(
      traffic({
        countries: [...COUNTRIES, country('DE', 90, { flagged: 3, recentRequests: 2 }), country('FR', 80)],
      }),
    );
    expect(pulses(container)).toEqual(['BR', 'US', 'RU', 'DE']);
    const color = (code: string) => container.querySelector(`[data-pulse="${code}"]`)?.className;
    expect(color('RU')).toContain('text-critical-text');
    expect(color('DE')).toContain('text-muted-foreground');
    expect(color('BR')).toContain('text-muted-foreground');
    // Cada um na sua fase, e escondidas do leitor de tela.
    for (const code of ['BR', 'US', 'RU', 'DE'])
      expect(container.querySelector<HTMLElement>(`[data-pulse="${code}"]`)?.style.animationDelay).toBe(
        `${-pulsePhase(code)}ms`,
      );
    expect(new Set(['BR', 'US', 'RU', 'DE'].map((code) => pulsePhase(code))).size).toBe(4);
    expect(container.querySelector('[data-pulse]')?.closest('[aria-hidden]')).not.toBeNull();
  });

  it('o botão pausa e retoma; parado, quem pulsaria mostra um anel fixo', async () => {
    mockReducedMotion(false);
    const user = userEvent.setup();
    // O Peru não teve requisição agora: nem onda, nem anel.
    const { container } = renderMap(traffic({ countries: [...COUNTRIES, country('PE', 3)] }));
    expect(container.querySelectorAll('[data-still-ring]')).toHaveLength(0);
    expect(screen.getByText('Onda: requisições nos últimos 15 minutos')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pausar a animação do mapa' }));
    expect(pulses(container)).toEqual([]);
    expect(container.querySelectorAll('[data-still-ring]')).toHaveLength(3);
    expect(screen.getByText('Anel tracejado: requisições nos últimos 15 minutos')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retomar a animação do mapa' }));
    expect(pulses(container)).toEqual(['BR', 'US', 'RU']);
    expect(container.querySelectorAll('[data-still-ring]')).toHaveLength(0);
  });

  it('a escolha fica guardada neste navegador, por pessoa', async () => {
    mockReducedMotion(false);
    const user = userEvent.setup();
    const first = renderMap(traffic(), 'pessoa-a');
    await user.click(screen.getByRole('button', { name: /^Pausar/ }));
    first.unmount();

    const again = renderMap(traffic(), 'pessoa-a');
    expect(pulses(again.container)).toEqual([]);
    expect(screen.getByRole('button', { name: /^Retomar/ })).toBeInTheDocument();
    again.unmount();

    const other = renderMap(traffic(), 'pessoa-b');
    expect(pulses(other.container)).toHaveLength(3);
  });

  it('com menos movimento pedido, começa parado; ligar vale só daquela vez e não é guardado', async () => {
    window.localStorage.setItem('verax:mapa-mundi:animacao:pessoa-a', 'ligada');
    mockReducedMotion(true);
    const user = userEvent.setup();
    const first = renderMap();
    expect(pulses(first.container)).toEqual([]);
    expect(first.container.querySelectorAll('[data-still-ring]')).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /^Retomar/ }));
    expect(pulses(first.container)).toHaveLength(3);
    await user.click(screen.getByRole('button', { name: /^Pausar/ }));
    expect(pulses(first.container)).toEqual([]);
    expect(window.localStorage.getItem('verax:mapa-mundi:animacao:pessoa-a')).toBe('ligada');
    await user.click(screen.getByRole('button', { name: /^Retomar/ }));
    first.unmount();
    expect(pulses(renderMap().container)).toEqual([]);
  });

  it('sem o armazenamento do navegador, o botão continua valendo', async () => {
    mockReducedMotion(false);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    const { container } = renderMap();
    await userEvent.setup().click(screen.getByRole('button', { name: /^Pausar/ }));
    expect(pulses(container)).toEqual([]);
  });

  it('com muitos países ativos, pulsam os 60 mais ativos, e o texto diz quantos eram', () => {
    mockReducedMotion(false);
    const many = Object.keys(COUNTRY_POINTS)
      .slice(0, 100)
      .map((code, index) => country(code, 100, { recentRequests: index + 1 }));
    const { container } = renderMap(traffic({ countries: many }));
    expect(within(map()).getAllByRole('img')).toHaveLength(100);
    expect(pulses(container)).toHaveLength(60);
    expect(
      screen.getByText(
        'A marca de atividade fica só nos 60 países com mais requisições nos últimos 15 minutos, de 100 com requisições nesse tempo.',
      ),
    ).toBeInTheDocument();
  });

  it('com a fonte parada, não fala em limite de ondas: não há onda', () => {
    const many = Object.keys(COUNTRY_POINTS)
      .slice(0, 100)
      .map((code) => country(code, 100, { recentRequests: 1 }));
    renderMap(traffic({ countries: many, state: 'stale' }));
    expect(screen.queryByText(/A marca de atividade fica só/)).not.toBeInTheDocument();
  });

  it('sem passar do limite, não fala em limite', () => {
    renderMap();
    expect(screen.queryByText(/A marca de atividade fica só/)).not.toBeInTheDocument();
  });

  it('sem ninguém ativo agora, não há o que pausar', () => {
    const { container } = renderMap(traffic({ countries: [country('BR', 10)] }));
    expect(pulses(container)).toEqual([]);
    expect(screen.queryByRole('button', { name: /^(Pausar|Retomar)/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/^Onda:/)).not.toBeInTheDocument();
  });
});

describe('teclado', () => {
  it('uma parada só (o maior volume); as setas percorrem com a dica; Home, End e Esc', async () => {
    const user = userEvent.setup();
    const { container } = renderMap(
      traffic({ countries: COUNTRIES.map((item) => ({ ...item, recentRequests: 0 })) }),
    );
    const stops = within(map())
      .getAllByRole('img')
      .filter((item) => item.getAttribute('tabindex') === '0');
    expect(stops).toEqual([dot('Brasil')]);

    await user.tab();
    expect(dot('Brasil')).toHaveFocus();
    expect(tip(container)).toHaveTextContent('Brasil');
    expect(container.querySelector('[data-ring="BR"]')).not.toBeNull();

    await user.keyboard('{ArrowRight}');
    expect(dot('Estados Unidos')).toHaveFocus();
    expect(tip(container)).toHaveTextContent('Estados Unidos');
    expect(dot('Estados Unidos')).toHaveAttribute('tabindex', '0');
    expect(dot('Brasil')).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{ArrowDown}');
    expect(dot('Rússia')).toHaveFocus();
    // No fim, fica no último.
    await user.keyboard('{ArrowDown}');
    expect(dot('Rússia')).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(dot('Estados Unidos')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(dot('Brasil')).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(dot('Brasil')).toHaveFocus();
    await user.keyboard('{End}');
    expect(dot('Rússia')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(dot('Brasil')).toHaveFocus();

    // Esc fecha a dica e deixa o foco (com o anel) onde está.
    await user.keyboard('{Escape}');
    expect(tip(container)).toBeNull();
    expect(dot('Brasil')).toHaveFocus();
    expect(container.querySelector('[data-ring="BR"]')).not.toBeNull();

    // Sair do mapa fecha a dica, e a volta é para o mesmo país.
    await user.keyboard('{End}');
    await user.tab();
    expect(tip(container)).toBeNull();
    expect(container.querySelector('[data-ring]')).toBeNull();
    await user.tab({ shift: true });
    expect(dot('Rússia')).toHaveFocus();
  });

  it('as setas não rolam a página; as outras teclas ficam com o navegador', () => {
    renderMap();
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
      expect(fireEvent.keyDown(dot('Brasil'), { key }), key).toBe(false);
    for (const key of ['Tab', 'PageDown', 'a'])
      expect(fireEvent.keyDown(dot('Brasil'), { key }), key).toBe(true);
  });

  it('se o país da parada sai do mapa, a parada volta ao maior', async () => {
    const user = userEvent.setup();
    const { rerender } = renderMap(
      traffic({ countries: COUNTRIES.map((item) => ({ ...item, recentRequests: 0 })) }),
    );
    await user.tab();
    await user.keyboard('{End}');
    expect(dot('Rússia')).toHaveFocus();
    rerender(
      <WorldMap traffic={traffic({ countries: [country('US', 5), country('BR', 9)] })} userId="pessoa-a" />,
    );
    expect(dot('Brasil')).toHaveAttribute('tabindex', '0');
    expect(dot('Estados Unidos')).toHaveAttribute('tabindex', '-1');
  });
});

describe('mouse e toque', () => {
  it('o mouse mostra a dica do ponto mais perto, com todos os números, e sair esconde', async () => {
    mockMapBox();
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.pointer({ target: map(), coords: at('RU', 6) });
    expect(tip(container)).toHaveTextContent('Rússia');
    expect(tip(container)).toHaveTextContent('Requisições100 (10%)');
    expect(tip(container)).toHaveTextContent('Bloqueadas20');
    expect(tip(container)).toHaveTextContent('Suspeitas45');
    expect(tip(container)?.querySelector('svg')).not.toBeNull();
    expect(tip(container)).toHaveTextContent('Últimos 15 min7 (1 suspeita)');
    expect(container.querySelector('[data-ring="RU"]')).not.toBeNull();
    // Na tela larga, a dica é solta: não há o espaço reservado do celular.
    expect(container.querySelector('[data-map-readout]')).toBeNull();

    await user.pointer({ target: map(), coords: at('BR') });
    expect(tip(container)).toHaveTextContent('Brasil');
    // Longe de qualquer ponto.
    await user.pointer({ target: map(), coords: { clientX: 480, clientY: 380 } });
    expect(tip(container)).toBeNull();

    await user.pointer({ target: map(), coords: at('BR') });
    await user.pointer({ target: document.body });
    expect(tip(container)).toBeNull();
  });

  it('Esc fecha a dica do mouse', async () => {
    mockMapBox();
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.pointer({ target: map(), coords: at('BR') });
    expect(tip(container)).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(tip(container)).toBeNull();
  });

  it('a escala da tela entra na conta: com o mapa na metade do tamanho, o ponto está na metade do caminho', async () => {
    vi.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
      ...{ left: 100, top: 50, width: 480, height: 196.8, right: 580, bottom: 246.8, x: 100, y: 50 },
      toJSON: () => ({}),
    });
    const user = userEvent.setup();
    const { container } = renderMap();
    const { clientX, clientY } = at('BR');
    await user.pointer({ target: map(), coords: { clientX: 100 + clientX / 2, clientY: 50 + clientY / 2 } });
    expect(tip(container)).toHaveTextContent('Brasil');
  });

  it('no toque, o primeiro toque já mostra a dica e a diz ao leitor de tela; tocar no mar ou fora fecha', async () => {
    mockMapBox();
    const user = userEvent.setup();
    const { container } = renderMap();
    const spoken = () => container.querySelector('[aria-live="polite"]')?.textContent;
    await user.pointer({ keys: '[TouchA]', target: map(), coords: at('US') });
    expect(tip(container)).toHaveTextContent('Estados Unidos');
    expect(spoken()).toContain('Estados Unidos: 250 requisições');

    await user.pointer({ keys: '[TouchA]', target: map(), coords: { clientX: 480, clientY: 380 } });
    expect(tip(container)).toBeNull();
    expect(spoken()).toBe('');

    await user.pointer({ keys: '[TouchA]', target: map(), coords: at('RU') });
    expect(tip(container)).toHaveTextContent('Rússia');
    await user.pointer({ keys: '[TouchA]', target: screen.getByText('Principais origens') });
    expect(tip(container)).toBeNull();
  });

  it('arrastar o dedo sobre o mapa não mostra dica, e levantar o dedo não fecha a do toque', async () => {
    mockMapBox();
    const user = userEvent.setup();
    const { container } = renderMap();
    fireEvent.pointerMove(map(), { pointerType: 'touch', ...at('BR') });
    expect(tip(container)).toBeNull();
    await user.pointer({ keys: '[TouchA]', target: map(), coords: at('US') });
    fireEvent.pointerOut(map(), { pointerType: 'touch', relatedTarget: document.body });
    expect(tip(container)).toHaveTextContent('Estados Unidos');
  });

  it('o clique do mouse não anuncia nada ao leitor de tela', async () => {
    mockMapBox();
    const user = userEvent.setup();
    const { container } = renderMap();
    await user.pointer([{ target: map(), coords: at('US') }, { keys: '[MouseLeft]' }]);
    expect(tip(container)).toHaveTextContent('Estados Unidos');
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent('');
  });

  it('passar o mouse numa origem da lista mostra onde ela está no mapa', async () => {
    const user = userEvent.setup();
    const { container } = renderMap();
    const row = container.querySelector('[data-origin="RU"]') as HTMLElement;
    await user.hover(row);
    expect(tip(container)).toHaveTextContent('Rússia');
    await user.unhover(row);
    expect(tip(container)).toBeNull();
  });
});

describe('lista, fora do mapa e tabela', () => {
  it('as principais origens, com o volume, o percentual do total e a marca de suspeita', () => {
    renderMap();
    const list = screen.getByRole('region', { name: 'Principais origens' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      'Brasil600 60%',
      'Estados Unidos250 25%',
      'Rússia (com muitas requisições suspeitas)100 10%',
    ]);
    const bars = rows.map((row) => row.querySelector<HTMLElement>('[style]')?.style.width);
    expect(bars[0]).toBe('100%');
    expect(bars[1]).toMatch(/^41\.6/);
    expect(within(list).queryByText(/^e mais/)).not.toBeInTheDocument();
  });

  it('mostra dez e diz quantos ficaram só na tabela', () => {
    const many = Object.keys(COUNTRY_POINTS)
      .slice(0, 30)
      .map((code, index) => country(code, 1_000_000 - index));
    renderMap(traffic({ countries: many }));
    const list = screen.getByRole('region', { name: 'Principais origens' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByText('e mais 20 países, na tabela')).toBeInTheDocument();
  });

  it('uma linha diz tudo o que não está no mapa, com o percentual', () => {
    const { container } = renderMap();
    expect(container.querySelector('[data-off-map]')).toHaveTextContent(
      /^Fora do mapa: 20 de origem desconhecida \(2%\), 5 de endereço interno \(0,5%\) e 25 por CDN ou proxy \(2,5%\)\.$/,
    );
    expect(
      screen.getByText(/^Por CDN ou proxy, o log traz o endereço da CDN, e não o país de quem acessou/),
    ).toBeInTheDocument();
    expect(screen.getByText(/VPN, proxy e nuvem podem esconder a origem real/)).toBeInTheDocument();
  });

  it('sem nada fora do mapa, não há linha; país sem ponto é nomeado', () => {
    const all = { unknown: none, throughProxy: none, internal: none };
    const { container, rerender } = renderMap(traffic(all));
    expect(container.querySelector('[data-off-map]')).toBeNull();
    expect(screen.queryByText(/^Por CDN ou proxy/)).not.toBeInTheDocument();
    rerender(
      <WorldMap
        traffic={traffic({ ...all, countries: [country('BR', 5), country('GI', 2), country('AQ', 1)] })}
        userId="pessoa-a"
      />,
    );
    expect(container.querySelector('[data-off-map]')).toHaveTextContent(
      /^Sem ponto no mapa \(só na lista e na tabela\): Gibraltar e Antártida\.$/,
    );
    expect(within(map()).getAllByRole('img')).toHaveLength(1);
    expect(map()).toHaveAccessibleName(/1 país no mapa/);
  });

  it('a tabela tem todos os países e o que está fora do mapa, com os mesmos números', async () => {
    const user = userEvent.setup();
    renderMap(traffic({ countries: [...COUNTRIES, country('GI', 1)] }));
    await user.click(screen.getByText(/^Ver em tabela \(4 países\)/));
    const table = screen.getByRole('table', { name: 'Origem das requisições nas últimas 24 horas' });
    const rows = within(table)
      .getAllByRole('row')
      .map((row) => [...row.children].map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Origem', 'Requisições', '% do total', 'Bloqueadas', 'Suspeitas', 'Últimos 15 min'],
      ['Brasil', '600', '60%', '1', '0', '30'],
      ['Estados Unidos', '250', '25%', '0', '0', '4'],
      ['Rússia', '100', '10%', '20', '45', '7'],
      ['Gibraltar (sem ponto no mapa)', '1', '0,1%', '0', '0', '0'],
      ['Origem desconhecida (fora do mapa)', '20', '2%', '0', '1', '—'],
      ['Endereço interno (fora do mapa)', '5', '0,5%', '0', '0', '—'],
      ['Por CDN ou proxy (fora do mapa)', '25', '2,5%', '0', '0', '—'],
    ]);
    expect(screen.getByRole('region', { name: /^Tabela: Origem/ })).toHaveAttribute('tabindex', '0');
  });
});

describe('estados', () => {
  it('sem requisições: o mapa vazio com o aviso, sem lista, botão nem tabela', () => {
    const { container } = renderMap(
      traffic({ countries: [], unknown: none, throughProxy: none, internal: none }),
    );
    expect(screen.getAllByText('Nenhuma requisição nas últimas 24 horas.')).toHaveLength(2);
    expect(map()).toHaveAccessibleName('Mapa de origens: nenhum país no mapa nas últimas 24 horas.');
    expect(container.querySelector('[data-land]')).not.toBeNull();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('Principais origens')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Ver em tabela/)).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Legenda do mapa' })).not.toBeInTheDocument();
  });

  it('nenhum país identificado: diz isso, e a linha de fora do mapa e a tabela continuam', () => {
    const { container } = renderMap(traffic({ countries: [country('ZZ', 30)] }));
    expect(screen.getByText('Nenhuma requisição com país identificado.')).toBeInTheDocument();
    expect(screen.getByText('80 requisições').closest('p')).toHaveTextContent(
      '80 requisições nas últimas 24 horas: 1 suspeita e nenhuma bloqueada.',
    );
    expect(container.querySelector('[data-off-map]')).toHaveTextContent(
      'Fora do mapa: 50 de origem desconhecida (63%)',
    );
    expect(screen.getByText(/^Ver em tabela/)).not.toHaveTextContent('países');
  });

  it('só países sem ponto: o mapa diz onde procurar', () => {
    renderMap(traffic({ countries: [country('GI', 3)] }));
    expect(
      screen.getByText('Nenhum dos países tem ponto no mapa: veja a lista e a tabela.'),
    ).toBeInTheDocument();
  });

  it('sem logs novos: diz desde quando, e nada pulsa', () => {
    mockReducedMotion(false);
    const { container } = renderMap(
      traffic({ state: 'stale', lastLogAt: new Date(2026, 10, 24, 13, 5).toISOString() }),
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sem logs novos desde 13:05. O mapa mostra só o que chegou até lá.',
    );
    expect(pulses(container)).toEqual([]);
    expect(container.querySelectorAll('[data-still-ring]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^(Pausar|Retomar)/ })).not.toBeInTheDocument();
    // Os países continuam no mapa.
    expect(within(map()).getAllByRole('img')).toHaveLength(3);
  });

  it('sem logs novos desde outro dia: com a data; sem saber desde quando: só o aviso', () => {
    const { rerender } = renderMap(
      traffic({ state: 'stale', lastLogAt: new Date(2026, 10, 22, 23, 59).toISOString() }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Sem logs novos desde 22/11/2026, 23:59.');
    rerender(<WorldMap traffic={traffic({ state: 'stale', lastLogAt: null })} userId="pessoa-a" />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Sem logs novos\. O mapa/);
  });

  it('atualização que falhou: diz de quando são os números, e nada pulsa', () => {
    mockReducedMotion(false);
    const { container } = renderMap(traffic({ refreshFailed: true }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Não foi possível atualizar agora. Os números são das 14:30.',
    );
    expect(pulses(container)).toEqual([]);
  });

  it('com tudo em ordem, não há aviso', () => {
    renderMap(traffic({ state: 'ok' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('números enormes: por extenso no resumo e na tabela, compactos na lista', () => {
    renderMap(traffic({ countries: [country('BR', 98_765_432_109)] }));
    expect(screen.getByText('98.765.432.159 requisições')).toBeInTheDocument();
    const list = screen.getByRole('region', { name: 'Principais origens' });
    expect(within(list).getByRole('listitem')).toHaveTextContent('Brasil98,8 bi 99%');
  });

  it('sem nada suspeito, diz isso', () => {
    renderMap(traffic({ countries: [country('BR', 10, { blocked: 2 })], unknown: none }));
    expect(screen.getByText('40 requisições').closest('p')).toHaveTextContent(
      '40 requisições nas últimas 24 horas, de 1 país identificado: nenhuma suspeita e 2 bloqueadas.',
    );
  });

  it('todos os códigos do mapa de uma vez: um ponto para cada', () => {
    renderMap(
      traffic({ countries: Object.keys(COUNTRY_POINTS).map((code, index) => country(code, index + 1)) }),
    );
    expect(within(map()).getAllByRole('img')).toHaveLength(246);
  });
});

describe('largura do celular', () => {
  it('a dica fica embaixo do mapa, num lugar reservado, e não solta sobre ele', async () => {
    let notify: ((entries: unknown[]) => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: unknown[]) => void) {
          notify = callback;
        }
        observe() {
          notify?.([{ contentRect: { width: 296 } }]);
        }
        disconnect() {}
      },
    );
    const user = userEvent.setup();
    const { container } = renderMap(
      traffic({ countries: COUNTRIES.map((item) => ({ ...item, recentRequests: 0 })) }),
    );
    const readout = container.querySelector('[data-map-readout]');
    expect(readout).toHaveTextContent('Toque num ponto para ver os números do país.');
    expect(map()).toHaveAttribute('viewBox', '0 0 296 121.36');
    await user.tab();
    expect(readout).toHaveTextContent('Brasil');
    expect(readout).toHaveTextContent('Requisições600 (60%)');
    expect(tip(container)).toBeNull();
    vi.unstubAllGlobals();
  });
});

import { focusManager, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WebTraffic } from '@verax/shared';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { OriginBand } from './origin-band';
import { readOriginPlace, rememberOriginPlace } from './origin-place';
import { STACKED_QUERY } from './strip-preference';
import { ORIGIN_IDLE_POLL_MS, ORIGIN_POLL_MS } from './origin-traffic';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterAll(() => server.close());

const SCOPE = '018f2c1e-0000-7000-8000-00000000a1fa';
const OTHER_SCOPE = '018f2c1e-0000-7000-8000-00000000be7a';
const USER = 'pessoa-a';
/** Carregar o módulo do mapa pode demorar com a máquina ocupada (as suítes rodam juntas no pre-push e no CI). */
const LOAD = { timeout: 12_000 };

const none = { requests: 0, blocked: 0, flagged: 0 };
/** Horário local: os textos mostram a hora do navegador. */
const local = (hour: number, minute: number) => new Date(2026, 10, 24, hour, minute).toISOString();

const traffic = (over: Partial<WebTraffic> = {}): WebTraffic => ({
  state: 'ok',
  window: '24h',
  windowHours: 24,
  generatedAt: local(14, 33),
  recentMinutes: 15,
  lastClosedAt: local(14, 20),
  lastLogAt: local(14, 24),
  countries: [
    { code: 'BR', requests: 12_000, blocked: 1, flagged: 4, recentRequests: 30, recentFlagged: 0 },
    { code: 'US', requests: 500, blocked: 40, flagged: 45, recentRequests: 4, recentFlagged: 1 },
  ],
  unknown: { requests: 20, blocked: 0, flagged: 0 },
  throughProxy: { requests: 30, blocked: 0, flagged: 0 },
  internal: { requests: 5, blocked: 0, flagged: 0 },
  unverified: { requests: 7, blocked: 0, flagged: 0 },
  sources: { authorized: 2, collecting: 2, observing: 0, failing: 0 },
  ...over,
});

/** O que a API responde por janela, e quantas vezes cada uma foi pedida. */
let asked: string[] = [];
function answer(reply: (window: string) => Response | WebTraffic | Promise<Response | WebTraffic>) {
  server.use(
    http.get(`${API_URL}/v1/web-logs/traffic`, async ({ request }) => {
      const window = new URL(request.url).searchParams.get('window') ?? '';
      asked.push(window);
      const body = await reply(window);
      return body instanceof Response ? body : HttpResponse.json(body);
    }),
  );
}
const problem = (status: number, code?: string) =>
  HttpResponse.json({ statusCode: status, message: 'x', code }, { status });

const tree = (props: Partial<Parameters<typeof OriginBand>[0]> = {}) => (
  <MemoryRouter>
    <OriginBand scope={SCOPE} userId={USER} startCollapsed={false} {...props} />
    <p>O resto da página</p>
  </MemoryRouter>
);
function renderBand(props: Partial<Parameters<typeof OriginBand>[0]> = {}) {
  const client = createQueryClient();
  const view = render(<QueryClientProvider client={client}>{tree(props)}</QueryClientProvider>);
  return { ...view, client };
}

const band = () => screen.queryByRole('region', { name: 'Origem das requisições' });
const findBand = () => screen.findByRole('region', { name: 'Origem das requisições' }, LOAD);
const findMap = () => screen.findByRole('group', { name: /^Mapa de origens/ }, LOAD);

const originalMatchMedia = window.matchMedia.bind(window);
function mockMedia(matches: (query: string) => boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: matches(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  asked = [];
  window.localStorage.clear();
});
afterEach(() => {
  server.resetHandlers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
  window.matchMedia = originalMatchMedia;
});

describe('quem não tem o mapa', () => {
  it.each([
    ['o nó com os ataques web desligados', () => problem(404, 'WEB_LOGS_DISABLED')],
    ['o nó de antes, sem a rota', () => problem(404)],
    ['nenhum balanceador autorizado', () => traffic({ state: 'no_source', countries: [] })],
    ['a primeira resposta falhando', () => problem(403)],
    ['uma resposta fora do contrato', () => HttpResponse.json({ ...traffic(), novo: 1 })],
  ])('%s: nada na tela, nem carregando', async (_name, reply) => {
    answer(reply);
    renderBand();
    expect(band()).toBeNull();
    await waitFor(() => expect(asked).toEqual(['24h']));
    await act(() => delay(50));
    expect(band()).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.body.textContent).toBe('O resto da página');
    expect(readOriginPlace(USER, SCOPE)).toBeNull();
  });

  it('o nó que não tem a rota é perguntado uma vez só; sem balanceador, de 5 em 5 minutos', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer(() => problem(404));
    const first = renderBand();
    await waitFor(() => expect(asked).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(3 * ORIGIN_IDLE_POLL_MS));
    // Nem ao voltar para a aba.
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(asked).toHaveLength(1);
    first.unmount();

    asked = [];
    answer(() => traffic({ state: 'no_source', countries: [] }));
    renderBand();
    await waitFor(() => expect(asked).toHaveLength(1));
    await act(() => vi.advanceTimersByTimeAsync(ORIGIN_IDLE_POLL_MS - 5_000));
    expect(asked).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(asked).toHaveLength(2);
  });

  it('quem tinha a faixa e não tem mais: some, e o lugar dela é esquecido', async () => {
    rememberOriginPlace(USER, SCOPE, { height: 500, header: 80 });
    answer(() => traffic({ state: 'no_source', countries: [] }));
    renderBand();
    expect(band()).not.toBeNull();
    await waitFor(() => expect(band()).toBeNull());
    expect(readOriginPlace(USER, SCOPE)).toBeNull();
  });
});

describe('aberta', () => {
  it('o mapa com os números da API, de onde eles saem, e o lugar guardado para a próxima vez', async () => {
    answer(() => traffic());
    renderBand();
    const region = await findBand();
    expect(
      within(region).getByRole('heading', { level: 2, name: 'Origem das requisições' }),
    ).toBeInTheDocument();
    const map = await findMap();
    expect(within(map).getAllByRole('img')).toHaveLength(2);
    expect(region).toHaveTextContent(
      'De que países vieram as requisições, pelos logs de acesso de 2 balanceadores da AWS.',
    );
    expect(region).toHaveTextContent('Atualizado às 14:33, com os logs completos até 14:20');
    expect(within(map).getByRole('img', { name: /^Brasil:/ })).toHaveAccessibleName(
      /; 30 nos 15 minutos até 14:20$/,
    );
    // Só os Estados Unidos passam do limite da marca (45 em 500).
    expect(within(map).getByRole('img', { name: /^Brasil:/ })).not.toHaveAttribute('data-flagged');
    expect(within(map).getByRole('img', { name: /^Estados Unidos:/ })).toHaveAttribute('data-flagged');
    // O que pode ser do visitante ou de uma CDN conta como origem desconhecida, com a nota.
    expect(region.querySelector('[data-off-map]')).toHaveTextContent(/27 de origem desconhecida/);
    expect(region).toHaveTextContent('7 requisições vieram de endereço público que pode ser do visitante');
    expect(readOriginPlace(USER, SCOPE)).toEqual({ height: null, header: null });
    expect(readOriginPlace(USER, OTHER_SCOPE)).toBeNull();
    expect(readOriginPlace('pessoa-b', SCOPE)).toBeNull();
  });

  it('diz quem só observa, quantos estão em dia e quem está com problema, com o caminho', async () => {
    answer(() => traffic({ sources: { authorized: 4, collecting: 3, observing: 2, failing: 1 } }));
    renderBand();
    const region = await findBand();
    await findMap();
    expect(region).toHaveTextContent(
      'de 4 balanceadores da AWS (leitura em dia em 3 de 4 e 2 só observando, sem abrir alertas).',
    );
    expect(region).toHaveTextContent('1 balanceador com problema na leitura: veja o motivo em Contas cloud.');
    expect(within(region).getByRole('link', { name: 'Contas cloud' })).toHaveAttribute(
      'href',
      '/cadastros/contas',
    );
  });

  it('com todos só observando, diz isso uma vez; com um, no singular', async () => {
    answer(() => traffic({ sources: { authorized: 1, collecting: 1, observing: 1, failing: 0 } }));
    renderBand();
    const region = await findBand();
    expect(region).toHaveTextContent('de 1 balanceador da AWS (só observando, sem abrir alertas).');
    expect(within(region).queryByRole('link', { name: 'Contas cloud' })).not.toBeInTheDocument();
  });

  it('parado: desde quando, nada pulsa, e sem repetir "em dia" nos balanceadores', async () => {
    answer(() =>
      traffic({
        state: 'stale',
        lastClosedAt: local(10, 20),
        lastLogAt: local(10, 22),
        sources: { authorized: 2, collecting: 0, observing: 0, failing: 2 },
      }),
    );
    const { container } = renderBand();
    const region = await findBand();
    await findMap();
    expect(within(region).getByText(/^Sem logs novos desde 10:22\.$/)).toBeInTheDocument();
    expect(container.querySelector('[data-pulse]')).toBeNull();
    expect(region).not.toHaveTextContent('leitura em dia');
    expect(region).toHaveTextContent('2 balanceadores com problema na leitura');
  });

  it.each([
    [
      { lastClosedAt: null },
      /A AWS entrega os logs em blocos de 5 minutos, com atraso: o mapa aparece cerca de 15 minutos/,
    ],
    [{}, /A leitura está em dia, e nenhum log chegou ainda: sem requisição, o balanceador não grava log\./],
    [
      { sources: { authorized: 1, collecting: 0, observing: 1, failing: 1 } },
      /A leitura está com problema, e nenhum log chegou ainda\./,
    ],
  ])('aguardando os primeiros logs (%#): diz o que esperar, sem mapa nem período', async (over, text) => {
    answer(() =>
      traffic({
        state: 'waiting',
        countries: [],
        lastLogAt: null,
        sources: { authorized: 1, collecting: 1, observing: 1, failing: 0 },
        ...over,
      }),
    );
    renderBand();
    const region = await findBand();
    expect(within(region).getByRole('status')).toHaveTextContent('Aguardando os primeiros logs');
    expect(within(region).getByRole('status')).toHaveTextContent(text);
    expect(region.querySelector('[data-world-map]')).toBeNull();
    expect(
      within(region).queryByRole('group', { name: 'Período do mapa de origens' }),
    ).not.toBeInTheDocument();
  });

  it('a cada minuto, com a aba à vista; em segundo plano, para; ao voltar, pede', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer(() => traffic());
    renderBand();
    await findBand();
    expect(asked).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(ORIGIN_POLL_MS + 1_000));
    await waitFor(() => expect(asked).toHaveLength(2));
    act(() => focusManager.setFocused(false));
    await act(() => vi.advanceTimersByTimeAsync(5 * ORIGIN_POLL_MS));
    expect(asked).toHaveLength(2);
    act(() => focusManager.setFocused(true));
    await waitFor(() => expect(asked).toHaveLength(3));
  });

  it('a atualização que falha mantém os números, com o aviso, e nada pulsa; a seguinte volta ao normal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failing = false;
    answer(() => (failing ? problem(400) : traffic()));
    const { container } = renderBand();
    await findMap();
    expect(container.querySelectorAll('[data-pulse]')).toHaveLength(2);
    failing = true;
    await act(() => vi.advanceTimersByTimeAsync(ORIGIN_POLL_MS + 1_000));
    expect(await screen.findByText('Não foi possível atualizar agora.')).toBeInTheDocument();
    expect(within(screen.getByRole('group', { name: /^Mapa de origens/ })).getAllByRole('img')).toHaveLength(
      2,
    );
    expect(container.querySelector('[data-pulse]')).toBeNull();
    failing = false;
    await act(() => vi.advanceTimersByTimeAsync(ORIGIN_POLL_MS + 1_000));
    await waitFor(() =>
      expect(screen.queryByText('Não foi possível atualizar agora.')).not.toBeInTheDocument(),
    );
    expect(container.querySelectorAll('[data-pulse]')).toHaveLength(2);
  });
});

describe('o período', () => {
  const week = () =>
    traffic({
      window: '7d',
      windowHours: 168,
      countries: [{ code: 'PT', requests: 9, blocked: 0, flagged: 0, recentRequests: 0, recentFlagged: 0 }],
    });
  const button = (name: string) =>
    within(screen.getByRole('group', { name: 'Período do mapa de origens' })).getByRole('button', { name });

  it('começa em 24 horas; trocar pede a janela e mantém o mapa à vista enquanto ela não vem', async () => {
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer(async (window) => {
      if (window === '24h') return traffic();
      await ready;
      return week();
    });
    renderBand();
    await findMap();
    expect(button('Últimas 24 horas')).toHaveAttribute('aria-pressed', 'true');
    expect(asked).toEqual(['24h']);
    await userEvent.click(button('Últimos 7 dias'));
    await waitFor(() => expect(asked).toEqual(['24h', '7d']));
    expect(screen.getByRole('group', { name: 'Período do mapa de origens' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByRole('group', { name: /^Mapa de origens nas últimas 24 horas/ })).toBeInTheDocument();
    release();
    expect(
      await screen.findByRole('group', { name: /^Mapa de origens nos últimos 7 dias/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Período do mapa de origens' })).toHaveAttribute(
      'aria-busy',
      'false',
    );
    await userEvent.click(button('Últimas 24 horas'));
    expect(screen.getByRole('group', { name: /^Mapa de origens nas últimas 24 horas/ })).toBeInTheDocument();
  });

  it('a janela que não vem: o erro no lugar do mapa, com "Tentar de novo"; as 24 horas continuam', async () => {
    let failing = true;
    answer((window) => (window === '24h' ? traffic() : failing ? problem(400) : week()));
    renderBand();
    await findMap();
    await userEvent.click(button('Últimos 30 dias'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /^Mapa de origens/ })).not.toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await findMap()).toBeInTheDocument();
    await userEvent.click(button('Últimas 24 horas'));
    expect(screen.getByRole('group', { name: /^Mapa de origens nas últimas 24 horas/ })).toBeInTheDocument();
  });

  it('com outra janela escolhida, só ela é pedida a cada minuto; recolhida, só as 24 horas', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    answer((window) => (window === '24h' ? traffic() : week()));
    renderBand();
    await findMap();
    await userEvent.click(button('Últimos 7 dias'), { advanceTimers: vi.advanceTimersByTime });
    await screen.findByRole('group', { name: /^Mapa de origens nos últimos 7 dias/ });
    asked = [];
    await act(() => vi.advanceTimersByTimeAsync(2 * ORIGIN_POLL_MS + 2_000));
    expect(asked).toEqual(['7d', '7d']);
    await userEvent.click(screen.getByRole('button', { name: /^Recolher/ }), {
      advanceTimers: vi.advanceTimersByTime,
    });
    asked = [];
    await act(() => vi.advanceTimersByTimeAsync(2 * ORIGIN_POLL_MS + 2_000));
    expect(new Set(asked)).toEqual(new Set(['24h']));
  });

  it('a fonte que some com outra janela escolhida: a faixa sai', async () => {
    answer((window) => (window === '24h' ? traffic() : traffic({ state: 'no_source', countries: [] })));
    renderBand();
    await findMap();
    await userEvent.click(button('Últimos 7 dias'));
    await waitFor(() => expect(band()).toBeNull());
  });
});

describe('recolher', () => {
  it('a escolha fica guardada por pessoa; recolhida, o mapa não está na página, e os números ficam numa linha', async () => {
    answer(() => traffic());
    const first = renderBand();
    await findMap();
    const toggle = screen.getByRole('button', { name: /^Recolher.*o mapa de origens$/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    const region = await findBand();
    expect(region.querySelector('[data-world-map]')).toBeNull();
    expect(region).toHaveTextContent('12,6 mil requisições em 24 h · 2 países · 1 país com muitas suspeitas');
    expect(within(region).queryByRole('group')).not.toBeInTheDocument();
    first.unmount();

    const again = renderBand();
    expect(await screen.findByRole('button', { name: /^Mostrar.*o mapa de origens$/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await userEvent.click(screen.getByRole('button', { name: /^Mostrar.*o mapa de origens$/ }));
    expect(await findMap()).toBeInTheDocument();
    again.unmount();

    window.localStorage.setItem(`verax:deteccoes:origens:${USER}`, 'recolhido');
    renderBand({ userId: 'pessoa-b' });
    expect(await findMap()).toBeInTheDocument();
  });

  it('o resumo recolhido diz o que pede atenção: parado, aguardando e a atualização que falhou', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem(`verax:deteccoes:origens:${USER}`, 'recolhido');
    let body: WebTraffic | Response = traffic({
      state: 'stale',
      lastLogAt: local(10, 22),
      countries: [{ code: 'BR', requests: 1, blocked: 0, flagged: 0, recentRequests: 0, recentFlagged: 0 }],
      unknown: none,
      throughProxy: none,
      internal: none,
      unverified: none,
    });
    answer(() => body);
    renderBand();
    const region = await findBand();
    expect(region).toHaveTextContent('1 requisição em 24 h · 1 país · sem logs novos desde 10:22');
    body = traffic({ state: 'stale', lastLogAt: null });
    await act(() => vi.advanceTimersByTimeAsync(ORIGIN_POLL_MS + 1_000));
    await waitFor(() => expect(region).toHaveTextContent(/muitas suspeitas · sem logs novosMostrar/));
    body = traffic({ state: 'waiting', countries: [], lastLogAt: null });
    await act(() => vi.advanceTimersByTimeAsync(ORIGIN_POLL_MS + 1_000));
    await waitFor(() => expect(region).toHaveTextContent('aguardando os primeiros logs'));
    expect(region).not.toHaveTextContent('requisições em 24 h');
    body = problem(400);
    await act(() => vi.advanceTimersByTimeAsync(ORIGIN_POLL_MS + 1_000));
    await waitFor(() =>
      expect(region).toHaveTextContent('aguardando os primeiros logs · não foi possível atualizar agora'),
    );
  });

  it('abaixo de 1280 px (tela empilhada) começa recolhida (R-07); por um link direto também, sem mexer na escolha guardada', async () => {
    answer(() => traffic());
    mockMedia((query) => query === STACKED_QUERY);
    const phone = renderBand();
    expect(await screen.findByRole('button', { name: /^Mostrar/ })).toBeInTheDocument();
    phone.unmount();

    mockMedia(() => false);
    window.localStorage.setItem(`verax:deteccoes:origens:${USER}`, 'aberto');
    const linked = renderBand({ startCollapsed: true });
    expect(await screen.findByRole('button', { name: /^Mostrar/ })).toBeInTheDocument();
    expect(window.localStorage.getItem(`verax:deteccoes:origens:${USER}`)).toBe('aberto');
    linked.unmount();
    renderBand();
    expect(await screen.findByRole('button', { name: /^Recolher/ })).toBeInTheDocument();
  });

  it('sem armazenamento no navegador, a faixa funciona com o padrão', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('bloqueado');
    });
    answer(() => traffic());
    renderBand();
    await findMap();
    await userEvent.click(screen.getByRole('button', { name: /^Recolher/ }));
    expect(screen.getByRole('button', { name: /^Mostrar/ })).toBeInTheDocument();
  });
});

describe('o lugar da faixa na página', () => {
  it('quem a tinha vê o lugar reservado, com a altura da última vez, enquanto a resposta não vem', async () => {
    rememberOriginPlace(USER, SCOPE, { height: 611.4, header: 79.2 });
    let release: () => void = () => undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    answer(async () => {
      await ready;
      return traffic();
    });
    renderBand();
    const region = band();
    expect(region).not.toBeNull();
    const loading = within(region as HTMLElement).getByRole('status');
    expect(loading).toHaveTextContent('Carregando o mapa de origens…');
    expect(loading.parentElement?.style.height).toBe('612px');
    // O cabeçalho também: com a resposta, a explicação dele pode passar a duas linhas.
    const header = region?.querySelector('header');
    expect(header?.style.minHeight).toBe('80px');
    release();
    expect(await findMap()).toBeInTheDocument();
    expect(header?.style.minHeight).toBe('');
  });

  it('recolhida, só a moldura', () => {
    rememberOriginPlace(USER, SCOPE, { height: 611, header: 80 });
    answer(() => new Promise<Response>(() => undefined));
    renderBand({ startCollapsed: true });
    expect(band()).not.toBeNull();
    expect(band()?.querySelector('header')?.style.minHeight).toBe('');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('e, se a primeira resposta falha, o erro com "Tentar de novo" (ela existe; só não veio)', async () => {
    rememberOriginPlace(USER, SCOPE, { height: 611, header: 80 });
    let failing = true;
    answer(() => (failing ? problem(400) : traffic()));
    renderBand();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await findMap()).toBeInTheDocument();
  });

  it('a altura do mapa pronto é guardada; com a tabela aberta, não', async () => {
    const callbacks: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: (entries: unknown[]) => void) {
          callbacks.push(() => callback([{ contentRect: { width: 0 } }]));
        }
        observe() {}
        disconnect() {}
      },
    );
    let height = 640;
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    try {
      answer(() => traffic());
      renderBand();
      await findMap();
      act(() => callbacks.forEach((callback) => callback()));
      expect(readOriginPlace(USER, SCOPE)).toEqual({ height: 640, header: 640 });
      await userEvent.click(screen.getByText(/^Ver em tabela/));
      height = 1_000;
      act(() => callbacks.forEach((callback) => callback()));
      expect(readOriginPlace(USER, SCOPE)).toEqual({ height: 640, header: 640 });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

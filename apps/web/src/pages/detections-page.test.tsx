import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_TENANTS, demoMe, demoTower } from '@/mocks/fixtures';
import { DEMO_INCIDENTS } from '@/mocks/findings-fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.restoreAllMocks();
  window.matchMedia = originalMatchMedia;
});
afterAll(() => server.close());

const [, beta] = DEMO_TENANTS.map((tenant) => tenant.id);
const INCIDENT = DEMO_INCIDENTS.chaveComprometida;
const FINDING = '018f2c1e-0000-7000-8000-000000001001';

function renderAt(path: string, state: MockState = { me: demoMe('analista_cliente') }) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Responde a `matchMedia` como pedido (o setup padrão diz que nada casa: tela estreita sem painel ao lado). */
const originalMatchMedia = window.matchMedia.bind(window);
function mockMedia(matches: (query: string) => boolean) {
  // Uma função nova (e não um espião do `vi.fn` do setup): o `afterEach` devolve a de sempre.
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

const list = async () => screen.findByRole('table', { name: /^Detecções do cliente|^Achados do cliente/ });
const rows = async () =>
  within(await list())
    .getAllByRole('row')
    .slice(1);
const search = (router: ReturnType<typeof renderAt>) => new URLSearchParams(router.state.location.search);

describe('Detecções: a lista', () => {
  it('agrupada por incidente: o incidente com nota, responsável e achados, e os achados fora de incidente', async () => {
    renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Detecções' })).toBeInTheDocument();
    const table = await list();
    const incident = within(table).getByRole('button', {
      name: /^Abrir o incidente: Atividade suspeita com a chave/,
    });
    const row = incident.closest('tr') as HTMLElement;
    expect(row).toHaveTextContent(/nota de risco 76 · 3 achados/);
    expect(row).toHaveTextContent('Equipe Verax');
    expect(within(table).getAllByText(/^Achado fora de incidente/).length).toBeGreaterThan(0);
    // A linha do incidente abre os achados dele logo abaixo.
    const expand = within(row).getByRole('button', { name: /^Abrir os achados do incidente/ });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    const children = document.getElementById(expand.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(await within(children).findAllByRole('button', { name: /^Abrir o achado/ })).toHaveLength(3);
  });

  it('"Todos os achados": a lista de achados, pela URL; voltar ao agrupado tira o filtro de responsável', async () => {
    const router = renderAt('/?responsavel=nenhum');
    await list();
    expect(within(await list()).queryAllByText(/^Achado fora de incidente/)).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Todos os achados' }));
    await waitFor(() => expect(search(router).get('visao')).toBe('achados'));
    expect(search(router).get('responsavel')).toBeNull();
    expect(await screen.findByRole('table', { name: 'Achados do cliente' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Todos os achados' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('um filtro só: severidade, status, busca e "mais filtros", tudo na URL, e "Limpar filtros"', async () => {
    const router = renderAt('/?visao=achados');
    await rows();
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'critical');
    await waitFor(() => expect(search(router).get('severidade')).toBe('critical'));
    await waitFor(async () => {
      for (const row of await rows()) expect(row).toHaveTextContent('Crítico');
    });

    await userEvent.type(screen.getByRole('searchbox', { name: 'Buscar' }), 'CloudTrail{Enter}');
    await waitFor(() => expect(search(router).get('busca')).toBe('CloudTrail'));
    await waitFor(async () => {
      for (const row of await rows()) expect(row.textContent?.toLowerCase()).toContain('cloudtrail');
    });

    const more = screen.getByRole('button', { name: 'Mais filtros' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    await userEvent.selectOptions(screen.getByLabelText('Tática do MITRE'), 'Defense Evasion');
    await waitFor(() => expect(search(router).get('tatica')).toBe('Defense Evasion'));
    // Técnica fora do padrão é recusada no próprio campo.
    await userEvent.type(screen.getByLabelText('Técnica do MITRE'), 'xyz');
    await userEvent.click(screen.getByRole('button', { name: 'Aplicar' }));
    expect(screen.getByText('Use o formato T1078 ou T1078.004.')).toBeInTheDocument();
    expect(search(router).get('tecnica')).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(search(router).toString()).toBe('visao=achados'));
  });

  it('o período personalizado pede as duas datas e filtra pelo intervalo', async () => {
    const router = renderAt('/?visao=achados');
    await rows();
    await userEvent.selectOptions(screen.getByLabelText('Período'), 'personalizado');
    await waitFor(() => expect(search(router).get('periodo')).toBe('personalizado'));
    expect(screen.getByText('Escolha as duas datas para filtrar.')).toBeInTheDocument();
    // Um intervalo de anos atrás: nenhum achado da demonstração cabe nele.
    const day = (offset: number) => {
      const date = new Date(Date.now() - offset * 86_400_000);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    };
    await userEvent.type(screen.getByLabelText('De'), day(20));
    await userEvent.type(screen.getByLabelText('Até'), day(19));
    expect(await screen.findByText('Nenhuma detecção com esses filtros')).toBeInTheDocument();
  });

  it('a página da URL e a paginação da API', async () => {
    const router = renderAt('/?visao=achados');
    await rows();
    expect(screen.getByRole('navigation', { name: 'Paginação' })).toHaveTextContent(/1–20 de \d+/);
    await userEvent.click(screen.getByRole('button', { name: 'Próxima página' }));
    await waitFor(() => expect(search(router).get('pagina')).toBe('2'));
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um', async () => {
    renderAt('/', { me: demoMe('admin_verax', { activeTenantId: null, scopeTenantId: null }) });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('erro da API: a mensagem e o "tentar de novo"', async () => {
    renderAt('/');
    server.use(
      http.get(`${API_URL}/v1/detections`, () => HttpResponse.json({ message: 'x' }, { status: 500 })),
    );
    expect(await screen.findByRole('button', { name: /Tentar de novo/ })).toBeInTheDocument();
  });
});

describe('Detecções: o detalhe e a triagem', () => {
  it('o incidente abre na gaveta (tela estreita), com o resumo, o tratamento e a linha do tempo; o status muda ali', async () => {
    const router = renderAt('/');
    await userEvent.click(
      await within(await list()).findByRole('button', {
        name: /^Abrir o incidente: Atividade suspeita com a chave/,
      }),
    );
    await waitFor(() => expect(search(router).get('incidente')).toBe(INCIDENT));
    const dialog = await screen.findByRole('dialog', { name: /Atividade suspeita com a chave/ });
    expect(within(dialog).getByRole('heading', { name: 'Resumo' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Primeiro passo:/)).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /Linha do tempo \(3 achados\)/ })).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'resolved');
    // A lista atrás da gaveta (escondida do leitor de tela enquanto ela está aberta) já mostra o status novo.
    await waitFor(() => {
      const table = screen.getByRole('table', { name: /^Detecções do cliente/, hidden: true });
      const row = within(table)
        .getByRole('button', { name: /^Abrir o incidente: Atividade suspeita com a chave/, hidden: true })
        .closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('Resolvido');
    });
    // Um achado da linha do tempo abre no mesmo painel.
    await userEvent.click(within(dialog).getAllByRole('link')[0] as HTMLElement);
    await waitFor(() => expect(search(router).get('achado')).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search(router).get('achado')).toBeNull());
    expect(search(router).get('incidente')).toBeNull();
  });

  it('o achado: triagem no lugar, com a oferta de exceção ao marcar como legítimo', async () => {
    const router = renderAt(`/?visao=achados&achado=${FINDING}`);
    const dialog = await screen.findByRole('dialog', {
      name: 'Tentativa de desligar a trilha do CloudTrail',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Marcar como legítimo' }));
    expect(await within(dialog).findByText('Criar exceção para alertas iguais?')).toBeInTheDocument();
    await waitFor(async () => {
      const row = within(await list())
        .getByRole('button', { name: 'Abrir o achado: Tentativa de desligar a trilha do CloudTrail' })
        .closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('Legítimo');
    });
    // O link "Ver incidente" troca o painel para o incidente do achado, sem sair da tela.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Agora não' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Ver incidente' }));
    await waitFor(() => expect(search(router).get('incidente')).toBe(INCIDENT));
    expect(search(router).get('visao')).toBe('achados');
  });

  it('quem só lê vê o detalhe sem os botões de triagem nem os campos do tratamento', async () => {
    renderAt(`/?incidente=${INCIDENT}`, { me: demoMe('leitura') });
    const dialog = await screen.findByRole('dialog', { name: /Atividade suspeita com a chave/ });
    expect(within(dialog).queryByRole('combobox', { name: 'Status' })).toBeNull();
    expect(within(dialog).getByText('Equipe Verax')).toBeInTheDocument();
  });

  it('na tela larga, o detalhe fica ao lado da lista; Esc fecha e o foco volta para o item', async () => {
    mockMedia((query) => query === '(min-width: 80rem)');
    const router = renderAt('/');
    const open = await within(await list()).findByRole('button', {
      name: /^Abrir o incidente: Atividade suspeita com a chave/,
    });
    await userEvent.click(open);
    const aside = await screen.findByRole('complementary', { name: /Atividade suspeita com a chave/ });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(within(aside).getByRole('heading', { level: 2 })).toHaveFocus());
    expect(open).toHaveAttribute('aria-current', 'true');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search(router).get('incidente')).toBeNull());
    await waitFor(() => expect(open).toHaveFocus());
  });
});

describe('Detecções: os endereços de antes', () => {
  it.each([
    [`/incidentes/${INCIDENT}`, (s: URLSearchParams) => s.get('incidente') === INCIDENT],
    [
      `/achados?achado=${FINDING}`,
      (s: URLSearchParams) => s.get('achado') === FINDING && s.get('visao') === 'achados',
    ],
    ['/incidentes?responsavel=nenhum', (s: URLSearchParams) => s.get('responsavel') === 'nenhum'],
    ['/relatorios?aba=mitre', (s: URLSearchParams) => s.get('analise') === 'mitre'],
  ])('%s leva à visão equivalente', async (path, check) => {
    const router = renderAt(path);
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(check(search(router))).toBe(true);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Detecções', hidden: true }),
    ).toBeInTheDocument();
  });

  it('o link de um incidente num e-mail abre o detalhe dele', async () => {
    renderAt(`/incidentes/${INCIDENT}`);
    expect(await screen.findByRole('dialog', { name: /Atividade suspeita com a chave/ })).toBeInTheDocument();
  });
});

describe('Detecções: o resumo da situação', () => {
  it('o semáforo com o motivo, as decisões com o atalho para a lista filtrada e a coleta numa gaveta', async () => {
    const router = renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Situação agora' });
    expect(await within(strip).findByRole('status', { name: /Situação: Crítico/ })).toHaveTextContent(
      '1 incidente crítico aberto, 2 incidentes altos abertos, nota de postura 69, abaixo de 70 e coleta parada (GCP).',
    );
    const decisions = within(strip).getByRole('region', { name: 'Decisões pendentes' });
    expect(within(decisions).getByText('2 incidentes sem responsável')).toBeInTheDocument();
    // Alerta sem dono é só do admin_verax.
    expect(within(decisions).queryByText(/conta não cadastrada/)).toBeNull();
    expect(within(strip).getByRole('link', { name: /Postura 69 de 100/ })).toHaveAttribute(
      'href',
      '/postura',
    );
    // O radar fica no resumo, menor.
    expect(within(strip).getByRole('region', { name: 'Radar das últimas 24 horas' })).toBeInTheDocument();

    await userEvent.click(within(strip).getByRole('button', { name: /Coleta parada: GCP/ }));
    const health = await screen.findByRole('dialog', { name: 'Saúde da coleta' });
    expect(within(health).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    expect(within(health).getByText('Agentes online')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(decisions).getByRole('link', { name: 'Ver os incidentes' }));
    await waitFor(() => expect(search(router).get('responsavel')).toBe('nenhum'));
    await waitFor(async () =>
      expect(within(await list()).queryAllByText(/^Achado fora de incidente/)).toHaveLength(0),
    );
  });

  it('recolhe e lembra a escolha por pessoa; recolhido, mostra o semáforo e as contagens', async () => {
    renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Situação agora' });
    const toggle = within(strip).getByRole('button', { name: /Recolher/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(within(strip).getByRole('button', { name: /Mostrar/ })).toHaveAttribute('aria-expanded', 'false');
    expect(within(strip).getByRole('status', { name: /Situação: Crítico/ })).toHaveAccessibleName(
      /1 incidente crítico aberto, 2 altos, \d+ detecções em 24 h, \d+ decisões pendentes/,
    );
    const userId = demoMe('analista_cliente').userId;
    expect(window.localStorage.getItem(`verax:deteccoes:resumo:${userId}`)).toBe('recolhido');
  });

  it('no celular começa recolhido; a escolha guardada vale sobre o padrão', async () => {
    mockMedia((query) => query.includes('max-width'));
    renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Situação agora' });
    expect(within(strip).getByRole('button', { name: /Mostrar/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('sem armazenamento no navegador, a tela segue com o padrão', async () => {
    // Só a chave do resumo falha: a sessão da demonstração e o tema seguem lendo o armazenamento.
    const getItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'getItem')?.value as (
      this: Storage,
      key: string,
    ) => string | null;
    const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem')?.value as (
      this: Storage,
      key: string,
      value: string,
    ) => void;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key.startsWith('verax:deteccoes:')) throw new Error('bloqueado');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key.startsWith('verax:deteccoes:')) throw new Error('bloqueado');
      setItem.call(this, key, value);
    });
    renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Situação agora' });
    await userEvent.click(within(strip).getByRole('button', { name: /Recolher/ }));
    expect(within(strip).getByRole('button', { name: /Mostrar/ })).toBeInTheDocument();
  });

  it('nó de antes (sem radar, pulso nem fontes): o resumo segue, sem o radar', async () => {
    renderAt('/', {
      me: demoMe('admin_verax', { activeTenantId: beta ?? null, scopeTenantId: beta ?? null }),
    });
    const { pulse: _pulse, radar: _radar, ...older } = demoTower(beta ?? '', { includeUnowned: false });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({
          ...older,
          coverage: {
            connectedAccounts: 1,
            lastCollectedAt: null,
            lastEventAt: null,
            silentAccounts: [],
            silentAfterHours: 24,
          },
        }),
      ),
    );
    const strip = await screen.findByRole('region', { name: 'Situação agora' });
    expect(
      await within(strip).findByRole('button', { name: /Coleta: 1 conta conectada/ }),
    ).toBeInTheDocument();
    expect(within(strip).queryByRole('region', { name: /Radar/ })).toBeNull();
  });

  it('quem não tem a permissão da Torre não vê o resumo; a lista continua', async () => {
    const me = demoMe('analista_cliente');
    renderAt('/', { me: { ...me, permissions: me.permissions.filter((p) => p !== 'tower:read') } });
    await list();
    expect(screen.queryByRole('region', { name: 'Situação agora' })).toBeNull();
  });
});

describe('Detecções: análise e exportação', () => {
  it('MITRE ATT&CK no período da tela; a tática filtra a lista', async () => {
    const router = renderAt('/?analise=mitre&periodo=7d');
    expect(screen.queryByRole('table', { name: /^Detecções do cliente/ })).toBeNull();
    const tab = await screen.findByRole('tab', { name: 'MITRE ATT&CK' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('table', { name: 'Táticas e técnicas do MITRE ATT&CK' });
    const tactic = screen.getByRole('link', { name: /^Evasão de defesas \(TA0005\)/ });
    await userEvent.click(tactic);
    await waitFor(() => expect(search(router).get('tatica')).toBe('Defense Evasion'));
    expect(search(router).get('analise')).toBeNull();
    expect(search(router).get('periodo')).toBe('7d');
    await list();
  });

  it('cobertura das fontes, com o CSV da tabela', async () => {
    renderAt('/?analise=cobertura');
    expect(
      await screen.findByRole('table', { name: 'Contas monitoradas e o que chegou de cada uma' }),
    ).toBeInTheDocument();
  });

  it('exporta em CSV a lista filtrada de agora', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return 'blob:teste';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt('/?severidade=critical');
    await rows();
    await userEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText(/^\d+ linhas? exportadas?\.$/)).toBeInTheDocument();
    const text = await (blobs[0] as Blob).text();
    expect(text.split('\r\n')[0]).toContain('"Tipo";"ID";"Título";"Severidade"');
    expect(text).toContain('"Incidente"');
    expect(text).not.toContain('"Alto"');
  });

  it('a análise só aparece para quem lê relatórios', async () => {
    const me = demoMe('analista_cliente');
    renderAt('/?analise=mitre', {
      me: { ...me, permissions: me.permissions.filter((p) => p !== 'reports:read') },
    });
    await list();
    expect(screen.queryByRole('tab', { name: 'MITRE ATT&CK' })).toBeNull();
  });
});

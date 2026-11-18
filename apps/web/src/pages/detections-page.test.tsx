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
/** "Política de bucket alterada para permitir leitura pública": alerta a validar, com um relacionado (o bloqueio). */
const BUCKET_ALERT = '018f2c1e-0000-7000-8000-00000000100e';
/**
 * Espera maior para o que depende de várias respostas em sequência (a suíte inteira roda em paralelo). No runner da CI,
 * sob carga, o painel do incidente passou de 5 s de vez em quando (#150, #152): o prazo é folgado, o que se confere é o
 * mesmo.
 */
const SLOW = { timeout: 12_000 };

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

const list = async () => screen.findByRole('table', { name: /^Incidentes do cliente|^Alertas do cliente/ });
const rows = async () =>
  within(await list())
    .getAllByRole('row')
    .slice(1);
const search = (router: ReturnType<typeof renderAt>) => new URLSearchParams(router.state.location.search);

describe('Detecções: a lista', () => {
  it('por padrão, os alertas: os a validar e os confirmados, com a marca "Em incidente" que abre o incidente', async () => {
    const router = renderAt('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'Detecções' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Alertas do cliente' });
    expect(screen.getByRole('button', { name: 'Alertas' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(table).getAllByText('A validar').length).toBeGreaterThan(0);
    const badges = within(table).getAllByRole('button', { name: /^Em incidente/ });
    expect(badges.length).toBeGreaterThan(0);
    await userEvent.click(badges[0] as HTMLElement);
    await waitFor(() => expect(search(router).get('incidente')).not.toBeNull());
  });

  it('a visão Incidentes: só os confirmados, com nota, responsável e os alertas de cada um logo abaixo', async () => {
    const router = renderAt('/');
    await screen.findByRole('table', { name: 'Alertas do cliente' });
    await userEvent.click(screen.getByRole('button', { name: 'Incidentes' }));
    await waitFor(() => expect(search(router).get('visao')).toBe('incidentes'));
    const table = await screen.findByRole('table', {
      name: 'Incidentes do cliente, com os alertas de cada um',
    });
    const incident = await within(table).findByRole('button', {
      name: /^Abrir o incidente: Atividade suspeita com a chave/,
    });
    const row = incident.closest('tr') as HTMLElement;
    expect(row).toHaveTextContent(/nota de risco 76 · 3 alertas/);
    expect(row).toHaveTextContent('Equipe Verax');
    expect(within(table).queryAllByText(/^Alerta fora de incidente/)).toHaveLength(0);
    // A linha do incidente abre os alertas dele logo abaixo.
    const expand = within(row).getByRole('button', { name: /^Abrir os alertas do incidente/ });
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    const children = document.getElementById(expand.getAttribute('aria-controls') ?? '') as HTMLElement;
    expect(await within(children).findAllByRole('button', { name: /^Abrir o alerta/ })).toHaveLength(3);
  });

  it('incidentes sem responsável pela URL; voltar aos alertas tira o filtro de responsável', async () => {
    const router = renderAt('/?visao=incidentes&responsavel=nenhum');
    const table = await screen.findByRole('table', { name: /^Incidentes do cliente/ });
    expect(await within(table).findAllByRole('button', { name: /^Abrir o incidente/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Alertas' }));
    await waitFor(() => expect(search(router).get('visao')).toBeNull());
    expect(search(router).get('responsavel')).toBeNull();
    expect(await screen.findByRole('table', { name: 'Alertas do cliente' })).toBeInTheDocument();
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
    expect(await screen.findByText('Nenhum alerta com esses filtros')).toBeInTheDocument();
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
    // Depois do renderAt, que põe os handlers normais na frente. O prazo cobre a tela numa máquina de CI lenta.
    server.use(
      http.get(`${API_URL}/v1/findings`, () => HttpResponse.json({ message: 'x' }, { status: 500 })),
    );
    expect(
      await screen.findByRole('button', { name: /Tentar de novo/ }, { timeout: 10_000 }),
    ).toBeInTheDocument();
  });
});

describe('Detecções: o detalhe e a triagem', () => {
  it('o incidente abre na gaveta (tela estreita), com o resumo, o tratamento e a linha do tempo; o status muda ali', async () => {
    const router = renderAt('/?visao=incidentes');
    await userEvent.click(
      await within(await list()).findByRole('button', {
        name: /^Abrir o incidente: Atividade suspeita com a chave/,
      }),
    );
    await waitFor(() => expect(search(router).get('incidente')).toBe(INCIDENT));
    const dialog = await screen.findByRole('dialog', { name: /Atividade suspeita com a chave/ });
    expect(within(dialog).getByRole('heading', { name: 'Resumo' })).toBeInTheDocument();
    expect(within(dialog).getByText(/Primeiro passo:/)).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: /Linha do tempo \(3 alertas\)/ })).toBeInTheDocument();
    expect(within(dialog).getByText(/confirmado por Equipe Verax/)).toBeInTheDocument();
    await userEvent.selectOptions(within(dialog).getByLabelText('Status'), 'resolved');
    // A lista atrás da gaveta (escondida do leitor de tela enquanto ela está aberta) já mostra o status novo.
    await waitFor(() => {
      const table = screen.getByRole('table', { name: /^Incidentes do cliente/, hidden: true });
      const row = within(table)
        .getByRole('button', { name: /^Abrir o incidente: Atividade suspeita com a chave/, hidden: true })
        .closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('Resolvido');
    });
    // Um alerta da linha do tempo abre no mesmo painel.
    await userEvent.click(within(dialog).getAllByRole('link')[0] as HTMLElement);
    await waitFor(() => expect(search(router).get('alerta')).not.toBeNull());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search(router).get('alerta')).toBeNull());
    expect(search(router).get('incidente')).toBeNull();
  });

  it('o alerta (endereço de antes): triagem no lugar, com a oferta de exceção ao marcar como legítimo', async () => {
    const router = renderAt(`/?visao=achados&achado=${FINDING}`);
    const dialog = await screen.findByRole('dialog', {
      name: 'Tentativa de desligar a trilha do CloudTrail',
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Marcar como legítimo' }));
    expect(await within(dialog).findByText('Criar exceção para alertas iguais?')).toBeInTheDocument();
    await waitFor(async () => {
      const row = within(await list())
        .getByRole('button', { name: 'Abrir o alerta: Tentativa de desligar a trilha do CloudTrail' })
        .closest('tr') as HTMLElement;
      expect(row).toHaveTextContent('Legítimo');
    });
    // O link "Ver incidente" troca o painel para o incidente do alerta, sem sair da tela.
    await userEvent.click(within(dialog).getByRole('button', { name: 'Agora não' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('link', { name: 'Ver incidente' }));
    await waitFor(() => expect(search(router).get('incidente')).toBe(INCIDENT));
    expect(search(router).get('visao')).toBe('achados');
  });

  it('quem só lê vê o detalhe sem os botões de triagem, de validação nem os campos do tratamento', async () => {
    renderAt(`/?incidente=${INCIDENT}`, { me: demoMe('leitura') });
    const dialog = await screen.findByRole('dialog', { name: /Atividade suspeita com a chave/ });
    expect(within(dialog).queryByRole('combobox', { name: 'Status' })).toBeNull();
    expect(within(dialog).getByText('Equipe Verax')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /^Remover do incidente/ })).toBeNull();
  });

  it('quem só lê não vê "Promover a incidente" nem "Anexar"', async () => {
    renderAt(`/?alerta=${BUCKET_ALERT}`, { me: demoMe('leitura') });
    const dialog = await screen.findByRole('dialog', {
      name: 'Política de bucket alterada para permitir leitura pública',
    });
    expect(within(dialog).queryByRole('button', { name: 'Promover a incidente' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Anexar a um incidente aberto' })).toBeNull();
  });

  it(
    'promover a incidente: os relacionados vêm marcados, e o incidente confirmado abre no painel',
    { timeout: 40_000 },
    async () => {
      const router = renderAt(`/?alerta=${BUCKET_ALERT}`);
      const panel = await screen.findByRole('dialog', {
        name: 'Política de bucket alterada para permitir leitura pública',
      });
      await userEvent.click(within(panel).getByRole('button', { name: 'Promover a incidente' }));
      const promote = await screen.findByRole('dialog', { name: 'Promover a incidente' });
      const related = await within(promote).findByRole('checkbox', {
        name: /Bloqueio de acesso público removido do bucket/,
      });
      expect(related).toBeChecked();
      expect(within(promote).getByRole('status')).toHaveTextContent('1 alerta relacionado');
      await userEvent.selectOptions(within(promote).getByLabelText('Responsável (opcional)'), 'demo-ana');
      await userEvent.click(
        within(promote).getByRole('button', { name: 'Confirmar incidente com 2 alertas' }),
      );
      await waitFor(() => expect(search(router).get('incidente')).not.toBeNull());
      expect(search(router).get('alerta')).toBeNull();
      const incident = await screen.findByRole(
        'dialog',
        { name: /Atividade suspeita do usuário carlos\.dev/ },
        SLOW,
      );
      expect(
        await within(incident).findByRole('heading', { name: /Linha do tempo \(2 alertas\)/ }, SLOW),
      ).toBeInTheDocument();
      expect(within(incident).getByLabelText('Responsável')).toHaveValue('demo-ana');
    },
  );

  it(
    'anexar a um incidente aberto e remover do incidente: o alerta volta para a validação',
    { timeout: 40_000 },
    async () => {
      const router = renderAt(`/?alerta=${BUCKET_ALERT}`);
      const panel = await screen.findByRole('dialog', {
        name: 'Política de bucket alterada para permitir leitura pública',
      });
      await userEvent.click(within(panel).getByRole('button', { name: 'Anexar a um incidente aberto' }));
      const select = await within(panel).findByLabelText('Incidente');
      const option = within(select).getByRole<HTMLOptionElement>('option', {
        name: /^Ataque a partir do IP 192\.0\.2\.200/,
      });
      await userEvent.selectOptions(select, option.value);
      await userEvent.click(within(panel).getByRole('button', { name: 'Anexar' }));
      await waitFor(() => expect(search(router).get('incidente')).toBe(option.value));
      // Com o alerta do carlos.dev, o elo mais forte do incidente passa a ser o usuário.
      const incident = await screen.findByRole(
        'dialog',
        { name: /Atividade suspeita do usuário carlos\.dev/ },
        SLOW,
      );
      expect(
        await within(incident).findByRole('heading', { name: /Linha do tempo \(4 alertas\)/ }, SLOW),
      ).toBeInTheDocument();
      await userEvent.click(
        within(incident).getByRole('button', {
          name: 'Remover do incidente: Política de bucket alterada para permitir leitura pública',
        }),
      );
      expect(
        await within(incident).findByRole('heading', { name: /Linha do tempo \(3 alertas\)/ }, SLOW),
      ).toBeInTheDocument();
    },
  );

  it('na tela larga, o detalhe fica ao lado da lista; Esc fecha e o foco volta para o item', async () => {
    mockMedia((query) => query === '(min-width: 80rem)');
    const router = renderAt('/?visao=incidentes');
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
    [`/achados?achado=${FINDING}`, (s: URLSearchParams) => s.get('alerta') === FINDING && !s.has('visao')],
    [
      '/incidentes?responsavel=nenhum',
      (s: URLSearchParams) => s.get('responsavel') === 'nenhum' && s.get('visao') === 'incidentes',
    ],
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
  it('o radar em destaque, o motivo em texto, as decisões com o atalho para a lista filtrada e a coleta numa gaveta', async () => {
    const router = renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Situação agora' });
    expect(await within(strip).findByRole('status', { name: /^Situação: / })).toHaveTextContent(
      '1 incidente crítico aberto, 2 incidentes altos abertos, nota de postura 69, abaixo de 70 e coleta parada (GCP).',
    );
    const decisions = within(strip).getByRole('region', { name: 'Decisões pendentes' });
    expect(within(decisions).getByText('1 incidente sem responsável')).toBeInTheDocument();
    expect(within(decisions).getByText(/alertas? altos? ou críticos? para validar$/)).toBeInTheDocument();
    // Alerta sem dono é só do admin_verax.
    expect(within(decisions).queryByText(/conta não cadastrada/)).toBeNull();
    expect(within(strip).getByRole('link', { name: /Postura 69 de 100/ })).toHaveAttribute(
      'href',
      '/postura',
    );
    // O radar em destaque no resumo; o semáforo foi descontinuado (17/11/2026).
    expect(within(strip).getByRole('region', { name: 'Radar das últimas 24 horas' })).toBeInTheDocument();
    expect(strip.querySelector('[data-lit]')).toBeNull();

    await userEvent.click(within(strip).getByRole('button', { name: /Coleta parada: GCP/ }));
    const health = await screen.findByRole('dialog', { name: 'Saúde da coleta' });
    expect(within(health).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    expect(within(health).getByText('Agentes online')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(within(decisions).getByRole('link', { name: 'Ver os incidentes' }));
    await waitFor(() => expect(search(router).get('responsavel')).toBe('nenhum'));
    expect(search(router).get('visao')).toBe('incidentes');
    expect(await screen.findByRole('table', { name: /^Incidentes do cliente/ })).toBeInTheDocument();
  });

  it('recolhe e lembra a escolha por pessoa; recolhido, mostra as contagens', async () => {
    renderAt('/');
    const strip = await screen.findByRole('region', { name: 'Situação agora' });
    const toggle = within(strip).getByRole('button', { name: /Recolher/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(within(strip).getByRole('button', { name: /Mostrar/ })).toHaveAttribute('aria-expanded', 'false');
    expect(within(strip).getByRole('status', { name: /^Situação: / })).toHaveAccessibleName(
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
    expect(screen.queryByRole('table', { name: /^Alertas do cliente/ })).toBeNull();
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

  it('MITRE sem período na URL: a tática leva a janela padrão da análise (30 dias), não todo o histórico', async () => {
    const router = renderAt('/?analise=mitre');
    await screen.findByRole('table', { name: 'Táticas e técnicas do MITRE ATT&CK' });
    await userEvent.click(screen.getByRole('link', { name: /^Evasão de defesas \(TA0005\)/ }));
    await waitFor(() => expect(search(router).get('tatica')).toBe('Defense Evasion'));
    expect(search(router).get('periodo')).toBe('30d');
  });

  it('um ponto do radar aberto numa aba de análise volta para a lista, onde o detalhe aparece', async () => {
    mockMedia((query) => query === '(min-width: 80rem)');
    const router = renderAt('/?analise=mitre');
    const radar = await screen.findByRole('region', { name: 'Radar das últimas 24 horas' });
    const point = within(radar).getAllByRole('link')[0] as HTMLElement;
    await userEvent.click(point);
    await waitFor(() => expect(search(router).get('analise')).toBeNull());
    const params = search(router);
    expect(params.get('alerta') ?? params.get('incidente')).toBeTruthy();
    expect(await screen.findByRole('tab', { name: 'Lista' })).toHaveAttribute('aria-selected', 'true');
    expect((await screen.findAllByRole('complementary')).length).toBeGreaterThan(0);
  });

  it('resumo do período: os números, a pizza por status e as linhas por dia', async () => {
    renderAt('/?analise=resumo');
    expect(await screen.findByText('Alertas no período')).toBeInTheDocument();
    expect(screen.getByText('Tempo médio até a validação')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Alertas por severidade' })).toBeInTheDocument();
    expect(screen.getAllByText('Alertas por status').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Alertas por dia').length).toBeGreaterThan(0);
  });

  it.each([
    ['regras', 'Regras', 'Regras que mais dispararam'],
    ['entidades', 'Entidades', 'IPs de origem'],
    ['resposta', 'Resposta a incidentes', 'Incidentes abertos no período'],
    ['excecoes', 'Exceções', 'Exceções e quantos alertas cada uma silenciou'],
  ])('a análise "%s" volta com a tabela dela', async (slug, tab, table) => {
    renderAt(`/?analise=${slug}`);
    expect(await screen.findByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('table', { name: table })).toBeInTheDocument();
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
    renderAt('/?visao=incidentes&severidade=critical');
    await rows();
    await userEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText(/^\d+ linhas? exportadas?\.$/)).toBeInTheDocument();
    const text = await (blobs[0] as Blob).text();
    expect(text.split('\r\n')[0]).toContain('"Tipo";"ID";"Título";"Severidade"');
    expect(text.split('\r\n')[0]).toContain('"Alertas"');
    expect(text).toContain('"Incidente"');
    expect(text).not.toContain('"Alto"');
    // Na visão Incidentes, só os incidentes: nenhum alerta avulso.
    expect(text).not.toContain('"Alerta";');
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

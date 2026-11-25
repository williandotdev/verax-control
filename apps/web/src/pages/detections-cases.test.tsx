import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { caseDetailSchema, casePageSchema, type Role } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_TENANTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

/** A tela Detecções com os casos: desligados, na medição e ligados; a lista, o detalhe e a triagem em massa inteira. */

const server = setupServer();
/** Os pedidos à API, na ordem: "GET /v1/cases?...". */
let requests: string[] = [];
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'error' });
  server.events.on('request:start', ({ request }) => {
    requests.push(`${request.method} ${request.url.slice(API_URL.length)}`);
  });
});
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  requests = [];
  window.matchMedia = originalMatchMedia;
});
afterAll(() => server.close());

const [alfa] = DEMO_TENANTS.map((tenant) => tenant.id);
const SLOW = { timeout: 12_000 };
const LONG = { timeout: 60_000 };

function stateOf(role: Role, overrides: Partial<MockState> = {}): MockState {
  return {
    me: demoMe(
      role,
      role === 'admin_verax' ? { activeTenantId: alfa ?? null, scopeTenantId: alfa ?? null } : {},
    ),
    cases: 'on',
    ...overrides,
  };
}

function renderAt(path: string, state: MockState = stateOf('analista_cliente')) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

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
const wide = () => mockMedia((query) => query === '(min-width: 80rem)');

const search = (router: ReturnType<typeof renderAt>) => new URLSearchParams(router.state.location.search);
const casesTable = () => screen.findByRole('table', { name: 'Casos do cliente' }, SLOW);
const groupsTable = () => screen.findByRole('table', { name: /^Vulnerabilidades agrupadas por/ }, SLOW);
const bar = () => screen.getByRole('region', { name: 'Ações em lote' });
const casePath = (path: string) => requests.filter((request) => request.includes(path));
/** A barra da lista e o diálogo, abertos com uma ação da barra. */
async function openBulk(action: string | RegExp) {
  await userEvent.click(within(bar()).getByRole('button', { name: action }));
  return screen.findByRole('dialog', { name: /^Tratar:/ });
}
const check = async (name: RegExp) => userEvent.click(await screen.findByRole('checkbox', { name }, SLOW));

/** Os corpos do POST /v1/triage-operations, sem mexer na resposta. */
function recordBodies(): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  server.use(
    http.post(`${API_URL}/v1/triage-operations`, async ({ request }) => {
      bodies.push((await request.clone().json()) as Record<string, unknown>);
    }),
  );
  return bodies;
}

describe('os casos desligados', () => {
  const asBefore = async () => {
    expect(await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Visão da lista' })).toHaveTextContent(/^AlertasIncidentes$/);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Operações recentes' })).toBeNull();
    expect(screen.queryByText(/^Um caso reúne/)).toBeNull();
    // Um pedido só a mais, o da situação.
    expect(casePath('/v1/cases')).toEqual(['GET /v1/cases/status']);
    expect(casePath('triage')).toEqual([]);
  };

  it('a situação diz que não: a tela de sempre, sem outro pedido', async () => {
    renderAt('/?visao=casos', stateOf('analista_cliente', { cases: 'off' }));
    await asBefore();
  });

  it.each([
    ['nó de antes (404)', () => HttpResponse.json({ statusCode: 404 }, { status: 404 })],
    ['erro do servidor', () => HttpResponse.json({ statusCode: 500 }, { status: 500 })],
    ['resposta que não se entende', () => HttpResponse.json({ mode: 'novo' })],
  ])('%s: a tela de sempre', async (_name, answer) => {
    renderAt('/', stateOf('analista_cliente', { cases: 'off' }));
    server.use(http.get(`${API_URL}/v1/cases/status`, answer));
    await asBefore();
  });

  it('o alerta aberto não pede a trilha da triagem em massa', async () => {
    renderAt('/?alerta=018f2c1e-0000-7000-8000-000000001001', stateOf('analista_cliente', { cases: 'off' }));
    await screen.findByRole('dialog', { name: 'Tentativa de desligar a trilha do CloudTrail' }, SLOW);
    expect(casePath('triage')).toEqual([]);
  });
});

describe('os casos desligados com a tela aberta', () => {
  it('a lista que passa a responder 404 faz a tela perguntar de novo, e voltar a ser a de sempre', async () => {
    renderAt('/');
    server.use(
      http.get(`${API_URL}/v1/cases`, () => HttpResponse.json({ statusCode: 404 }, { status: 404 })),
      http.get(`${API_URL}/v1/cases/status`, () => HttpResponse.json({ statusCode: 404 }, { status: 404 })),
    );
    // A primeira resposta da situação já tinha dito que sim.
    server.use(
      http.get(
        `${API_URL}/v1/cases/status`,
        () => HttpResponse.json({ mode: 'on', asOf: null, oldestUnassignedMinutes: null }),
        { once: true },
      ),
    );
    expect(await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Casos' })).toBeNull();
    expect(casePath('/v1/cases/status')).toHaveLength(2);
  });

  it('o nó sem as rotas da triagem não mostra erro no lugar do histórico', async () => {
    renderAt('/');
    server.use(
      http.get(`${API_URL}/v1/triage-operations`, () =>
        HttpResponse.json({ statusCode: 404 }, { status: 404 }),
      ),
    );
    await casesTable();
    await waitFor(() => expect(casePath('triage-operations').length).toBeGreaterThan(0));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Operações recentes' })).toBeNull();
  });
});

describe('a medição (shadow)', () => {
  it('quem é do cliente não vê nada dos casos', async () => {
    renderAt('/?visao=casos', stateOf('admin_cliente', { cases: 'shadow' }));
    expect(await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Casos' })).toBeNull();
  });

  it('a equipe da Verax lê, sem tratar: o padrão continua nos alertas', async () => {
    renderAt('/', stateOf('admin_verax', { cases: 'shadow' }));
    expect(await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Casos' }));
    await casesTable();
    expect(screen.getByText(/^Medição: só a equipe da Verax vê os casos/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /^Abrir o caso: Grupo de log/ }));
    const detail = await screen.findByRole('dialog', { name: 'Grupo de log do CloudWatch apagado' });
    await within(detail).findByRole('region', { name: 'Resumo' });
    expect(within(detail).queryByRole('region', { name: 'Tratar o caso' })).toBeNull();
    expect(within(detail).queryByRole('checkbox')).toBeNull();
    expect(within(detail).queryByRole('button', { name: /Separar/ })).toBeNull();
  });
});

describe('a lista de casos', () => {
  it('é a visão padrão, sem pedir os alertas, e diz o que cada caso tem', async () => {
    renderAt('/');
    const table = await casesTable();
    expect(screen.getByRole('button', { name: 'Casos' })).toHaveAttribute('aria-pressed', 'true');
    const row = (name: RegExp) => within(table).getByRole('button', { name }).closest('tr') as HTMLElement;
    const denied = row(/^Abrir o caso: Chamadas negadas/);
    expect(denied).toHaveTextContent(/Baixo.*relatorios-app e outros.*49/);
    expect(row(/^Abrir o caso: Senha de console/)).toHaveTextContent('Item protegido');
    expect(row(/^Abrir o caso: Grupo de log/)).toHaveTextContent('Voltou (1×)');
    expect(row(/^Abrir o caso: Grupo de segurança/)).toHaveTextContent('Em análise (1)');
    // O mais grave primeiro; nele, o protegido.
    expect(within(table).getAllByRole('button', { name: /^Abrir o caso/ })[0]).toHaveAccessibleName(
      /Senha de console/,
    );
    expect(casePath('/v1/findings')).toEqual([]);
    expect(casePath('/v1/cases/status')).toHaveLength(1);
  });

  it('as contas batem com a lista de alertas', async () => {
    renderAt('/');
    await casesTable();
    const page = casePageSchema.parse(
      await (await fetch(`${API_URL}/v1/cases?pageSize=100&state=all`)).json(),
    );
    const total = page.items.reduce((sum, row) => sum + row.counts.total, 0);
    const alerts = (await (await fetch(`${API_URL}/v1/findings?pageSize=1`)).json()) as { total: number };
    expect(total).toBe(alerts.total);
    for (const row of page.items) {
      const { new: fresh, investigating, legitimate, resolved, incident } = row.counts;
      expect(fresh + investigating + legitimate + resolved + incident).toBe(row.counts.total);
      const pending = row.pending.critical + row.pending.high + row.pending.medium + row.pending.low;
      expect(pending).toBe(fresh + investigating);
    }
  });

  it('os filtros vão para a URL e para a API; a severidade some com os tratados', async () => {
    const router = renderAt('/');
    await casesTable();
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'medium');
    await waitFor(() => expect(search(router).get('severidade')).toBe('medium'));
    await waitFor(() => expect(casePath('severity=medium').at(-1)).toMatch(/state=pending/));
    await userEvent.selectOptions(screen.getByLabelText('Situação'), 'treated');
    await waitFor(() => expect(search(router).get('estado')).toBe('tratados'));
    expect(search(router).get('severidade')).toBeNull();
    expect(screen.queryByLabelText('Severidade')).toBeNull();
    // Tratado não se seleciona.
    await within(await casesTable()).findAllByRole('button', { name: /^Abrir o caso: Ataques web/ }, SLOW);
    expect(screen.queryByRole('checkbox')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Fila'), 'posture');
    await waitFor(() => expect(search(router).get('fila')).toBe('postura'));
    await userEvent.click(screen.getByRole('button', { name: 'Limpar filtros' }));
    await waitFor(() => expect(search(router).toString()).toBe('fila=postura'));
    expect(
      await screen.findAllByRole('button', { name: /^Abrir o caso: Controle de segurança/ }, SLOW),
    ).not.toHaveLength(0);
    await userEvent.selectOptions(screen.getByLabelText('Ordem'), 'volume');
    await waitFor(() => expect(search(router).get('ordem')).toBe('volume'));
  });

  it('sem nada: diz o que aconteceu e leva à lista de alertas', async () => {
    const router = renderAt('/?busca=nao-existe-nada-assim');
    expect(await screen.findByText('Nenhum caso com esses filtros', undefined, SLOW)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Ver a lista de alertas' }));
    await waitFor(() => expect(search(router).get('visao')).toBe('alertas'));
    expect(search(router).get('busca')).toBe('nao-existe-nada-assim');
  });

  it('o atraso do agrupamento é avisado', async () => {
    renderAt('/');
    server.use(
      http.get(`${API_URL}/v1/cases/status`, () =>
        HttpResponse.json({
          mode: 'on',
          asOf: new Date(Date.now() - 600_000).toISOString(),
          oldestUnassignedMinutes: 12,
        }),
      ),
    );
    expect(await screen.findByText(/esperando um caso há 12 minutos/, undefined, SLOW)).toBeInTheDocument();
  });

  it('texto do evento aparece como texto, nunca como HTML nem link', async () => {
    renderAt('/');
    const hostile = '<img src=x onerror=alert(1)>';
    server.use(
      http.get(
        `${API_URL}/v1/cases`,
        async () => {
          const page = casePageSchema.parse(
            await (await fetch(`${API_URL}/v1/cases?pageSize=1&queue=posture`)).json(),
          );
          const [row] = page.items;
          return HttpResponse.json({
            ...page,
            items: [
              {
                ...row,
                preview: { accounts: [], actors: [hostile], ips: ['http://exemplo.invalid'], resources: [] },
              },
            ],
            total: 1,
          });
        },
        { once: true },
      ),
    );
    const table = await casesTable();
    expect(within(table).getByText(/onerror=alert/)).toBeInTheDocument();
    expect(table.querySelector('img')).toBeNull();
    expect(within(table).queryByRole('link')).toBeNull();
  });

  it('erro da API: a mensagem e o tentar de novo', async () => {
    renderAt('/');
    server.use(http.get(`${API_URL}/v1/cases`, () => HttpResponse.json({}, { status: 500 })));
    expect(await screen.findByRole('button', { name: 'Tentar de novo' }, SLOW)).toBeInTheDocument();
  });

  it('quem só lê vê os casos e o histórico, sem caixas nem ações', async () => {
    renderAt('/', stateOf('leitura'));
    await casesTable();
    expect(screen.queryByRole('checkbox')).toBeNull();
    const panel = await screen.findByRole('region', { name: 'Operações recentes' }, SLOW);
    await userEvent.click(within(panel).getByRole('button', { name: /Mostrar/ }));
    expect(await within(panel).findAllByText('Marcar como resolvido')).not.toHaveLength(0);
    expect(within(panel).queryByRole('button', { name: /^Desfazer/ })).toBeNull();
  });

  it('os atalhos de antes continuam: o status é da lista de alertas, e o alerta abre sobre os casos', async () => {
    renderAt('/?status=new');
    expect(await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW)).toBeInTheDocument();
  });

  it('o alerta pelo endereço abre o painel sobre os casos, com a trilha da triagem em massa', async () => {
    renderAt('/?visao=casos&alerta=018f2c1e-0000-7000-8000-000000001001');
    expect(
      await screen.findByRole('dialog', { name: 'Tentativa de desligar a trilha do CloudTrail' }, SLOW),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Voltar ao caso' })).toBeNull();
    expect(
      await screen.findByRole('table', { name: 'Casos do cliente', hidden: true }, SLOW),
    ).toBeInTheDocument();
  });
});

describe('a fila de vulnerabilidades', () => {
  it('agrupada por pacote; o grupo abre os casos dele, e o sem pacote existe', async () => {
    const router = renderAt('/');
    await casesTable();
    await userEvent.click(screen.getByRole('button', { name: 'Vulnerabilidades' }));
    await waitFor(() => expect(search(router).get('visao')).toBe('vulnerabilidades'));
    const table = await groupsTable();
    expect(within(table).getByRole('rowheader', { name: /^openssl/ })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: /^Sem pacote/ })).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'Abrir os casos do grupo: openssl' }));
    expect(
      await within(table).findAllByRole('button', {
        name: /^Abrir o caso: Vulnerabilidade em pacote, openssl/,
      }),
    ).toHaveLength(4);
    await userEvent.click(
      within(table).getByRole('button', { name: /^Abrir os casos do grupo: Sem pacote/ }),
    );
    expect(
      await within(table).findByRole('button', { name: /^Abrir o caso: Vulnerabilidade no código/ }),
    ).toBeInTheDocument();
    // Sem valor, a lista vai só com por onde agrupa.
    expect(casePath('groupBy=package').some((request) => !request.includes('group='))).toBe(true);
  });

  it('por recurso, por conta e sem agrupar (a lista corrida, com todas as situações)', async () => {
    const router = renderAt('/?visao=vulnerabilidades');
    await groupsTable();
    await userEvent.selectOptions(screen.getByLabelText('Agrupar por'), 'resource');
    await waitFor(() => expect(search(router).get('agrupar')).toBe('recurso'));
    expect(
      await screen.findByRole('button', { name: /^Abrir os casos do grupo: i-0a1b2c3d4e5f67890/ }, SLOW),
    ).toBeInTheDocument();
    // Agrupada, só o que tem pendência.
    expect(
      within(screen.getByLabelText('Situação'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Pendentes', 'Em análise']);
    await userEvent.selectOptions(screen.getByLabelText('Agrupar por'), 'none');
    expect(
      await screen.findByRole('table', { name: 'Casos de vulnerabilidade do cliente' }, SLOW),
    ).toBeInTheDocument();
    expect(within(screen.getByLabelText('Situação')).getAllByRole('option')).toHaveLength(4);
  });

  it(
    'tratar o grupo inteiro: a prévia conta, os críticos ficam de fora, e a fila anda até o fim',
    LONG,
    async () => {
      renderAt('/?visao=vulnerabilidades');
      const recorded = recordBodies();
      const table = await groupsTable();
      await userEvent.click(within(table).getByRole('button', { name: /^Tratar ?o grupo openssl$/ }));
      const dialog = await screen.findByRole('dialog', { name: 'Tratar: pacote openssl' });
      const summary = await within(dialog).findByRole('region', { name: 'O que vai ser tratado' });
      expect(summary).toHaveTextContent(/4 casos, 215 alertas pendentes/);
      expect(
        within(dialog).getByRole('checkbox', { name: /^Incluir também os 3 alertas críticos/ }),
      ).not.toBeChecked();
      await userEvent.click(within(dialog).getByRole('radio', { name: /^Resolvido/ }));
      await userEvent.type(within(dialog).getByLabelText('Motivo (obrigatório)'), 'Imagem base atualizada.');
      await userEvent.click(
        within(dialog).getByRole('button', { name: 'Marcar 212 alertas como resolvidos' }),
      );
      expect(await screen.findByText('A operação está na fila e segue sozinha.')).toBeInTheDocument();
      expect(screen.getByText('3 alertas críticos ficaram de fora.')).toBeInTheDocument();
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
      expect(recorded[0]).toMatchObject({
        action: 'status',
        status: 'resolved',
        expectedCount: 212,
        includeCritical: false,
        target: {
          filter: { queue: 'vulnerability', groupBy: 'package', group: 'openssl', state: 'pending' },
        },
      });
      expect(await screen.findByText('212 alertas mudaram.', undefined, SLOW)).toBeInTheDocument();
      expect(screen.queryByRole('progressbar')).toBeNull();
      // Acabou: a lista foi relida, e o que sobrou são os críticos.
      const closing = screen.getByRole('dialog');
      await userEvent.click(within(closing).getAllByRole('button', { name: 'Fechar' }).at(-1) as HTMLElement);
      await waitFor(() =>
        expect(
          (screen.getByRole('rowheader', { name: /^openssl/ }).closest('tr') as HTMLElement).textContent,
        ).not.toMatch(/alto|médio|baixo/),
      );
      // Nada mais se relê sozinho.
      const before = casePath('triage-operations').length;
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      expect(casePath('triage-operations').length).toBe(before);
    },
  );
});

describe('as linhas da busca anterior, enquanto a nova não vem', () => {
  /** Segura a próxima resposta de um caminho; a resposta é a de sempre. */
  function hold(path: string): () => void {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(`${API_URL}${path}`, async () => {
        await gate;
      }),
    );
    return release;
  }

  it('a lista de casos: nada pode ser marcado, nem o filtro inteiro', LONG, async () => {
    renderAt('/');
    await casesTable();
    const page = () => screen.getByRole('checkbox', { name: 'Selecionar os casos desta página' });
    expect(page()).toBeEnabled();
    const release = hold('/v1/cases');
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'high');
    const all = await screen.findByRole('button', { name: /^Selecionar (o|os) .*do filtro$/ });
    expect(all).toBeDisabled();
    expect(page()).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox', { name: /^Selecionar: / })) expect(box).toBeDisabled();
    release();
    await waitFor(() => expect(page()).toBeEnabled(), SLOW);
    expect(all).toBeEnabled();
  });

  it('a lista de alertas: nada pode ser marcado', LONG, async () => {
    renderAt('/?visao=alertas');
    await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW);
    const page = () => screen.getByRole('checkbox', { name: 'Selecionar os alertas desta página' });
    expect(page()).toBeEnabled();
    const release = hold('/v1/findings');
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'high');
    await waitFor(() => expect(page()).toBeDisabled());
    for (const box of screen.getAllByRole('checkbox', { name: /^Selecionar: / })) expect(box).toBeDisabled();
    release();
    await waitFor(() => expect(page()).toBeEnabled(), SLOW);
  });

  it('os grupos de vulnerabilidades: o grupo de antes não é tratado nem aberto', LONG, async () => {
    renderAt('/?visao=vulnerabilidades');
    await groupsTable();
    expect(await screen.findByRole('button', { name: /^Tratar ?o grupo openssl$/ })).toBeEnabled();
    const release = hold('/v1/cases/groups');
    await userEvent.selectOptions(screen.getByLabelText('Agrupar por'), 'Recurso');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Tratar ?o grupo openssl$/ })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'Abrir os casos do grupo: openssl' })).toBeDisabled();
    release();
    await waitFor(
      () => expect(screen.queryByRole('button', { name: /^Tratar ?o grupo openssl$/ })).toBeNull(),
      SLOW,
    );
    for (const button of screen.getAllByRole('button', { name: /^Tratar ?o grupo / }))
      expect(button).toBeEnabled();
  });
});

describe('a triagem em massa dos casos', () => {
  it('a caixa do cabeçalho marca só esta página, o Shift marca o trecho, e a barra conta', async () => {
    renderAt('/');
    await casesTable();
    const boxes = () => screen.getAllByRole('checkbox', { name: /^Selecionar: / });
    expect(screen.queryByRole('region', { name: 'Ações em lote' })).toBeNull();
    await userEvent.click(boxes()[0] as HTMLElement);
    expect(within(bar()).getByRole('status')).toHaveTextContent('1 caso · 1 alerta');
    const user = userEvent.setup();
    await user.keyboard('{Shift>}');
    await user.click(boxes()[3] as HTMLElement);
    await user.keyboard('{/Shift}');
    expect(within(bar()).getByRole('status')).toHaveTextContent('4 casos · 4 alertas');
    const header = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Selecionar os casos desta página',
    });
    expect(header.indeterminate).toBe(true);
    await userEvent.click(header);
    expect(header).toBeChecked();
    expect(boxes().every((box) => (box as HTMLInputElement).checked)).toBe(true);
    await userEvent.click(within(bar()).getByRole('button', { name: /^Limpar/ }));
    expect(screen.queryByRole('region', { name: 'Ações em lote' })).toBeNull();
    // Espaço alterna a caixa em foco.
    (boxes()[1] as HTMLElement).focus();
    await userEvent.keyboard(' ');
    expect(within(bar()).getByRole('status')).toHaveTextContent('1 caso');
  });

  it('mudar o filtro limpa a seleção', async () => {
    renderAt('/');
    await check(/^Selecionar: Login do usuário root/);
    expect(bar()).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'high');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Ações em lote' })).toBeNull());
  });

  it(
    'legítimo: pede o motivo, avisa do item protegido, muda os alertas, e "Desfazer" devolve',
    LONG,
    async () => {
      renderAt('/');
      const bodies = recordBodies();
      await check(/^Selecionar: Senha de console/);
      await check(/^Selecionar: Login do usuário root/);
      const dialog = await openBulk('Legítimo');
      expect(dialog).toHaveTextContent('1 caso toca a lista de proteção');
      const confirm = within(dialog).getByRole('button', { name: 'Marcar 2 alertas como legítimos' });
      expect(confirm).toBeDisabled();
      // Só espaço não é motivo, e um Enter no campo não confirma nada.
      await userEvent.type(within(dialog).getByLabelText('Motivo (obrigatório)'), '   ');
      expect(confirm).toBeDisabled();
      await userEvent.type(within(dialog).getByLabelText('Motivo (obrigatório)'), 'Combinado com o time.');
      await userEvent.click(confirm);
      expect(await screen.findByText('2 alertas mudaram.')).toBeInTheDocument();
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        action: 'status',
        status: 'legitimate',
        expectedCount: 2,
        includeCritical: false,
        reason: 'Combinado com o time.',
      });
      await waitFor(() =>
        expect(
          screen.queryByRole('button', { name: /^Abrir o caso: Login do usuário root/, hidden: true }),
        ).toBeNull(),
      );
      expect(screen.queryByRole('region', { name: 'Ações em lote', hidden: true })).toBeNull();

      await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Desfazer/ }));
      const undo = await screen.findByRole('dialog', { name: 'Desfazer: Marcar como legítimo' });
      expect(undo).toHaveTextContent('2 alertas foram mudados por esta operação');
      await userEvent.click(within(undo).getByRole('button', { name: 'Desfazer' }));
      expect(await screen.findByText('2 alertas voltaram ao que eram.')).toBeInTheDocument();
      await userEvent.click(
        within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Fechar' }).at(-1) as HTMLElement,
      );
      expect(
        await screen.findByRole('button', { name: /^Abrir o caso: Login do usuário root/ }, SLOW),
      ).toBeInTheDocument();
      // O histórico fica na tela, com as duas.
      const panel = screen.getByRole('region', { name: 'Operações recentes' });
      await userEvent.click(within(panel).getByRole('button', { name: /Mostrar/ }));
      expect(within(panel).getByText('Desfeita')).toBeInTheDocument();
    },
  );

  it('um alerta só não pede motivo; em análise não tira da fila', async () => {
    renderAt('/');
    await check(/^Selecionar: Login do usuário root/);
    const dialog = await openBulk('Em análise');
    const confirm = within(dialog).getByRole('button', { name: 'Colocar 1 alerta em análise' });
    expect(confirm).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Legítimo/ }));
    expect(within(dialog).getByRole('button', { name: 'Marcar 1 alerta como legítimo' })).toBeEnabled();
    expect(within(dialog).getByLabelText('Motivo (opcional)')).toBeInTheDocument();
  });

  it(
    'o conjunto mudou: mostra o número novo e só vai com nova confirmação, num pedido novo',
    LONG,
    async () => {
      renderAt('/', stateOf('analista_cliente', { triage: 'mudou' }));
      const bodies = recordBodies();
      await check(/^Selecionar: Login do usuário root/);
      const dialog = await openBulk('Em análise');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Colocar 1 alerta em análise' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'O alvo mudou enquanto você confirmava: agora são 61 alertas. Confira e confirme de novo.',
      );
      expect(bodies).toHaveLength(1);
      await userEvent.click(
        await within(dialog).findByRole('button', { name: 'Colocar 61 alertas em análise' }),
      );
      expect(await screen.findByText('61 alertas mudaram.')).toBeInTheDocument();
      expect(bodies.map((body) => body['expectedCount'])).toEqual([1, 61]);
      expect(bodies[0]?.['requestId']).not.toBe(bodies[1]?.['requestId']);
    },
  );

  it('banco ocupado: nada mudou, e tentar de novo manda o mesmo pedido com o mesmo id', async () => {
    renderAt('/', stateOf('analista_cliente', { triage: 'ocupada' }));
    const bodies = recordBodies();
    await check(/^Selecionar: Login do usuário root/);
    const dialog = await openBulk('Em análise');
    const confirm = within(dialog).getByRole('button', { name: 'Colocar 1 alerta em análise' });
    await userEvent.click(confirm);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/ocupado, e nada mudou/);
    await userEvent.click(confirm);
    expect(await screen.findByText('1 alerta mudou.')).toBeInTheDocument();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    // Mudou o que se pede, o id é outro.
    expect(bodies[0]?.['requestId']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('só críticos no alvo: sem incluir, a API recusa e diz quantos; incluindo, vai', LONG, async () => {
    renderAt('/?fila=postura');
    await check(/^Selecionar: Controle de segurança reprovado, sg-0123/);
    const dialog = await openBulk('Em análise');
    // A lista já sabe: sem os críticos, não há o que mudar.
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Não há alerta pendente para mudar.');
    expect(within(dialog).getByRole('button', { name: /^Colocar/ })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /^Incluir também o alerta crítico/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Colocar 1 alerta em análise' }));
    expect(await screen.findByText('1 alerta mudou.')).toBeInTheDocument();
  });

  it('a API é quem diz que só há críticos: o aviso traz a inclusão', async () => {
    renderAt('/');
    server.use(
      http.post(`${API_URL}/v1/triage-operations`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            code: 'TRIAGE_NOTHING_TO_DO',
            message: 'x',
            details: { count: 0, excludedCritical: 2 },
          },
          { status: 409 },
        ),
      ),
    );
    await check(/^Selecionar: Login do usuário root/);
    const dialog = await openBulk('Em análise');
    await userEvent.click(within(dialog).getByRole('button', { name: /^Colocar 1 alerta/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Só há 2 alertas críticos/);
    expect(
      within(dialog).getByRole('checkbox', { name: /^Incluir também os 2 alertas críticos/ }),
    ).toBeInTheDocument();
  });

  it('cota do analista e fila cheia: a recusa diz o que fazer', async () => {
    renderAt('/');
    let answer = { code: 'TRIAGE_QUOTA_EXCEEDED', status: 403, details: { limit: 5_000, count: 5_010 } };
    server.use(
      http.post(`${API_URL}/v1/triage-operations`, () =>
        HttpResponse.json({ statusCode: answer.status, message: 'x', ...answer }, { status: answer.status }),
      ),
    );
    await check(/^Selecionar: Login do usuário root/);
    const dialog = await openBulk('Em análise');
    const confirm = within(dialog).getByRole('button', { name: /^Colocar 1 alerta/ });
    await userEvent.click(confirm);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /limite de 5\.000 alertas.*administrador/,
    );
    answer = { code: 'TRIAGE_QUEUE_FULL', status: 409, details: { limit: 10, count: 10 } };
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(/operações demais na fila/),
    );
  });

  it('acima de 1.000, a quantidade é digitada; acima de 2.000, o analista nem pede', LONG, async () => {
    renderAt('/?visao=vulnerabilidades', stateOf('analista_cliente', { caseVolume: 1_500 }));
    const table = await groupsTable();
    await userEvent.click(within(table).getByRole('button', { name: /^Tratar ?o grupo openssl$/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Tratar: pacote openssl' });
    await userEvent.click(await within(dialog).findByRole('radio', { name: /^Em análise/ }));
    const typed = await within(dialog).findByLabelText(/Digite [\d.]+ para confirmar/);
    const label = within(dialog).getByText(/Digite [\d.]+ para confirmar/).textContent ?? '';
    const words = label.split(' ');
    const asked = words[words.indexOf('Digite') + 1] ?? '';
    const confirm = within(dialog).getByRole('button', { name: /^Colocar/ });
    expect(confirm).toBeDisabled();
    await userEvent.type(typed, '7');
    expect(confirm).toBeDisabled();
    await userEvent.clear(typed);
    await userEvent.type(typed, asked);
    expect(confirm).toBeEnabled();
    // Mudar o que se faz, com a mesma quantidade, também pede de novo.
    await userEvent.type(within(dialog).getByLabelText(/^Motivo/), 'Combinado.');
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Resolvido/ }));
    expect(within(dialog).getByRole('button', { name: /^Marcar/ })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/para confirmar$/), asked);
    expect(within(dialog).getByRole('button', { name: /^Marcar/ })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Em análise/ }));
    // E incluir os críticos também.
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /^Incluir também/ }));
    expect(within(dialog).getByRole('button', { name: /^Colocar/ })).toBeDisabled();
  });

  it('o analista acima da cota por operação nem chega a pedir; quem administra, sim', LONG, async () => {
    const volume = { caseVolume: 2_700 };
    renderAt('/?visao=vulnerabilidades', stateOf('analista_cliente', volume));
    await userEvent.click(
      within(await groupsTable()).getByRole('button', { name: /^Tratar ?o grupo openssl$/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Tratar: pacote openssl' }, SLOW);
    await userEvent.click(await within(dialog).findByRole('radio', { name: /^Em análise/ }, SLOW));
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/Acima de 2\.000 alertas.*administrador/);
    expect(within(dialog).queryByLabelText(/para confirmar$/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: /^Colocar/ })).toBeDisabled();
  });

  it('todos os casos do filtro: só com um filtro que estreite, e a prévia conta', LONG, async () => {
    renderAt('/');
    await casesTable();
    expect(screen.queryByRole('button', { name: /do filtro$/ })).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'medium');
    const all = await screen.findByRole('button', { name: /^Selecionar os \d+ casos do filtro$/ }, SLOW);
    const bodies = recordBodies();
    await userEvent.click(all);
    expect(within(bar()).getByRole('status')).toHaveTextContent(/^Todos os \d+ casos do filtro$/);
    const dialog = await openBulk('Em análise');
    expect(await within(dialog).findByText(/O filtro de severidade escolhe os casos/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Colocar/ }));
    await screen.findByText('Pronto.');
    expect(bodies[0]?.['target']).toEqual({
      filter: { queue: 'detection', severity: 'medium', state: 'pending' },
    });
  });

  it('promover: o incidente nasce com os alertas, e desfazer avisa o que não volta', LONG, async () => {
    const router = renderAt('/');
    await check(/^Selecionar: Política de bucket alterada/);
    await check(/^Selecionar: Bloqueio de acesso público/);
    const dialog = await openBulk('Promover a incidente');
    expect(dialog).toHaveTextContent(/O aviso por e-mail sai uma vez/);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Promover 2 alertas a incidente' }));
    expect(await screen.findByText('2 alertas mudaram.')).toBeInTheDocument();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Desfazer/ }));
    const undo = await screen.findByRole('dialog', { name: 'Desfazer: Promover a incidente' });
    expect(undo).toHaveTextContent(/continua nele, e o incidente é encerrado/);
    await userEvent.click(within(undo).getByRole('button', { name: 'Desfazer' }));
    expect(await screen.findByText('O alerta que abriu o incidente continua nele.')).toBeInTheDocument();
    expect(screen.getByText(/aviso por e-mail do incidente já tinha saído/)).toBeInTheDocument();
    expect(search(router).get('incidente')).toBeNull();
  });

  it('quem não opera incidentes não promove nem anexa em massa', async () => {
    const me = demoMe('analista_cliente');
    renderAt('/', {
      me: { ...me, permissions: me.permissions.filter((permission) => permission !== 'incidents:write') },
      cases: 'on',
    });
    await check(/^Selecionar: Login do usuário root/);
    expect(within(bar()).queryByRole('button', { name: /incidente$/ })).toBeNull();
    const dialog = await openBulk('Em análise');
    expect(within(dialog).getAllByRole('radio')).toHaveLength(3);
  });

  it('anexar a um incidente em aberto, e o link abre o incidente', LONG, async () => {
    const router = renderAt('/');
    const bodies = recordBodies();
    await check(/^Selecionar: Login do usuário root/);
    const dialog = await openBulk('Anexar a incidente');
    const select = await within(dialog).findByLabelText('Incidente');
    const option = within(select).getByRole<HTMLOptionElement>('option', {
      name: /^Ataque a partir do IP 192\.0\.2\.200/,
    });
    await userEvent.selectOptions(select, option.value);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Anexar 1 alerta' }));
    await userEvent.click(await screen.findByRole('link', { name: 'Ver o incidente' }));
    expect(bodies[0]).toMatchObject({ action: 'attach', incidentId: option.value });
    await waitFor(() => expect(search(router).get('incidente')).toBe(option.value));
  });
});

describe('as operações na fila', () => {
  const treatGroup = async () => {
    await userEvent.click(
      within(await groupsTable()).getByRole('button', { name: /^Tratar ?o grupo openssl$/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Tratar: pacote openssl' });
    await userEvent.click(await within(dialog).findByRole('radio', { name: /^Em análise/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /^Colocar/ }));
    await screen.findByText('A operação está na fila e segue sozinha.');
    return screen.getByRole('dialog');
  };

  it('cancelar: o que já foi feito fica, e dá para desfazer', LONG, async () => {
    renderAt('/?visao=vulnerabilidades', stateOf('analista_cliente', { triage: 'lenta' }));
    const dialog = await treatGroup();
    await waitFor(
      () =>
        expect(Number(within(dialog).getByRole('progressbar').getAttribute('aria-valuenow'))).toBeGreaterThan(
          0,
        ),
      SLOW,
    );
    await userEvent.click(within(dialog).getByRole('button', { name: /^Cancelar/ }));
    expect(await within(dialog).findByText('Cancelada.', undefined, SLOW)).toBeInTheDocument();
    expect(within(dialog).getByText(/^\d+ alertas? (mudou|mudaram)\.$/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^Desfazer/ })).toBeInTheDocument();
  });

  it('parou no meio: diz por quê, e "Continuar" termina o que faltou', LONG, async () => {
    renderAt('/?visao=vulnerabilidades', stateOf('analista_cliente', { triage: 'parcial' }));
    const dialog = await treatGroup();
    expect(await within(dialog).findByText('Parou antes do fim.', undefined, SLOW)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/3 não puderam ser gravados/);
    expect(dialog).toHaveTextContent('Alguns alertas não puderam ser gravados. Os outros entraram.');
    expect(within(dialog).getByRole('button', { name: /^Desistir do resto/ })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /^Continuar/ }));
    expect(await within(dialog).findByText('Pronto.', undefined, SLOW)).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/não puderam ser gravados/);
  });

  it('falhou antes de começar: nada mudou, e dá para continuar', LONG, async () => {
    renderAt('/?visao=vulnerabilidades', stateOf('analista_cliente', { triage: 'falha' }));
    const dialog = await treatGroup();
    expect(await within(dialog).findByText('Falhou.', undefined, SLOW)).toBeInTheDocument();
    expect(dialog).toHaveTextContent(/indisponível por tempo demais/);
    expect(within(dialog).queryByRole('button', { name: /^Desfazer/ })).toBeNull();
    expect(within(dialog).getByRole('button', { name: /^Continuar/ })).toBeInTheDocument();
  });

  it('o painel mostra o andamento com o diálogo fechado, e deixa cancelar', LONG, async () => {
    renderAt('/?visao=vulnerabilidades', stateOf('analista_cliente', { triage: 'lenta' }));
    const dialog = await treatGroup();
    await userEvent.click(within(dialog).getAllByRole('button', { name: 'Fechar' }).at(-1) as HTMLElement);
    const panel = await screen.findByRole('region', { name: 'Operações recentes' });
    await waitFor(() => expect(panel).toHaveTextContent(/Colocar em análise: \d+ de 20\d alertas/), SLOW);
    await userEvent.click(within(panel).getByRole('button', { name: /Mostrar/ }));
    await userEvent.click(await within(panel).findByRole('button', { name: 'Cancelar: Colocar em análise' }));
    expect(await within(panel).findByText('Cancelada', undefined, SLOW)).toBeInTheDocument();
  });

  it('a fila cheia é avisada no diálogo', async () => {
    renderAt('/?visao=vulnerabilidades', stateOf('analista_cliente', { triage: 'cheia' }));
    await userEvent.click(
      within(await groupsTable()).getByRole('button', { name: /^Tratar ?o grupo openssl$/ }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Tratar: pacote openssl' });
    await userEvent.click(await within(dialog).findByRole('radio', { name: /^Em análise/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: /^Colocar/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/operações demais na fila/);
  });

  it('desfazer tudo de uma pessoa: só quem administra, com o nome digitado e o motivo', LONG, async () => {
    renderAt('/', stateOf('admin_cliente'));
    const panel = await screen.findByRole('region', { name: 'Operações recentes' }, SLOW);
    await userEvent.click(within(panel).getByRole('button', { name: /Mostrar/ }));
    expect(within(panel).queryByRole('button', { name: /^Desfazer tudo/ })).toBeNull();
    await userEvent.selectOptions(within(panel).getByLabelText('De quem'), 'demo-joao');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Desfazer tudo de João Lima' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desfazer tudo de João Lima' });
    const confirm = within(dialog).getByRole('button', { name: 'Desfazer tudo' });
    expect(confirm).toBeDisabled();
    const name = () => within(dialog).getByLabelText('Digite João Lima para confirmar');
    await userEvent.type(name(), 'João Lima');
    expect(confirm).toBeDisabled();
    await userEvent.clear(name());
    await userEvent.type(within(dialog).getByLabelText('Motivo (obrigatório)'), 'Conta comprometida.');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Digite João Lima para confirmar'), 'João');
    expect(confirm).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Digite João Lima para confirmar'), ' Lima');
    expect(confirm).toBeEnabled();
    await userEvent.click(confirm);
    expect(await screen.findByText('1 operação vai ser desfeita.')).toBeInTheDocument();
    // De novo, não há o que desfazer.
    await userEvent.click(
      within(screen.getByRole('dialog')).getAllByRole('button', { name: 'Fechar' }).at(-1) as HTMLElement,
    );
    await userEvent.click(await within(panel).findByRole('button', { name: 'Desfazer tudo de João Lima' }));
    const again = await screen.findByRole('dialog', { name: 'Desfazer tudo de João Lima' });
    await userEvent.type(within(again).getByLabelText('Motivo (obrigatório)'), 'x');
    await userEvent.type(within(again).getByLabelText('Digite João Lima para confirmar'), 'João Lima');
    await waitFor(async () => {
      await userEvent.click(within(again).getByRole('button', { name: 'Desfazer tudo' }));
      expect(await within(again).findByRole('alert')).toHaveTextContent(
        'Esta pessoa não tem operação que ainda possa ser desfeita.',
      );
    }, SLOW);
  });

  it('o analista filtra por pessoa, sem o desfazer tudo', async () => {
    renderAt('/');
    const panel = await screen.findByRole('region', { name: 'Operações recentes' }, SLOW);
    await userEvent.click(within(panel).getByRole('button', { name: /Mostrar/ }));
    await userEvent.selectOptions(within(panel).getByLabelText('De quem'), 'demo-joao');
    await waitFor(() => expect(casePath('authorId=demo-joao').length).toBeGreaterThan(0));
    expect(await within(panel).findByText('Pacote atualizado na imagem base.')).toBeInTheDocument();
    expect(within(panel).queryByText('Limpeza programada dos grupos de log antigos.')).toBeNull();
    expect(within(panel).queryByRole('button', { name: /^Desfazer/ })).toBeNull();
    // As próprias: nenhuma ainda.
    await userEvent.selectOptions(within(panel).getByLabelText('De quem'), 'As minhas');
    expect(await within(panel).findByText('Nenhuma operação desta pessoa')).toBeInTheDocument();
  });

  it('sem operação nenhuma, o painel não existe', async () => {
    renderAt('/');
    server.use(
      http.get(`${API_URL}/v1/triage-operations`, () =>
        HttpResponse.json({ items: [], page: 1, pageSize: 10, total: 0 }),
      ),
    );
    await casesTable();
    await waitFor(() => expect(casePath('triage-operations').length).toBeGreaterThan(0));
    expect(screen.queryByRole('region', { name: 'Operações recentes' })).toBeNull();
  });
});

describe('os alertas da lista em massa', () => {
  it('só os que esperam validação se marcam; o pedido leva os ids', LONG, async () => {
    renderAt('/?visao=alertas');
    const table = await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW);
    const bodies = recordBodies();
    expect(
      within(table).getByRole('checkbox', { name: /Tentativa de desligar.*já está num incidente/ }),
    ).toBeDisabled();
    await userEvent.click(
      within(table).getByRole('checkbox', { name: 'Selecionar: Login do usuário root no console' }),
    );
    await userEvent.click(
      within(table).getByRole('checkbox', { name: 'Selecionar: Tentativa de desativar o GuardDuty' }),
    );
    expect(within(bar()).getByRole('status')).toHaveTextContent('2 alertas · 2 alertas');
    const dialog = await openBulk('Resolvido');
    expect(dialog).toHaveTextContent(/Os já tratados ou em incidente ficam como estão/);
    await userEvent.type(within(dialog).getByLabelText('Motivo (obrigatório)'), 'Corrigido.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Marcar 2 alertas como resolvidos' }));
    expect(await screen.findByText('2 alertas mudaram.')).toBeInTheDocument();
    expect((bodies[0]?.['target'] as { findingIds: string[] }).findingIds).toHaveLength(2);
  });

  it('marcar a página pula os que não podem', async () => {
    renderAt('/?visao=alertas');
    const table = await screen.findByRole('table', { name: 'Alertas do cliente' }, SLOW);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Selecionar os alertas desta página' }));
    const boxes = within(table).getAllByRole<HTMLInputElement>('checkbox', { name: /^Selecionar: / });
    for (const box of boxes) expect(box.checked).toBe(!box.disabled);
  });
});

describe('o detalhe do caso', () => {
  const open = async (path = '/', name: RegExp = /^Abrir o caso: Chamadas negadas/) => {
    const router = renderAt(path);
    await userEvent.click(await screen.findByRole('button', { name }, SLOW));
    const detail = await screen.findByRole('dialog');
    await within(detail).findByRole('region', { name: 'Resumo' }, SLOW);
    return { router, detail };
  };

  it('o resumo, o que os alertas têm em comum, o que foge do padrão e a linha do tempo', async () => {
    const { router, detail } = await open();
    expect(search(router).get('caso')).not.toBeNull();
    expect(within(detail).getByRole('region', { name: 'Resumo' })).toHaveTextContent(
      /49 alertas para tratar, de 49 guardados/,
    );
    const common = within(detail).getByRole('region', { name: 'O que os alertas têm em comum' });
    expect(common).toHaveTextContent(/Conta111122223333Regra80202/);
    expect(common).toHaveTextContent(/nunca dividem um caso/);
    const rare = within(detail).getByRole('region', { name: 'O que foge do padrão' });
    expect(within(rare).getAllByRole('listitem')[0]).toHaveTextContent(/^198\.51\.100\.2001 vez/);
    expect(
      await within(detail).findByRole(
        'img',
        { name: /^Alertas do caso por hora: 49 alertas no total/ },
        SLOW,
      ),
    ).toBeInTheDocument();
  });

  it('um alerta abre no mesmo painel, e "Voltar ao caso" devolve o filtro e o foco', LONG, async () => {
    const { router, detail } = await open();
    const caseId = search(router).get('caso');
    await userEvent.selectOptions(within(detail).getByLabelText('Severidade do alerta'), 'low');
    const links = await within(detail).findAllByRole('link', { name: /^Chamadas negadas/ }, SLOW);
    await waitFor(() => expect(casePath('severity=low').length).toBeGreaterThan(0));
    const id = (links[1] as HTMLElement).dataset['alerta'];
    await userEvent.click(links[1] as HTMLElement);
    await waitFor(() => expect(search(router).get('alerta')).toBe(id));
    expect(search(router).get('caso')).toBe(caseId);
    await userEvent.click(await screen.findByRole('button', { name: 'Voltar ao caso' }, SLOW));
    await waitFor(() => expect(search(router).get('alerta')).toBeNull());
    expect(search(router).get('caso')).toBe(caseId);
    const back = await screen.findByLabelText('Severidade do alerta', undefined, SLOW);
    expect(back).toHaveValue('low');
    await waitFor(() => expect((document.activeElement as HTMLElement).dataset['alerta']).toBe(id));
    // Fechar fecha tudo.
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search(router).get('caso')).toBeNull());
  });

  it('os alertas vêm aos poucos, e o cursor que não vale mais recomeça', LONG, async () => {
    const { detail } = await open();
    expect(await within(detail).findAllByRole('link', { name: /^Chamadas negadas/ }, SLOW)).toHaveLength(20);
    await userEvent.click(within(detail).getByRole('button', { name: 'Carregar mais alertas' }));
    await waitFor(() =>
      expect(within(detail).getAllByRole('link', { name: /^Chamadas negadas/ })).toHaveLength(40),
    );
    server.use(
      http.get(
        `${API_URL}/v1/cases/:id/findings`,
        () =>
          HttpResponse.json({ statusCode: 400, code: 'CASE_CURSOR_INVALID', message: 'x' }, { status: 400 }),
        { once: true },
      ),
    );
    await userEvent.click(within(detail).getByRole('button', { name: 'Carregar mais alertas' }));
    expect(await within(detail).findByText(/recomeçou do mais recente/, undefined, SLOW)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(detail).getAllByRole('link', { name: /^Chamadas negadas/ })).toHaveLength(20),
    );
  });

  it('a linha do tempo que o banco cortou não derruba o resto, e dá para tentar de novo', async () => {
    renderAt('/');
    server.use(
      http.get(`${API_URL}/v1/cases/:id/timeline`, () => HttpResponse.json({}, { status: 503 }), {
        once: true,
      }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: /^Abrir o caso: Chamadas negadas/ }, SLOW),
    );
    const timeline = await screen.findByRole('region', { name: 'Linha do tempo' }, SLOW);
    await userEvent.click(await within(timeline).findByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByRole('img', { name: /^Alertas do caso por hora/ }, SLOW)).toBeInTheDocument();
  });

  it('sem a análise (caso grande demais), o resto vale; incompleta, diz sobre quantos', async () => {
    const answer = async (change: (detail: Record<string, unknown>) => unknown) => {
      server.use(
        http.get(`${API_URL}/v1/cases/:id`, async ({ request, params }) => {
          if (['status', 'groups'].includes(String(params['id']))) return undefined;
          if (new URL(request.url).searchParams.has('original')) return undefined;
          const original = (await (await fetch(`${request.url}?original=1`)).json()) as Record<
            string,
            unknown
          >;
          return HttpResponse.json(caseDetailSchema.parse(change(original)));
        }),
      );
      await userEvent.click(
        await screen.findByRole('button', { name: /^Abrir o caso: Chamadas negadas/ }, SLOW),
      );
      return screen.findByRole('region', { name: 'O que foge do padrão' }, SLOW);
    };
    const view = renderAt('/');
    expect(await answer((detail) => ({ ...detail, analysis: null }))).toHaveTextContent(/grande demais/);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search(view).get('caso')).toBeNull());
  });

  it('o subgrupo se trata e se separa; o caso anterior e as operações ficam no detalhe', LONG, async () => {
    const { detail } = await open(
      '/?fila=postura',
      /^Abrir o caso: Controle de segurança reprovado, arn:aws:s3:::loja-exemplo-backups$/,
    );
    const groups = await within(detail).findByRole('region', { name: 'Recursos' });
    expect(within(groups).getAllByRole('listitem')).toHaveLength(3);
    await userEvent.click(
      within(groups).getByRole('button', { name: 'Tratar este grupo: arn:aws:s3:::loja-exemplo-relatorios' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Tratar: grupo arn:aws:s3:::loja-exemplo-relatorios',
    });
    await userEvent.click(within(dialog).getByRole('radio', { name: /^Resolvido/ }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Marcar 1 alerta como resolvido' }));
    expect(await screen.findByText('1 alerta mudou.')).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole('dialog', { name: /^Resolvido:/ }))
        .getAllByRole('button', { name: 'Fechar' })
        .at(-1) as HTMLElement,
    );
    const operations = await screen.findByRole('region', { name: 'Operações em massa' }, SLOW);
    expect(operations).toHaveTextContent(/Marcar como resolvido · concluída · 1 alerta/);
    expect(within(operations).getByRole('button', { name: /^Desfazer/ })).toBeInTheDocument();

    // Dividir pelo grupo.
    await userEvent.click(
      screen.getByRole('button', { name: /^Separar ?em outro caso: arn:aws:s3:::loja-exemplo-imagens$/ }),
    );
    const split = await screen.findByRole('dialog', { name: 'Separar em outro caso' });
    await userEvent.click(within(split).getByRole('button', { name: 'Separar 1 alerta' }));
    expect(
      await within(split).findByText(/1 alerta separado; 2 alertas ficaram neste caso/),
    ).toBeInTheDocument();
    await userEvent.click(within(split).getByRole('link', { name: 'Abrir o caso novo' }));
    expect(await screen.findByText(/Nasceu de um caso dividido/, undefined, SLOW)).toBeInTheDocument();
  });

  it(
    'os alertas marcados no detalhe se tratam e se separam; o caso inteiro não se separa',
    LONG,
    async () => {
      const { detail } = await open();
      const boxes = await within(detail).findAllByRole('checkbox', { name: /^Selecionar: / }, SLOW);
      await userEvent.click(boxes[0] as HTMLElement);
      await userEvent.click(boxes[1] as HTMLElement);
      const actions = within(detail).getByRole('region', { name: 'Ações nos alertas marcados' });
      expect(within(actions).getByRole('status')).toHaveTextContent('2 alertas marcados');
      await userEvent.click(within(actions).getByRole('button', { name: 'Separar em outro caso' }));
      const split = await screen.findByRole('dialog', { name: 'Separar em outro caso' });
      await userEvent.type(within(split).getByLabelText('Motivo (opcional)'), 'Outra história.');
      await userEvent.click(within(split).getByRole('button', { name: 'Separar 2 alertas' }));
      expect(await within(split).findByText(/2 alertas separados; 47 alertas ficaram/)).toBeInTheDocument();
      await userEvent.click(within(split).getAllByRole('button', { name: 'Fechar' }).at(-1) as HTMLElement);
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: 'Ações nos alertas marcados' })).toBeNull(),
      );
      await userEvent.keyboard('{Escape}');

      // Um caso de um alerta só não se divide.
      await userEvent.click(
        await screen.findByRole('button', { name: /^Abrir o caso: Login do usuário root/ }, SLOW),
      );
      const single = await screen.findByRole('dialog', { name: 'Login do usuário root no console' });
      await userEvent.click(await within(single).findByRole('checkbox', { name: /^Selecionar: / }, SLOW));
      await userEvent.click(within(single).getByRole('button', { name: 'Separar em outro caso' }));
      const refused = await screen.findByRole('dialog', { name: 'Separar em outro caso' });
      expect(within(refused).getByRole('alert')).toHaveTextContent('pelo menos um alerta');
      expect(within(refused).getByRole('button', { name: 'Separar 1 alerta' })).toBeDisabled();
    },
  );

  it('o caso que voltou mostra o anterior; o anterior mostra a operação que o tratou', async () => {
    const { detail } = await open('/', /^Abrir o caso: Grupo de log/);
    expect(detail).toHaveTextContent('Voltou depois de tratado (1×)');
    const previous = within(detail).getByRole('region', { name: 'Casos anteriores' });
    expect(previous).toHaveTextContent(/tratado · 3 alertas · nada pendente/);
    await userEvent.click(within(previous).getByRole('link'));
    expect(
      await screen.findByText('Limpeza programada dos grupos de log antigos.', undefined, SLOW),
    ).toBeInTheDocument();
    expect(screen.getByText('Nada pendente')).toBeInTheDocument();
    // Passou do prazo: não se desfaz.
    expect(screen.queryByRole('button', { name: /^Desfazer/ })).toBeNull();
  });

  it('resolvido, mas a origem voltou a ver: diz quantos', async () => {
    const { detail } = await open(
      '/?visao=vulnerabilidades&agrupar=sem-grupo&busca=zlib',
      /^Abrir o caso: Vulnerabilidade em pacote, zlib/,
    );
    expect(detail).toHaveTextContent('2 alertas marcados como resolvidos continuam ativos na origem.');
    expect(await within(detail).findAllByText('Ainda ativo na origem', undefined, SLOW)).toHaveLength(2);
  });

  it('caso que não existe mais: o erro, sem derrubar a tela', async () => {
    renderAt('/?caso=018f2c1e-0000-7000-8000-0000000fffff');
    const dialog = await screen.findByRole('dialog', { name: 'Caso' }, SLOW);
    expect(await within(dialog).findByText('Não encontrado.')).toBeInTheDocument();
  });

  it('na tela larga, o detalhe fica ao lado, com o foco no título, e Esc devolve o foco à linha', async () => {
    wide();
    const router = renderAt('/');
    const opener = await screen.findByRole('button', { name: /^Abrir o caso: Login do usuário root/ }, SLOW);
    await userEvent.click(opener);
    const aside = await screen.findByRole('complementary', { name: 'Login do usuário root no console' });
    expect(opener).toHaveAttribute('aria-current', 'true');
    await waitFor(() => expect(within(aside).getByRole('heading', { level: 2 })).toHaveFocus());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(search(router).get('caso')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('a triagem de um alerta só, no painel, atualiza o caso e a trilha do alerta', LONG, async () => {
    const { router, detail } = await open('/', /^Abrir o caso: Login do usuário root/);
    await userEvent.click(
      await within(detail).findByRole('link', { name: 'Login do usuário root no console' }, SLOW),
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Marcar como resolvido' }, SLOW));
    await userEvent.click(await screen.findByRole('button', { name: 'Voltar ao caso' }));
    expect(await screen.findByText('Nada pendente', undefined, SLOW)).toBeInTheDocument();
    expect(search(router).get('caso')).not.toBeNull();
  });
});

describe('a exportação', () => {
  it('os casos em CSV, sem fórmula na planilha', async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt('/');
    await casesTable();
    await userEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText(/^\d+ linhas exportadas\.$/)).toBeInTheDocument();
    const text = await (blobs[0] as Blob).text();
    expect(text.split('\r\n')[0]).toContain('"ID";"Fila";"Título";"O que os alertas têm em comum"');
    expect(text).toContain('"Chamadas negadas por falta de permissão (AccessDenied) em sequência"');
    expect(casePath('/v1/cases?').at(-1)).toMatch(/pageSize=100/);
    vi.restoreAllMocks();
  });
});

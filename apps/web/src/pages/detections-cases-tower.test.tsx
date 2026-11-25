import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type CaseDetail,
  caseDetailSchema,
  casePageSchema,
  type Role,
  triageOperationPageSchema,
  type TowerSummary,
  towerSummarySchema,
} from '@verax/shared';
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

/**
 * Os casos no resumo da situação, no radar e nas análises; e o que a tela dos casos passou a saber pela API. Com um nó de
 * antes (que recusa o pedido, ou não manda o campo), a tela é a de sempre.
 */

const server = setupServer();
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
  window.localStorage.clear();
  vi.restoreAllMocks();
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

function renderAt(
  path: string,
  state: MockState = stateOf('analista_cliente'),
  ...first: Parameters<typeof server.use>
) {
  server.use(...createHandlers(state));
  if (first.length > 0) server.use(...first);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const search = (router: ReturnType<typeof renderAt>) => new URLSearchParams(router.state.location.search);
const asked = (path: string) => requests.filter((request) => request.startsWith(`GET ${path}`));
const strip = () => screen.findByRole('region', { name: 'Situação agora' });
const decisions = async () =>
  within(await strip()).findByRole('region', { name: 'Decisões pendentes' }, SLOW);

/** A Torre da demonstração, para o teste mudar o que quiser. */
async function demoSummary(query = '?cases=true'): Promise<TowerSummary> {
  return towerSummarySchema.parse(await (await fetch(`${API_URL}/v1/tower${query}`)).json());
}

describe('o pedido dos casos', () => {
  it('desligados: a Torre e as análises de sempre, sem pedir nada dos casos', async () => {
    renderAt('/?analise=resumo', stateOf('analista_cliente', { cases: 'off' }));
    await decisions();
    await screen.findByText('Alertas no período', undefined, SLOW);
    expect(asked('/v1/tower')).toEqual(['GET /v1/tower']);
    expect(asked('/v1/reports')).toEqual(['GET /v1/reports/summary?period=30d']);
    expect(screen.queryByRole('group', { name: /^Radar de casos/ })).toBeNull();
    expect(screen.getByRole('group', { name: /^Radar de detecções/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Casos abertos no período' })).toBeNull();
    expect(within(await strip()).queryByText(/casos? pendentes?|Nenhum caso/)).toBeNull();
  });

  it('na medição, quem é do cliente pede o de sempre', async () => {
    renderAt('/', stateOf('analista_cliente', { cases: 'shadow' }));
    await decisions();
    expect(asked('/v1/tower')).toEqual(['GET /v1/tower']);
  });

  it('ligados: um pedido só, já com os casos', async () => {
    renderAt('/?analise=mitre');
    await decisions();
    await screen.findByRole('heading', { name: 'Casos por tática' }, SLOW);
    expect(asked('/v1/tower')).toEqual(['GET /v1/tower?cases=true']);
    expect(asked('/v1/reports/mitre')).toEqual(['GET /v1/reports/mitre?period=30d&cases=true']);
  });

  it('o relatório que não muda com os casos não os pede', async () => {
    renderAt('/?analise=regras');
    await screen.findByRole('heading', { name: 'Regras que mais dispararam' }, SLOW);
    expect(asked('/v1/reports/rules')).toEqual(['GET /v1/reports/rules?period=30d']);
  });
});

describe('versões diferentes do nó', () => {
  const refuse = (path: string) =>
    http.get(`${API_URL}${path}`, ({ request }) =>
      new URL(request.url).searchParams.has('cases')
        ? HttpResponse.json({ statusCode: 400, message: 'Dados inválidos' }, { status: 400 })
        : undefined,
    );

  it('o nó que tem casos e recusa o pedido: a Torre e as análises de sempre', async () => {
    renderAt(
      '/?analise=resumo',
      stateOf('analista_cliente'),
      refuse('/v1/tower'),
      refuse('/v1/reports/:kind'),
    );
    const list = await decisions();
    expect(within(list).getByText(/^\d+ alertas altos ou críticos para validar$/)).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Ver os alertas' })).toHaveAttribute(
      'href',
      '/?status=new',
    );
    expect(screen.getByRole('group', { name: /^Radar de detecções/ })).toBeInTheDocument();
    await screen.findByText('Alertas no período', undefined, SLOW);
    expect(screen.queryByRole('heading', { name: 'Casos abertos no período' })).toBeNull();
    expect(asked('/v1/tower')).toEqual(['GET /v1/tower?cases=true', 'GET /v1/tower']);
    expect(asked('/v1/reports/summary')).toEqual([
      'GET /v1/reports/summary?period=30d&cases=true',
      'GET /v1/reports/summary?period=30d',
    ]);
  });

  it('o nó mais novo manda algo que este painel não conhece: vale a resposta de sempre', async () => {
    renderAt(
      '/',
      stateOf('analista_cliente'),
      http.get(`${API_URL}/v1/tower`, async ({ request }) => {
        if (!new URL(request.url).searchParams.has('cases')) return undefined;
        return HttpResponse.json({ ...(await demoSummary('')), futuro: true });
      }),
    );
    expect(await screen.findByRole('group', { name: /^Radar de detecções/ }, SLOW)).toBeInTheDocument();
    expect(await decisions()).toHaveTextContent(/alertas altos ou críticos para validar/);
  });

  it('um erro de verdade continua sendo erro, sem segundo pedido', async () => {
    renderAt(
      '/',
      stateOf('analista_cliente'),
      http.get(`${API_URL}/v1/tower`, () => HttpResponse.json({ statusCode: 403 }, { status: 403 })),
    );
    expect(await within(await strip()).findByRole('alert', undefined, SLOW)).toBeInTheDocument();
    expect(asked('/v1/tower')).toEqual(['GET /v1/tower?cases=true']);
  });
});

describe('as decisões pendentes', () => {
  it('contam casos, e cada uma leva à lista certa', async () => {
    const router = renderAt('/?visao=alertas&busca=root');
    const list = await decisions();
    expect(
      within(list).getByText(/^\d+ casos? com alerta alto ou crítico para validar$/),
    ).toBeInTheDocument();
    expect(
      within(list).getByText(/^\d+ casos? de vulnerabilidade com alerta alto ou crítico para validar$/),
    ).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Ver os casos' })).toHaveAttribute('href', '/');
    expect(within(list).getByRole('link', { name: 'Ver a postura' })).toHaveAttribute(
      'href',
      '/?fila=postura',
    );
    expect(within(list).getByRole('link', { name: 'Ver as vulnerabilidades' })).toHaveAttribute(
      'href',
      '/?visao=vulnerabilidades',
    );
    expect(list).toHaveTextContent(/casos? pendentes? de detecção, .* de vulnerabilidade e .* de postura\./);
    await userEvent.click(within(list).getByRole('link', { name: 'Ver os casos' }));
    expect(await screen.findByRole('table', { name: 'Casos do cliente' }, SLOW)).toBeInTheDocument();
    expect([...search(router)]).toEqual([]);
    await userEvent.click(within(await decisions()).getByRole('link', { name: 'Ver a postura' }));
    await waitFor(() => expect(search(router).get('fila')).toBe('postura'));
  });

  it('as contagens batem com a lista de casos e com os alertas fora deles', async () => {
    renderAt('/');
    await decisions();
    const summary = await demoSummary();
    const plain = await demoSummary('');
    const countOf = (from: TowerSummary, kind: string) =>
      from.pendingDecisions.find((decision) => decision.kind === kind)?.count ?? 0;
    expect(countOf(summary, 'untriaged_case')).toBeGreaterThan(0);
    expect(countOf(summary, 'untriaged_case')).toBeLessThan(countOf(plain, 'untriaged_finding'));
    expect([summary.light, summary.reasons]).toEqual([plain.light, plain.reasons]);
    expect(summary.radar?.total).toBe(plain.radar?.total);
    expect(summary.radar?.cases?.alerts).toBeLessThanOrEqual(plain.radar?.total ?? 0);
  });

  const decided = async (changes: (summary: TowerSummary) => Partial<TowerSummary>) => {
    renderAt(
      '/',
      stateOf('analista_cliente'),
      http.get(`${API_URL}/v1/tower`, async ({ request }) => {
        if (request.headers.has('x-original')) return undefined;
        const original = towerSummarySchema.parse(
          await (await fetch(request.url, { headers: { 'x-original': '1' } })).json(),
        );
        return HttpResponse.json({ ...original, ...changes(original) });
      }),
    );
    return decisions();
  };

  it('só postura: um link só, para ela', async () => {
    const none = { critical: 0, high: 0, medium: 0, low: 0 };
    const list = await decided((summary) => ({
      pendingDecisions: [{ kind: 'untriaged_case', count: 1 }],
      ...(summary.cases && {
        cases: { ...summary.cases, detection: { ...none, low: 3 }, posture: { ...none, high: 1 } },
      }),
    }));
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Ver a postura']);
    expect(list).toHaveTextContent('1 caso com alerta alto ou crítico para validar');
  });

  it('só detecção: um link só; e os alertas fora dos casos têm a própria linha', async () => {
    const none = { critical: 0, high: 0, medium: 0, low: 0 };
    const list = await decided((summary) => ({
      pendingDecisions: [
        { kind: 'untriaged_case', count: 2 },
        { kind: 'untriaged_finding', count: 5 },
      ],
      ...(summary.cases && { cases: { ...summary.cases, posture: none } }),
    }));
    expect(
      within(list)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Ver os casos', 'Ver os alertas']);
    expect(list).toHaveTextContent('5 alertas altos ou críticos para validar fora dos casos');
  });

  it('a equipe da Verax na medição: os casos no radar, e as decisões continuam contando alertas', async () => {
    renderAt('/', stateOf('admin_verax', { cases: 'shadow' }));
    const list = await decisions();
    expect(within(list).getByText(/^\d+ alertas altos ou críticos para validar$/)).toBeInTheDocument();
    expect(within(list).queryByText(/fora dos casos/)).toBeNull();
    expect(await screen.findByRole('group', { name: /^Radar de casos/ }, SLOW)).toBeInTheDocument();
    expect(list).toHaveTextContent(/casos? pendentes? de detecção/);
  });

  it('recolhido, diz os casos junto das detecções', async () => {
    renderAt('/');
    await decisions();
    await userEvent.click(within(await strip()).getByRole('button', { name: /Recolher/ }));
    const summary = await demoSummary();
    const total = summary.radar?.cases?.total ?? 0;
    expect(total).toBeGreaterThan(1);
    const name = within(await strip())
      .getByRole('status', { name: /^Situação: / })
      .getAttribute('aria-label');
    expect(name).toMatch(/\d+ detecções em 24 h, \d+ casos de detecção, \d+ decisões pendentes\.$/);
    expect(name).toContain(`, ${summary.radar?.total} detecções em 24 h, ${total} casos de detecção, `);
  });
});

describe('o radar de casos', () => {
  it('o ponto abre o caso no painel, mantendo os filtros; a frase liga os alertas aos casos', async () => {
    const router = renderAt('/?severidade=high');
    const radar = await screen.findByRole('group', { name: /^Radar de casos das últimas 24 horas/ }, SLOW);
    const points = within(radar).getAllByRole('link');
    const summary = await demoSummary();
    expect(points).toHaveLength(summary.radar?.cases?.items.length ?? -1);
    expect((await strip()).textContent).toContain(
      `${summary.radar?.cases?.alerts} alertas em ${summary.radar?.cases?.total} casos de detecção`,
    );
    const root = within(radar).getByRole('link', { name: /Login do usuário root no console/ });
    await userEvent.click(root);
    const panel = await screen.findByRole('dialog', { name: 'Login do usuário root no console' }, SLOW);
    expect(panel).toHaveTextContent(/Caso · Detecção/);
    expect(search(router).get('severidade')).toBe('high');
    const id = search(router).get('caso');
    expect(summary.radar?.cases?.items.map((item) => item.id)).toContain(id);
  });
});

describe('as análises com os casos', () => {
  it('o resumo: abertos, tratados, pendentes e a mediana, e o CSV com os números crus', async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt('/?analise=resumo');
    const heading = await screen.findByRole('heading', { name: 'Casos abertos no período' }, SLOW);
    const section = heading.closest('section') as HTMLElement;
    const body = (await (await fetch(`${API_URL}/v1/reports/summary?period=30d&cases=true`)).json()) as {
      cases: { opened: number; treated: number; pending: number; medianMinutesToTreat: number };
    };
    expect(body.cases.opened).toBe(body.cases.treated + body.cases.pending);
    for (const [label, value] of [
      ['Casos abertos', body.cases.opened],
      ['Já tratados', body.cases.treated],
      ['Ainda pendentes', body.cases.pending],
    ] as const) {
      expect(within(section).getByText(label).parentElement).toHaveTextContent(`${label}${value}`);
    }
    expect(within(section).getByText('Tempo mediano até tratar')).toBeInTheDocument();
    await userEvent.click(
      within(section).getByRole('button', { name: 'Exportar Casos abertos no período em CSV' }),
    );
    const lines = (await (blobs[0] as Blob).text()).split('\r\n');
    expect(lines[0]).toContain('"Casos abertos";"Tratados";"Pendentes";"Mediana até tratar (minutos)"');
    const { opened, treated, pending, medianMinutesToTreat } = body.cases;
    expect(lines[1]).toBe(
      [opened, treated, pending, medianMinutesToTreat].map((value) => `"${value}"`).join(';'),
    );
  });

  it('o MITRE: a coluna dos casos na tabela e no CSV, só com eles', async () => {
    renderAt('/?analise=mitre');
    const table = await screen.findByRole('table', { name: 'Táticas e técnicas do MITRE ATT&CK' }, SLOW);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['Tática', 'Casos', 'Alertas', 'Participação', 'Incidentes', 'Técnicas mais vistas']);
    const discovery = within(table)
      .getByText(/Descoberta/)
      .closest('tr') as HTMLElement;
    const [cases, alerts] = [...discovery.querySelectorAll('td')]
      .slice(1, 3)
      .map((cell) => Number(cell.textContent));
    expect(cases).toBeGreaterThan(0);
    expect(cases).toBeLessThan(alerts ?? 0);
  });

  it('desligados, a tabela do MITRE é a de sempre', async () => {
    renderAt('/?analise=mitre', stateOf('analista_cliente', { cases: 'off' }));
    const table = await screen.findByRole('table', { name: 'Táticas e técnicas do MITRE ATT&CK' }, SLOW);
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).not.toContain('Casos');
    expect(screen.getByRole('heading', { name: 'Alertas por tática' })).toBeInTheDocument();
  });
});

describe('as operações no detalhe do caso', () => {
  const withOperation = (change: (operation: CaseDetail['operations'][number]) => object) =>
    http.get(`${API_URL}/v1/cases/:id`, async ({ request, params }) => {
      if (request.headers.has('x-original') || params['id'] === 'status') return undefined;
      const response = await fetch(request.url, { headers: { 'x-original': '1' } });
      const detail = caseDetailSchema.parse(await response.json());
      return HttpResponse.json({ ...detail, operations: detail.operations.map((item) => change(item)) });
    });
  const openOperations = async () => {
    await userEvent.click(
      await screen.findByRole('button', { name: /^Abrir o caso: Vulnerabilidade.*zlib/ }, SLOW),
    );
    return screen.findByRole('region', { name: 'Operações em massa' }, SLOW);
  };
  const path = '/?visao=vulnerabilidades&agrupar=sem-grupo&busca=zlib';

  it('o que a API diz que dá para fazer, aparece; o que não diz, não', LONG, async () => {
    renderAt(path, stateOf('analista_cliente'));
    // A operação é de outra pessoa, e o analista não administra.
    const list = await openOperations();
    expect(list).toHaveTextContent('Pacote atualizado na imagem base.');
    expect(within(list).queryByRole('button')).toBeNull();
  });

  it('quem administra desfaz daqui', async () => {
    renderAt(path, stateOf('admin_cliente'));
    expect(within(await openOperations()).getByRole('button', { name: /^Desfazer/ })).toBeInTheDocument();
  });

  it('cancelar e continuar também vêm da API, mesmo para quem a regra do painel não deixaria desfazer', async () => {
    renderAt(
      path,
      stateOf('analista_cliente'),
      withOperation((operation) => ({
        ...operation,
        state: 'partial',
        can: { cancel: true, continue: true, undo: false },
      })),
    );
    const list = await openOperations();
    expect(within(list).getByRole('button', { name: /^Continuar/ })).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: /^Desistir do resto/ })).toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /^Desfazer/ })).toBeNull();
  });

  it('um nó de antes não diz: vale a regra do painel, só para desfazer', async () => {
    const older = withOperation(({ can: _can, ...operation }) => ({ ...operation, state: 'partial' }));
    renderAt(path, stateOf('admin_cliente'), older);
    const list = await openOperations();
    expect(within(list).getByRole('button', { name: /^Desfazer/ })).toBeInTheDocument();
    expect(within(list).getAllByRole('button')).toHaveLength(1);
  });

  it('na medição, a equipe da Verax não vê ação nenhuma', async () => {
    renderAt(path, stateOf('admin_verax', { cases: 'shadow' }));
    const list = await openOperations();
    expect(within(list).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Tratar o caso' })).toBeNull();
  });
});

describe('o filtro por pessoa das operações', () => {
  const openPanel = async () => {
    const panel = await screen.findByRole('region', { name: 'Operações recentes' }, SLOW);
    await userEvent.click(within(panel).getByRole('button', { name: /Mostrar/ }));
    return panel;
  };
  const people = (panel: HTMLElement) =>
    [...within(panel).getByLabelText<HTMLSelectElement>('De quem').options].map(
      (option) => option.textContent,
    );

  it('traz quem pediu operações nos últimos 30 dias, mesmo fora da primeira página', async () => {
    renderAt(
      '/',
      stateOf('analista_cliente'),
      http.get(`${API_URL}/v1/triage-operations/authors`, () =>
        HttpResponse.json({
          items: [
            { id: 'demo-carlos', name: 'Carlos Dev' },
            { id: 'demo-analista_cliente', name: 'Eu Mesma' },
          ],
          truncated: false,
        }),
      ),
    );
    // Recolhido, com as operações já lidas, ninguém precisa da lista de pessoas.
    const closed = await screen.findByRole('region', { name: 'Operações recentes' }, SLOW);
    await within(closed).findByRole('button', { name: /Mostrar/ });
    await screen.findAllByRole('button', { name: /^Abrir o caso: / }, SLOW);
    expect(asked('/v1/triage-operations/authors')).toEqual([]);
    const panel = await openPanel();
    await waitFor(() => expect(people(panel)).toContain('Carlos Dev'));
    expect(people(panel)).toEqual(['Todas as pessoas', 'As minhas', 'Carlos Dev', 'João Lima', 'Ana Souza']);
    await userEvent.selectOptions(within(panel).getByLabelText('De quem'), 'demo-carlos');
    expect(
      await within(panel).findByText('Nenhuma operação desta pessoa', undefined, SLOW),
    ).toBeInTheDocument();
  });

  it('um nó de antes recusa: o filtro fica com quem se vê nas operações', async () => {
    renderAt(
      '/',
      stateOf('analista_cliente'),
      http.get(`${API_URL}/v1/triage-operations/authors`, () =>
        HttpResponse.json({ statusCode: 400, message: 'id inválido' }, { status: 400 }),
      ),
    );
    const panel = await openPanel();
    await waitFor(() => expect(asked('/v1/triage-operations/authors')).toHaveLength(1));
    const page = triageOperationPageSchema.parse(
      await (await fetch(`${API_URL}/v1/triage-operations?page=1&pageSize=10`)).json(),
    );
    expect(people(panel)).toEqual([
      'Todas as pessoas',
      'As minhas',
      ...new Set(page.items.map((item) => item.author?.name)),
    ]);
    expect(within(panel).queryByRole('alert')).toBeNull();
  });
});

describe('a prévia de um filtro no diálogo', () => {
  const openDialog = async (...first: Parameters<typeof server.use>) => {
    renderAt('/', stateOf('analista_cliente'), ...first);
    await screen.findByRole('table', { name: 'Casos do cliente' }, SLOW);
    await userEvent.selectOptions(screen.getByLabelText('Severidade'), 'high');
    await userEvent.click(
      await screen.findByRole('button', { name: /^Selecionar (os \d+ casos|o caso) do filtro$/ }, SLOW),
    );
    const bar = screen.getByRole('region', { name: 'Ações em lote' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Em análise' }));
    // Enquanto a prévia conta, o diálogo é outro.
    await screen.findByRole('button', { name: /^Colocar/ }, SLOW);
    return screen.getByRole('dialog', { name: /^Tratar:/ });
  };
  const preview = (change: (body: Record<string, unknown>) => object) =>
    http.get(`${API_URL}/v1/triage-operations/preview`, async ({ request }) => {
      if (request.headers.has('x-original')) return undefined;
      const response = await fetch(request.url, { headers: { 'x-original': '1' } });
      return HttpResponse.json(change((await response.json()) as Record<string, unknown>));
    });

  it('diz quantos casos tocam a lista de proteção, e a conta de "em análise" é exata', LONG, async () => {
    const dialog = await openDialog(
      preview((body) => ({
        ...body,
        protectedCases: 2,
        pending: { critical: 2, high: 9, medium: 0, low: 0 },
        new: 8,
        investigating: 3,
        alerts: 11,
        byStatus: {
          new: { critical: 1, high: 7, medium: 0, low: 0 },
          investigating: { critical: 1, high: 2, medium: 0, low: 0 },
        },
      })),
    );
    expect(within(dialog).getByText('2 casos tocam a lista de proteção')).toBeInTheDocument();
    expect(within(dialog).queryByText(/O filtro pode incluir/)).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Colocar 7 alertas em análise' })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: /^Incluir também/ }));
    expect(within(dialog).getByRole('button', { name: 'Colocar 8 alertas em análise' })).toBeInTheDocument();
  });

  it('nenhum protegido: nada a avisar', async () => {
    const dialog = await openDialog(preview((body) => ({ ...body, protectedCases: 0 })));
    expect(within(dialog).queryByText(/lista de proteção/)).toBeNull();
  });

  it('um nó de antes não diz: o aviso de sempre, e a conta é um teto', async () => {
    const dialog = await openDialog(
      preview(({ protectedCases: _protected, byStatus: _byStatus, ...body }) => ({
        ...body,
        pending: { critical: 2, high: 9, medium: 0, low: 0 },
        new: 8,
        investigating: 3,
        alerts: 11,
      })),
    );
    expect(
      within(dialog).getByText(/O filtro pode incluir casos que tocam a lista de proteção/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('button', { name: 'Colocar até 9 alertas em análise' }),
    ).toBeInTheDocument();
  });
});

describe('voltou depois de tratado', () => {
  it('na exportação, as voltas e quantas foram depois de tratado', async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:x';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt(
      '/?busca=Grupo%20de%20log',
      stateOf('analista_cliente'),
      http.get(`${API_URL}/v1/cases`, async ({ request }) => {
        if (request.headers.has('x-original')) return undefined;
        const response = await fetch(request.url, { headers: { 'x-original': '1' } });
        const page = casePageSchema.parse(await response.json());
        return HttpResponse.json({
          ...page,
          items: page.items.map((item) => ({ ...item, recurrence: 5, recurrenceTreated: 2 })),
        });
      }),
    );
    await screen.findByRole('button', { name: /^Abrir o caso: Grupo de log/ }, SLOW);
    await userEvent.click(screen.getByRole('button', { name: 'Exportar CSV' }));
    expect(await screen.findByText(/^\d+ linhas? exportadas?\.$/)).toBeInTheDocument();
    const [header, first] = (await (blobs[0] as Blob).text()).split('\r\n');
    // Toda célula vem entre aspas, e o texto pode ter ponto e vírgula.
    const cells = (line: string | undefined) => (line ?? '').split('";"');
    const value = (name: string) => cells(first)[cells(header).findIndex((cell) => cell === name)];
    expect(cells(first)).toHaveLength(cells(header).length);
    expect(value('Vezes que voltou')).toBe('5');
    expect(value('Voltas depois de tratado')).toBe('2');
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import {
  GB_BYTES,
  GIB_BYTES,
  PLAN_LIMIT_REACHED_CODE,
  type PlanUsage,
  planLimitMessage,
  planUsageSchema,
  resolvePlan,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { formatPercent, formatUsageMonth, formatVolume } from '@/features/plan/plan-format';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoAdminStore } from '@/mocks/admin';
import { DEMO_TENANTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import {
  DEMO_FRANCHISE_GB_PER_DAY,
  DEMO_PLAN,
  DEMO_PLATFORM_PLAN,
  DEMO_VOLUME_RATIO,
  demoFranchise,
  demoPlanRefusal,
  demoPlanUsage,
} from '@/mocks/plan-handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

const [ALFA, BETA] = DEMO_TENANTS;

function renderAt(path: string, state: MockState, plan?: PlanUsage) {
  server.use(
    ...(plan ? [http.get(`${API_URL}/v1/plan`, () => HttpResponse.json(plan))] : []),
    ...createHandlers(state),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const veraxIn = (tenantId: string | undefined) =>
  demoMe('admin_verax', { activeTenantId: tenantId ?? null, scopeTenantId: tenantId ?? null });

/** A página carregada: a moldura com o título, já sem o "Carregando". */
async function page() {
  const heading = await screen.findByRole('heading', { level: 1, name: 'Plano e uso' });
  await screen.findByRole('heading', { name: /^Plano / });
  return heading.closest('section') as HTMLElement;
}

const tile = (name: string) => screen.getByRole('region', { name });

const usage = (overrides: Partial<PlanUsage['usage']>, plan = DEMO_PLAN): PlanUsage => ({
  plan,
  usage: { cloudAccounts: 1, users: 1, month: '2026-11', monthlyBytes: 0, ...overrides },
});

describe('Plano e uso', () => {
  it('fica em Administração, só para quem administra', async () => {
    renderAt('/cadastros/plano', { me: demoMe('admin_cliente') });
    const nav = await screen.findByRole('navigation', { name: 'Menu principal' });
    expect(within(nav).getByRole('link', { name: /Plano e uso/ })).toHaveAttribute(
      'href',
      '/cadastros/plano',
    );

    for (const role of ['analista_cliente', 'leitura'] as const) {
      const router = renderAt('/cadastros/plano', { me: demoMe(role) });
      await waitFor(() => expect(router.state.location.pathname).toBe('/sem-permissao'));
    }
  });

  it('o plano do nó, os contadores e a faixa a partir de 80% do volume (Alfa)', async () => {
    renderAt('/cadastros/plano', { me: demoMe('admin_cliente') });
    await page();
    const { limits } = DEMO_PLAN;
    const expected = demoPlanUsage(demoAdminStore(), ALFA?.id ?? '');
    expect(tile(`Plano ${DEMO_PLAN.label}`)).toHaveTextContent(
      `Uso de ${formatUsageMonth(expected.usage.month)}, no calendário de Brasília.`,
    );

    const accounts = tile('Contas cloud');
    expect(accounts).toHaveTextContent(`${expected.usage.cloudAccounts} de ${limits.maxCloudAccounts}`);
    expect(within(accounts).getByRole('meter', { name: 'Contas cloud' })).toHaveAttribute(
      'aria-valuetext',
      `${expected.usage.cloudAccounts} de ${limits.maxCloudAccounts}`,
    );
    expect(tile('Usuários')).toHaveTextContent(`${expected.usage.users} de ${limits.maxUsers}`);

    const ratio = DEMO_VOLUME_RATIO[ALFA?.id ?? ''] ?? 0;
    const volume = tile('Volume do mês');
    expect(volume).toHaveTextContent(
      `${formatVolume(expected.usage.monthlyBytes)} de ${limits.monthlyGib} GiB`,
    );
    expect(within(volume).getByRole('meter', { name: 'Volume do mês' })).toHaveAttribute(
      'aria-valuenow',
      String(Math.round(ratio * 100)),
    );
    expect(tile('Histórico')).toHaveTextContent(`${limits.historyDays} dias`);
    expect(tile('Histórico')).toHaveTextContent('A trilha de auditoria fica ao menos 13 meses');
    expect(tile('Histórico')).toHaveTextContent('o evento bruto do log, 30 dias');

    const band = screen.getByText(/O volume do mês já chegou a/).closest('[role="status"]') as HTMLElement;
    expect(band).toHaveTextContent(`${formatPercent(ratio)} do incluído no plano (${limits.monthlyGib} GiB)`);
    expect(band).toHaveTextContent('nenhum log é descartado');
  });

  it('abaixo de 80%: sem faixa (Beta, pela Verax com o cliente selecionado)', async () => {
    renderAt('/cadastros/plano', { me: veraxIn(BETA?.id) });
    await page();
    expect(tile('Volume do mês')).toHaveTextContent(formatPercent(DEMO_VOLUME_RATIO[BETA?.id ?? ''] ?? 0));
    expect(screen.queryByText(/do incluído no plano/)).not.toBeInTheDocument();
  });

  it('acima de 100%: a faixa diz que a coleta continua e nada é descartado', async () => {
    const included = (DEMO_PLAN.limits.monthlyGib ?? 0) * GIB_BYTES;
    renderAt(
      '/cadastros/plano',
      { me: demoMe('admin_cliente') },
      usage({ monthlyBytes: Math.round(included * 1.25) }),
    );
    await page();
    const band = screen.getByText(/passou do incluído no plano/).closest('[role="status"]') as HTMLElement;
    expect(band).toHaveTextContent('125%');
    expect(band).toHaveTextContent(
      'A coleta continua: nenhum log é descartado e os achados continuam chegando.',
    );
    expect(within(tile('Volume do mês')).getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });

  it('vagas: no limite e acima dele (descida de plano), com o que fazer', async () => {
    const limits = DEMO_PLAN.limits;
    renderAt(
      '/cadastros/plano',
      { me: demoMe('admin_cliente') },
      usage({ cloudAccounts: (limits.maxCloudAccounts ?? 0) + 2, users: limits.maxUsers ?? 0 }),
    );
    await page();
    expect(tile('Contas cloud')).toHaveTextContent('Acima do limite do plano: nada foi desativado');
    expect(tile('Usuários')).toHaveTextContent('Limite do plano atingido');
  });

  it('plano sem limite (o nó da Verax): os números, sem barra nem faixa', async () => {
    const interno = resolvePlan('interno');
    renderAt(
      '/cadastros/plano',
      { me: demoMe('admin_cliente') },
      usage({ cloudAccounts: 40, users: 30, monthlyBytes: 500 * GIB_BYTES }, interno),
    );
    await page();
    expect(screen.getByRole('heading', { name: 'Plano Interno' })).toBeInTheDocument();
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(tile('Contas cloud')).toHaveTextContent('Sem limite no plano');
    expect(tile('Histórico')).toHaveTextContent('Sem limite');
    expect(screen.queryByText(/do incluído no plano/)).not.toBeInTheDocument();
  });

  it('só leitura: nenhum botão nem campo na página (o plano vem da configuração do nó)', async () => {
    renderAt('/cadastros/plano', { me: demoMe('admin_cliente') });
    const section = await page();
    expect(within(section).queryAllByRole('button')).toHaveLength(0);
    expect(within(section).queryAllByRole('textbox')).toHaveLength(0);
    expect(within(section).queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('a Verax sem cliente selecionado: pede para escolher um', async () => {
    renderAt('/cadastros/plano', { me: veraxIn(undefined) });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });

  it('a demonstração recusa como a API: 409 PLAN_LIMIT_REACHED quando as vagas acabam', async () => {
    const store = demoAdminStore();
    const tenantId = BETA?.id ?? '';
    expect(demoPlanRefusal(store, tenantId, 'users')).toBeNull();
    const admin = store.users.get(tenantId)?.[0];
    if (!admin) throw new Error('a Beta da demonstração tem um administrador');
    const max = DEMO_PLAN.limits.maxUsers ?? 0;
    store.users.set(
      tenantId,
      Array.from({ length: max }, (_, index) => ({ ...admin, id: `demo-${index}` })),
    );
    const refusal = demoPlanRefusal(store, tenantId, 'users');
    expect(refusal?.status).toBe(409);
    expect(await refusal?.json()).toMatchObject({
      code: PLAN_LIMIT_REACHED_CODE,
      message: planLimitMessage('users', max),
    });
    // Desativado não ocupa vaga.
    store.users.set(
      tenantId,
      (store.users.get(tenantId) ?? []).map((user, index) => ({
        ...user,
        status: index === 0 ? 'disabled' : user.status,
      })),
    );
    expect(demoPlanRefusal(store, tenantId, 'users')).toBeNull();
  });

  describe('Plataforma: o contador da franquia em GB/dia (CE-10)', () => {
    /** Dia 12 de 30: 40 GB usados contra 90 GB (3 GB/dia); projeção de 100 GB, excedente de 0,33 GB/dia. */
    const franchise = {
      cycle: { start: '2026-11-01', end: '2026-11-30', day: 12, days: 30 },
      franchiseGbPerDay: 3,
      schedule: [{ from: '2026-11-01', gbPerDay: 3 }],
      budgetGb: 90,
      usedBytes: 40 * GB_BYTES,
      dailyAverageBytes: Math.floor((40 * GB_BYTES) / 12),
      projectedBytes: 100 * GB_BYTES,
      projectedOverageUnits: 33,
      days: Array.from({ length: 30 }, (_, index) => ({
        day: index < 18 ? `2026-10-${String(14 + index)}` : `2026-11-${String(index - 17).padStart(2, '0')}`,
        aws: index === 29 ? 2 * GB_BYTES : 0,
        gcp: index === 29 ? GB_BYTES / 2 : 0,
        cloudflare: 0,
      })),
    };
    const platform = (overrides: Partial<typeof franchise> = {}): PlanUsage =>
      planUsageSchema.parse({
        ...usage({ monthlyBytes: 0 }, DEMO_PLATFORM_PLAN),
        franchise: { ...franchise, ...overrides },
      });

    it('o ciclo, o volume contra o orçamento com a marca do dia, a média, a projeção e o excedente projetado', async () => {
      renderAt('/cadastros/plano', { me: demoMe('admin_cliente') }, platform());
      await page();
      const card = tile('Franquia de 3 GB/dia');
      expect(card).toHaveTextContent(
        'Ciclo de 1º a 30 de novembro, no calendário de Brasília: hoje é o dia 12 de 30.',
      );
      expect(card).toHaveTextContent('40 GB de 90 GB');
      const meter = within(card).getByRole('meter', { name: 'Volume do ciclo' });
      expect(meter).toHaveAttribute('aria-valuenow', '44');
      expect(meter).toHaveAttribute(
        'aria-valuetext',
        '40 GB de 90 GB do ciclo (44%); hoje é o dia 12 de 30 (40% do ciclo)',
      );
      expect(within(card).getByTestId('marca-do-ciclo')).toHaveStyle({ left: '40%' });
      expect(card).toHaveTextContent('Média do ciclo3,3 GB/dia');
      expect(card).toHaveTextContent('Projeção do ciclo100 GB');
      expect(card).toHaveTextContent('Excedente projetado0,33 GB/dia');
      expect(card).toHaveTextContent('nenhum log é descartado');
      // Nenhum valor em dinheiro: o preço vem depois, do estado desejado.
      expect(card).not.toHaveTextContent('R$');
      // O volume do mês em GiB dá lugar à franquia.
      expect(screen.queryByRole('region', { name: 'Volume do mês' })).not.toBeInTheDocument();
    });

    it('"Ampliar franquia" fica desligado, com o aviso de que chega em breve', async () => {
      renderAt('/cadastros/plano', { me: demoMe('admin_cliente') }, platform({ projectedOverageUnits: 0 }));
      const section = await page();
      const button = within(section).getByRole('button', { name: 'Ampliar franquia' });
      expect(button).toBeDisabled();
      expect(button).toHaveAccessibleDescription(
        'Em breve: ampliar a franquia pelo painel. Por enquanto, fale com a Verax.',
      );
      expect(tile('Franquia de 3 GB/dia')).toHaveTextContent('Excedente projetadoNenhum');
      expect(within(section).queryAllByRole('textbox')).toHaveLength(0);
    });

    it('o volume por dia: 30 colunas por fonte, com o resumo acessível e a tabela', async () => {
      renderAt('/cadastros/plano', { me: demoMe('admin_cliente') }, platform());
      await page();
      const chart = tile('Volume por dia');
      expect(within(chart).getByRole('img')).toHaveAccessibleName(
        'Volume por dia nos últimos 30 dias: 2,5 GB no total; o dia com mais foi 12/11, com 2,5 GB. A franquia de hoje é 3 GB/dia.',
      );
      expect(chart).toHaveTextContent('AWS');
      expect(chart).toHaveTextContent('Cloudflare (auditoria)');
      const rows = within(chart).getAllByRole('row', { hidden: true });
      expect(rows).toHaveLength(31);
      expect(rows.at(-1)).toHaveTextContent('12/112 GB0,5 GB0 GB2,5 GB');
    });

    it('o contrato: a demonstração devolve o mesmo schema estrito da API', () => {
      const demo = demoFranchise(new Date('2026-11-12T15:00:00Z'));
      expect(demo.franchiseGbPerDay).toBe(DEMO_FRANCHISE_GB_PER_DAY);
      expect(demo.days).toHaveLength(30);
      expect(demo.days.at(-1)?.day).toBe('2026-11-12');
      expect(demo.cycle).toEqual({ start: '2026-11-01', end: '2026-11-30', day: 12, days: 30 });
      expect(demo.projectedOverageUnits).toBeGreaterThan(0);
      const body = { ...usage({}, DEMO_PLATFORM_PLAN), franchise: demo };
      expect(planUsageSchema.parse(body)).toEqual(body);
      // Um campo a mais (um valor em dinheiro, por exemplo) é recusado pelo contrato.
      expect(planUsageSchema.safeParse({ ...body, franchise: { ...demo, price: 1 } }).success).toBe(false);
    });
  });
});

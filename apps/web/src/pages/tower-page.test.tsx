import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, DEMO_TENANTS, demoMe, demoTower } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { demoUnownedAlerts } from '@/mocks/unowned-handlers';
import { routes } from '@/routes/router';
import { towerReason } from './tower-reason';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

const [alfa, beta] = DEMO_TENANTS.map((tenant) => tenant.id);

function renderTower(state: MockState) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

const adminOn = (tenantId: string | undefined) =>
  demoMe('admin_verax', { activeTenantId: tenantId ?? null, scopeTenantId: tenantId ?? null });

describe('Torre', () => {
  it('diz a situação e o porquê, as decisões, os incidentes, a postura e a cobertura', async () => {
    renderTower({ me: demoMe('analista_cliente') });

    const status = await screen.findByRole('status', { name: /Situação: Crítico/ });
    expect(status).toHaveTextContent(
      '1 incidente crítico aberto, 2 incidentes altos abertos e nota de postura 64, abaixo de 70.',
    );

    const decisions = screen.getByRole('region', { name: 'Decisões pendentes' });
    expect(within(decisions).getByText('2 incidentes sem responsável')).toBeInTheDocument();
    expect(within(decisions).getByText('5 achados altos ou críticos sem triagem')).toBeInTheDocument();
    // Alerta sem dono é só do admin_verax.
    expect(within(decisions).queryByText(/conta não cadastrada/)).not.toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Crítico: 1 incidente aberto' })).toHaveAttribute(
      'href',
      '/incidentes?severidade=critical',
    );
    expect(screen.getByRole('link', { name: 'Alto: 2 incidentes abertos' })).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Nota de postura' })).toHaveAttribute('aria-valuenow', '64');
  });

  it('cobertura: conectadas, última coleta, último evento e as contas silenciosas, sem eventos no período', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    const coverage = await screen.findByRole('region', { name: 'Cobertura' });
    const value = (term: string) => within(coverage).getByText(term).nextElementSibling;
    expect(value('Contas conectadas')).toHaveTextContent('2');
    expect(value('Última coleta')).toHaveTextContent(/há 1 min/);
    expect(value('Último evento recebido')).toHaveTextContent(/há 3 min/);
    expect(within(coverage).getByText(/2 contas sem eventos há mais de 24 horas/)).toHaveTextContent(
      `${DEMO_ACCOUNTS.alfaHomologacao} e ${DEMO_ACCOUNTS.alfaCloudflare}`,
    );
  });

  it('cobertura de quem nunca coletou: nenhuma coleta, nenhum evento e nenhuma conta conectada', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({
          ...demoTower(beta ?? '', { includeUnowned: false }),
          coverage: {
            connectedAccounts: 0,
            lastCollectedAt: null,
            lastEventAt: null,
            silentAccounts: [DEMO_ACCOUNTS.beta],
            silentAfterHours: 24,
          },
        }),
      ),
    );
    const coverage = await screen.findByRole('region', { name: 'Cobertura' });
    expect(within(coverage).getByText('Contas conectadas').nextElementSibling).toHaveTextContent('0');
    expect(within(coverage).getByText('Última coleta').nextElementSibling).toHaveTextContent('nenhuma ainda');
    expect(within(coverage).getByText('Último evento recebido').nextElementSibling).toHaveTextContent(
      'nenhum ainda',
    );
    expect(within(coverage).getByText(/1 conta sem eventos há mais de 24 horas/)).toHaveTextContent(
      DEMO_ACCOUNTS.beta,
    );
  });

  it('sem logs novos da AWS (PR-V6): o aviso com o tempo parado e o caminho para Contas cloud', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    const tower = demoTower(beta ?? '', { includeUnowned: false });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({
          ...tower,
          coverage: {
            ...tower.coverage,
            awsLogsStalledSince: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            awsStalledAfterHours: 2,
          },
        }),
      ),
    );
    const coverage = await screen.findByRole('region', { name: 'Cobertura' });
    const warning = within(coverage).getByText('Sem logs novos da AWS:').closest('p');
    expect(warning).toHaveTextContent(
      'Sem logs novos da AWS: a coleta das contas AWS conectadas está parada há 3 horas. Confira a conexão e a coleta em Contas cloud.',
    );
    expect(within(coverage).getByRole('link', { name: 'Contas cloud' })).toHaveAttribute(
      'href',
      '/cadastros/contas',
    );
    // O medidor parado é só da equipe da Verax: sem o campo, nada.
    expect(within(coverage).queryByText(/Medidor da AWS parado/)).toBeNull();
  });

  it('sem parada (ou de um nó de antes do PR-V6, sem os campos), nenhum aviso da AWS', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    const tower = demoTower(beta ?? '', { includeUnowned: false });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({ ...tower, coverage: { ...tower.coverage, awsLogsStalledSince: null } }),
      ),
    );
    const coverage = await screen.findByRole('region', { name: 'Cobertura' });
    expect(within(coverage).queryByText(/Sem logs novos da AWS/)).toBeNull();
  });

  it('a equipe da Verax vê o medidor da AWS parado por mais de um cliente no nó', async () => {
    renderTower({ me: adminOn(alfa) });
    const tower = demoTower(alfa ?? '', { includeUnowned: true });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({ ...tower, coverage: { ...tower.coverage, awsMeterBlocked: true } }),
      ),
    );
    const coverage = await screen.findByRole('region', { name: 'Cobertura' });
    expect(
      within(coverage).getByText(/Medidor da AWS parado neste nó: há mais de um cliente no Wazuh dele/),
    ).toBeInTheDocument();
  });

  it('resumo MITRE ATT&CK: as 14 táticas dos últimos 30 dias, cada uma levando ao relatório', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    const mitre = await screen.findByRole('region', { name: 'MITRE ATT&CK' });
    expect(within(mitre).getAllByRole('listitem')).toHaveLength(14);
    const evasion = within(mitre).getByRole('link', { name: /^Evasão de defesas \(TA0005\): \d+ achados?/ });
    expect(evasion).toHaveAttribute('href', '/relatorios?aba=mitre');
    expect(within(mitre).getByText(/táticas? observadas? nos últimos 30 dias/)).toBeInTheDocument();
  });

  it('o botão da decisão leva à lista já filtrada', async () => {
    const router = renderTower({ me: demoMe('analista_cliente') });
    const card = (await screen.findByText('2 incidentes sem responsável')).closest('section');
    await userEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Ver incidentes' }));
    expect(router.state.location.pathname).toBe('/incidentes');
    expect(router.state.location.search).toBe('?responsavel=nenhum');
  });

  it('cliente tranquilo: verde, e o admin_verax vê os alertas sem dono', async () => {
    renderTower({ me: adminOn(beta) });
    expect(await screen.findByRole('status', { name: /Situação: Normal/ })).toHaveTextContent(
      'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado.',
    );
    // A contagem é a da própria fila fictícia, nos últimos 7 dias, como a API conta.
    const week = demoUnownedAlerts().filter(
      (alert) => Date.parse(alert.createdAt) >= Date.now() - 7 * 24 * 3_600_000,
    ).length;
    expect(screen.getByText(`${week} alertas de conta não cadastrada`)).toBeInTheDocument();
  });

  it('sem nenhuma decisão pendente, diz isso', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({ ...demoTower(beta ?? '', { includeUnowned: false }), pendingDecisions: [] }),
      ),
    );
    expect(await screen.findByText('Nenhuma decisão pendente')).toBeInTheDocument();
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um, sem buscar a Torre', async () => {
    renderTower({ me: adminOn(undefined) });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /Situação/ })).not.toBeInTheDocument();
  });

  it('erro na API: mensagem e opção de tentar de novo', async () => {
    renderTower({ me: adminOn(alfa) });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({ statusCode: 500, message: 'Erro interno' }, { status: 500 }),
      ),
    );
    // Uma segunda tentativa antes do erro (lib/query-client.ts), cerca de 1 s depois da primeira.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
  });

  it('resposta fora do contrato é erro, nunca dado na tela', async () => {
    renderTower({ me: adminOn(alfa) });
    server.use(http.get(`${API_URL}/v1/tower`, () => HttpResponse.json({ light: 'blue' })));
    // Uma segunda tentativa antes do erro (lib/query-client.ts), cerca de 1 s depois da primeira.
    expect(await screen.findByRole('alert', {}, { timeout: 4000 })).toBeInTheDocument();
  });
});

describe('frase do semáforo', () => {
  const base = demoTower(alfa ?? '', { includeUnowned: false });

  it('só postura baixa', () => {
    expect(
      towerReason({
        ...base,
        light: 'yellow',
        reasons: ['low_posture'],
        openIncidents: { critical: 0, high: 0, medium: 0, low: 0 },
      }),
    ).toBe('nota de postura 64, abaixo de 70.');
  });

  it('um incidente alto no singular', () => {
    expect(
      towerReason({
        ...base,
        light: 'yellow',
        reasons: ['high_incident'],
        openIncidents: { ...base.openIncidents, high: 1 },
      }),
    ).toBe('1 incidente alto aberto.');
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IncidentDetail } from '@verax/shared';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  describeFinding,
  incidentRecommendation,
  incidentSummary,
  incidentTitle,
} from '@/features/incidents/narrative';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { DEMO_INCIDENTS } from '@/mocks/findings-fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

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

const rows = async () =>
  within(await screen.findByRole('table', { name: /Incidentes do cliente/ }))
    .getAllByRole('row')
    .slice(1);

describe('lista de incidentes', () => {
  it('ordenada pela nota, com severidade, ativos, tempo aberto e responsável', async () => {
    renderAt('/incidentes');
    const items = await rows();
    expect(items).toHaveLength(6);
    const scores = items.map((row) => Number(within(row).getByLabelText(/Nota de risco/).textContent));
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(items[0]).toHaveTextContent('Atividade suspeita com a chave de acesso DEMO3QX7Z2KD9WLB5N8R');
    expect(items[0]).toHaveTextContent('Crítico');
    expect(items[0]).toHaveTextContent('Equipe Verax');
  });

  it('o atalho da Torre mostra só os sem responsável', async () => {
    renderAt('/incidentes?responsavel=nenhum');
    const items = await rows();
    expect(items).toHaveLength(2);
    for (const row of items) expect(row).toHaveTextContent('Ninguém');
    expect(screen.getByLabelText('Responsável')).toHaveValue('nenhum');
  });

  it('filtro por severidade e por status', async () => {
    const router = renderAt('/incidentes?severidade=high');
    expect(await rows()).toHaveLength(2);
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'open');
    await waitFor(() => expect(router.state.location.search).toBe('?severidade=high&status=open'));
    await waitFor(async () => expect(await rows()).toHaveLength(1));
    expect((await rows())[0]).toHaveTextContent('Ataque a partir do IP 192.0.2.200');
  });
});

describe('detalhe do incidente', () => {
  const path = `/incidentes/${DEMO_INCIDENTS.chaveComprometida}`;

  it('resumo em português, primeiro passo, linha do tempo com link para cada achado, ativos e MITRE', async () => {
    renderAt(path);
    expect(
      await screen.findByRole('heading', {
        name: 'Atividade suspeita com a chave de acesso DEMO3QX7Z2KD9WLB5N8R',
      }),
    ).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Resumo' });
    expect(summary).toHaveTextContent(
      'A chave de acesso DEMO3QX7Z2KD9WLB5N8R, do usuário deploy-bot, a partir do IP 198.51.100.23, usou credenciais da AWS de forma suspeita, criou uma chave de acesso e tentou desligar a trilha do CloudTrail. 3 achados entre',
    );
    expect(summary).toHaveTextContent('Desative a chave de acesso');

    const timeline = screen.getByRole('region', { name: /Linha do tempo \(3 achados\)/ });
    const links = within(timeline).getAllByRole('link');
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', expect.stringMatching(/^\/achados\?achado=/));

    const assets = screen.getByRole('region', { name: 'Ativos envolvidos' });
    expect(within(assets).getByText('111122223333')).toBeInTheDocument();
    expect(within(assets).getByText('198.51.100.23')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'MITRE ATT&CK' })).toHaveTextContent('T1562.008');
  });

  it('trocar status e responsável aparece na Torre', async () => {
    const router = renderAt(`/incidentes/${DEMO_INCIDENTS.ataqueWaf}`);
    const treatment = await screen.findByRole('region', { name: 'Tratamento' });
    // As opções de responsável chegam depois do primeiro desenho.
    await within(treatment).findByRole('option', { name: 'Ana Souza' });
    await userEvent.selectOptions(within(treatment).getByLabelText('Responsável'), 'demo-ana');
    await waitFor(() => expect(within(treatment).getByLabelText('Responsável')).toHaveValue('demo-ana'));
    await userEvent.selectOptions(within(treatment).getByLabelText('Status'), 'resolved');
    await waitFor(() => expect(within(treatment).getByLabelText('Status')).toHaveValue('resolved'));

    await router.navigate('/');
    // Um incidente alto a menos aberto e um sem responsável a menos.
    expect(await screen.findByRole('link', { name: 'Alto: 1 incidente aberto' })).toBeInTheDocument();
    expect(screen.getByText('1 incidente sem responsável')).toBeInTheDocument();
  });

  it('papel de leitura vê o tratamento, sem poder mudar', async () => {
    renderAt(path, { me: demoMe('leitura') });
    const treatment = await screen.findByRole('region', { name: 'Tratamento' });
    expect(within(treatment).queryByRole('combobox')).not.toBeInTheDocument();
    expect(treatment).toHaveTextContent('Equipe Verax');
  });

  it('incidente que não existe (ou de outro cliente) mostra o erro, sem dados', async () => {
    renderAt('/incidentes/018f2c1e-0000-7000-8000-00000000dead');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('narrativa', () => {
  const base: IncidentDetail = {
    id: DEMO_INCIDENTS.portaSsh,
    severity: 'medium',
    status: 'open',
    riskScore: 30,
    findingCount: 1,
    firstSeenAt: '2026-11-02T10:00:00.000Z',
    lastSeenAt: '2026-11-02T10:00:00.000Z',
    keys: ['ip:203.0.113.12', 'resource:sg-0123', 'user:joao.lima'],
    accounts: ['111122223333'],
    resources: ['sg-0123'],
    mitreTactics: [],
    mitreTechniques: [],
    assignee: null,
    findings: [
      {
        id: '018f2c1e-0000-7000-8000-000000000099',
        accountId: '111122223333',
        occurredAt: '2026-11-02T10:00:00.000Z',
        severity: 'medium',
        status: 'new',
        title: 'Security group opened',
        source: 'cloudtrail',
        eventName: 'AuthorizeSecurityGroupIngress',
        region: 'sa-east-1',
        resource: 'sg-0123',
        actor: { user: 'joao.lima', type: 'IAMUser', accessKeyId: null, ip: '203.0.113.12' },
        mitreTactics: [],
        incidentId: DEMO_INCIDENTS.portaSsh,
        commentCount: 0,
      },
    ],
  };

  it('usuário com IP, ação do dicionário, horário único', () => {
    expect(incidentTitle(base)).toBe('Atividade suspeita do usuário joao.lima');
    expect(incidentSummary(base)).toMatch(
      /^O usuário joao\.lima, a partir do IP 203\.0\.113\.12, liberou uma porta num grupo de segurança\. 1 achado em /,
    );
    expect(incidentRecommendation(base)).toMatch(/^Confirme com o usuário/);
  });

  it('só IP vira ataque; evento desconhecido usa o título do achado', () => {
    expect(incidentTitle({ keys: ['ip:192.0.2.1'] })).toBe('Ataque a partir do IP 192.0.2.1');
    expect(
      describeFinding({
        source: 'cloudtrail',
        eventName: 'SomethingNew',
        title: 'Algo novo aconteceu',
        resource: null,
      }),
    ).toBe('algo novo aconteceu');
    expect(
      describeFinding({
        source: 'guardduty',
        eventName: 'CryptoCurrency:EC2/X',
        title: 'x',
        resource: 'i-1',
      }),
    ).toBe('consultou domínios de mineração de criptomoeda');
  });

  it('força bruta: o IP de origem é quem age, e a instância atacada vai no complemento', async () => {
    renderAt(`/incidentes/${DEMO_INCIDENTS.forcaBrutaSsh}`);
    const summary = await screen.findByRole('region', { name: 'Resumo' });
    expect(summary).toHaveTextContent(
      'O IP 192.0.2.77 tentou força bruta no SSH da instância i-0a1b2c3d4e5f67890.',
    );
    expect(summary).not.toHaveTextContent('sofreu');
  });
});

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
import { demoAgents } from '@/mocks/agents-handlers';
import { DEMO_ACCOUNTS, DEMO_TENANTS, DEMO_TOWER_AGENTS, demoMe, demoTower } from '@/mocks/fixtures';
import { demoFindings } from '@/mocks/findings-fixtures';
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
      '1 incidente crítico aberto, 2 incidentes altos abertos, nota de postura 69, abaixo de 70 e coleta parada (GCP).',
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
    expect(screen.getByRole('meter', { name: 'Nota de postura' })).toHaveAttribute('aria-valuenow', '69');
  });

  it('saúde da coleta: cada fonte com o estado e o último dado, o último evento à parte e as silenciosas', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    const health = await screen.findByRole('region', { name: 'Saúde da coleta' });
    expect(within(health).getByText(/^Coleta ativa em 3 de 5 fontes, último dado/)).toBeInTheDocument();
    const rows = within(health).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('p')?.textContent)).toEqual([
      'AWS',
      'GCP',
      'Cloudflare',
      'Agentes nas instâncias',
      'Postura e inventário',
    ]);
    const [aws, gcp, cloudflare] = rows;
    // OP-01: o último dado da AWS é o andamento dos eventos no Wazuh; o último alerta vai à parte.
    expect(aws).toHaveTextContent(/^AWSColetando.*último dado há 2 minutosúltimo alerta há 3 minutos$/);
    // A GCP pela última leitura bem-sucedida da assinatura (as leituras falham há 3 horas), com a última entrada à parte.
    expect(gcp).toHaveTextContent(/^GCPParada.*último dado há 3 horasúltimo evento há 3 horas$/);
    expect(cloudflare).toHaveTextContent(
      /^CloudflareAguardando o primeiro dado.*último evento nenhum ainda$/,
    );
    expect(within(health).getByText('1 conta conectada')).toBeInTheDocument();
    // A GCP com as leituras falhando há 3 horas ainda não é silenciosa (24 horas).
    expect(within(health).getByText(/2 contas sem eventos há mais de 24 horas/)).toHaveTextContent(
      `${DEMO_ACCOUNTS.alfaHomologacao} e ${DEMO_ACCOUNTS.alfaCloudflare}`,
    );
    expect(within(health).getByRole('link', { name: 'Ver contas' })).toHaveAttribute(
      'href',
      '/cadastros/contas',
    );
  });

  it('cliente sem GCP, Cloudflare nem agentes: as fontes que ele não tem vêm por último, como não configuradas', async () => {
    renderTower({ me: adminOn(beta) });
    const health = await screen.findByRole('region', { name: 'Saúde da coleta' });
    expect(
      within(health).getByText(/^Coleta ativa em 2 de 2 fontes, último dado há 2 minutos\.$/),
    ).toBeInTheDocument();
    const rows = within(health).getAllByRole('listitem');
    expect(
      rows.map((row) => [row.querySelector('p')?.textContent, row.textContent?.includes('Não configurada')]),
    ).toEqual([
      ['AWS', false],
      ['Postura e inventário', false],
      ['GCP', true],
      ['Cloudflare', true],
      ['Agentes nas instâncias', true],
    ]);
    // A conta calma, sem alerta há quase 7 horas, não é silenciosa (OP-01).
    expect(rows[0]).toHaveTextContent('último alerta há 7 horas');
    expect(within(health).queryByText(/sem eventos há mais de/)).toBeNull();
  });

  it('nó de antes do OP-02 (sem as fontes nem o pulso): as datas de antes, sem a faixa do pulso', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    // Sem `pulse` nem `sources`: o painel novo continua lendo o resumo de um nó de antes.
    const { pulse: _pulse, ...older } = demoTower(beta ?? '', { includeUnowned: false });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({
          ...older,
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
    const coverage = await screen.findByRole('region', { name: 'Saúde da coleta' });
    expect(screen.queryByRole('region', { name: 'Pulso da operação' })).toBeNull();
    // Sem a prova da coleta, a frase do verde é a de antes, sem "Tudo calmo".
    expect(screen.getByRole('status', { name: /Situação: Normal/ })).toHaveTextContent(
      /^NormalNenhum incidente crítico ou alto aberto, e a postura está dentro do esperado\.$/,
    );
    expect(within(coverage).getByText('0 contas conectadas')).toBeInTheDocument();
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
    const coverage = await screen.findByRole('region', { name: 'Saúde da coleta' });
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
    const coverage = await screen.findByRole('region', { name: 'Saúde da coleta' });
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
    const coverage = await screen.findByRole('region', { name: 'Saúde da coleta' });
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

  it('cliente tranquilo: verde com "Tudo calmo" e a prova da coleta, e o admin_verax vê os alertas sem dono', async () => {
    renderTower({ me: adminOn(beta) });
    expect(await screen.findByRole('status', { name: /Situação: Normal/ })).toHaveTextContent(
      'Tudo calmo. Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado. Coleta ativa em 2 de 2 fontes, último dado há 2 minutos.',
    );
    // A contagem é a da própria fila fictícia, nos últimos 7 dias, como a API conta.
    const week = demoUnownedAlerts().filter(
      (alert) => Date.parse(alert.createdAt) >= Date.now() - 7 * 24 * 3_600_000,
    ).length;
    expect(screen.getByText(`${week} alertas de conta não cadastrada`)).toBeInTheDocument();
  });

  it('sem nenhuma decisão pendente e com todas as fontes coletando: "Tudo calmo", com a prova', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({ ...demoTower(beta ?? '', { includeUnowned: false }), pendingDecisions: [] }),
      ),
    );
    const decisions = await screen.findByRole('region', { name: 'Decisões pendentes' });
    expect(await within(decisions).findByText('Tudo calmo: nada para decidir agora')).toBeInTheDocument();
    expect(
      within(decisions).getByText(
        'Tudo o que pedia uma decisão já foi tratado. Coleta ativa em 2 de 2 fontes, último dado há 2 minutos.',
      ),
    ).toBeInTheDocument();
  });

  // Todas as fontes coletando e nada para decidir, mas o semáforo não está verde: um incidente crítico que já tem
  // responsável, ou a postura abaixo do limite. A Torre não diz "Tudo calmo" ao lado da luz vermelha ou amarela.
  it.each([
    [
      'incidente crítico com responsável (vermelho)',
      {
        light: 'red' as const,
        reasons: ['critical_incident' as const],
        openIncidents: { critical: 1, high: 0, medium: 1, low: 0 },
      },
      /Situação: Crítico/,
    ],
    [
      'postura abaixo do limite (amarelo)',
      {
        light: 'yellow' as const,
        reasons: ['low_posture' as const],
        posture: { score: 55, scannedAt: new Date().toISOString(), warningBelow: 70 },
      },
      /Situação: Atenção/,
    ],
  ])(
    'sem decisão pendente e com tudo coletando, mas com %s: o estado vazio neutro, sem "Tudo calmo"',
    async (_name, change, situation) => {
      renderTower({ me: demoMe('analista_cliente') });
      server.use(
        http.get(`${API_URL}/v1/tower`, () =>
          HttpResponse.json({
            ...demoTower(beta ?? '', { includeUnowned: false }),
            pendingDecisions: [],
            ...change,
          }),
        ),
      );
      expect(await screen.findByRole('status', { name: situation })).toBeInTheDocument();
      const decisions = screen.getByRole('region', { name: 'Decisões pendentes' });
      expect(within(decisions).getByText('Nenhuma decisão pendente')).toBeInTheDocument();
      expect(
        within(decisions).getByText(
          'Tudo o que pedia uma decisão já foi tratado. Coleta ativa em 2 de 2 fontes, último dado há 2 minutos.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Tudo calmo/)).toBeNull();
    },
  );

  it('sem decisão pendente, mas com a coleta parada: não diz "Tudo calmo" e aponta a fonte parada', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    server.use(
      http.get(`${API_URL}/v1/tower`, () =>
        HttpResponse.json({ ...demoTower(alfa ?? '', { includeUnowned: false }), pendingDecisions: [] }),
      ),
    );
    const decisions = await screen.findByRole('region', { name: 'Decisões pendentes' });
    expect(await within(decisions).findByText('Nenhuma decisão pendente')).toBeInTheDocument();
    expect(
      within(decisions).getByText(
        'Tudo o que pedia uma decisão já foi tratado. Mas há coleta parada (GCP): veja a Saúde da coleta.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Tudo calmo/)).toBeNull();
  });

  it('pulso da operação: achados de 24 h por hora, esperados, tempo até detectar, agentes e eventos do mês', async () => {
    renderTower({ me: demoMe('analista_cliente') });
    const pulse = await screen.findByRole('region', { name: 'Pulso da operação' });
    const tile = (label: string) => within(pulse).getByRole('region', { name: label });

    // Os achados do mock que aconteceram nas últimas 24 horas cheias.
    const since = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 23 * 3_600_000;
    const recent = (demoFindings().get(alfa ?? '') ?? []).filter(
      (finding) => Date.parse(finding.occurredAt) >= since,
    ).length;
    const findings = tile('Achados nas últimas 24 h');
    expect(findings).toHaveTextContent(String(recent));
    const chart = within(findings).getByRole('img', { name: /^Achados por hora nas últimas 24 horas: / });
    expect(chart.getAttribute('aria-label')).toContain(`${recent} achado`);
    expect(within(findings).getByRole('link', { name: 'Ver achados' })).toHaveAttribute(
      'href',
      '/achados?periodo=24h',
    );
    // A tabela equivalente, com as 24 horas.
    expect(within(findings).getByText('Ver tabela')).toBeInTheDocument();
    expect(within(findings).getAllByRole('row', { hidden: true })).toHaveLength(25);

    expect(tile('Tempo até detectar')).toHaveTextContent('4 min');
    // Os mesmos agentes da tela Agentes.
    const agents = demoAgents();
    const online = agents.filter((agent) => agent.status === 'active').length;
    expect(DEMO_TOWER_AGENTS).toMatchObject({ online, total: agents.length });
    expect(tile('Agentes online')).toHaveTextContent(`${online} de ${agents.length}`);
    expect(within(tile('Agentes online')).getByRole('link', { name: 'Ver agentes' })).toHaveAttribute(
      'href',
      '/cadastros/agentes',
    );
    expect(tile('Eventos lidos no mês')).toHaveTextContent('1,3 mi');
    expect(tile('Eventos lidos no mês')).toHaveTextContent('AWS 1,2 mi · GCP 80,1 mil');
  });

  it('pulso de quem não tem agentes: o cartão some em vez de mostrar zero', async () => {
    renderTower({ me: adminOn(beta) });
    const pulse = await screen.findByRole('region', { name: 'Pulso da operação' });
    expect(within(pulse).queryByRole('region', { name: 'Agentes online' })).toBeNull();
    expect(within(pulse).getByRole('region', { name: 'Eventos lidos no mês' })).toHaveTextContent(
      '412,9 mil',
    );
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

  it('só a coleta parada, com as fontes pelo nome', () => {
    expect(
      towerReason({
        ...base,
        light: 'yellow',
        reasons: ['collection_stalled'],
        coverage: {
          ...base.coverage,
          sources: base.coverage.sources?.map((source) =>
            source.source === 'agents' ? { ...source, state: 'stalled' } : source,
          ),
        },
      }),
    ).toBe('coleta parada (GCP e agentes).');
  });

  it('verde com fonte atrasada: a prova, sem "Tudo calmo"; sem fonte nenhuma, diz que falta conectar', () => {
    const now = new Date(base.generatedAt);
    const green = { ...base, light: 'green' as const, reasons: [] };
    const delayed = {
      ...green,
      coverage: {
        ...green.coverage,
        sources: green.coverage.sources?.map((source) =>
          source.state === 'stalled' ? { ...source, state: 'delayed' as const } : source,
        ),
      },
    };
    expect(towerReason(delayed, now)).toBe(
      'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado. Coleta ativa em 3 de 5 fontes, último dado agora há pouco.',
    );
    const none = {
      ...green,
      coverage: {
        ...green.coverage,
        lastDataAt: null,
        sources: green.coverage.sources?.map((source) => ({
          ...source,
          state: 'not_configured' as const,
          lastDataAt: null,
        })),
      },
    };
    expect(towerReason(none, now)).toBe(
      'Nenhum incidente crítico ou alto aberto, e a postura está dentro do esperado. Nenhuma fonte de dados conectada ainda.',
    );
  });

  it('só postura baixa', () => {
    expect(
      towerReason({
        ...base,
        light: 'yellow',
        reasons: ['low_posture'],
        openIncidents: { critical: 0, high: 0, medium: 0, low: 0 },
      }),
    ).toBe('nota de postura 69, abaixo de 70.');
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

import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
import { demoPosture } from '@/mocks/posture';
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

const checkRows = async () =>
  within(await screen.findByRole('table', { name: 'Checagens reprovadas na última varredura' }))
    .getAllByRole('row')
    .slice(1);

const catalogRows = async () =>
  within(await screen.findByRole('table', { name: 'Checagens do catálogo na última varredura' }))
    .getAllByRole('row')
    .slice(1);

/** A linha do catálogo de uma checagem, pelo título. */
const catalogRow = async (title: string) => {
  const row = (await catalogRows()).find((item) => within(item).queryByText(title) !== null);
  if (row === undefined) throw new Error(`sem a linha ${title}`);
  return row;
};

/** Os campos novos da conta (PR-15'), para as respostas montadas à mão nos testes. */
const nativeFields = { unknown: 0, checks: [], errors: [] };

describe('Postura cloud', () => {
  it('nota e evolução por conta, e as checagens da mais grave à menos grave', async () => {
    renderAt('/postura');
    const prod = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaProducao}` });
    expect(within(prod).getByRole('meter', { name: 'Nota de postura' })).toHaveAttribute(
      'aria-valuenow',
      '68',
    );
    expect(
      within(prod).getByRole('img', { name: /Evolução da nota da conta 111122223333: de \d+ em/ }),
    ).toBeInTheDocument();
    expect(prod).toHaveTextContent(
      '33 aprovadas e 19 reprovadas: 2 críticas, 12 altas, 5 médias. 6 não lidas, fora da nota.',
    );
    const homolog = screen.getByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaHomologacao}` });
    expect(within(homolog).getByRole('meter')).toHaveAttribute('aria-valuenow', '72');
    expect(homolog).toHaveTextContent('10 aprovadas e 5 reprovadas: 4 altas, 1 média.');
    expect(homolog).not.toHaveTextContent('não lida');

    // 24 reprovações nas duas contas: a primeira página tem 20, da mais grave à menos grave.
    const rows = await checkRows();
    expect(rows).toHaveLength(20);
    const order = rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent);
    expect(order.slice(0, 3)).toEqual(['Crítico', 'Crítico', 'Alto']);
    expect(order.at(-1)).toBe('Médio');
  });

  it('a nota da Torre na demonstração é a mesma da postura (a mesma fórmula, somando as contas)', () => {
    const posture = demoPosture();
    expect(posture.size).toBe(2);
    for (const [tenantId, { overview }] of posture) {
      expect(DEMO_TENANTS.some((tenant) => tenant.id === tenantId)).toBe(true);
      expect(demoTower(tenantId, { includeUnowned: false }).posture.score).toBe(overview.score);
    }
  });

  it('a varredura parcial diz o que a AWS recusou e que as checagens dela ficam fora da nota', async () => {
    renderAt('/postura');
    const band = await screen.findByRole('region', { name: 'Varredura parcial' });
    expect(band).toHaveTextContent(`Conta ${DEMO_ACCOUNTS.alfaProducao}`);
    expect(
      within(band)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      expect.stringContaining(`Conta ${DEMO_ACCOUNTS.alfaProducao}`),
      'Instâncias EC2 em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
      'Security groups em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
      'Criptografia padrão do EBS em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).',
    ]);
    expect(band).toHaveTextContent('nunca contam como aprovadas');
    expect(band).not.toHaveTextContent(DEMO_ACCOUNTS.alfaHomologacao);
  });

  it('o catálogo: as 18 checagens com a situação, somadas nas contas ou de uma conta só', async () => {
    renderAt('/postura');
    expect(await catalogRows()).toHaveLength(18);
    expect(
      screen.getByText(/Todas as contas: as 18 checagens do catálogo do Verax Control/),
    ).toBeInTheDocument();
    // Somada: a trilha aprovada na produção e reprovada na homologação.
    expect(await catalogRow('Trilha do CloudTrail multirregião gravando')).toHaveTextContent(
      'Reprovada1 aprovado e 1 reprovado',
    );
    // Uma região aprovada e outra recusada: não lida, nunca aprovada.
    expect(
      await catalogRow('Nenhum security group aberto para a internet em todas as portas'),
    ).toHaveTextContent('Não lida5 aprovados e 1 não lido');
  });

  it('o catálogo segue o filtro da conta: aprovada, reprovada, não lida e não se aplica', async () => {
    renderAt(`/postura?conta=${DEMO_ACCOUNTS.alfaProducao}`);
    expect(
      await screen.findByText(`Conta ${DEMO_ACCOUNTS.alfaProducao}: as 18 checagens`, { exact: false }),
    ).toBeInTheDocument();
    expect(await catalogRow('Trilha do CloudTrail multirregião gravando')).toHaveTextContent(
      'Aprovada1 aprovado',
    );
    expect(await catalogRow('IMDSv2 obrigatório nas instâncias EC2')).toHaveTextContent(
      'Reprovada1 aprovado, 2 reprovados e 1 não lido',
    );
    expect(await catalogRow('RDP (porta 3389) fechado para a internet')).toHaveTextContent(
      'Não lida4 aprovados e 1 não lido',
    );
  });

  it('o catálogo de uma conta sem usuário com console nem bucket: não se aplica, sem resultado', async () => {
    renderAt(`/postura?conta=${DEMO_ACCOUNTS.alfaHomologacao}`);
    expect(await catalogRow('MFA nos usuários IAM com acesso ao console')).toHaveTextContent(
      'Não se aplica—',
    );
    expect(await catalogRow('Nenhum bucket S3 público')).toHaveTextContent('Não se aplica—');
  });

  it('o atalho da conta filtra as checagens dela', async () => {
    const router = renderAt('/postura');
    const homolog = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaHomologacao}` });
    await userEvent.click(within(homolog).getByRole('button', { name: 'Ver o que corrigir nesta conta' }));
    await waitFor(() => expect(router.state.location.search).toBe(`?conta=${DEMO_ACCOUNTS.alfaHomologacao}`));
    await waitFor(async () => expect(await checkRows()).toHaveLength(5));
    for (const row of await checkRows()) expect(row).toHaveTextContent(DEMO_ACCOUNTS.alfaHomologacao);
  });

  it('filtro por gravidade', async () => {
    renderAt('/postura?severidade=critical');
    const rows = await checkRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Bucket S3 público');
    expect(rows[0]).toHaveTextContent('loja-exemplo-relatorios');
    expect(rows[1]).toHaveTextContent('Usuário root sem MFA');
  });

  it('o passo de correção traz o comando já com o recurso, em fonte monoespaçada', async () => {
    renderAt('/postura?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Bucket S3 público/ }));
    const panel = await screen.findByRole('dialog', { name: 'Bucket S3 público' });
    const command = within(panel).getByText(
      /^aws s3api put-public-access-block --bucket loja-exemplo-relatorios /,
    );
    expect(command.tagName).toBe('CODE');
  });

  it('o detalhe diz por que importa, como corrigir e leva à referência em outra aba', async () => {
    renderAt('/postura?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Usuário root sem MFA/ }));
    const panel = await screen.findByRole('dialog', { name: 'Usuário root sem MFA' });
    expect(within(panel).getByRole('region', { name: 'Por que importa' })).toHaveTextContent(
      'controla a conta inteira',
    );
    expect(within(panel).getByRole('region', { name: 'Como corrigir' })).toHaveTextContent(
      'ative um dispositivo de MFA',
    );
    // Comparação exata do endereço e do nome (nada de prefixo de URL).
    const link = within(panel).getByRole('link');
    expect(link).toHaveAttribute(
      'href',
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/enable-virt-mfa-for-root.html',
    );
    expect(link).toHaveAccessibleName('docs.aws.amazon.com (abre em outra aba)');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('o gráfico mostra a nota de cada dia pelas setas do teclado', async () => {
    renderAt('/postura');
    const prod = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaProducao}` });
    const chart = within(prod).getByRole('img', { name: /Evolução da nota/ });
    chart.focus();
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(within(prod).getByText(/· nota/)).toBeInTheDocument();
    // Os mesmos números estão na tabela para leitor de tela: 30 dias.
    const table = within(prod).getByRole('table', { name: /Evolução da nota/, hidden: true });
    expect(within(table).getAllByRole('row', { hidden: true })).toHaveLength(31);
  });

  it('varredura sem nota (só checagens que não pesam) continua mostrando os resultados', async () => {
    renderAt('/postura');
    server.use(
      http.get(`${API_URL}/v1/posture`, () =>
        HttpResponse.json({
          score: null,
          warningBelow: 70,
          accounts: [
            {
              accountId: DEMO_ACCOUNTS.alfaProducao,
              score: null,
              scannedAt: new Date().toISOString(),
              passed: 0,
              failed: 1,
              failedBySeverity: { critical: 0, high: 0, medium: 0, low: 0, informational: 1 },
              history: [],
              ...nativeFields,
            },
          ],
        }),
      ),
    );
    const card = await screen.findByRole('region', { name: `Conta ${DEMO_ACCOUNTS.alfaProducao}` });
    expect(card).toHaveTextContent('Sem nota nesta varredura');
    expect(card).toHaveTextContent('0 aprovadas e 1 reprovadas: 1 informativa.');
    expect(screen.queryByText('Ainda sem varredura')).not.toBeInTheDocument();
    expect(
      await screen.findByRole('table', { name: 'Checagens reprovadas na última varredura' }),
    ).toBeInTheDocument();
    // Sem checagens do catálogo gravadas (uma varredura anterior ao PR-15'): sem a tabela do catálogo nem a faixa.
    expect(
      screen.queryByRole('table', { name: 'Checagens do catálogo na última varredura' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Varredura parcial' })).not.toBeInTheDocument();
  });

  it('conta AWS sem varredura ainda: o aviso sem citar ferramenta nem prometer prazo', async () => {
    renderAt('/postura');
    server.use(
      http.get(`${API_URL}/v1/posture`, () =>
        HttpResponse.json({
          score: null,
          warningBelow: 70,
          accounts: [
            {
              accountId: DEMO_ACCOUNTS.alfaProducao,
              score: null,
              scannedAt: null,
              passed: 0,
              failed: 0,
              failedBySeverity: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
              history: [],
              ...nativeFields,
            },
          ],
        }),
      ),
    );
    expect(await screen.findByText('Ainda sem varredura')).toBeInTheDocument();
    const main = screen.getByRole('heading', { level: 1, name: 'Postura cloud' }).closest('section');
    expect(main).toHaveTextContent('A nota aparece depois da primeira conferência de cada conta.');
    expect(main).not.toHaveTextContent(/Prowler|minutos|24 horas/);
    expect(screen.queryByText(/em breve/)).not.toBeInTheDocument();
  });

  it('cliente sem conta AWS (só GCP ou Cloudflare): "em breve", sem cartão nem tabela', async () => {
    renderAt('/postura');
    server.use(
      http.get(`${API_URL}/v1/posture`, () =>
        HttpResponse.json({ score: null, warningBelow: 70, accounts: [] }),
      ),
    );
    expect(await screen.findByText('Postura de GCP e Cloudflare: em breve')).toBeInTheDocument();
    expect(screen.getByText(/ainda não tem conta AWS ativa/)).toBeInTheDocument();
    expect(screen.queryByText('Ainda sem varredura')).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('nenhum texto da tela cita o Prowler', async () => {
    renderAt('/postura?severidade=critical');
    await userEvent.click(await screen.findByRole('button', { name: /Usuário root sem MFA/ }));
    await screen.findByRole('dialog', { name: 'Usuário root sem MFA' });
    expect(document.body).not.toHaveTextContent(/Prowler/);
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um', async () => {
    renderAt('/postura', { me: demoMe('admin_verax') });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });
});

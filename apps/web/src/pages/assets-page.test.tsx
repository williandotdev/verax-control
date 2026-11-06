import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InventorySummary } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bucketPublic, describeRule, describeSectionError } from '@/features/inventory/labels';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, demoMe } from '@/mocks/fixtures';
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

const rowsOf = async (caption: string) =>
  within(await screen.findByRole('table', { name: caption }))
    .getAllByRole('row')
    .slice(1);

describe('Ativos e identidades', () => {
  it('alerta da conta root, abas com contagem e usuários do maior risco ao menor', async () => {
    renderAt('/ativos');
    expect(await screen.findByRole('alert')).toHaveTextContent('Conta root de 111122223333: root sem MFA.');
    expect(screen.getByRole('tab', { name: /Usuários IAM 9 6 com risco/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Buckets S3 5 2 com risco/ })).toBeInTheDocument();

    const rows = await rowsOf('Usuários IAM');
    expect(rows).toHaveLength(9);
    expect(within(rows[0] as HTMLElement).getByText('Alto')).toBeInTheDocument();
    expect(within(rows.at(-1) as HTMLElement).getByText('Ok')).toBeInTheDocument();
    const joao = rows.find((row) => row.textContent?.includes('joao.lima')) as HTMLElement;
    expect(within(joao).getByText('console sem MFA')).toBeInTheDocument();
    expect(within(joao).getByText('Não')).toHaveClass('text-critical-text');
  });

  it('chaves: a antiga em destaque, com o motivo', async () => {
    const router = renderAt('/ativos');
    await userEvent.click(await screen.findByRole('tab', { name: /Chaves de acesso/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?aba=keys'));
    const rows = await rowsOf('Chaves de acesso');
    const key = rows.find((row) => row.textContent?.includes('DEMO3QX7Z2KD9WLB5N8R')) as HTMLElement;
    expect(within(key).getByText('240 dias')).toHaveClass('text-critical-text');
    expect(within(key).getByText('chave com mais de 90 dias')).toBeInTheDocument();
    const never = rows.find((row) => row.textContent?.includes('DEMO1NV6TF8QA4GS0K2P')) as HTMLElement;
    expect(within(never).getByText('nunca')).toBeInTheDocument();
  });

  it('buckets: público em destaque; o filtro mostra só os com risco', async () => {
    const router = renderAt('/ativos?aba=buckets');
    const rows = await rowsOf('Buckets S3');
    expect(rows).toHaveLength(5);
    const reports = rows[0] as HTMLElement;
    expect(reports).toHaveTextContent('loja-exemplo-relatorios');
    expect(within(reports).getByText('bucket público')).toBeInTheDocument();
    expect(within(reports).getByText('Sim')).toHaveClass('text-critical-text');

    await userEvent.selectOptions(screen.getByLabelText('Mostrar'), 'sim');
    await waitFor(() => expect(router.state.location.search).toBe('?aba=buckets&risco=sim'));
    await waitFor(async () => expect(await rowsOf('Buckets S3')).toHaveLength(2));
  });

  it('security groups: as portas abertas para a internet', async () => {
    renderAt('/ativos?aba=security-groups');
    const rows = await rowsOf('Security groups');
    expect(rows[0]).toHaveTextContent('TCP 22');
    expect(rows[0]).toHaveTextContent('porta de administração (SSH ou RDP) aberta para a internet');
    const web = rows.find((row) => row.textContent?.includes('web-publico')) as HTMLElement;
    expect(web).toHaveTextContent('TCP 443 e TCP 80');
    const internal = rows.find((row) => row.textContent?.includes('interno')) as HTMLElement;
    expect(internal).toHaveTextContent('nada');
  });

  it('trocar de aba nunca mostra linhas do tipo anterior com as colunas do novo', async () => {
    const router = renderAt('/ativos');
    await rowsOf('Usuários IAM');
    // Vai direto a um tipo ainda não carregado, com colunas incompatíveis com usuários.
    await userEvent.click(screen.getByRole('tab', { name: /Security groups/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?aba=security-groups'));
    const rows = await rowsOf('Security groups');
    expect(rows[0]).toHaveTextContent('TCP 22');
    expect(screen.queryByText(/deu errado|Erro/)).not.toBeInTheDocument();
  });

  it('as abas funcionam pelo teclado', async () => {
    const router = renderAt('/ativos');
    const users = await screen.findByRole('tab', { name: /Usuários IAM/ });
    users.focus();
    await userEvent.keyboard('{ArrowRight}');
    // A aba escolhida vai para a URL e a tela redesenha com ela.
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /Chaves de acesso/ })).toHaveAttribute('aria-selected', 'true'),
    );
    expect(screen.getByRole('tab', { name: /Chaves de acesso/ })).toHaveFocus();
    await waitFor(() => expect(router.state.location.search).toBe('?aba=keys'));
  });

  it('admin_verax sem cliente escolhido é orientado a escolher um', async () => {
    renderAt('/ativos', { me: demoMe('admin_verax') });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
  });
});

describe('Ativos: coleta parcial e "em breve" (PR-14)', () => {
  const empty = { total: 0, atRisk: 0 };
  const counts = { users: empty, keys: empty, instances: empty, buckets: empty, 'security-groups': empty };
  const account = (changes: Partial<InventorySummary['accounts'][number]> = {}) => ({
    accountId: DEMO_ACCOUNTS.beta,
    collectedAt: new Date().toISOString(),
    root: { mfaEnabled: true, accessKeysPresent: false, risk: 'none', reasons: [] },
    errors: [],
    truncated: false,
    ...changes,
  });
  const summaryWith = (accounts: object[]) =>
    http.get(`${API_URL}/v1/assets`, () => HttpResponse.json({ accounts, counts }));

  it('a faixa diz o que ficou de fora em cada conta, e o resto continua nas abas', async () => {
    renderAt('/ativos');
    const band = await screen.findByRole('region', { name: 'Coleta parcial' });
    expect(band).toHaveTextContent(`Conta ${DEMO_ACCOUNTS.alfaProducao}`);
    const items = within(band)
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(items).toContain('Instâncias EC2 em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).');
    expect(items).toContain('Security groups em us-east-1: a AWS recusou a leitura (UnauthorizedOperation).');
    // A outra conta do cliente veio inteira: não aparece na faixa.
    expect(band).not.toHaveTextContent(DEMO_ACCOUNTS.alfaHomologacao);
    expect(band).toHaveTextContent('política do papel verax-control-reader');
    expect(await rowsOf('Usuários IAM')).toHaveLength(9);
  });

  it('o teto de itens e os itens fora do formato também viram coleta parcial', async () => {
    renderAt('/ativos');
    server.use(
      summaryWith([
        account({ truncated: true, errors: [{ section: 'iam', region: null, code: 'invalid_items' }] }),
      ]),
    );
    const band = await screen.findByRole('region', { name: 'Coleta parcial' });
    expect(band).toHaveTextContent(
      'Usuários IAM e chaves de acesso: itens fora do formato esperado ficaram de fora.',
    );
    expect(band).toHaveTextContent('Alguma parte passou do teto de 1.000 itens por tipo');
  });

  it('retrato completo: sem a faixa', async () => {
    renderAt('/ativos');
    server.use(summaryWith([account()]));
    expect(await screen.findByRole('tab', { name: /Usuários IAM/ })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Coleta parcial' })).not.toBeInTheDocument();
  });

  it('cliente sem conta AWS (só GCP ou Cloudflare): "em breve", sem abas', async () => {
    renderAt('/ativos');
    server.use(summaryWith([]));
    expect(await screen.findByText('Ativos de GCP e Cloudflare: em breve')).toBeInTheDocument();
    expect(screen.getByText(/ainda não tem conta AWS ativa/)).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('conta AWS que ainda não foi inventariada: o aviso, sem prometer prazo em minutos', async () => {
    renderAt('/ativos');
    server.use(summaryWith([account({ collectedAt: null, root: null })]));
    expect(await screen.findByText('Ainda sem inventário')).toBeInTheDocument();
    const page = screen.getByRole('heading', { level: 1, name: 'Ativos e identidades' }).closest('section');
    expect(page).toHaveTextContent('depois que a conexão dela é verificada em Contas cloud');
    expect(page).not.toHaveTextContent(/minutos|Prowler/);
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });
});

describe('parte que ficou de fora do inventário', () => {
  it.each([
    [
      { section: 'iam', region: null, code: 'AccessDenied' },
      'Usuários IAM e chaves de acesso: a AWS recusou a leitura (AccessDenied)',
    ],
    [
      { section: 'ec2', region: 'sa-east-1', code: 'UnauthorizedOperation' },
      'Instâncias EC2 em sa-east-1: a AWS recusou a leitura (UnauthorizedOperation)',
    ],
    [
      { section: 'sg', region: 'ap-east-1', code: 'AuthFailure' },
      'Security groups em ap-east-1: a região não aceitou a sessão, desligada ou fora do opt-in (AuthFailure)',
    ],
    [
      { section: 's3', region: null, code: 'invalid_items' },
      'Buckets S3: itens fora do formato esperado ficaram de fora',
    ],
    [
      { section: 'root', region: null, code: 'InvalidParameterValue' },
      'Conta root: a leitura falhou (InvalidParameterValue)',
    ],
  ] as const)('%o vira o texto da faixa', (error, text) => {
    expect(describeSectionError(error)).toBe(text);
  });
});

describe('regras abertas', () => {
  it.each([
    [{ protocol: '-1', fromPort: null, toPort: null }, 'Todo o tráfego'],
    [{ protocol: 'tcp', fromPort: 22, toPort: 22 }, 'TCP 22'],
    [{ protocol: 'tcp', fromPort: 1000, toPort: 2000 }, 'TCP 1000–2000'],
    [{ protocol: 'icmp', fromPort: -1, toPort: -1 }, 'ICMP'],
  ])('%o vira %s', (rule, text) => {
    expect(describeRule(rule)).toBe(text);
  });
});

describe('bucket público', () => {
  it.each([
    [{ policyPublic: true, aclPublic: false }, true],
    [{ policyPublic: false, aclPublic: true }, true],
    [{ policyPublic: null, aclPublic: true }, true],
    [{ policyPublic: false, aclPublic: false }, false],
    [{ policyPublic: false, aclPublic: null }, false],
    [{ policyPublic: null, aclPublic: null }, null],
  ])('%o é %s', (bucket, expected) => {
    expect(bucketPublic(bucket)).toBe(expected);
  });
});

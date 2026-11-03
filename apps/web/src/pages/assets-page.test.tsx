import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bucketPublic, describeRule } from '@/features/inventory/labels';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
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
    expect(within(joao).getByText('Não')).toHaveClass('text-critical');
  });

  it('chaves: a antiga em destaque, com o motivo', async () => {
    const router = renderAt('/ativos');
    await userEvent.click(await screen.findByRole('tab', { name: /Chaves de acesso/ }));
    await waitFor(() => expect(router.state.location.search).toBe('?aba=keys'));
    const rows = await rowsOf('Chaves de acesso');
    const key = rows.find((row) => row.textContent?.includes('DEMO3QX7Z2KD9WLB5N8R')) as HTMLElement;
    expect(within(key).getByText('240 dias')).toHaveClass('text-critical');
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
    expect(within(reports).getByText('Sim')).toHaveClass('text-critical');

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

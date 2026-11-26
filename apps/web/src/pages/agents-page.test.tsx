import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WAZUH_AGENT_PACKAGES } from '@verax/shared';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_AGENTS_ADDRESS, DEMO_ENROLLMENT } from '@/mocks/agents-handlers';
import { DEMO_TENANTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

const [ALFA, BETA, INATIVO] = DEMO_TENANTS;

function renderAt(path: string, state: MockState) {
  server.use(...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Abre o painel "Instalar novo agente" e devolve ele (o diálogo). */
async function openInstall() {
  await userEvent.click(await screen.findByRole('button', { name: 'Instalar novo agente' }));
  return screen.findByRole('dialog', { name: 'Instalar novo agente' });
}

const veraxIn = (tenantId: string | undefined) =>
  demoMe('admin_verax', { activeTenantId: tenantId ?? null, scopeTenantId: tenantId ?? null });

describe('Agentes', () => {
  it('R-04: a explicação do topo numa linha, o resto em "Como funciona"', async () => {
    renderAt('/cadastros/agentes', { me: demoMe('leitura') });
    expect(await screen.findByText('Agentes do Wazuh nas suas VMs e instâncias EC2.')).toBeInTheDocument();
    const rest = screen.getByText(/^Integridade de arquivos, inventário/);
    expect(rest.closest('details')).not.toHaveAttribute('open');
    expect(within(rest.closest('details')!).getByText('Como funciona')).toBeInTheDocument();
  });

  it('fica no menu, no grupo Fontes, para todos os papéis', async () => {
    renderAt('/cadastros/agentes', { me: demoMe('leitura') });
    const nav = await screen.findByRole('navigation', { name: /principal|menu/i });
    expect(within(nav).getByRole('link', { name: /Agentes/ })).toHaveAttribute('href', '/cadastros/agentes');
  });

  it('pronto: "Instalar novo agente" abre a instalação guiada, com a senha mascarada até o "Mostrar senha"', async () => {
    const router = renderAt('/cadastros/agentes', { me: demoMe('admin_cliente') });
    expect(await screen.findByRole('heading', { level: 1, name: 'Agentes' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /Script de instalação/ })).not.toBeInTheDocument();
    const sheet = await openInstall();
    expect(router.state.location.search).toBe('?instalar=');
    expect(within(sheet).getByText(/198\.51\.100\.0\/28/)).toBeInTheDocument();
    const script = screen.getByRole('region', { name: 'Script de instalação para Linux (deb)' });
    expect(script).toHaveTextContent(DEMO_AGENTS_ADDRESS);
    expect(script).toHaveTextContent(WAZUH_AGENT_PACKAGES['deb-amd64'].sha512);
    expect(script).not.toHaveTextContent(DEMO_ENROLLMENT);
    expect(screen.queryByText(DEMO_ENROLLMENT)).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Mostrar senha' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Esconder senha' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(DEMO_ENROLLMENT)).toBeInTheDocument();
    expect(script).toHaveTextContent(DEMO_ENROLLMENT);
  });

  it('copiar leva o script com a senha de verdade, mesmo com ela mascarada na tela', async () => {
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt('/cadastros/agentes?instalar', { me: demoMe('admin_cliente') });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Copiar: Script de instalação para Linux (deb)' }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0]).toContain(`WAZUH_REGISTRATION_PASSWORD='${DEMO_ENROLLMENT}'`);
    expect(await screen.findByText('Script copiado.')).toBeInTheDocument();
  });

  it('as abas trocam o script: rpm com a arquitetura escolhida e Windows', async () => {
    const router = renderAt('/cadastros/agentes?instalar', { me: demoMe('admin_cliente') });
    await userEvent.click(await screen.findByRole('tab', { name: 'Linux (rpm)' }));
    await userEvent.selectOptions(screen.getByLabelText('Arquitetura'), 'arm64');
    expect(screen.getByRole('region', { name: 'Script de instalação para Linux (rpm)' })).toHaveTextContent(
      WAZUH_AGENT_PACKAGES['rpm-aarch64'].file,
    );
    await userEvent.click(screen.getByRole('tab', { name: 'Windows' }));
    expect(new URLSearchParams(router.state.location.search).get('sistema')).toBe('windows');
    expect(screen.getByRole('region', { name: 'Script de instalação para Windows' })).toHaveTextContent(
      'Start-Service WazuhSvc',
    );
    expect(screen.queryByLabelText('Arquitetura')).not.toBeInTheDocument();
    // Fechar tira o painel e a escolha do sistema da URL.
    await userEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(router.state.location.search).toBe('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('analista vê as instruções sem a senha, com o lugar dela marcado', async () => {
    renderAt('/cadastros/agentes', { me: demoMe('analista_cliente') });
    await openInstall();
    expect(
      await screen.findByText(/Só quem administra o ambiente vê a senha de registro/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mostrar senha' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Script de instalação para Linux (deb)' })).toHaveTextContent(
      '<SENHA-DE-REGISTRO>',
    );
    expect(screen.queryByText(DEMO_ENROLLMENT, { exact: false })).not.toBeInTheDocument();
  });

  it('lista os agentes com sistema, IP, versão, situação e último sinal', async () => {
    renderAt('/cadastros/agentes', { me: demoMe('admin_cliente') });
    const table = await screen.findByRole('table', { name: 'Agentes registrados' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(5);
    const disconnected = rows.find((row) => row.textContent?.includes('banco-relatorios'));
    expect(disconnected).toHaveTextContent('Amazon Linux 2023');
    expect(disconnected).toHaveTextContent('Desconectado');
    const fresh = rows.find((row) => row.textContent?.includes('worker-novo'));
    expect(fresh).toHaveTextContent('Nunca conectou');
    expect(fresh).toHaveTextContent('Ainda não informado');
    expect(screen.getByText(/^Lista atualizada/)).toBeInTheDocument();
  });

  it('liberação pendente: pede ao cliente os IPs de saída, sem instruções', async () => {
    renderAt('/cadastros/agentes', { me: veraxIn(BETA?.id) });
    expect(
      await screen.findByRole('heading', { name: 'Falta liberar os IPs de saída das suas instâncias' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Nenhum agente registrado ainda')).toBeInTheDocument();
    const sheet = await openInstall();
    expect(within(sheet).getByText(/as portas 1514 e/)).toBeInTheDocument();
    expect(within(sheet).queryByRole('region', { name: /Script de instalação/ })).not.toBeInTheDocument();
  });

  it('desligado neste ambiente: "Nenhum agente instalado", e o botão mostra os passos para ligar, sem script', async () => {
    renderAt('/cadastros/agentes', { me: veraxIn(INATIVO?.id) });
    expect(await screen.findByRole('heading', { name: 'Nenhum agente instalado' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const sheet = await openInstall();
    expect(within(sheet).getByText(/ainda não está ligado no seu ambiente/)).toBeInTheDocument();
    expect(within(sheet).getByText(/ao suporte da Verax/)).toBeInTheDocument();
    expect(within(sheet).getByText(/as portas 1514 e 1515 só para os IPs/)).toBeInTheDocument();
    expect(within(sheet).queryByRole('region', { name: /Script de instalação/ })).not.toBeInTheDocument();
  });

  it('admin_verax sem cliente escolhido: pede o cliente', async () => {
    renderAt('/cadastros/agentes', { me: veraxIn(undefined) });
    expect(await screen.findByText('Escolha um cliente')).toBeInTheDocument();
    expect(ALFA).toBeDefined();
  });
});

import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ME_QUERY_KEY } from '@/features/session/session';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import DemoTour from './demo-tour';
import { readTourProgress, type TourProgress, writeTourProgress } from './progress';
import type { TourStep } from './steps';
import TourLauncher from './tour-launcher';

const STEPS: TourStep[] = [
  {
    id: 'um',
    path: '/',
    target: ['[data-tour="alvo-a"]'],
    title: 'Primeiro passo',
    body: 'Texto do primeiro.',
  },
  {
    id: 'dois',
    path: '/b',
    target: ['[data-tour="alvo-b"]'],
    title: 'Segundo passo',
    body: 'Texto do segundo.',
  },
  {
    id: 'tres',
    title: 'Último passo',
    body: 'Texto do último.',
    link: { href: 'https://veraxsistemas.com.br', label: 'veraxsistemas.com.br' },
  },
];

/** O jsdom não calcula layout: os alvos do teste ganham um tamanho; o "escondido" fica sem (como `display: none`). */
function stubLayout() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const target = this.getAttribute('data-tour');
    const box = (x: number, y: number, width: number, height: number) => new DOMRect(x, y, width, height);
    if (this.hasAttribute('data-tour-card')) return box(0, 0, 320, 200);
    if (target && target !== 'escondido') return box(100, 100, 200, 40);
    return box(0, 0, 0, 0);
  });
}

function renderTour({
  path = '/',
  steps = STEPS,
  progress,
}: { path?: string; steps?: TourStep[]; progress?: TourProgress } = {}) {
  if (progress) writeTourProgress(progress);
  const queryClient = createQueryClient();
  queryClient.setQueryData(ME_QUERY_KEY, demoMe('admin_verax'));
  function Layout() {
    return (
      <>
        <TourLauncher />
        <Outlet />
        <DemoTour steps={steps} targetTimeoutMs={50} />
      </>
    );
  }
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <Layout />,
        children: [
          {
            index: true,
            element: (
              <div>
                <div data-tour="escondido">menu recolhido</div>
                <div data-tour="alvo-a">A</div>
              </div>
            ),
          },
          { path: 'b', element: <div data-tour="alvo-b">B</div> },
          { path: 'c', element: <p>Tela sem alvo</p> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, ...view };
}

const card = () => document.querySelector('[data-tour-card]');
const backdrop = () => document.querySelector('[data-tour-backdrop]');

describe('tour guiado da demonstração', () => {
  beforeEach(() => {
    stubLayout();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('abre sozinho na primeira entrada: diálogo com título, "Passo 1 de 3", descrição e o foco nele', async () => {
    renderTour();
    const dialog = await screen.findByRole('dialog', { name: 'Primeiro passo' });
    expect(dialog).toHaveAccessibleDescription('Passo 1 de 3 Texto do primeiro.');
    await waitFor(() => expect(dialog).toHaveFocus());
    await waitFor(() => expect(card()).toHaveAttribute('data-placement', 'below'));
    expect(backdrop()).toHaveAttribute('data-spotlight', 'sim');
    expect(screen.getByRole('button', { name: 'Voltar' })).toBeDisabled();
  });

  it('"Próximo" e "Voltar", e as setas, passam de passo e de tela', async () => {
    const user = userEvent.setup();
    const { router } = renderTour();
    await screen.findByRole('dialog', { name: 'Primeiro passo' });

    await user.click(screen.getByRole('button', { name: 'Próximo' }));
    const second = await screen.findByRole('dialog', { name: 'Segundo passo' });
    expect(router.state.location.pathname).toBe('/b');
    await waitFor(() => expect(second).toHaveFocus());

    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    const first = await screen.findByRole('dialog', { name: 'Primeiro passo' });
    expect(router.state.location.pathname).toBe('/');
    await waitFor(() => expect(first).toHaveFocus());

    await user.keyboard('{ArrowRight}');
    await screen.findByRole('dialog', { name: 'Segundo passo' });
    expect(router.state.location.pathname).toBe('/b');
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveFocus());
    await user.keyboard('{ArrowLeft}');
    await screen.findByRole('dialog', { name: 'Primeiro passo' });
  });

  it('guarda o progresso: recarregar a página retoma do mesmo passo, na tela dele', async () => {
    const user = userEvent.setup();
    const first = renderTour();
    await screen.findByRole('dialog', { name: 'Primeiro passo' });
    await user.click(screen.getByRole('button', { name: 'Próximo' }));
    await screen.findByRole('dialog', { name: 'Segundo passo' });
    expect(readTourProgress()).toEqual({ seen: false, open: true, step: 'dois' });

    first.unmount();
    const { router } = renderTour({ path: '/' });
    await screen.findByRole('dialog', { name: 'Segundo passo' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/b'));
  });

  it('"Concluir" encerra e marca como visto: o tour não abre mais sozinho', async () => {
    const user = userEvent.setup();
    const first = renderTour({ progress: { seen: false, open: true, step: 'tres' } });
    const dialog = await screen.findByRole('dialog', { name: 'Último passo' });
    expect(dialog).toHaveAccessibleDescription('Passo 3 de 3 Texto do último.');
    expect(screen.getByRole('link', { name: /^veraxsistemas\.com\.br/ })).toHaveAttribute(
      'href',
      'https://veraxsistemas.com.br',
    );
    expect(screen.queryByRole('button', { name: 'Pular' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Concluir' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(readTourProgress()).toEqual({ seen: true, open: false, step: null });

    first.unmount();
    renderTour();
    expect(await screen.findByRole('button', { name: 'Fazer o tour' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Esc encerra o tour e conta como visto', async () => {
    const user = userEvent.setup();
    renderTour();
    const dialog = await screen.findByRole('dialog', { name: 'Primeiro passo' });
    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(backdrop()).toBeNull();
    expect(readTourProgress()).toMatchObject({ seen: true, open: false });
  });

  it('"Pular" encerra; "Fazer o tour" retoma de onde parou e, ao encerrar, o foco volta ao botão', async () => {
    const user = userEvent.setup();
    renderTour();
    await screen.findByRole('dialog', { name: 'Primeiro passo' });
    await user.click(screen.getByRole('button', { name: 'Próximo' }));
    await screen.findByRole('dialog', { name: 'Segundo passo' });
    await user.click(screen.getByRole('button', { name: 'Pular' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(readTourProgress()).toEqual({ seen: true, open: false, step: 'dois' });

    const launcher = screen.getByRole('button', { name: 'Fazer o tour' });
    await user.click(launcher);
    const dialog = await screen.findByRole('dialog', { name: 'Segundo passo' });
    await waitFor(() => expect(dialog).toHaveFocus());
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(launcher).toHaveFocus());
  });

  it('alvo ausente: o cartão aparece no centro, sem destaque, e o tour segue', async () => {
    const user = userEvent.setup();
    const steps: TourStep[] = [
      { id: 'sem-alvo', path: '/c', target: ['[data-tour="nao-existe"]'], title: 'Sem alvo', body: 'Nada.' },
      ...STEPS.slice(1),
    ];
    renderTour({ path: '/c', steps });
    const dialog = await screen.findByRole('dialog', { name: 'Sem alvo' });
    await waitFor(() => expect(card()).toHaveAttribute('data-placement', 'center'));
    expect(backdrop()).toHaveAttribute('data-spotlight', 'nao');
    await waitFor(() => expect(dialog).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Próximo' }));
    await screen.findByRole('dialog', { name: 'Segundo passo' });
  });

  it('alvo escondido (menu recolhido no celular) passa a vez ao alvo seguinte', async () => {
    const steps: TourStep[] = [
      {
        id: 'menu',
        path: '/',
        target: ['[data-tour="escondido"]', '[data-tour="alvo-a"]'],
        title: 'Menu',
        body: 'O menu.',
      },
    ];
    renderTour({ steps });
    await screen.findByRole('dialog', { name: 'Menu' });
    await waitFor(() => expect(card()).toHaveAttribute('data-placement', 'below'));
    expect(backdrop()).toHaveAttribute('data-spotlight', 'sim');
  });

  it('quem já viu entra no painel sem o tour', async () => {
    renderTour({ progress: { seen: true, open: false, step: null } });
    expect(await screen.findByRole('button', { name: 'Fazer o tour' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(backdrop()).toBeNull();
  });
});

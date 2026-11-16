import type { RadarDetection, TowerRadar } from '@verax/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetectionRadar } from './detection-radar';

const NOW = '2026-11-15T12:00:00.000Z';
const minutesAgo = (minutes: number) => new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
const id = (index: number) => `018f2c1e-0000-7000-8000-${String(index).padStart(12, '0')}`;

const DETECTIONS: RadarDetection[] = [
  {
    id: id(1),
    severity: 'critical',
    status: 'investigating',
    source: 'cloudtrail',
    occurredAt: minutesAgo(5),
    title: 'Tentativa de desligar a trilha do CloudTrail',
    incident: { id: id(901), open: true },
  },
  {
    id: id(2),
    severity: 'medium',
    status: 'new',
    source: 'gcp_audit',
    occurredAt: minutesAgo(200),
    title: 'Conta de serviço recebeu o papel Editor no projeto',
    incident: null,
  },
  {
    id: id(3),
    severity: 'low',
    status: 'resolved',
    source: 'wazuh_agent',
    occurredAt: minutesAgo(600),
    title: 'Tentativa de login no SSH com usuário inexistente',
    incident: { id: id(902), open: false },
  },
];

const radarOf = (detections: RadarDetection[], total = detections.length): TowerRadar => ({
  since: new Date(Date.parse(NOW) - 24 * 3_600_000).toISOString(),
  windowHours: 24,
  limit: 100,
  total,
  detections,
});

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderRadar(element: ReactNode) {
  const router = createMemoryRouter(
    [
      { path: '/', element },
      { path: '/achados', element: <Where /> },
      { path: '/incidentes/:id', element: <Where /> },
    ],
    { initialEntries: ['/'] },
  );
  const result = render(<RouterProvider router={router} />);
  return { router, ...result };
}

/** Responde ao `prefers-reduced-motion` como pedido; o resto, como o setup padrão (nada casa). */
function mockReducedMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('reduced-motion') ? reduce : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

const radarGroup = () => screen.getByRole('group', { name: /^Radar de detecções das últimas 24 horas/ });
const blip = (title: string) =>
  within(radarGroup()).getByRole('link', { name: (name) => name.includes(title) });

describe('radar de detecções', () => {
  it('tem nome acessível com o total e os setores; cada ponto é um link que diz severidade, origem, hora e incidente', () => {
    renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    expect(radarGroup()).toHaveAccessibleName(
      /3 detecções; AWS 1, GCP 1, Cloudflare 0, Agentes 1\. O centro é agora e o anel de fora, 24 horas atrás\./,
    );
    const critical = blip('Tentativa de desligar a trilha');
    expect(critical).toHaveAccessibleName(
      /^Crítico: Tentativa de desligar a trilha do CloudTrail\. CloudTrail, há 5 minutos \(\d{2}:\d{2}\)\. Em análise\. Em incidente aberto$/,
    );
    expect(blip('Tentativa de login no SSH')).toHaveAccessibleName(
      /^Baixo: .*Agente \(instância\).*Em incidente resolvido$/,
    );
    // Severidade também pela forma: octógono no crítico, losango no baixo, círculo no médio.
    expect(critical.querySelector('polygon')?.getAttribute('points')?.split(' ')).toHaveLength(8);
    expect(
      blip('Tentativa de login no SSH').querySelector('polygon')?.getAttribute('points')?.split(' '),
    ).toHaveLength(4);
    expect(blip('papel Editor').querySelector('polygon')).toBeNull();
    // Só o incidente aberto ganha o anel.
    expect(critical.querySelector('[data-incident-ring]')).not.toBeNull();
    expect(blip('Tentativa de login no SSH').querySelector('[data-incident-ring]')).toBeNull();
    expect(screen.getByText('3 detecções')).toBeInTheDocument();
  });

  it('o mouse mostra a dica com título, severidade, origem e hora; sair esconde', async () => {
    const user = userEvent.setup();
    const { container } = renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    await user.hover(blip('papel Editor'));
    const tip = container.querySelector<HTMLElement>('[data-radar-tip]');
    expect(tip).not.toBeNull();
    expect(tip).toHaveTextContent('Conta de serviço recebeu o papel Editor no projeto');
    expect(tip).toHaveTextContent('Médio');
    expect(tip).toHaveTextContent('GCP (auditoria)');
    expect(tip).toHaveTextContent(/há 3 horas, às \d{2}:\d{2} · Novo/);
    await user.unhover(blip('papel Editor'));
    expect(container.querySelector('[data-radar-tip]')).toBeNull();
  });

  it('teclado: uma parada só (o mais recente), as setas percorrem com a dica e o Enter abre o achado', async () => {
    const user = userEvent.setup();
    const { container } = renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    const links = within(radarGroup()).getAllByRole('link');
    expect(links.filter((link) => link.getAttribute('tabindex') === '0')).toHaveLength(1);

    await user.tab();
    expect(blip('Tentativa de desligar a trilha')).toHaveFocus();
    expect(container.querySelector('[data-radar-tip]')).toHaveTextContent('Tentativa de desligar a trilha');
    expect(blip('Tentativa de desligar a trilha')).toHaveAttribute('data-active', 'true');

    await user.keyboard('{ArrowRight}');
    expect(blip('papel Editor')).toHaveFocus();
    expect(container.querySelector('[data-radar-tip]')).toHaveTextContent('papel Editor');
    expect(blip('papel Editor')).toHaveAttribute('tabindex', '0');
    expect(blip('Tentativa de desligar a trilha')).toHaveAttribute('tabindex', '-1');

    await user.keyboard('{End}');
    expect(blip('Tentativa de login no SSH')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(blip('Tentativa de desligar a trilha')).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('where')).toHaveTextContent(`/achados?achado=${id(1)}`);
  });

  it('o clique abre o achado', async () => {
    const user = userEvent.setup();
    renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    await user.click(blip('papel Editor'));
    expect(await screen.findByTestId('where')).toHaveTextContent(`/achados?achado=${id(2)}`);
  });

  it('com movimento: varredura girando, brilho em cada ponto e pulso só na detecção recente', () => {
    mockReducedMotion(false);
    const { container } = renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    expect(container.querySelector('[data-radar-sweep]')).not.toBeNull();
    expect(container.querySelectorAll('.radar-echo')).toHaveLength(3);
    const pulses = container.querySelectorAll('[data-pulse]');
    expect(pulses).toHaveLength(1);
    expect(pulses[0]?.closest('[data-blip]')).toHaveAttribute('data-blip', id(1));
  });

  it('com menos movimento pedido: sem varredura, sem brilho e sem pulso; o radar continua completo', () => {
    mockReducedMotion(true);
    const { container } = renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    expect(container.querySelector('[data-radar-sweep]')).toBeNull();
    expect(container.querySelector('.radar-echo')).toBeNull();
    expect(container.querySelector('[data-pulse]')).toBeNull();
    expect(within(radarGroup()).getAllByRole('link')).toHaveLength(3);
  });

  it('na atualização, pulsa só a detecção que chegou', () => {
    mockReducedMotion(false);
    const later = '2026-11-15T12:01:00.000Z';
    const arrived: RadarDetection = {
      id: id(4),
      severity: 'high',
      status: 'new',
      source: 'cloudflare_waf',
      occurredAt: minutesAgo(30),
      title: 'Rajada bloqueada pelo WAF do Cloudflare',
      incident: null,
    };
    const { container, rerender } = render(
      <MemoryRouter>
        <DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />
      </MemoryRouter>,
    );
    expect(
      [...container.querySelectorAll('[data-pulse]')].map((pulse) =>
        pulse.closest('[data-blip]')?.getAttribute('data-blip'),
      ),
    ).toEqual([id(1)]);
    rerender(
      <MemoryRouter>
        <DetectionRadar radar={radarOf([...DETECTIONS, arrived])} generatedAt={later} />
      </MemoryRouter>,
    );
    // A que chegou pulsa, mesmo com 30 minutos (atrasada na fonte); a recente que já estava, não pulsa de novo.
    expect(
      [...container.querySelectorAll('[data-pulse]')].map((pulse) =>
        pulse.closest('[data-blip]')?.getAttribute('data-blip'),
      ),
    ).toEqual([id(4)]);
    // Uma atualização sem nada novo não pulsa nada.
    rerender(
      <MemoryRouter>
        <DetectionRadar radar={radarOf([...DETECTIONS, arrived])} generatedAt="2026-11-15T12:02:00.000Z" />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('[data-pulse]')).toHaveLength(0);
  });

  it('teto: avisa que mostra só as mais recentes, com link para todos os achados', () => {
    renderRadar(<DetectionRadar radar={radarOf(DETECTIONS, 134)} generatedAt={NOW} />);
    expect(screen.getByText(/O radar mostra as 3 mais recentes de 134 detecções\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver todas em Achados' })).toHaveAttribute(
      'href',
      '/achados?periodo=24h',
    );
    expect(radarGroup()).toHaveAccessibleName(/134 detecções, 3 mais recentes no radar/);
  });

  it('a tabela tem as mesmas detecções, com severidade por rótulo e links para o achado e o incidente', async () => {
    const user = userEvent.setup();
    renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    await user.click(screen.getByText('Ver em tabela (3)'));
    const table = screen.getByRole('table', { name: 'Detecções do radar' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    expect(
      within(rows[0] as HTMLElement).getByRole('link', { name: /Tentativa de desligar a trilha/ }),
    ).toHaveAttribute('href', `/achados?achado=${id(1)}`);
    expect(rows[0]).toHaveTextContent('Crítico');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Aberto' })).toHaveAttribute(
      'href',
      `/incidentes/${id(901)}`,
    );
    expect(rows[2]).toHaveTextContent('Resolvido');
    // A lista ao lado do radar: as mais recentes, com link.
    expect(screen.getByRole('heading', { name: 'Mais recentes' })).toBeInTheDocument();
  });

  it('sem detecção: o radar diz que não há nenhuma', () => {
    renderRadar(<DetectionRadar radar={radarOf([])} generatedAt={NOW} />);
    expect(
      screen.getByRole('group', { name: 'Radar de detecções: nenhuma nas últimas 24 horas.' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Nenhuma detecção nas últimas 24 horas.')).toBeInTheDocument();
    expect(screen.queryByText(/Ver em tabela/)).not.toBeInTheDocument();
  });
});

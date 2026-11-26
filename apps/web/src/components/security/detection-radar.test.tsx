import type { RadarCase, RadarDetection, TowerRadar } from '@verax/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { createMemoryRouter, MemoryRouter, RouterProvider, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetectionRadar, RADAR_IDLE_MS } from './detection-radar';

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

const SECTOR_OF = {
  cloudtrail: 'aws',
  guardduty: 'aws',
  waf: 'aws',
  security_hub: 'aws',
  inspector: 'aws',
  access_analyzer: 'aws',
  vpc_flow: 'aws',
  alb: 'aws',
  cloudwatch_logs: 'aws',
  gcp_audit: 'gcp',
  cloudflare_audit: 'cloudflare',
  cloudflare_waf: 'cloudflare',
  wazuh_agent: 'agents',
} as const;

/** O radar com as detecções; as contagens da janela saem delas, salvo quando o teste dá as da janela inteira. */
const radarOf = (
  detections: RadarDetection[],
  window?: Pick<TowerRadar, 'bySeverity' | 'bySector'>,
): TowerRadar => {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const bySector = { aws: 0, gcp: 0, cloudflare: 0, agents: 0 };
  for (const detection of detections) {
    bySeverity[detection.severity] += 1;
    bySector[SECTOR_OF[detection.source]] += 1;
  }
  const counts = window ?? { bySeverity, bySector };
  return {
    since: new Date(Date.parse(NOW) - 24 * 3_600_000).toISOString(),
    windowHours: 24,
    limit: 100,
    total: Object.values(counts.bySeverity).reduce((sum, value) => sum + value, 0),
    ...counts,
    detections,
  };
};

function Where() {
  const location = useLocation();
  return <p data-testid="where">{`${location.pathname}${location.search}`}</p>;
}

function renderRadar(element: ReactNode) {
  const router = createMemoryRouter(
    [
      // O radar numa rota à parte: os links levam ao detalhe na tela Detecções (`/`).
      { path: '/radar', element },
      { path: '/', element: <Where /> },
    ],
    { initialEntries: ['/radar'] },
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
    expect(await screen.findByTestId('where')).toHaveTextContent(`/?alerta=${id(1)}`);
  });

  it('no toque, o primeiro toque mostra a dica e o segundo, no mesmo ponto, abre o achado', async () => {
    const user = userEvent.setup();
    const { container } = renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    const tip = () => container.querySelector('[data-radar-tip]');

    await user.pointer({ keys: '[TouchA]', target: blip('papel Editor') });
    expect(tip()).toHaveTextContent('papel Editor');
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();

    // Outro ponto: troca a dica, sem abrir.
    await user.pointer({ keys: '[TouchA]', target: blip('Tentativa de login no SSH') });
    expect(tip()).toHaveTextContent('Tentativa de login no SSH');
    expect(screen.queryByTestId('where')).not.toBeInTheDocument();

    await user.pointer({ keys: '[TouchA]', target: blip('Tentativa de login no SSH') });
    expect(await screen.findByTestId('where')).toHaveTextContent(`/?alerta=${id(3)}`);
  });

  it('o clique abre o achado', async () => {
    const user = userEvent.setup();
    renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
    await user.click(blip('papel Editor'));
    expect(await screen.findByTestId('where')).toHaveTextContent(`/?alerta=${id(2)}`);
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

  it('E-14: o brilho só muda a opacidade, e um minuto sem movimento para a animação até a próxima interação', () => {
    vi.useFakeTimers();
    try {
      mockReducedMotion(false);
      const { container } = renderRadar(<DetectionRadar radar={radarOf(DETECTIONS)} generatedAt={NOW} />);
      const frame = container.querySelector('[data-radar-sweep]')?.parentElement;
      expect(frame).not.toHaveAttribute('data-idle');
      // O brilho nasce no tamanho final: nada de `transform` por quadro.
      for (const echo of container.querySelectorAll('.radar-echo'))
        expect(echo).not.toHaveAttribute('style', expect.stringContaining('transform'));
      act(() => {
        vi.advanceTimersByTime(RADAR_IDLE_MS);
      });
      expect(frame).toHaveAttribute('data-idle', 'true');
      act(() => {
        window.dispatchEvent(new Event('pointermove'));
      });
      expect(frame).not.toHaveAttribute('data-idle');
    } finally {
      vi.useRealTimers();
    }
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

  it('teto: avisa que mostra só as mais recentes; as contagens por severidade e por setor são da janela inteira', () => {
    // 134 na janela, 3 desenhadas: os críticos antigos e o Cloudflare (sem ponto desenhado) entram nas contagens.
    renderRadar(
      <DetectionRadar
        radar={radarOf(DETECTIONS, {
          bySeverity: { critical: 5, high: 0, medium: 1, low: 128 },
          bySector: { aws: 100, gcp: 4, cloudflare: 10, agents: 20 },
        })}
        generatedAt={NOW}
      />,
    );
    expect(screen.getByText(/O radar mostra as 3 mais recentes de 134 detecções\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver todas na lista' })).toHaveAttribute('href', '/?periodo=24h');
    expect(screen.getByText('134 detecções').closest('p')).toHaveTextContent(
      '134 detecções nas últimas 24 horas: 5 crítico, 1 médio, 128 baixo.',
    );
    expect(radarGroup()).toHaveAccessibleName(
      /134 detecções, 3 mais recentes no radar; AWS 100, GCP 4, Cloudflare 10, Agentes 20\./,
    );
    expect(within(radarGroup()).getByText('10 detecções')).toBeInTheDocument();
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
    ).toHaveAttribute('href', `/?alerta=${id(1)}`);
    expect(rows[0]).toHaveTextContent('Crítico');
    expect(within(rows[0] as HTMLElement).getByRole('link', { name: 'Aberto' })).toHaveAttribute(
      'href',
      `/?incidente=${id(901)}`,
    );
    expect(rows[2]).toHaveTextContent('Resolvido');
    // A lista ao lado do radar: as mais recentes, com link.
    expect(screen.getByRole('heading', { name: 'Mais recentes' })).toBeInTheDocument();
  });

  it('compacto (no resumo da tela Detecções): sem a lista das mais recentes, com a tabela e os links da tela', async () => {
    const user = userEvent.setup();
    renderRadar(
      <DetectionRadar
        radar={radarOf(DETECTIONS)}
        generatedAt={NOW}
        compact
        links={{
          finding: (finding) => ({ search: `?periodo=7d&achado=${finding}` }),
          incident: (incident) => ({ search: `?periodo=7d&incidente=${incident}` }),
          all: '/?periodo=24h',
          case: (item) => ({ search: `?periodo=7d&caso=${item}` }),
          allCases: '/?estado=todos',
        }}
      />,
    );
    expect(screen.queryByRole('heading', { name: 'Mais recentes' })).toBeNull();
    await user.click(screen.getByText('Ver em tabela (3)'));
    const table = screen.getByRole('table', { name: 'Detecções do radar' });
    expect(within(table).getByRole('link', { name: /Tentativa de desligar a trilha/ })).toHaveAttribute(
      'href',
      `/radar?periodo=7d&achado=${id(1)}`,
    );
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

describe('radar de casos', () => {
  const caseItem = (index: number, overrides: Partial<RadarCase> = {}): RadarCase => ({
    id: id(500 + index),
    title: `Caso ${index}`,
    severity: 'high',
    sources: ['cloudtrail'],
    sector: 'aws',
    total: 1,
    pending: 1,
    recent: 1,
    lastActivityAt: minutesAgo(60 * index),
    incident: null,
    ...overrides,
  });
  const CASES: RadarCase[] = [
    caseItem(1, {
      title: 'Permissão de administrador concedida',
      severity: 'critical',
      total: 20_000,
      pending: 12,
      recent: 4,
      lastActivityAt: minutesAgo(5),
      incident: { id: id(901), open: true, severity: 'critical' },
    }),
    caseItem(2, {
      title: 'Ataques web acusados pelo WAF',
      severity: 'low',
      sources: ['waf', 'cloudflare_waf'],
      total: 40,
      pending: 40,
      recent: 38,
    }),
    caseItem(3, {
      title: 'Atividade suspeita de uma fonte nova',
      severity: null,
      sources: [],
      sector: 'agents',
      total: 3,
      pending: 0,
      recent: 0,
      incident: { id: id(902), open: false, severity: 'high' },
    }),
  ];
  /** 100 alertas na janela, 42 deles nos casos. */
  const casesRadar = (items: RadarCase[] = CASES, total = items.length, alerts = 42): TowerRadar => ({
    ...radarOf(DETECTIONS, {
      bySeverity: { critical: 2, high: 8, medium: 30, low: 60 },
      bySector: { aws: 90, gcp: 4, cloudflare: 1, agents: 5 },
    }),
    cases: { total, alerts, limit: 100, items },
  });
  const casesGroup = () => screen.getByRole('group', { name: /^Radar de casos das últimas 24 horas/ });
  const point = (title: string) =>
    within(casesGroup()).getByRole('link', { name: (name) => name.includes(title) });

  it('cada ponto é um caso, com severidade, origem, atividade, alertas e incidente; as contagens são de alertas', () => {
    renderRadar(<DetectionRadar radar={casesRadar()} generatedAt={NOW} compact />);
    expect(casesGroup()).toHaveAccessibleName(
      'Radar de casos das últimas 24 horas: 3 casos de detecção, com 42 alertas nesse tempo. Alertas por origem: AWS 90, GCP 4, Cloudflare 1, Agentes 5. ' +
        'O centro é agora e o anel de fora, 24 horas atrás. Use as setas para percorrer os casos e Enter para abrir.',
    );
    expect(within(casesGroup()).getAllByRole('link')).toHaveLength(3);
    expect(point('Permissão de administrador')).toHaveAccessibleName(
      /^Crítico: Permissão de administrador concedida\. CloudTrail, última atividade há 5 minutos \(\d{2}:\d{2}\)\. 20\.000 alertas, 12 pendentes, 4 nas últimas 24 horas\. Em incidente aberto$/,
    );
    // Sem nada pendente: sem severidade, e sem "pendentes"; a fonte que não se conhece é o setor.
    expect(point('fonte nova')).toHaveAccessibleName(
      /^Nada pendente: Atividade suspeita de uma fonte nova\. Agentes, última atividade há 3 horas \(\d{2}:\d{2}\)\. 3 alertas, 0 nas últimas 24 horas\. Em incidente resolvido$/,
    );
    expect(point('WAF')).toHaveAccessibleName(/WAF.* e /);
    // Os alertas continuam contados como sempre, e a frase liga os dois.
    expect(screen.getByText('100 detecções').closest('p')).toHaveTextContent(
      '100 detecções nas últimas 24 horas: 2 crítico, 8 alto, 30 médio, 60 baixo.',
    );
    expect(screen.getByText('42 alertas em 3 casos').closest('p')).toHaveTextContent(
      /^42 alertas em 3 casos de detecção\. Os outros 58 são de vulnerabilidade e de postura, ou não têm caso\.$/,
    );
    expect(within(casesGroup()).getByText('90 detecções')).toBeInTheDocument();
    expect(screen.queryByText(/O radar mostra/)).toBeNull();
  });

  it('sem nada pendente, num incidente aberto: a gravidade é a do incidente, com o anel', async () => {
    const user = userEvent.setup();
    renderRadar(
      <DetectionRadar
        radar={casesRadar([
          caseItem(1, {
            title: 'Trilha desligada',
            severity: null,
            pending: 0,
            incident: { id: id(903), open: true, severity: 'critical' },
          }),
        ])}
        generatedAt={NOW}
        compact
      />,
    );
    expect(point('Trilha desligada')).toHaveAccessibleName(
      /^Crítico: Trilha desligada\. CloudTrail, .*\. 1 alerta, 1 nas últimas 24 horas\. Em incidente aberto$/,
    );
    expect(point('Trilha desligada')).toHaveAttribute('data-severity', 'critical');
    expect(point('Trilha desligada').querySelector('[data-incident-ring]')).not.toBeNull();
    expect(screen.queryByText('Nada pendente')).toBeNull();
    await user.click(screen.getByText('Ver em tabela (1)'));
    expect(
      within(screen.getByRole('table', { name: 'Casos do radar' })).getByText('Crítico'),
    ).toBeInTheDocument();
    // A dica também.
    await user.hover(point('Trilha desligada'));
    expect(document.querySelector('[data-radar-tip]')).toHaveTextContent(
      /Crítico· CloudTrail.*Em incidente aberto$/,
    );
  });

  it('a forma é a severidade, o tamanho são os alertas, e o anel, o incidente aberto', () => {
    const { container } = renderRadar(<DetectionRadar radar={casesRadar()} generatedAt={NOW} compact />);
    const mark = (title: string) => point(title).querySelector('polygon');
    expect(mark('Permissão')?.getAttribute('points')?.split(' ')).toHaveLength(8);
    expect(mark('WAF')?.getAttribute('points')?.split(' ')).toHaveLength(4);
    const extent = (title: string) => {
      const xs = (mark(title)?.getAttribute('points') ?? '')
        .split(' ')
        .map((pair) => Number(pair.split(',')[0]));
      return Math.max(...xs) - Math.min(...xs);
    };
    // O crítico de 20 mil alertas está no teto do tamanho.
    expect(extent('Permissão')).toBeGreaterThan(2 * 7 * 1.9);
    expect(extent('WAF')).toBeGreaterThan(2 * 4.5 * 1.3);
    // O de nada pendente é um círculo vazado.
    expect(mark('fonte nova')).toBeNull();
    expect(point('fonte nova')).toHaveAttribute('data-severity', 'none');
    expect(point('Permissão').querySelector('[data-incident-ring]')).not.toBeNull();
    expect(point('fonte nova').querySelector('[data-incident-ring]')).toBeNull();
    // O maior fica embaixo, para não esconder os pequenos.
    const order = [...container.querySelectorAll('[data-blip]')].map((element) =>
      element.getAttribute('data-blip'),
    );
    expect(order).toEqual([id(501), id(502), id(503)]);
    // A área de toque nunca é menor que a marca.
    for (const element of container.querySelectorAll('[data-blip]')) {
      expect(Number(element.querySelector('circle')?.getAttribute('r'))).toBeGreaterThanOrEqual(16);
    }
    // A legenda explica o tamanho e o círculo vazado.
    expect(
      within(screen.getByRole('list', { name: 'Legenda do radar' })).getByText('Nada pendente'),
    ).toBeVisible();
    expect(screen.getByText(/o tamanho é quantos alertas ele reúne/)).toBeInTheDocument();
  });

  it('teclado: uma parada (o mais grave), as setas seguem a ordem da API, e o Enter abre o caso', async () => {
    const user = userEvent.setup();
    const { container } = renderRadar(<DetectionRadar radar={casesRadar()} generatedAt={NOW} compact />);
    await user.tab();
    expect(point('Permissão')).toHaveFocus();
    expect(container.querySelector('[data-radar-tip]')).toHaveTextContent(
      /Permissão de administrador concedidaCrítico· CloudTrail20\.000 alertas, 12 pendentes, 4 nas últimas 24 horasÚltima atividade há 5 minutos/,
    );
    await user.keyboard('{ArrowRight}');
    expect(point('WAF')).toHaveFocus();
    await user.keyboard('{End}');
    expect(point('fonte nova')).toHaveFocus();
    expect(container.querySelector('[data-radar-tip]')).toHaveTextContent('Nada pendente');
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('where')).toHaveTextContent(`/?caso=${id(503)}`);
  });

  it('a tabela tem os mesmos casos e os mesmos números, com link para o caso e o incidente', async () => {
    const user = userEvent.setup();
    renderRadar(<DetectionRadar radar={casesRadar()} generatedAt={NOW} compact />);
    await user.click(screen.getByText('Ver em tabela (3)'));
    const table = screen.getByRole('table', { name: 'Casos do radar' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([
      'Caso',
      'Severidade',
      'Alertas',
      'Pendentes',
      'Em 24 h',
      'Origem',
      'Última atividade',
      'Incidente',
    ]);
    const cells = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.querySelectorAll('td')].slice(0, 5).map((cell) => cell.textContent));
    expect(cells).toEqual([
      ['Crítico', '20.000', '12', '4', 'CloudTrail'],
      ['Baixo', '40', '40', '38', expect.stringContaining('WAF')],
      ['Nada pendente', '3', '0', '0', 'Agentes'],
    ]);
    expect(within(table).getByRole('link', { name: 'Ataques web acusados pelo WAF' })).toHaveAttribute(
      'href',
      `/?caso=${id(502)}`,
    );
    expect(within(table).getByRole('link', { name: 'Aberto' })).toHaveAttribute(
      'href',
      `/?incidente=${id(901)}`,
    );
    expect(screen.queryByRole('table', { name: 'Detecções do radar' })).toBeNull();
  });

  it('mais casos que o radar desenha: diz quantos, e leva à lista', () => {
    renderRadar(<DetectionRadar radar={casesRadar(CASES, 134)} generatedAt={NOW} compact />);
    expect(screen.getByText('42 alertas em 134 casos').closest('p')).toHaveTextContent(
      /O radar mostra os 3 mais graves\. Ver todos os casos$/,
    );
    expect(screen.getByRole('link', { name: 'Ver todos os casos' })).toHaveAttribute(
      'href',
      '/?estado=todos&periodo=24h',
    );
    expect(casesGroup()).toHaveAccessibleName(
      /134 casos de detecção, com 42 alertas nesse tempo, 3 mais graves no radar\./,
    );
  });

  it.each([
    [
      0,
      0,
      100,
      /^Nenhum caso de detecção ativo\. Os alertas são de vulnerabilidade e de postura, ou não têm caso\.$/,
    ],
    [3, 100, 100, /^100 alertas em 3 casos de detecção\.$/],
    [1, 1, 100, /^1 alerta em 1 caso de detecção\. Os outros 99 são/],
    [
      3,
      99,
      100,
      /^99 alertas em 3 casos de detecção\. O outro é de vulnerabilidade ou de postura, ou não tem caso\.$/,
    ],
  ])('%i casos com %i dos %i alertas', (cases, alerts, _total, text) => {
    const { container } = renderRadar(
      <DetectionRadar radar={casesRadar(CASES.slice(0, cases), cases, alerts)} generatedAt={NOW} compact />,
    );
    const sentences = [...container.querySelectorAll('p')].map((element) => element.textContent);
    expect(sentences.filter((sentence) => text.test(sentence))).toHaveLength(1);
  });

  it('nenhum caso: o radar diz que não há', () => {
    renderRadar(<DetectionRadar radar={casesRadar([], 0, 0)} generatedAt={NOW} compact />);
    expect(
      screen.getByRole('group', { name: 'Radar de casos: nenhum ativo nas últimas 24 horas.' }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Ver em tabela/)).toBeNull();
  });

  it('a mesma animação de sempre: um brilho por ponto e o pulso só do que chegou; sem movimento, nada', () => {
    mockReducedMotion(false);
    const { container, rerender } = render(
      <MemoryRouter>
        <DetectionRadar radar={casesRadar()} generatedAt={NOW} compact />
      </MemoryRouter>,
    );
    const pulsing = () =>
      [...container.querySelectorAll('[data-pulse]')].map((pulse) =>
        pulse.closest('[data-blip]')?.getAttribute('data-blip'),
      );
    expect(container.querySelectorAll('.radar-echo')).toHaveLength(3);
    expect(pulsing()).toEqual([id(501)]);
    // Os mesmos casos na leitura seguinte não pulsam; um caso novo, sim.
    rerender(
      <MemoryRouter>
        <DetectionRadar radar={casesRadar()} generatedAt="2026-11-15T12:01:00.000Z" compact />
      </MemoryRouter>,
    );
    expect(pulsing()).toEqual([]);
    rerender(
      <MemoryRouter>
        <DetectionRadar
          radar={casesRadar([...CASES, caseItem(4)], 4)}
          generatedAt="2026-11-15T12:02:00.000Z"
          compact
        />
      </MemoryRouter>,
    );
    expect(pulsing()).toEqual([id(504)]);
    mockReducedMotion(true);
    const quiet = renderRadar(<DetectionRadar radar={casesRadar()} generatedAt={NOW} compact />);
    expect(quiet.container.querySelector('[data-radar-sweep], .radar-echo, [data-pulse]')).toBeNull();
  });

  it('a varredura não redesenha nada: os pontos só mudam quando a leitura muda', async () => {
    const user = userEvent.setup();
    const { container } = renderRadar(<DetectionRadar radar={casesRadar()} generatedAt={NOW} compact />);
    const changed: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const { target } of records) {
        const owner = (target as Element).closest('[data-blip]')?.getAttribute('data-blip');
        if (owner) changed.push(owner);
      }
    });
    observer.observe(container, { subtree: true, attributes: true, childList: true });
    await user.hover(point('WAF'));
    await user.unhover(point('WAF'));
    observer.disconnect();
    // Só o ponto sob o mouse mudou (o destaque dele); os outros não foram tocados.
    expect(new Set(changed)).toEqual(new Set([id(502)]));
  });
});

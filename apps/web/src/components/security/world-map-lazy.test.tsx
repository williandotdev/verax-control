import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORLD_MAP_HEIGHT, WORLD_MAP_WIDTH } from './world-map-data';
import { LazyWorldMap } from './world-map-lazy';
import type { WorldTraffic } from './world-map-model';
import { WorldMapSkeleton } from './world-map-skeleton';

const none = { requests: 0, blocked: 0, flagged: 0 };
const TRAFFIC: WorldTraffic = {
  generatedAt: '2026-11-24T17:30:00.000Z',
  windowHours: 24,
  recentMinutes: 15,
  countries: [{ code: 'BR', requests: 3, blocked: 0, flagged: 0, recentRequests: 0, recentFlagged: 0 }],
  unknown: none,
  throughProxy: none,
  internal: none,
};

/** Carregar o módulo pode demorar com a máquina ocupada (as suítes rodam juntas no pre-push e no CI). */
const LOAD = { timeout: 10_000 };

afterEach(() => {
  vi.doUnmock('./world-map');
  vi.resetModules();
});

describe('mapa de origens carregado sob demanda', () => {
  it('mostra o esqueleto e depois o mapa', async () => {
    render(<LazyWorldMap traffic={TRAFFIC} userId="pessoa-a" />);
    expect(screen.getByRole('status')).toHaveTextContent('Carregando o mapa de origens…');
    expect(await screen.findByRole('group', { name: /^Mapa de origens/ }, LOAD)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('se o arquivo não vem, um aviso no lugar do mapa, sem derrubar a página', async () => {
    vi.doMock('./world-map', () => {
      throw new Error('sem rede');
    });
    vi.resetModules();
    const fresh = await import('./world-map-lazy');
    render(
      <>
        <p>O resto da página</p>
        <fresh.LazyWorldMap traffic={TRAFFIC} userId="pessoa-a" />
      </>,
    );
    expect(await screen.findByRole('alert', undefined, LOAD)).toHaveTextContent(
      'Não foi possível carregar o mapa de origens. Recarregue a página para tentar de novo.',
    );
    expect(screen.getByText('O resto da página')).toBeInTheDocument();
  });

  it('o esqueleto tem a proporção do mapa: a página não pula quando ele chega', () => {
    const { container } = render(<WorldMapSkeleton />);
    const [width, height] =
      container
        .querySelector('[class*="aspect-["]')
        ?.className.match(/aspect-\[(\d+)\/(\d+)\]/)
        ?.slice(1) ?? [];
    expect(Number(width) / Number(height)).toBeCloseTo(WORLD_MAP_WIDTH / WORLD_MAP_HEIGHT, 10);
  });
});

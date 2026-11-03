import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoBanner } from '@/components/demo-banner';
import { DemoTourButton, DemoTourMount } from './entry';
import { registerTourHost } from './tour-store';

describe('o tour só existe no modo mock', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('fora do modo mock, nem o tour nem o botão "Fazer o tour" existem', () => {
    expect(import.meta.env.MODE).not.toBe('mock');
    const unregister = registerTourHost();
    const { container } = render(
      <>
        <DemoTourMount />
        <DemoTourButton />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
    // A faixa forçada para "mock" (como nos testes dela) também fica sem o botão: ele depende do build, não da faixa.
    render(<DemoBanner mode="mock" />);
    expect(screen.queryByRole('button', { name: 'Fazer o tour' })).not.toBeInTheDocument();
    unregister();
  });

  it('no modo mock, o botão aparece quando o painel tem um tour montado', async () => {
    vi.stubEnv('MODE', 'mock');
    vi.resetModules();
    const entry = await import('./entry');
    const store = await import('./tour-store');
    const unregister = store.registerTourHost();
    render(<entry.DemoTourButton />);
    expect(await screen.findByRole('button', { name: 'Fazer o tour' })).toBeInTheDocument();
    unregister();
  });
});

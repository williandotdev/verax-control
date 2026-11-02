import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeToggle } from '@/components/theme-toggle';
import { CatalogPage } from '@/pages/catalog/catalog-page';
import { setPrefersDark } from '@/test/setup';
import { compareSeverity, SEVERITIES, SEVERITY_STYLES } from './severity';

describe('severidade', () => {
  it('cada nível tem rótulo e ícone próprios (identidade sem depender da cor)', () => {
    const labels = new Set(SEVERITIES.map((s) => SEVERITY_STYLES[s].label));
    const icons = new Set(SEVERITIES.map((s) => SEVERITY_STYLES[s].icon));
    expect(labels.size).toBe(SEVERITIES.length);
    expect(icons.size).toBe(SEVERITIES.length);
  });

  it('ordena do mais grave para o normal', () => {
    expect(
      ['ok', 'critical', 'low', 'high', 'medium'].sort(compareSeverity as (a: string, b: string) => number),
    ).toEqual(['critical', 'high', 'medium', 'low', 'ok']);
  });
});

describe('tema', () => {
  it('segue o sistema por padrão', () => {
    setPrefersDark(true);
    render(<ThemeToggle />);
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(screen.getByRole('radio', { name: 'Sistema' })).toHaveAttribute('aria-checked', 'true');
  });

  it('a escolha manual vale e fica guardada no navegador', async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('radio', { name: 'Escuro' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    expect(window.localStorage.getItem('verax.theme')).toBe('dark');

    await userEvent.click(screen.getByRole('radio', { name: 'Sistema' }));
    expect(window.localStorage.getItem('verax.theme')).toBeNull();
    expect(document.documentElement.dataset['theme']).toBe('light');
  });
});

describe('catálogo', () => {
  it('mostra as cores de severidade com rótulo, os tokens de base, a tipografia e o espaçamento', () => {
    render(<CatalogPage />);
    const colors = screen.getByRole('region', { name: 'Cores de severidade' });
    for (const severity of SEVERITIES) {
      expect(within(colors).getByText(SEVERITY_STYLES[severity].label)).toBeInTheDocument();
    }
    expect(screen.getByRole('heading', { name: 'Cores de base' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Tipografia' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Espaçamento' })).toBeInTheDocument();
  });
});

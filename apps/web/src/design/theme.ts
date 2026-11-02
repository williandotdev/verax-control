import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
const STORAGE_KEY = 'verax.theme';

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function readThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function applyTheme(preference: ThemePreference): void {
  document.documentElement.dataset['theme'] = preference === 'system' ? systemTheme() : preference;
}

/** Preferência de tema (claro, escuro ou do sistema), guardada no navegador. */
export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== 'system') return undefined;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = (): void => applyTheme('system');
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, [preference]);

  const update = useCallback((next: ThemePreference) => {
    if (next === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, next);
    setPreference(next);
  }, []);

  return [preference, update];
}

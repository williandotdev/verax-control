import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

const snapshot = (): boolean => window.matchMedia(QUERY).matches;

/**
 * Quem pediu menos movimento ao sistema: acompanha a preferência sem recarregar a página. O CSS global já encurta as
 * animações; isto é para o que o próprio componente decide não desenhar (a varredura do radar, por exemplo).
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

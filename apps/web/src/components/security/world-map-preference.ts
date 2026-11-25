import { useState } from 'react';
import { usePrefersReducedMotion } from '@/lib/use-reduced-motion';

const STORAGE_KEY = 'verax:mapa-mundi:animacao:';

/**
 * A animação do mapa: ligada ou pausada, lembrada por pessoa neste navegador. O armazenamento pode faltar (janela privada,
 * bloqueio): a escolha vale até sair da tela.
 *
 * Quem pediu menos movimento ao sistema sempre começa com o mapa parado, qualquer que seja a escolha guardada; ligar a
 * animação ali é uma escolha só daquela vez, que não é guardada.
 */
export function useWorldMapMotion(userId: string): [paused: boolean, setPaused: (paused: boolean) => void] {
  const key = `${STORAGE_KEY}${userId}`;
  const reduced = usePrefersReducedMotion();
  const [stored, setStored] = useState(() => {
    try {
      return window.localStorage.getItem(key) === 'pausada';
    } catch {
      // Sem armazenamento: o padrão, ligada.
      return false;
    }
  });
  const [pausedWhileReduced, setPausedWhileReduced] = useState(true);

  const setPaused = (next: boolean) => {
    if (reduced) {
      setPausedWhileReduced(next);
      return;
    }
    setStored(next);
    try {
      window.localStorage.setItem(key, next ? 'pausada' : 'ligada');
    } catch {
      // Sem armazenamento, a escolha vale até sair da tela.
    }
  };
  return [reduced ? pausedWhileReduced : stored, setPaused];
}

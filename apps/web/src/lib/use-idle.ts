import { useEffect, useState } from 'react';

/** O que conta como alguém mexendo na tela. */
const ACTIVITY = [
  'pointermove',
  'pointerdown',
  'keydown',
  'wheel',
  'scroll',
  'focusin',
  'touchstart',
] as const;

/**
 * Ninguém mexe na tela há `ms` milissegundos (E-14): as animações contínuas param e voltam no primeiro movimento. A aba
 * escondida também conta como parada. Só observa eventos; não guarda nada.
 */
export function useIdle(ms: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setIdle(document.visibilityState === 'hidden');
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), ms);
    };
    wake();
    for (const event of ACTIVITY) window.addEventListener(event, wake, { passive: true, capture: true });
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY) window.removeEventListener(event, wake, { capture: true });
      document.removeEventListener('visibilitychange', wake);
    };
  }, [ms]);
  return idle;
}

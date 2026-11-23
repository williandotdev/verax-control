import { useState } from 'react';

const STORAGE_KEY = 'verax:deteccoes:resumo:';
const NARROW = '(max-width: 47.99rem)';

/**
 * Aberto ou recolhido, lembrado por pessoa neste navegador. O armazenamento pode faltar (janela privada, bloqueio): a
 * tela segue com o padrão, aberto no computador e recolhido no celular.
 */
export function useStripPreference(userId: string): [boolean, (expanded: boolean) => void] {
  const key = `${STORAGE_KEY}${userId}`;
  const [expanded, setState] = useState(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'aberto') return true;
      if (stored === 'recolhido') return false;
    } catch {
      // Sem armazenamento: o padrão.
    }
    return typeof window.matchMedia === 'function' ? !window.matchMedia(NARROW).matches : true;
  });
  const set = (next: boolean) => {
    setState(next);
    try {
      window.localStorage.setItem(key, next ? 'aberto' : 'recolhido');
    } catch {
      // Sem armazenamento, a escolha vale até sair da tela.
    }
  };
  return [expanded, set];
}

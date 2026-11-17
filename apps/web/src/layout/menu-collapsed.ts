import { useState } from 'react';

const STORAGE_KEY = 'verax:menu';

/**
 * Menu lateral aberto ou recolhido (só os ícones), lembrado neste navegador. Vale no computador; no celular o menu é
 * uma gaveta e abre sempre inteiro. Sem armazenamento (janela privada, bloqueio), começa aberto.
 */
export function useMenuCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setState] = useState(() => {
    try {
      return window.localStorage.getItem(STORAGE_KEY) === 'recolhido';
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? 'recolhido' : 'aberto');
    } catch {
      // Sem armazenamento, a escolha vale até recarregar a página.
    }
  };
  return [collapsed, set];
}

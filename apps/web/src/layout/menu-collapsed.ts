import { useState } from 'react';

const STORAGE_KEY = 'verax:menu';
/** De 768 a 1023 px (tablet, janela dividida): o menu começa nos ícones (R-07), para sobrar largura ao conteúdo. */
export const MENU_ICONS_QUERY = '(min-width: 48rem) and (max-width: 63.99rem)';

const iconsByDefault = (): boolean =>
  typeof window.matchMedia === 'function' && window.matchMedia(MENU_ICONS_QUERY).matches;

/**
 * Menu lateral aberto ou recolhido (só os ícones), lembrado neste navegador. Vale no computador; no celular o menu é
 * uma gaveta e abre sempre inteiro. Sem escolha guardada, começa nos ícones de 768 a 1023 px e aberto nas telas maiores;
 * a escolha de cada pessoa vale sobre o padrão. Sem armazenamento (janela privada, bloqueio), o padrão.
 */
export function useMenuCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setState] = useState(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'recolhido') return true;
      if (stored === 'aberto') return false;
    } catch {
      // Sem armazenamento: o padrão.
    }
    return iconsByDefault();
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

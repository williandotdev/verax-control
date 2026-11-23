import { useSyncExternalStore } from 'react';

/** Tela larga o bastante para o painel ficar ao lado da lista (o menu lateral ocupa 15rem). */
export const SIDE_PANEL_QUERY = '(min-width: 80rem)';
/** Tela larga o bastante para a lista caber inteira, com todas as colunas, ao lado do radar. */
export const WIDE_LIST_QUERY = '(min-width: 110rem)';

/** Uma media query, acompanhando as mudanças (girar o celular, redimensionar a janela). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false),
    () => false,
  );
}

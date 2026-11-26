import { useSyncExternalStore } from 'react';

/** O celular: abaixo de 768 px, o menu vira gaveta e a tela Detecções troca para o arranjo do celular (E-02). */
export const NARROW_QUERY = '(max-width: 47.99rem)';
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

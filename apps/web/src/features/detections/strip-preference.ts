import { useState } from 'react';

/**
 * A tela empilhada: abaixo de 1280 px, o resumo e a lista ficam um embaixo do outro (`SIDE_PANEL_QUERY` é o contrário).
 * Aí o mapa e o resumo começam recolhidos (R-07), como já começavam no celular: só as contagens, numa linha.
 */
export const STACKED_QUERY = '(max-width: 79.99rem)';

/**
 * Aberto ou recolhido, lembrado por pessoa neste navegador. O armazenamento pode faltar (janela privada, bloqueio): a
 * tela segue com o padrão, aberto no computador (1280 px ou mais) e recolhido com a tela empilhada (R-07). Com
 * `startCollapsed`, começa recolhido só desta vez: a escolha guardada fica como está.
 */
function usePanelPreference(key: string, startCollapsed = false): [boolean, (expanded: boolean) => void] {
  const [expanded, setState] = useState(() => {
    if (startCollapsed) return false;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === 'aberto') return true;
      if (stored === 'recolhido') return false;
    } catch {
      // Sem armazenamento: o padrão.
    }
    return typeof window.matchMedia === 'function' ? !window.matchMedia(STACKED_QUERY).matches : true;
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

/** O resumo da situação. */
export const useStripPreference = (userId: string) => usePanelPreference(`verax:deteccoes:resumo:${userId}`);

/** A faixa do mapa de origens. */
export const useOriginBandPreference = (userId: string, startCollapsed: boolean) =>
  usePanelPreference(`verax:deteccoes:origens:${userId}`, startCollapsed);

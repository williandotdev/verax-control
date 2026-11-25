import { useState } from 'react';

const NARROW = '(max-width: 47.99rem)';

/**
 * Aberto ou recolhido, lembrado por pessoa neste navegador. O armazenamento pode faltar (janela privada, bloqueio): a
 * tela segue com o padrão, aberto no computador e recolhido no celular. Com `startCollapsed`, começa recolhido só desta
 * vez: a escolha guardada fica como está.
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

/** O resumo da situação. */
export const useStripPreference = (userId: string) => usePanelPreference(`verax:deteccoes:resumo:${userId}`);

/** A faixa do mapa de origens. */
export const useOriginBandPreference = (userId: string, startCollapsed: boolean) =>
  usePanelPreference(`verax:deteccoes:origens:${userId}`, startCollapsed);

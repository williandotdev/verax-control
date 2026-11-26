import { type ComponentType, createElement, lazy } from 'react';

/** O que carrega cada tela registrada: os testes de tela chamam todos antes (`preloadPages`). */
const loaders: (() => Promise<unknown>)[] = [];

/**
 * Uma tela carregada só quando é aberta (E-13 da auditoria de UX): cada tela do painel vem num arquivo dela, baixado na
 * primeira vez que abre. Depois de carregada (ou pré-carregada), a tela é desenhada direto, sem passar de novo pelo
 * carregamento: o mesmo que uma tela importada direto.
 */
export function lazyPage<M>(load: () => Promise<M>, pick: (module: M) => ComponentType): ComponentType {
  let ready: ComponentType | null = null;
  const fetchPage = async (): Promise<ComponentType> => {
    ready ??= pick(await load());
    return ready;
  };
  const Lazy = lazy(async () => ({ default: await fetchPage() }));
  loaders.push(fetchPage);
  return function LazyPage() {
    return createElement(ready ?? Lazy);
  };
}

/** Carrega todas as telas registradas (os testes de tela, antes de desenhar). */
export async function preloadPages(): Promise<void> {
  await Promise.all(loaders.map((load) => load()));
}

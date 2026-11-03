import { lazy, Suspense } from 'react';

/*
 * Pontos de montagem do tour guiado da demonstração. O tour só existe no build do modo `mock`: em qualquer outro modo
 * as constantes abaixo viram `null`, o Vite remove os imports dinâmicos e nenhum código ou texto do tour chega ao
 * bundle de produção (como os mocks, em `main.tsx`).
 */
const Tour = import.meta.env.MODE === 'mock' ? lazy(() => import('./demo-tour')) : null;
const Launcher = import.meta.env.MODE === 'mock' ? lazy(() => import('./tour-launcher')) : null;

/** O tour, dentro do painel (depois do login). */
export function DemoTourMount() {
  if (!Tour) return null;
  return (
    <Suspense fallback={null}>
      <Tour />
    </Suspense>
  );
}

/** O botão "Fazer o tour", na faixa da demonstração. */
export function DemoTourButton() {
  if (!Launcher) return null;
  return (
    <Suspense fallback={null}>
      <Launcher />
    </Suspense>
  );
}

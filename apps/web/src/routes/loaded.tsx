import { type ReactNode, Suspense } from 'react';
import { LoadingState } from '@/components/states';

/** Enquanto o arquivo da tela chega: o mesmo esqueleto de carregamento das listas, anunciado ao leitor de tela. */
export function Loaded({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<LoadingState rows={4} label="Carregando a tela" className="p-6" />}>
      {children}
    </Suspense>
  );
}

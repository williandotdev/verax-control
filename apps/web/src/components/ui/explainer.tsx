import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Uma explicação que sai da frente (R-03, R-04): "Como funciona", "Como ler o radar". Um trecho que abre e fecha, nativo
 * (`<details>`), que funciona por teclado, por toque e com leitor de tela, nunca uma dica que só aparece com o mouse.
 * Fechado, ocupa uma linha; no celular, o alvo do toque tem 44 px.
 */
export function Explainer({
  label = 'Como funciona',
  about,
  children,
  className,
}: {
  label?: string;
  /** Do que se trata, só para leitor de tela ("Como funciona: Detecções"). */
  about?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <details className={cn('group', className)} data-explainer>
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded py-0.5 text-sm font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 group-open:rotate-90 motion-safe:transition-transform" />
        {label}
        {about && <span className="sr-only">: {about}</span>}
      </summary>
      <div className="mt-1 max-w-2xl space-y-2 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}

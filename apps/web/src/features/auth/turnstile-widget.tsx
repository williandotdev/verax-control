import { LoaderCircle } from 'lucide-react';
import type { RefObject } from 'react';
import { TURNSTILE_ERROR_MESSAGE, type TurnstileStatus } from './turnstile';

/**
 * O lugar do widget do Turnstile no formulário, com o estado visível: "Carregando verificação…" até o widget
 * aparecer e o aviso quando ele não carrega. O widget em si é da Cloudflare (um iframe com o próprio foco de
 * teclado); o botão de enviar fica desligado até o token chegar.
 */
export function TurnstileWidget({
  containerRef,
  status,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  status: TurnstileStatus;
}) {
  return (
    <div className="space-y-2">
      <div ref={containerRef} data-turnstile aria-busy={status === 'loading'} className="min-h-16" />
      {status === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          Carregando verificação…
        </p>
      )}
      {status === 'error' && (
        <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 px-3 py-2 text-sm">
          {TURNSTILE_ERROR_MESSAGE}
        </p>
      )}
    </div>
  );
}

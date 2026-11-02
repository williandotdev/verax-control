import { CircleSlash, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { errorMessage, requestIdOf } from '@/lib/errors';

/** Nada para mostrar: diz por quê e, quando faz sentido, o que fazer. */
export function EmptyState({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center',
        className,
      )}
    >
      <CircleSlash aria-hidden className="size-6 text-subtle-foreground" />
      <p className="font-medium">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action}
    </div>
  );
}

/** Carregando: esqueleto com a forma do conteúdo, anunciado para leitor de tela. */
export function LoadingState({
  rows = 3,
  label = 'Carregando',
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy className={cn('space-y-2', className)}>
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        {label}…
      </span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden className="h-9 animate-pulse rounded-md bg-foreground/5" />
      ))}
    </div>
  );
}

/** Erro: mensagem sem detalhe técnico, código para o suporte e opção de tentar de novo. */
export function ErrorState({
  error,
  onRetry,
  className,
}: {
  error: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const requestId = requestIdOf(error);
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-2 rounded-lg border border-critical/40 bg-critical/5 p-4',
        className,
      )}
    >
      <p className="flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden className="size-4 text-critical" />
        {errorMessage(error)}
      </p>
      {requestId && (
        <p className="font-mono text-xs text-muted-foreground">Código para o suporte: {requestId}</p>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Tentar de novo
        </Button>
      )}
    </div>
  );
}

import type { ReactNode } from 'react';
import { BrandLockup } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme-toggle';

/**
 * Moldura das telas de autenticação: o navy da marca ao fundo (como o topo do site), a logo, o cartão central e o
 * tema. O cartão segue o tema escolhido; só o que fica sobre o navy (logo e tema) usa a faixa da marca, para os
 * tokens dela não vazarem para o cartão.
 */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-brand p-6">
      <BrandLockup size="lg" className="brand-surface" />
      <div className="w-full max-w-sm space-y-6 rounded-panel border bg-surface p-6 shadow-xl">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
      <div className="brand-surface">
        <ThemeToggle />
      </div>
    </div>
  );
}

export function FormError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md border border-critical/40 bg-critical/5 px-3 py-2 text-sm">
      {message}
    </p>
  );
}

export function FormNotice({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p role="status" className="rounded-md border border-ok/50 bg-ok/10 px-3 py-2 text-sm">
      {message}
    </p>
  );
}

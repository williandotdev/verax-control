import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

/** A moldura das telas de acesso (`/entrar` e `/configurar`): a faixa da marca e o cartão no centro, sem o menu. */
export function AuthFrame({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="brand-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Verax Control</p>
            <p className="text-lg font-semibold">Console do responsável</p>
          </div>
          <ThemeToggle />
        </div>
      </header>
      <main id="conteudo" className="mx-auto max-w-md px-4 py-10">
        <div className="space-y-5 rounded-xl border bg-surface p-6 shadow-xs">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">{title}</h1>
            {description !== undefined && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

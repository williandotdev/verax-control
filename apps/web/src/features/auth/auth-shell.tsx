import type { ReactNode } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';

/** Moldura das telas de autenticação: cartão central, nome do produto e tema. */
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
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-6">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-surface p-6 shadow-sm">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-muted-foreground">Verax Control</p>
          <h1 className="text-2xl font-semibold">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
      <ThemeToggle />
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

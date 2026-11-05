import { useQuery } from '@tanstack/react-query';
import { Calculator, Receipt, ShieldCheck, Wallet } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ThemeToggle } from './theme-toggle';

const NAVIGATION = [
  { to: '/modelos-de-custo', label: 'Modelos de custo', icon: Wallet },
  { to: '/tabelas-de-preco', label: 'Tabelas de preço', icon: Receipt },
  { to: '/simulador', label: 'Simulador de DRE', icon: Calculator },
] as const;

/** Quem está no console: o e-mail que o IAP confirmou (`GET /v1/admin/me`). */
function SignedInAs() {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
  if (me.isPending) return <span className="text-sm text-muted-foreground">Conferindo o acesso…</span>;
  if (me.isError) return <span className="text-sm text-critical-text">Acesso não confirmado</span>;
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <ShieldCheck aria-hidden className="size-4" />
      <span className="sr-only">Conectado como </span>
      <span data-testid="usuario">{me.data.email}</span>
    </span>
  );
}

/** Moldura do console: cabeçalho na faixa da marca, menu das três telas e o conteúdo. */
export function Layout() {
  return (
    <div className="min-h-screen">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Pular para o conteúdo
      </a>
      <header className="brand-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Verax Control</p>
            <p className="text-lg font-semibold">Console do responsável</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <SignedInAs />
            <ThemeToggle />
          </div>
        </div>
        <nav aria-label="Menu do console" className="mx-auto max-w-6xl px-4">
          <ul className="flex flex-wrap gap-1">
            {NAVIGATION.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex items-center gap-2 border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground',
                      isActive && 'border-primary font-medium text-foreground',
                    )
                  }
                >
                  <Icon aria-hidden className="size-4" />
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="conteudo" tabIndex={-1} className="mx-auto max-w-6xl space-y-6 px-4 py-6 focus:outline-none">
        <Outlet />
      </main>
    </div>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Calculator, LogOut, Receipt, Scale, ShieldCheck, UserCog, Users, Wallet } from 'lucide-react';
import { Link, Navigate, NavLink, Outlet, useLocation } from 'react-router';
import { useLogout, useSessionExpiredRedirect } from '@/features/auth/session';
import { api, SessionExpiredError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { loginPath } from '@/lib/return-path';
import { ErrorState, LoadingState } from './states';
import { ThemeToggle } from './theme-toggle';
import { Button } from './ui/button';

const NAVIGATION = [
  { to: '/modelos-de-custo', label: 'Modelos de custo', icon: Wallet },
  { to: '/tabelas-de-preco', label: 'Tabelas de preço', icon: Receipt },
  { to: '/simulador', label: 'Simulador de DRE', icon: Calculator },
  { to: '/clientes', label: 'Clientes', icon: Users },
  { to: '/textos-legais', label: 'Textos legais', icon: Scale },
] as const;

/** A consulta de quem está no console (`GET /v1/admin/me`): a sessão do cookie, conferida pela API. */
function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: api.me, staleTime: Infinity });
}

/** Quem está no console (o e-mail da sessão), o link da conta e a saída. */
function SignedInAs({ email }: { email: string }) {
  const logout = useLogout();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="flex items-center gap-1.5 text-sm">
        <ShieldCheck aria-hidden className="size-4" />
        <span className="sr-only">Conectado como </span>
        <span data-testid="usuario">{email}</span>
      </span>
      <Link
        to="/conta"
        className="inline-flex items-center gap-1.5 text-sm underline-offset-2 hover:underline"
      >
        <UserCog aria-hidden className="size-4" />
        Minha conta
      </Link>
      <Button variant="secondary" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
        <LogOut aria-hidden />
        {logout.isPending ? 'Saindo…' : 'Sair'}
      </Button>
    </div>
  );
}

/**
 * Moldura do console: cabeçalho na faixa da marca, menu das telas e o conteúdo. Nada das telas aparece antes de a API
 * confirmar a sessão (`/me`); sem sessão (ou com ela vencida em qualquer chamada depois), a tela de entrada abre.
 */
export function Layout() {
  const me = useMe();
  const location = useLocation();
  useSessionExpiredRedirect();
  if (me.isPending) {
    return (
      <main className="mx-auto max-w-6xl px-4 py-6">
        <LoadingState label="Conferindo o acesso" />
      </main>
    );
  }
  if (me.isError) {
    if (me.error instanceof SessionExpiredError) {
      return <Navigate to={loginPath(`${location.pathname}${location.search}`)} replace />;
    }
    return (
      <main className="mx-auto max-w-6xl space-y-3 px-4 py-6">
        <ErrorState error={me.error} onRetry={() => void me.refetch()} />
        <SignOutOnly />
      </main>
    );
  }
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
            <SignedInAs email={me.data.email} />
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

/** Sessão aberta de quem não é (mais) responsável: só a saída. */
function SignOutOnly() {
  const logout = useLogout();
  return (
    <Button variant="secondary" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
      <LogOut aria-hidden />
      Sair
    </Button>
  );
}

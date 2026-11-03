import { ROLE_LABELS } from '@verax/shared';
import { LogOut, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useMe, useSignOut } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { visibleNavigation } from './navigation';
import { TenantSwitcher } from './tenant-switcher';

/**
 * Estrutura das páginas internas: menu lateral por permissão e cabeçalho com cliente e usuário. Em telas estreitas
 * (celular), o menu vira uma gaveta aberta pelo botão "Menu" e fecha ao navegar, ao tocar fora ou com Esc.
 */
export function AppLayout() {
  const { data: me } = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // O menu guarda o caminho em que foi aberto: ao navegar, o caminho muda e a gaveta fecha sozinha.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const menuOpen = openAt === pathname;
  const setMenuOpen = (open: boolean) => setOpenAt(open ? pathname : null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenAt(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  if (!me) return null;

  const groups = visibleNavigation(me.permissions);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15rem_1fr]">
      {menuOpen && (
        <button
          type="button"
          aria-label="Fechar menu"
          className="fixed inset-0 z-30 bg-foreground/30 md:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        id="menu-principal"
        data-open={menuOpen}
        className={cn(
          'flex-col border-r bg-surface md:static md:flex',
          menuOpen ? 'fixed inset-y-0 left-0 z-40 flex w-64 shadow-lg' : 'hidden',
        )}
      >
        <div className="flex items-center justify-between px-5 py-4">
          <span className="text-base font-semibold">Verax Control</span>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Fechar menu"
            onClick={() => setMenuOpen(false)}
          >
            <X aria-hidden />
          </Button>
        </div>
        <nav aria-label="Menu principal" className="flex-1 space-y-5 px-3">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-2 pb-1 text-xs font-medium text-subtle-foreground">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <li key={to}>
                    <NavLink
                      to={to}
                      end={to === '/'}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                          isActive && 'bg-foreground/10 font-medium text-foreground',
                        )
                      }
                    >
                      <Icon aria-hidden className="size-4" />
                      {label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b bg-surface px-4 py-3 md:px-6">
          <div className="flex items-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="md:hidden"
              aria-expanded={menuOpen}
              aria-controls="menu-principal"
              onClick={() => setMenuOpen(true)}
            >
              <Menu aria-hidden />
              Menu
            </Button>
            {me.permissions.includes('session:switch_tenant') && <TenantSwitcher me={me} />}
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium">{me.email}</p>
              <p className="text-xs text-muted-foreground">{ROLE_LABELS[me.role]}</p>
            </div>
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              disabled={signOut.isPending}
              onClick={() =>
                signOut.mutate(undefined, { onSettled: () => void navigate('/login', { replace: true }) })
              }
            >
              <LogOut aria-hidden />
              Sair
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

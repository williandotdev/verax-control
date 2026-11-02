import { ROLE_LABELS } from '@verax/shared';
import { LogOut } from 'lucide-react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useMe, useSignOut } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { visibleNavigation } from './navigation';
import { TenantSwitcher } from './tenant-switcher';

/** Estrutura das páginas internas: menu lateral por permissão e cabeçalho com cliente e usuário. */
export function AppLayout() {
  const { data: me } = useMe();
  const signOut = useSignOut();
  const navigate = useNavigate();
  if (!me) return null;

  const groups = visibleNavigation(me.permissions);

  return (
    <div className="grid min-h-screen grid-cols-[15rem_1fr]">
      <aside className="flex flex-col border-r bg-surface">
        <div className="px-5 py-4 text-base font-semibold">Verax Control</div>
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
        <header className="flex items-end justify-between gap-4 border-b bg-surface px-6 py-3">
          {me.permissions.includes('session:switch_tenant') ? <TenantSwitcher me={me} /> : <span />}
          <div className="flex items-center gap-3">
            <div className="text-right">
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
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

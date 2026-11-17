import { ROLE_LABELS } from '@verax/shared';
import { LogOut, Menu, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router';
import { BrandLockup } from '@/components/brand/logo';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { useAuthClientConfig } from '@/features/auth/client-config';
import { useMe, useSignOut } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { visibleNavigation } from './navigation';
import { useMenuCollapsed } from './menu-collapsed';
import { Sidebar } from './sidebar';
import { TenantSwitcher } from './tenant-switcher';

/**
 * Estrutura das páginas internas: menu lateral por permissão e cabeçalho com cliente e usuário. No computador o menu
 * pode ser recolhido aos ícones. Em telas estreitas (celular), vira uma gaveta aberta pelo botão "Menu" e fecha ao
 * navegar, ao tocar fora ou com Esc.
 */
export function AppLayout() {
  const { data: me } = useMe();
  const clientConfig = useAuthClientConfig();
  const signOut = useSignOut();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useMenuCollapsed();
  // Qualquer navegação (link, voltar ou avançar do navegador) fecha a gaveta. Ajuste de estado durante a
  // renderização, como recomenda o React para zerar estado quando um valor muda, sem efeito.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  if (!me) return null;

  const groups = visibleNavigation(me.permissions);
  // O console do responsável (o "Admin master"), só para o admin_verax onde a equipe entra (o endereço dela na célula
  // ou o nó dedicado da Verax): a API diz onde ele fica.
  // Abre o console na mesma aba, com a sessão dele (a entrada única); as permissões são as do próprio console.
  const adminMasterUrl = me.role === 'admin_verax' ? (clientConfig.data?.adminMasterUrl ?? null) : null;

  return (
    <div
      className={cn(
        'min-h-screen md:grid',
        collapsed ? 'md:grid-cols-[4.5rem_1fr]' : 'md:grid-cols-[15rem_1fr]',
      )}
    >
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
        data-collapsed={collapsed}
        className={cn(
          // No navy da marca nos dois temas, como o cabeçalho do site (tokens do modo escuro, no index.css). No
          // computador fica preso à altura da tela, e o menu rola por dentro quando não cabe.
          'brand-surface flex-col border-r md:sticky md:top-0 md:flex md:h-screen',
          menuOpen ? 'fixed inset-y-0 left-0 z-40 flex w-64 shadow-lg' : 'hidden',
        )}
      >
        <Sidebar
          groups={groups}
          adminMasterUrl={adminMasterUrl}
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onClose={() => setMenuOpen(false)}
        />
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* No celular o menu lateral, que leva a marca, fica fechado: ela vai numa faixa no topo, como no site. */}
        <div className="brand-surface px-4 py-3 md:hidden">
          <BrandLockup />
        </div>
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
            {/* A própria conta e a preferência de aviso por e-mail (fase 2, PR-17'). */}
            <Link to="/minha-conta" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              <UserRound aria-hidden />
              <span className="sr-only sm:not-sr-only">Minha conta</span>
            </Link>
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
          {/* Trocar de cliente remonta a página: nenhuma tela segura na mão (como dado provisório) o que era do outro. */}
          <Outlet key={me.scopeTenantId ?? 'nenhum'} />
        </main>
      </div>
    </div>
  );
}

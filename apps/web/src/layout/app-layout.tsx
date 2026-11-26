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
import { NARROW_QUERY, useMediaQuery } from '@/lib/use-media-query';
import { visibleNavigation } from './navigation';
import { useMenuCollapsed } from './menu-collapsed';
import { Sidebar } from './sidebar';
import { SourcesTabs } from './sources-tabs';
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
  const narrow = useMediaQuery(NARROW_QUERY);
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
  const canSwitch = me.permissions.includes('session:switch_tenant');
  const signOutButton = (
    <Button
      variant="ghost"
      size="sm"
      className="max-md:min-h-11"
      disabled={signOut.isPending}
      onClick={() =>
        signOut.mutate(undefined, { onSettled: () => void navigate('/login', { replace: true }) })
      }
    >
      <LogOut aria-hidden />
      Sair
    </Button>
  );
  // O console do responsável (o "Admin master"), só para o admin_verax onde a equipe entra (o endereço dela na célula
  // ou o nó dedicado da Verax): a API diz onde ele fica.
  // Abre o console na mesma aba, com a sessão dele (a entrada única); as permissões são as do próprio console.
  const adminMasterUrl = me.role === 'admin_verax' ? (clientConfig.data?.adminMasterUrl ?? null) : null;

  return (
    <>
      {/* R-12: o primeiro item do teclado leva direto ao conteúdo, sem passar pelo menu e pelo cabeçalho. Só aparece com o
          foco. O foco vai para o conteúdo sem mexer no endereço (a URL guarda o estado das telas). */}
      <a
        href="#conteudo"
        className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm font-medium shadow-lg focus:fixed focus:top-2 focus:left-2 focus:h-auto focus:w-auto focus:overflow-visible focus:whitespace-normal focus:[clip:auto] focus:m-0 focus:px-3 focus:py-2 focus-visible:outline-2 focus-visible:outline-ring"
        onClick={(event) => {
          event.preventDefault();
          const main = document.getElementById('conteudo');
          main?.focus();
          main?.scrollIntoView({ block: 'start' });
        }}
      >
        Pular para o conteúdo
      </a>
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
            footer={
              narrow && (
                <div className="space-y-3 border-t border-foreground/10 px-5 py-4">
                  <div className="text-sm">
                    <p className="font-medium wrap-anywhere">{me.email}</p>
                    <p className="text-xs text-muted-foreground">{ROLE_LABELS[me.role]}</p>
                  </div>
                  <ThemeToggle />
                  {signOutButton}
                </div>
              )
            }
          />
        </aside>

        <div className="flex min-w-0 flex-col">
          {narrow ? (
            // E-02: no celular, uma barra só, na cor da marca: "Menu", a marca e a conta. O tema e "Sair" ficam no menu.
            <div className="brand-surface flex items-center justify-between gap-2 px-2 py-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11"
                aria-expanded={menuOpen}
                aria-controls="menu-principal"
                onClick={() => setMenuOpen(true)}
              >
                <Menu aria-hidden />
                Menu
              </Button>
              <BrandLockup />
              <Link
                to="/minha-conta"
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-11')}
              >
                <UserRound aria-hidden />
                <span className="sr-only">Minha conta</span>
              </Link>
            </div>
          ) : null}
          {(!narrow || canSwitch) && (
            <header className="flex flex-wrap items-end justify-between gap-3 border-b bg-surface px-4 py-3 md:px-6">
              <div className="flex items-end gap-2">{canSwitch && <TenantSwitcher me={me} />}</div>
              {!narrow && (
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
                  {signOutButton}
                </div>
              )}
            </header>
          )}
          <main id="conteudo" tabIndex={-1} className="flex-1 p-4 focus:outline-none md:p-6">
            {/* Trocar de cliente remonta a página: nenhuma tela segura na mão (como dado provisório) o que era do outro. */}
            <SourcesTabs permissions={me.permissions} />
            <Outlet key={me.scopeTenantId ?? 'nenhum'} />
          </main>
        </div>
      </div>
    </>
  );
}

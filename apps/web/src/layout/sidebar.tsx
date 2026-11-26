import { ChevronsLeft, ChevronsRight, KeyRound, type LucideIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { BrandLockup, PRODUCT_NAME, VeraxSymbol } from '@/components/brand/logo';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { NavGroup } from './navigation';

interface SidebarProps {
  groups: NavGroup[];
  adminMasterUrl: string | null;
  /** Recolhido: no computador, só os ícones (o nome vira dica e continua para o leitor de tela). */
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  /** Fecha a gaveta do celular. */
  onClose: () => void;
  /** No celular, embaixo do menu: a conta, o tema e "Sair" (E-02). */
  footer?: ReactNode;
}

/** Classe de um item: ícone e nome; o da página atual em negrito, sobre um fundo claro discreto. */
function itemClass(collapsed: boolean, active: boolean, hasBadge: boolean) {
  return cn(
    'flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
    active
      ? 'bg-foreground/[0.08] font-semibold text-foreground'
      : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
    hasBadge && 'pr-16',
    collapsed && 'md:justify-center md:px-0',
  );
}

function ItemContent({
  icon: Icon,
  label,
  collapsed,
}: {
  icon: LucideIcon;
  label: string;
  collapsed: boolean;
}) {
  return (
    <>
      <Icon aria-hidden strokeWidth={1.75} className="size-[18px] shrink-0" />
      <span className={cn('truncate', collapsed && 'md:sr-only')}>{label}</span>
    </>
  );
}

/**
 * Etiqueta ao lado do nome ("Novo"). Fica fora do link e escondida do leitor de tela: o nome do link continua só o da
 * página, e quem navega pelo teclado ou leitor de tela não ouve a etiqueta a cada item.
 */
function Badge({ text, collapsed }: { text: string; collapsed: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full bg-primary px-2 py-0.5',
        'text-[10px] font-bold uppercase leading-none tracking-wider text-primary-foreground',
        collapsed && 'md:hidden',
      )}
    >
      {text}
    </span>
  );
}

function GroupLabel({ children, collapsed }: { children: string; collapsed: boolean }) {
  return (
    <p
      className={cn(
        'px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-subtle-foreground',
        collapsed && 'md:sr-only',
      )}
    >
      {children}
    </p>
  );
}

/**
 * Menu lateral no navy da marca: seções com o título pequeno em caixa alta, itens com ícone de traço fino e, no topo,
 * a marca com o botão de recolher.
 */
export function Sidebar({
  groups,
  adminMasterUrl,
  collapsed,
  onCollapsedChange,
  onClose,
  footer,
}: SidebarProps) {
  const sections: { label: string; content: ReactNode }[] = groups.map((group) => ({
    label: group.label,
    content: group.items.map(({ to, label, icon, badge }) => (
      <li key={to} className="relative">
        <NavLink
          to={to}
          end={to === '/'}
          title={collapsed ? label : undefined}
          className={({ isActive }) => itemClass(collapsed, isActive, badge !== undefined)}
        >
          <ItemContent icon={icon} label={label} collapsed={collapsed} />
        </NavLink>
        {badge !== undefined && <Badge text={badge} collapsed={collapsed} />}
      </li>
    )),
  }));
  if (adminMasterUrl !== null) {
    sections.push({
      label: 'Console',
      content: (
        <li>
          <a
            href={adminMasterUrl}
            rel="noreferrer"
            title={collapsed ? 'Admin master' : undefined}
            className={itemClass(collapsed, false, false)}
          >
            <ItemContent icon={KeyRound} label="Admin master" collapsed={collapsed} />
          </a>
        </li>
      ),
    });
  }

  return (
    <>
      <div
        className={cn(
          'flex items-center justify-between gap-2 px-5 pb-6 pt-6',
          collapsed && 'md:flex-col md:justify-start md:gap-4 md:px-0',
        )}
      >
        <BrandLockup className={cn(collapsed && 'md:hidden')} />
        {collapsed && <VeraxSymbol label={PRODUCT_NAME} className="hidden h-6 md:block" />}
        <Button
          variant="ghost"
          size="icon"
          className="hidden size-8 text-subtle-foreground hover:text-foreground md:inline-flex"
          aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          aria-controls="menu-principal"
          aria-expanded={!collapsed}
          title={collapsed ? 'Expandir menu' : 'Recolher menu'}
          onClick={() => onCollapsedChange(!collapsed)}
        >
          {collapsed ? <ChevronsRight aria-hidden /> : <ChevronsLeft aria-hidden />}
        </Button>
        <Button variant="ghost" size="icon" className="md:hidden" aria-label="Fechar menu" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <nav
        aria-label="Menu principal"
        className={cn('flex-1 space-y-6 overflow-y-auto px-3 pb-6', collapsed && 'md:space-y-0 md:px-2')}
      >
        {sections.map((section, index) => (
          <div
            key={section.label}
            className={cn(collapsed && index > 0 && 'md:mt-3 md:border-t md:border-foreground/10 md:pt-3')}
          >
            <GroupLabel collapsed={collapsed}>{section.label}</GroupLabel>
            <ul className="space-y-1">{section.content}</ul>
          </div>
        ))}
      </nav>
      {footer}
    </>
  );
}

import type { Permission } from '@verax/shared';
import { NavLink, useLocation } from 'react-router';
import { cn } from '@/lib/cn';

/**
 * As telas de "Fontes" (pedido do responsável de 26/11/2026): Contas cloud e Agentes viram abas de uma entrada só do
 * menu. Cada aba continua no endereço dela (os links de antes valem) e aparece só para quem tem a permissão dela; quem
 * tem uma só vê a tela sem abas. É uma moldura fina em volta das telas de sempre: o conteúdo delas não muda.
 */
const SOURCE_TABS: readonly { to: string; label: string; permission: Permission }[] = [
  { to: '/cadastros/contas', label: 'Contas cloud', permission: 'cloud_accounts:read' },
  { to: '/cadastros/agentes', label: 'Agentes', permission: 'agents:read' },
];

export function SourcesTabs({ permissions }: { permissions: readonly Permission[] }) {
  const { pathname } = useLocation();
  if (!SOURCE_TABS.some((tab) => tab.to === pathname)) return null;
  const visible = SOURCE_TABS.filter((tab) => permissions.includes(tab.permission));
  return (
    <nav aria-label="Fontes" className="mb-4 space-y-2">
      <p className="text-xs font-semibold tracking-[0.12em] text-muted-foreground uppercase">Fontes</p>
      {visible.length > 1 && (
        <ul className="flex gap-1 border-b">
          {visible.map((tab) => (
            <li key={tab.to}>
              <NavLink
                to={tab.to}
                end
                className={({ isActive }) =>
                  cn(
                    '-mb-px inline-flex items-center border-b-2 px-3 py-2 text-sm max-md:min-h-11',
                    'focus-visible:outline-2 focus-visible:outline-ring',
                    isActive
                      ? 'border-foreground font-medium text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground',
                  )
                }
              >
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}

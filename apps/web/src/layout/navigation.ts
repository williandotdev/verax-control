import type { Permission } from '@verax/shared';
import {
  Activity,
  BellOff,
  Boxes,
  Building2,
  ChartColumn,
  Cloud,
  FileSearch,
  type LucideIcon,
  ShieldAlert,
  ShieldCheck,
  ShieldPlus,
  Users,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Sem a permissão, o item nem aparece (a API recusaria os dados de qualquer forma). */
  permission: Permission;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Menu lateral. Cada página do E7 entra aqui com a permissão que a API exige para os seus dados. A auditoria volta
 * ao menu quando a API tiver o endpoint de listagem (a trilha já é gravada desde a T1.3).
 */
export const NAVIGATION: NavGroup[] = [
  {
    label: 'Operação',
    items: [
      { to: '/', label: 'Torre', icon: Activity, permission: 'tower:read' },
      { to: '/incidentes', label: 'Incidentes', icon: ShieldAlert, permission: 'incidents:read' },
      { to: '/achados', label: 'Achados', icon: FileSearch, permission: 'findings:read' },
      { to: '/postura', label: 'Postura cloud', icon: ShieldCheck, permission: 'posture:read' },
      { to: '/ativos', label: 'Ativos e identidades', icon: Boxes, permission: 'assets:read' },
      { to: '/relatorios', label: 'Relatórios', icon: ChartColumn, permission: 'reports:read' },
    ],
  },
  {
    label: 'Administração',
    items: [
      { to: '/cadastros/clientes', label: 'Clientes', icon: Building2, permission: 'tenants:read' },
      { to: '/cadastros/usuarios', label: 'Usuários', icon: Users, permission: 'users:read' },
      { to: '/cadastros/contas', label: 'Contas cloud', icon: Cloud, permission: 'cloud_accounts:read' },
      {
        to: '/cadastros/protecao',
        label: 'Lista de proteção',
        icon: ShieldPlus,
        permission: 'protected_resources:read',
      },
      { to: '/cadastros/excecoes', label: 'Exceções', icon: BellOff, permission: 'alert_exceptions:read' },
    ],
  },
];

export function visibleNavigation(permissions: readonly Permission[]): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => permissions.includes(item.permission)),
  })).filter((group) => group.items.length > 0);
}

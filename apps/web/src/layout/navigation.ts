import type { Permission } from '@verax/shared';
import {
  BellOff,
  BellRing,
  Boxes,
  Building2,
  Cloud,
  Gauge,
  Inbox,
  type LucideIcon,
  Radar,
  ScrollText,
  Server,
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
  /** Etiqueta curta ao lado do nome, como "Novo". Só visual: tire quando deixar de valer. */
  badge?: string;
  /**
   * Outras telas da mesma entrada (as abas de "Fontes"): a entrada aparece para quem pode ver qualquer uma delas, leva à
   * primeira que a pessoa pode ver e fica marcada em todas.
   */
  alternates?: readonly { to: string; permission: Permission }[];
  /** Os endereços em que a entrada fica marcada (preenchido por `visibleNavigation`). */
  match?: readonly string[];
  /** Tela com rota própria que não tem entrada no menu: aparece como aba de outra (`alternates`). */
  menu?: false;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Menu lateral. Cada página do E7 entra aqui com a permissão que a API exige para os seus dados. */
export const NAVIGATION: NavGroup[] = [
  {
    label: 'Operação',
    items: [
      // Detecções (16/11/2026): no lugar da Torre, de Incidentes, de Achados e de Relatórios. "Novo" até o fim de 2026.
      { to: '/', label: 'Detecções', icon: Radar, permission: 'findings:read', badge: 'Novo' },
      { to: '/postura', label: 'Postura cloud', icon: ShieldCheck, permission: 'posture:read' },
      { to: '/ativos', label: 'Ativos e identidades', icon: Boxes, permission: 'assets:read' },
    ],
  },
  // R-09: grupos curtos no lugar de "Administração" (nenhum endereço muda). Quem só lê deixa de ver "Administração".
  // "Fontes" (26/11/2026) junta Contas cloud e Agentes numa entrada só, com uma aba para cada (`sources-tabs.tsx`).
  {
    label: 'Fontes e regras',
    items: [
      {
        to: '/cadastros/contas',
        label: 'Fontes',
        icon: Cloud,
        permission: 'cloud_accounts:read',
        alternates: [{ to: '/cadastros/agentes', permission: 'agents:read' }],
      },
      // A rota dos agentes continua (os links de antes valem), como aba de "Fontes", sem entrada própria no menu.
      { to: '/cadastros/agentes', label: 'Agentes', icon: Server, permission: 'agents:read', menu: false },
      {
        to: '/cadastros/protecao',
        label: 'Lista de proteção',
        icon: ShieldPlus,
        permission: 'protected_resources:read',
      },
      { to: '/cadastros/excecoes', label: 'Exceções', icon: BellOff, permission: 'alert_exceptions:read' },
    ],
  },
  {
    label: 'Conta',
    items: [
      { to: '/cadastros/usuarios', label: 'Usuários', icon: Users, permission: 'users:read' },
      { to: '/cadastros/plano', label: 'Plano e uso', icon: Gauge, permission: 'plan:read' },
      {
        to: '/cadastros/escalonamento',
        label: 'Escalonamento',
        icon: BellRing,
        permission: 'escalation_contact:read',
      },
      { to: '/auditoria', label: 'Auditoria', icon: ScrollText, permission: 'audit:read' },
    ],
  },
  {
    label: 'Verax',
    items: [
      { to: '/cadastros/clientes', label: 'Clientes', icon: Building2, permission: 'tenants:read' },
      { to: '/alertas-sem-dono', label: 'Alertas sem dono', icon: Inbox, permission: 'unowned_alerts:read' },
    ],
  },
];

export function visibleNavigation(permissions: readonly Permission[]): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.flatMap((item) => {
      if (item.menu === false) return [];
      const routes = [{ to: item.to, permission: item.permission }, ...(item.alternates ?? [])];
      const allowed = routes.filter((route) => permissions.includes(route.permission));
      const first = allowed[0];
      if (first === undefined) return [];
      return [
        { ...item, to: first.to, permission: first.permission, match: allowed.map((route) => route.to) },
      ];
    }),
  })).filter((group) => group.items.length > 0);
}

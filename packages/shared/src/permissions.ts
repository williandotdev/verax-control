/**
 * Papéis e matriz de permissões (T2.4). Fonte única para a API (que nega por padrão) e para o painel (que
 * esconde o que o usuário não pode fazer). Esconder no painel é conforto; quem decide é a API.
 */
export const ROLES = ['admin_verax', 'admin_cliente', 'analista_cliente', 'leitura'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  admin_verax: 'Administrador Verax',
  admin_cliente: 'Administrador do cliente',
  analista_cliente: 'Analista do cliente',
  leitura: 'Somente leitura',
};

const ALL: readonly Role[] = ROLES;
const VERAX: readonly Role[] = ['admin_verax'];
const ADMINS: readonly Role[] = ['admin_verax', 'admin_cliente'];
const OPERATORS: readonly Role[] = ['admin_verax', 'admin_cliente', 'analista_cliente'];

/** `recurso:ação` → papéis autorizados. Uma permissão nova entra aqui antes de ser usada numa rota. */
export const PERMISSIONS = {
  // Cadastros (E3)
  'tenants:read': VERAX,
  'tenants:write': VERAX,
  'users:read': ADMINS,
  'users:write': ADMINS,
  'cloud_accounts:read': ALL,
  'cloud_accounts:write': ADMINS,
  'protected_resources:read': ALL,
  'protected_resources:write': ADMINS,
  'alert_exceptions:read': ALL,
  'alert_exceptions:write': OPERATORS,
  // Dados (E5) e telas (E7)
  'tower:read': ALL,
  'reports:read': ALL,
  'findings:read': ALL,
  'findings:triage': OPERATORS,
  'incidents:read': ALL,
  'incidents:write': OPERATORS,
  'posture:read': ALL,
  'assets:read': ALL,
  'audit:read': ADMINS,
  // Exclusivas da Verax
  'session:switch_tenant': VERAX,
  'unowned_alerts:read': VERAX,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS[permission].includes(role);
}

export function permissionsOf(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => hasPermission(role, permission));
}

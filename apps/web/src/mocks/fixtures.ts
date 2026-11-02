import {
  type Me,
  meSchema,
  permissionsOf,
  type Role,
  type TenantSummary,
  tenantSummarySchema,
} from '@verax/shared';

/**
 * Dados fictícios do modo `dev:mock` e dos testes do painel. Tipados e validados pelos schemas de
 * `packages/shared`: se o contrato da API mudar, estes dados quebram no carregamento, não na tela.
 * Nenhum nome de cliente real.
 */
export const DEMO_TENANTS: TenantSummary[] = [
  { id: '018f2c1e-0000-7000-8000-00000000a1fa', name: 'Cliente Demo Alfa', status: 'active' },
  { id: '018f2c1e-0000-7000-8000-00000000be7a', name: 'Cliente Demo Beta', status: 'active' },
  { id: '018f2c1e-0000-7000-8000-0000000c0ffe', name: 'Cliente Demo Inativo', status: 'inactive' },
].map((tenant) => tenantSummarySchema.parse(tenant));

const ALFA = DEMO_TENANTS[0]?.id ?? '';

export function demoMe(role: Role, overrides: Partial<Me> = {}): Me {
  const tenantId = role === 'admin_verax' ? null : ALFA;
  return meSchema.parse({
    userId: `demo-${role}`,
    email: `${role.replace('_', '.')}@demo.verax.local`,
    role,
    tenantId,
    activeTenantId: null,
    scopeTenantId: tenantId,
    mfaEnabled: true,
    permissions: permissionsOf(role),
    ...overrides,
  });
}

import {
  type Me,
  meSchema,
  permissionsOf,
  type Role,
  type TenantSummary,
  tenantSummarySchema,
  type TowerSummary,
  towerSummarySchema,
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

/** Contas AWS fictícias (os IDs de exemplo da documentação da AWS). */
export const DEMO_ACCOUNTS = {
  alfaProducao: '111122223333',
  alfaHomologacao: '444455556666',
  beta: '777788889999',
} as const;

const minutesAgo = (now: Date, minutes: number): string =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

/**
 * Torre de cada cliente fictício. A Alfa tem o que mostrar numa apresentação (incidente crítico, decisões
 * pendentes, postura baixa e uma conta silenciosa); a Beta está tranquila, para comparar.
 */
export function demoTower(tenantId: string, options: { includeUnowned: boolean; now?: Date }): TowerSummary {
  const now = options.now ?? new Date();
  if (tenantId !== ALFA) {
    return towerSummarySchema.parse({
      light: 'green',
      reasons: [],
      pendingDecisions: options.includeUnowned ? [{ kind: 'unowned_alert', count: 3 }] : [],
      openIncidents: { critical: 0, high: 0, medium: 1, low: 2 },
      posture: { score: 91, scannedAt: minutesAgo(now, 7 * 60), warningBelow: 70 },
      coverage: {
        connectedAccounts: 1,
        lastEventAt: minutesAgo(now, 1),
        silentAccounts: [],
        silentAfterHours: 24,
      },
      generatedAt: now.toISOString(),
    });
  }
  return towerSummarySchema.parse({
    light: 'red',
    reasons: ['critical_incident', 'high_incident', 'low_posture'],
    pendingDecisions: [
      { kind: 'unassigned_incident', count: 2 },
      { kind: 'untriaged_finding', count: 5 },
      ...(options.includeUnowned ? [{ kind: 'unowned_alert', count: 3 }] : []),
    ],
    openIncidents: { critical: 1, high: 2, medium: 3, low: 1 },
    posture: { score: 64, scannedAt: minutesAgo(now, 6 * 60), warningBelow: 70 },
    coverage: {
      connectedAccounts: 2,
      lastEventAt: minutesAgo(now, 3),
      silentAccounts: [DEMO_ACCOUNTS.alfaHomologacao],
      silentAfterHours: 24,
    },
    generatedAt: now.toISOString(),
  });
}

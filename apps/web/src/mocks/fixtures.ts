import {
  type Me,
  meSchema,
  mitreTactics,
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
    mustChangePassword: false,
    permissions: permissionsOf(role),
    ...overrides,
  });
}

/** Contas fictícias: AWS (os IDs de exemplo da documentação da AWS), um projeto da GCP e uma conta do Cloudflare. */
export const DEMO_ACCOUNTS = {
  alfaProducao: '111122223333',
  alfaHomologacao: '444455556666',
  beta: '777788889999',
  alfaGcp: 'loja-alfa-demo',
  alfaCloudflare: 'd0e0000000000000000000000000a1fa',
} as const;

const minutesAgo = (now: Date, minutes: number): string =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

/**
 * Torre de cada cliente fictício. A Alfa tem o que mostrar numa apresentação (incidente crítico, decisões
 * pendentes, postura baixa e uma conta silenciosa); a Beta está tranquila, para comparar. As contagens de achados e
 * incidentes vêm do estado do mock, para a Torre acompanhar a triagem feita nas outras telas; o semáforo segue a
 * regra da T5.10 (vermelho com incidente crítico aberto; amarelo com alto aberto ou postura abaixo de 70).
 */
export function demoTower(
  tenantId: string,
  options: {
    includeUnowned: boolean;
    /** Alertas sem dono dos últimos 7 dias (só para a equipe da Verax). */
    unownedAlerts?: number;
    untriagedFindings?: number;
    openIncidents?: TowerSummary['openIncidents'];
    unassignedIncidents?: number;
    mitre?: TowerSummary['mitre'];
    now?: Date;
  },
): TowerSummary {
  const now = options.now ?? new Date();
  const alfa = tenantId === ALFA;
  const open =
    options.openIncidents ??
    (alfa ? { critical: 1, high: 2, medium: 3, low: 0 } : { critical: 0, high: 0, medium: 1, low: 0 });
  const score = alfa ? 64 : 91;
  const warningBelow = 70;
  const reasons = [
    ...(open.critical > 0 ? ['critical_incident' as const] : []),
    ...(open.high > 0 ? ['high_incident' as const] : []),
    ...(score < warningBelow ? ['low_posture' as const] : []),
  ];
  return towerSummarySchema.parse({
    light: reasons.includes('critical_incident') ? 'red' : reasons.length > 0 ? 'yellow' : 'green',
    reasons,
    pendingDecisions: [
      { kind: 'unassigned_incident', count: options.unassignedIncidents ?? (alfa ? 2 : 0) },
      { kind: 'untriaged_finding', count: options.untriagedFindings ?? (alfa ? 5 : 0) },
      { kind: 'unowned_alert', count: options.includeUnowned ? (options.unownedAlerts ?? 3) : 0 },
    ].filter((decision) => decision.count > 0),
    openIncidents: open,
    posture: { score, scannedAt: minutesAgo(now, alfa ? 6 * 60 : 7 * 60), warningBelow },
    coverage: alfa
      ? {
          connectedAccounts: 2,
          lastEventAt: minutesAgo(now, 3),
          silentAccounts: [DEMO_ACCOUNTS.alfaHomologacao],
          silentAfterHours: 24,
        }
      : { connectedAccounts: 1, lastEventAt: minutesAgo(now, 1), silentAccounts: [], silentAfterHours: 24 },
    mitre: options.mitre ?? { periodDays: 30, tactics: mitreTactics([], []) },
    generatedAt: now.toISOString(),
  });
}

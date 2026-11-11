import { describe, expect, it } from 'vitest';
import {
  parseTenantPlan,
  PLAN_IDS,
  PLAN_LABELS,
  planIdSchema,
  planOverrideProblems,
  planOverridesSchema,
  PLANS,
  resolvedPlanOf,
  resolvedPlanSchema,
  resolvePlan,
  TENANT_PLAN_IDS,
  type TenantPlan,
  tenantPlanFromResolved,
  tenantPlanProblems,
} from './plans.js';

describe('planos (fase 2)', () => {
  it('Essencial e Profissional têm os limites da tabela comercial', () => {
    expect(resolvePlan('essencial')).toEqual({
      id: 'essencial',
      label: 'Essencial',
      limits: { maxCloudAccounts: 3, maxUsers: 5, monthlyGib: 15, historyDays: 90 },
    });
    expect(resolvePlan('profissional')).toEqual({
      id: 'profissional',
      label: 'Profissional',
      limits: { maxCloudAccounts: 15, maxUsers: 15, monthlyGib: 60, historyDays: 365 },
    });
  });

  it('interno não tem limite nenhum e não aceita ajuste', () => {
    expect(resolvePlan('interno').limits).toEqual({
      maxCloudAccounts: null,
      maxUsers: null,
      monthlyGib: null,
      historyDays: null,
    });
    expect(planOverrideProblems('interno', { maxUsers: 10 })).toEqual([
      { key: 'maxUsers', message: 'não se aplica ao plano interno, que não tem limite' },
    ]);
    expect(() => resolvePlan('interno', { maxUsers: 10 })).toThrow('maxUsers');
  });

  it('enterprise não tem padrão: exige os quatro ajustes', () => {
    expect(PLANS.enterprise).toBeNull();
    expect(planOverrideProblems('enterprise', { maxUsers: 40 }).map((problem) => problem.key)).toEqual([
      'maxCloudAccounts',
      'monthlyGib',
      'historyDays',
    ]);
    expect(() => resolvePlan('enterprise')).toThrow('obrigatório no plano enterprise');
    const overrides = { maxCloudAccounts: 50, maxUsers: 40, monthlyGib: 300, historyDays: 730 };
    expect(resolvePlan('enterprise', overrides)).toEqual({
      id: 'enterprise',
      label: 'Enterprise',
      limits: overrides,
    });
  });

  it('os ajustes trocam só o limite informado (extras do Essencial e do Profissional)', () => {
    expect(resolvePlan('essencial', { maxCloudAccounts: 4, monthlyGib: 25 }).limits).toEqual({
      maxCloudAccounts: 4,
      maxUsers: 5,
      monthlyGib: 25,
      historyDays: 90,
    });
    expect(planOverrideProblems('profissional', { maxUsers: 20 })).toEqual([]);
  });

  it.each([
    ['contas zeradas', { maxCloudAccounts: 0 }],
    ['usuários fracionados', { maxUsers: 2.5 }],
    ['volume acima do teto', { monthlyGib: 100_001 }],
    ['histórico abaixo do piso de 30 dias', { historyDays: 7 }],
    ['ajuste desconhecido', { maxZones: 3 }],
  ])('ajuste inválido é recusado: %s', (_label, overrides) => {
    expect(planOverridesSchema.safeParse(overrides).success).toBe(false);
    expect(() => resolvePlan('essencial', overrides as never)).toThrow();
  });

  it('a mensagem de faixa diz os limites, sem o valor recebido', () => {
    const result = planOverridesSchema.safeParse({ historyDays: 7 });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'deve ser um número inteiro de 30 a 3650',
    ]);
  });

  it('id do plano: só os quatro conhecidos', () => {
    expect(PLAN_IDS.map((id) => planIdSchema.parse(id))).toEqual([...PLAN_IDS]);
    expect(planIdSchema.safeParse('Essencial').success).toBe(false);
    expect(planIdSchema.safeParse('gratis').success).toBe(false);
  });

  it('o plano resolvido segue o contrato, e o rótulo cabe em Tenant.plan (60 caracteres)', () => {
    for (const id of PLAN_IDS) {
      const plan =
        id === 'enterprise'
          ? resolvePlan(id, { maxCloudAccounts: 50, maxUsers: 40, monthlyGib: 300, historyDays: 730 })
          : resolvePlan(id);
      expect(resolvedPlanSchema.parse(plan)).toEqual(plan);
      expect(PLAN_LABELS[id].length).toBeLessThanOrEqual(60);
    }
  });
});

describe('plano do cliente (CE-02)', () => {
  /** Uma Plataforma FICTÍCIA: os números não são os vendidos (esses ficam na tabela de preços, fora do repositório). */
  const plataforma: TenantPlan = {
    planId: 'plataforma',
    limits: { maxCloudAccounts: 5, maxUsers: 5, monthlyGib: null, historyDays: 90 },
    franchiseGbPerDay: 4,
  };

  it('a Plataforma é plano de cliente, mas não do node.conf', () => {
    expect(TENANT_PLAN_IDS).toEqual([...PLAN_IDS, 'plataforma']);
    expect(planIdSchema.safeParse('plataforma').success).toBe(false);
    expect(PLAN_LABELS.plataforma).toBe('Plataforma');
  });

  it('a Plataforma exige contas, usuários, histórico e a franquia, e não tem volume do mês', () => {
    expect(tenantPlanProblems(plataforma)).toEqual([]);
    expect(resolvedPlanOf(plataforma)).toEqual({
      id: 'plataforma',
      label: 'Plataforma',
      limits: plataforma.limits,
    });
    expect(
      tenantPlanProblems({
        ...plataforma,
        franchiseGbPerDay: null,
        limits: { ...plataforma.limits, monthlyGib: 10 },
      }),
    ).toEqual([
      {
        field: 'limits.monthlyGib',
        message: 'não se aplica ao plano plataforma, que mede o volume por dia contra a franquia',
      },
      { field: 'franchiseGbPerDay', message: 'obrigatória no plano plataforma' },
    ]);
    expect(() =>
      parseTenantPlan({ ...plataforma, limits: { ...plataforma.limits, historyDays: null } }),
    ).toThrow('limits.historyDays obrigatório no plano plataforma');
  });

  it('os planos do nó: sem franquia; o interno sem limite; os outros com os quatro', () => {
    for (const id of ['essencial', 'profissional', 'interno'] as const) {
      expect(tenantPlanProblems(tenantPlanFromResolved(resolvePlan(id)))).toEqual([]);
    }
    expect(
      tenantPlanProblems({ ...tenantPlanFromResolved(resolvePlan('essencial')), franchiseGbPerDay: 3 }),
    ).toEqual([
      {
        field: 'franchiseGbPerDay',
        message: 'não se aplica ao plano essencial, que não tem franquia por dia',
      },
    ]);
    expect(
      tenantPlanProblems({
        planId: 'enterprise',
        limits: { maxCloudAccounts: 10, maxUsers: null, monthlyGib: 10, historyDays: 90 },
        franchiseGbPerDay: null,
      }),
    ).toEqual([{ field: 'limits.maxUsers', message: 'obrigatório no plano enterprise' }]);
  });

  it('a faixa vale nos limites e na franquia, e a recusa nunca repete o valor recebido', () => {
    expect(() => parseTenantPlan({ ...plataforma, franchiseGbPerDay: 0 })).toThrow(
      'franchiseGbPerDay deve ser um número inteiro de 1 a 1000',
    );
    expect(() => parseTenantPlan({ ...plataforma, franchiseGbPerDay: 2.5 })).toThrow('franchiseGbPerDay');
    let message = '';
    try {
      parseTenantPlan({ ...plataforma, limits: { ...plataforma.limits, historyDays: 98765 } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('limits.historyDays');
    expect(message).not.toContain('98765');
    expect(() => parseTenantPlan({ ...plataforma, extra: true })).toThrow();
  });
});

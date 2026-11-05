import { describe, expect, it } from 'vitest';
import {
  GIB_BYTES,
  PLAN_SEAT_LIMIT,
  PLAN_SEATS,
  planLimitMessage,
  type PlanUsage,
  planUsageSchema,
  planVolumeRatio,
} from './plan-usage.js';
import { resolvePlan } from './plans.js';

const usage = (overrides: Partial<PlanUsage['usage']> = {}): PlanUsage['usage'] => ({
  cloudAccounts: 2,
  users: 4,
  month: '2026-11',
  monthlyBytes: 0,
  ...overrides,
});

describe('limites do plano e "Plano e uso" (fase 2, PR-18)', () => {
  it('cada vaga aponta para um limite do plano', () => {
    expect(PLAN_SEATS.map((seat) => PLAN_SEAT_LIMIT[seat])).toEqual(['maxCloudAccounts', 'maxUsers']);
  });

  it('a mensagem da recusa diz o limite e o que fazer, no singular e no plural', () => {
    expect(planLimitMessage('cloudAccounts', 3)).toBe(
      'Seu plano permite até 3 contas cloud ativas. Desative uma conta ou fale com a Verax para ampliar.',
    );
    expect(planLimitMessage('cloudAccounts', 1)).toContain('até 1 conta cloud ativa.');
    expect(planLimitMessage('users', 5)).toBe(
      'Seu plano permite até 5 usuários. Desative um usuário ou fale com a Verax para ampliar.',
    );
    expect(planLimitMessage('users', 1)).toContain('até 1 usuário.');
  });

  it('o contrato do GET /v1/plan leva o plano resolvido e o uso do mês, e nada a mais', () => {
    const body = { plan: resolvePlan('essencial'), usage: usage() };
    expect(planUsageSchema.parse(body)).toEqual(body);
    expect(planUsageSchema.safeParse({ ...body, tenantId: 'outro' }).success).toBe(false);
    expect(planUsageSchema.safeParse({ ...body, usage: { ...usage(), extra: 1 } }).success).toBe(false);
    expect(planUsageSchema.safeParse({ ...body, usage: usage({ users: -1 }) }).success).toBe(false);
    expect(planUsageSchema.safeParse({ ...body, usage: usage({ monthlyBytes: 1.5 }) }).success).toBe(false);
    for (const month of ['2026-13', '2026-1', '2026-11-01', '']) {
      expect(planUsageSchema.safeParse({ ...body, usage: usage({ month }) }).success).toBe(false);
    }
  });

  it('a fração do volume usa GiB (2^30 bytes) e passa de 1 acima do plano; sem limite, null', () => {
    const plan = resolvePlan('profissional', { monthlyGib: 10 });
    expect(GIB_BYTES).toBe(1_073_741_824);
    expect(planVolumeRatio({ plan, usage: usage({ monthlyBytes: 8 * GIB_BYTES }) })).toBe(0.8);
    expect(planVolumeRatio({ plan, usage: usage({ monthlyBytes: 15 * GIB_BYTES }) })).toBe(1.5);
    expect(planVolumeRatio({ plan, usage: usage() })).toBe(0);
    expect(planVolumeRatio({ plan: resolvePlan('interno'), usage: usage({ monthlyBytes: GIB_BYTES }) })).toBe(
      null,
    );
  });
});

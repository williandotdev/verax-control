import { HttpStatus } from '@nestjs/common';
import { PERIOD_BEYOND_HISTORY_CODE, resolvePlan } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../common/http/api-error.js';
import { assertPeriodWithinHistory } from './plan-history.js';

/** A recusa que a função lança, ou `null` quando o período passa. */
function refusal(...args: Parameters<typeof assertPeriodWithinHistory>): ApiError | null {
  try {
    assertPeriodWithinHistory(...args);
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}

describe('período dos filtros pelo histórico do plano', () => {
  it('Essencial (90 dias): até 90 dias passa; 12 meses é recusado com o código e a mensagem', () => {
    const plan = resolvePlan('essencial');
    for (const period of ['24h', '7d', '30d', '90d', undefined] as const) {
      expect(refusal(plan, period)).toBeNull();
    }
    const error = refusal(plan, '12m');
    expect(error?.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(error?.code).toBe(PERIOD_BEYOND_HISTORY_CODE);
    expect(error?.message).toBe(
      'Seu plano guarda 90 dias de histórico. Escolha um período menor ou fale com a Verax para ampliar.',
    );
  });

  it('Profissional (365 dias) e Interno (sem limite) aceitam 12 meses', () => {
    expect(refusal(resolvePlan('profissional'), '12m')).toBeNull();
    expect(refusal(resolvePlan('interno'), '12m')).toBeNull();
  });

  it('o ajuste do histórico vale: Enterprise com 60 dias recusa também 90 dias', () => {
    const plan = resolvePlan('enterprise', {
      maxCloudAccounts: 50,
      maxUsers: 50,
      monthlyGib: 500,
      historyDays: 60,
    });
    expect(refusal(plan, '30d')).toBeNull();
    expect(refusal(plan, '90d')?.message).toContain('60 dias de histórico');
    expect(refusal(resolvePlan('essencial', { historyDays: 365 }), '12m')).toBeNull();
  });
});

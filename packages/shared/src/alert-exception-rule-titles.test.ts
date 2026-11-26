import { describe, expect, it } from 'vitest';
import {
  ALERT_EXCEPTION_RULE_TITLES_MAX,
  alertExceptionRuleTitlesQuerySchema,
  alertExceptionRuleTitlesSchema,
} from './alert-exceptions.js';

describe('títulos das regras das exceções (E-09)', () => {
  it('o pedido: números de regra separados por vírgula, até uma página', () => {
    expect(alertExceptionRuleTitlesQuerySchema.safeParse({ ruleIds: '80270,80202' }).success).toBe(true);
    const many = Array.from({ length: ALERT_EXCEPTION_RULE_TITLES_MAX }, (_, i) => String(80000 + i));
    expect(alertExceptionRuleTitlesQuerySchema.safeParse({ ruleIds: many.join(',') }).success).toBe(true);
    expect(alertExceptionRuleTitlesQuerySchema.safeParse({ ruleIds: [...many, '1'].join(',') }).success).toBe(
      false,
    );
    for (const ruleIds of ['', 'abc', '80270,', '1234567', '80270;80202', '80270 ,1']) {
      expect(alertExceptionRuleTitlesQuerySchema.safeParse({ ruleIds }).success, ruleIds).toBe(false);
    }
    expect(alertExceptionRuleTitlesQuerySchema.safeParse({ ruleIds: '1', extra: 'x' }).success).toBe(false);
  });

  it('a resposta é estrita', () => {
    expect(
      alertExceptionRuleTitlesSchema.safeParse({ items: [{ ruleId: '80270', title: 'Login no console' }] })
        .success,
    ).toBe(true);
    expect(
      alertExceptionRuleTitlesSchema.safeParse({ items: [{ ruleId: '80270', title: '' }] }).success,
    ).toBe(false);
    expect(
      alertExceptionRuleTitlesSchema.safeParse({ items: [{ ruleId: 'x', title: 'Título' }] }).success,
    ).toBe(false);
    expect(
      alertExceptionRuleTitlesSchema.safeParse({ items: [{ ruleId: '1', title: 'T', level: 3 }] }).success,
    ).toBe(false);
  });
});

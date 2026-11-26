import { describe, expect, it } from 'vitest';
import {
  AWS_SOURCE_ACTIVE_STATES,
  AWS_SOURCE_ATTENTION_STATES,
  AWS_SOURCE_STATES,
  cloudAccountSourceAttentionSchema,
  needsAwsSourceAttention,
} from './aws-onboarding.js';

const AUTHORIZED = { authorizedAt: '2026-11-01T10:00:00.000Z', authorizedBy: 'u1', revokedAt: null };

describe('fontes que pedem atenção (E-08)', () => {
  it('são as autorizadas paradas, sem permissão, com erro de leitura ou que sumiram', () => {
    const flagged = AWS_SOURCE_STATES.filter((state) =>
      needsAwsSourceAttention({ state, authorization: AUTHORIZED }),
    );
    expect(flagged).toEqual([...AWS_SOURCE_ATTENTION_STATES]);
    // Coletando, esperando o primeiro evento ou ainda configurando não pedem ninguém.
    for (const state of ['collecting', 'waiting_events', 'configuring', 'authorized'] as const) {
      expect(needsAwsSourceAttention({ state, authorization: AUTHORIZED })).toBe(false);
    }
  });

  it('a fonte sem autorização, ou com ela retirada, não conta', () => {
    expect(
      needsAwsSourceAttention({
        state: 'stalled',
        authorization: { authorizedAt: null, authorizedBy: null, revokedAt: null },
      }),
    ).toBe(false);
    expect(
      needsAwsSourceAttention({
        state: 'permission_error',
        authorization: { ...AUTHORIZED, revokedAt: '2026-11-02T10:00:00.000Z' },
      }),
    ).toBe(false);
  });

  it('todo estado de atenção é de uma fonte em coleta, menos a que sumiu', () => {
    for (const state of AWS_SOURCE_ATTENTION_STATES) {
      if (state === 'source_missing') continue;
      expect(AWS_SOURCE_ACTIVE_STATES as readonly string[]).toContain(state);
    }
  });

  it('a resposta é estrita: conta com zero, campo a mais ou id inválido são recusados', () => {
    const id = '0190b7a0-0000-7000-8000-000000000001';
    expect(
      cloudAccountSourceAttentionSchema.safeParse({
        items: [{ cloudAccountId: id, sourcesNeedingAttention: 7 }],
      }).success,
    ).toBe(true);
    expect(cloudAccountSourceAttentionSchema.safeParse({ items: [] }).success).toBe(true);
    expect(
      cloudAccountSourceAttentionSchema.safeParse({
        items: [{ cloudAccountId: id, sourcesNeedingAttention: 0 }],
      }).success,
    ).toBe(false);
    expect(
      cloudAccountSourceAttentionSchema.safeParse({
        items: [{ cloudAccountId: id, sourcesNeedingAttention: 1, names: ['x'] }],
      }).success,
    ).toBe(false);
    expect(
      cloudAccountSourceAttentionSchema.safeParse({
        items: [{ cloudAccountId: 'conta', sourcesNeedingAttention: 1 }],
      }).success,
    ).toBe(false);
  });
});

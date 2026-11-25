import { ROLES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { CASES_MODES, casesOperable, casesVisibleTo } from './cases-mode.js';

describe('para quem os casos existem', () => {
  it('off: ninguém; shadow: só a equipe da Verax; on: todos', () => {
    const seen = Object.fromEntries(
      CASES_MODES.map((mode) => [mode, ROLES.filter((role) => casesVisibleTo(mode, role))]),
    );
    expect(seen).toEqual({ off: [], shadow: ['admin_verax'], on: [...ROLES] });
  });

  it('operar: só com on, para ninguém na medição', () => {
    expect(CASES_MODES.filter((mode) => casesOperable(mode))).toEqual(['on']);
  });
});

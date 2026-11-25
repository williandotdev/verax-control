import { describe, expect, it } from 'vitest';
import {
  arrivalOf,
  CASE_AGE_MS,
  CASE_SILENCE_MS,
  type OpenCaseState,
  sealReasonFor,
} from './case-lifecycle.js';

const T0 = new Date('2026-11-02T12:00:00.000Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);
const DAY_MS = 24 * 60 * 60 * 1000;

const open = (overrides: Partial<OpenCaseState> = {}): OpenCaseState => ({
  queue: 'detection',
  openedAt: T0,
  lastAlertAt: T0,
  pending: true,
  promoted: false,
  treated: false,
  ...overrides,
});

describe('o ciclo de um caso', () => {
  it('as janelas são de 24 h de silêncio e de 7 dias de idade', () => {
    expect([CASE_SILENCE_MS, CASE_AGE_MS]).toEqual([DAY_MS, 7 * DAY_MS]);
  });

  it.each<[string, Partial<OpenCaseState>, number, ReturnType<typeof sealReasonFor>]>([
    ['na hora', {}, 0, null],
    ['no limite do silêncio', {}, DAY_MS, null],
    ['1 ms depois do silêncio', {}, DAY_MS + 1, 'window'],
    ['no limite da idade', { lastAlertAt: at(7 * DAY_MS - 1) }, 7 * DAY_MS, null],
    ['1 ms depois da idade', { lastAlertAt: at(7 * DAY_MS - 1) }, 7 * DAY_MS + 1, 'window'],
    ['antes do último alerta (um antigo que voltou)', { lastAlertAt: at(DAY_MS) }, -30 * DAY_MS, null],
    ['postura, um ano depois', { queue: 'posture' }, 365 * DAY_MS, null],
    ['vulnerabilidade, um ano depois', { queue: 'vulnerability' }, 365 * DAY_MS, null],
    ['tratado', { pending: false, treated: true }, 0, 'treated'],
    ['tratado, depois da janela', { pending: false, treated: true }, 30 * DAY_MS, 'treated'],
    ['sem alerta nenhum', { pending: false }, 0, 'idle'],
    ['sem alerta nenhum, depois da janela', { pending: false }, 30 * DAY_MS, 'idle'],
    ['postura tratada', { queue: 'posture', pending: false, treated: true }, 0, 'treated'],
    ['vulnerabilidade vazia', { queue: 'vulnerability', pending: false }, 0, 'idle'],
    ['promovido, incidente aberto', { pending: false, promoted: true, treated: true }, DAY_MS, null],
    ['promovido, depois da janela', { pending: false, promoted: true, treated: true }, DAY_MS + 1, 'window'],
    [
      'postura promovida, um ano depois',
      { queue: 'posture', pending: false, promoted: true },
      365 * DAY_MS,
      null,
    ],
    ['parte tratada, parte pendente', { treated: true }, DAY_MS, null],
  ])('%s', (_, overrides, arrival, reason) => {
    expect(sealReasonFor(open(overrides), at(arrival))).toBe(reason);
  });

  it('a chegada é a do servidor, nunca depois de agora', () => {
    expect(arrivalOf(at(-5), at(0))).toEqual(at(-5));
    expect(arrivalOf(at(0), at(0))).toEqual(at(0));
    expect(arrivalOf(at(5), at(0))).toEqual(at(0));
  });
});

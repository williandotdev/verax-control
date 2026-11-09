import { describe, expect, it } from 'vitest';
import {
  accountRef,
  type AdminSession,
  afterFailure,
  isLocked,
  LOCKOUT_DURATION_MS,
  LOCKOUT_THRESHOLD,
  LOCKOUT_WINDOW_MS,
  type LoginThrottle,
  loginRequestSchema,
  needsTouch,
  newOpaqueId,
  opaqueIdSchema,
  opaqueRef,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  sessionState,
  throttleRef,
} from './admin-auth.schema.js';

const START = new Date('2026-11-04T12:00:00.000Z');
const MINUTE = 60_000;
const at = (minutes: number): Date => new Date(START.getTime() + minutes * MINUTE);

describe('bloqueio por conta', () => {
  it('5 falhas em 15 min bloqueiam por 15 min; durante o bloqueio, nada muda; depois, recomeça', () => {
    expect(LOCKOUT_THRESHOLD).toBe(5);
    expect(LOCKOUT_WINDOW_MS).toBe(15 * MINUTE);
    expect(LOCKOUT_DURATION_MS).toBe(15 * MINUTE);
    let throttle: LoginThrottle | undefined;
    for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt += 1) {
      const result = afterFailure(throttle, at(attempt));
      expect(result.lockedNow).toBe(false);
      expect(isLocked(result.next, at(attempt))).toBe(false);
      throttle = result.next;
    }
    expect(throttle?.failures).toBe(4);
    const locking = afterFailure(throttle, at(5));
    expect(locking.lockedNow).toBe(true);
    throttle = locking.next;
    expect(isLocked(throttle, at(5))).toBe(true);
    expect(isLocked(throttle, at(19))).toBe(true);
    // Uma falha durante o bloqueio não o estende.
    const during = afterFailure(throttle, at(10));
    expect(during.lockedNow).toBe(false);
    expect(during.next).toBe(throttle);
    expect(isLocked(throttle, at(20))).toBe(false);
    // Acabado o bloqueio, a contagem recomeça do 1.
    const after = afterFailure(throttle, at(21));
    expect(after.next.failures).toBe(1);
    expect(after.next.lockedUntil).toBeUndefined();
  });

  it('falhas espalhadas por mais de 15 min não bloqueiam (a janela recomeça)', () => {
    let throttle: LoginThrottle | undefined;
    for (const minute of [0, 5, 10, 14, 16, 20, 25, 29]) {
      const result = afterFailure(throttle, at(minute));
      expect(result.lockedNow, String(minute)).toBe(false);
      throttle = result.next;
    }
    // O documento expira (TTL) no fim da janela.
    expect(throttle?.expiresAt.getTime()).toBe(
      (throttle?.windowStartedAt.getTime() ?? 0) + LOCKOUT_WINDOW_MS,
    );
  });

  it('o contador é por e-mail (normalizado), exista a conta ou não, e não é o id da conta', () => {
    expect(throttleRef(' Responsavel@Verax.Example ')).toBe(throttleRef('responsavel@verax.example'));
    expect(throttleRef('responsavel@verax.example')).not.toBe(accountRef('responsavel@verax.example'));
    expect(throttleRef('a@verax.example')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('validade da sessão', () => {
  const session: AdminSession = {
    email: 'responsavel@verax.example',
    createdAt: START,
    lastSeenAt: START,
    expiresAt: new Date(START.getTime() + SESSION_ABSOLUTE_MS),
  };

  it('30 min sem uso: inativa; o uso empurra o prazo, até 12 h do login', () => {
    expect(SESSION_IDLE_MS).toBe(30 * MINUTE);
    expect(SESSION_ABSOLUTE_MS).toBe(12 * 60 * MINUTE);
    expect(sessionState(session, at(29))).toBe('valid');
    expect(sessionState(session, at(30))).toBe('idle');
    const used = { ...session, lastSeenAt: at(11 * 60 + 50) };
    expect(sessionState(used, at(11 * 60 + 59))).toBe('valid');
    expect(sessionState(used, at(12 * 60))).toBe('expired');
    // Um `expiresAt` adulterado para depois não estende o prazo absoluto.
    expect(sessionState({ ...used, expiresAt: at(48 * 60) }, at(12 * 60))).toBe('expired');
  });

  it('o "visto por último" só é regravado depois de 1 min', () => {
    expect(needsTouch(session, new Date(START.getTime() + 59_000))).toBe(false);
    expect(needsTouch(session, at(1))).toBe(true);
  });

  it('o id da sessão é aleatório (256 bits) e só o SHA-256 dele vai ao banco', () => {
    const id = newOpaqueId();
    expect(opaqueIdSchema.safeParse(id).success).toBe(true);
    expect(newOpaqueId()).not.toBe(id);
    expect(opaqueRef(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(opaqueRef(id)).not.toContain(id);
  });
});

describe('pedido de login', () => {
  it('exige exatamente um segundo fator: o código do aplicativo ou um de recuperação', () => {
    const base = { email: 'a@verax.example', password: 'x' };
    expect(loginRequestSchema.safeParse({ ...base, code: '123456' }).success).toBe(true);
    expect(loginRequestSchema.safeParse({ ...base, recoveryCode: 'ABCDE-FGHJK' }).success).toBe(true);
    // Só a senha não é um pedido de login: não existe estado "meio autenticado".
    expect(loginRequestSchema.safeParse(base).success).toBe(false);
    expect(loginRequestSchema.safeParse({ ...base, code: '1', recoveryCode: 'x' }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ ...base, code: '123456', extra: 1 }).success).toBe(false);
    expect(loginRequestSchema.safeParse({ ...base, password: 'x'.repeat(129), code: '1' }).success).toBe(
      false,
    );
  });
});

import type { Prisma } from '../generated/prisma/client.js';
import { TOTP_REPLAY_WINDOW_SECONDS } from './auth.constants.js';

/**
 * Bloqueio por conta (T2.3): 5 tentativas de login em 15 min sem chegar a uma sessão completa (senha e, se
 * cadastrado, o código do MFA) bloqueiam o e-mail por 15 min.
 */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_ATTEMPT_WINDOW_MINUTES = 15;
export const LOGIN_LOCK_MINUTES = 15;

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 ? email : undefined;
}

/**
 * Reserva uma tentativa de login antes de a senha ser conferida e diz se ela pode seguir. Conta e decide
 * numa única instrução, então requisições simultâneas não passam juntas pelo limite: a sexta da janela
 * bloqueia, mesmo que as cinco anteriores ainda estejam em andamento.
 *
 * A contagem só zera com uma sessão completa (`clearLoginAttempts`). Por isso uma senha certa sem o código
 * do MFA também conta: quem tem a senha não abre desafios de MFA sem limite.
 */
export async function reserveLoginAttempt(db: Prisma.TransactionClient, email: string): Promise<boolean> {
  const rows = await db.$queryRaw<{ locked: boolean }[]>`
    INSERT INTO "LoginAttempt" (email, failures, "firstFailureAt", "lockedUntil")
    VALUES (${email}, 1, now(), NULL)
    ON CONFLICT (email) DO UPDATE SET
      failures = CASE
        WHEN "LoginAttempt"."lockedUntil" > now() THEN "LoginAttempt".failures
        WHEN "LoginAttempt"."firstFailureAt" > now() - make_interval(mins => ${LOGIN_ATTEMPT_WINDOW_MINUTES})
          THEN "LoginAttempt".failures + 1
        ELSE 1
      END,
      "firstFailureAt" = CASE
        WHEN "LoginAttempt"."lockedUntil" > now() THEN "LoginAttempt"."firstFailureAt"
        WHEN "LoginAttempt"."firstFailureAt" > now() - make_interval(mins => ${LOGIN_ATTEMPT_WINDOW_MINUTES})
          THEN "LoginAttempt"."firstFailureAt"
        ELSE now()
      END,
      "lockedUntil" = CASE
        WHEN "LoginAttempt"."lockedUntil" > now() THEN "LoginAttempt"."lockedUntil"
        WHEN "LoginAttempt"."firstFailureAt" > now() - make_interval(mins => ${LOGIN_ATTEMPT_WINDOW_MINUTES})
          AND "LoginAttempt".failures + 1 > ${LOGIN_MAX_ATTEMPTS}
          THEN now() + make_interval(mins => ${LOGIN_LOCK_MINUTES})
        ELSE NULL
      END
    RETURNING ("lockedUntil" IS NOT NULL AND "lockedUntil" > now()) AS locked`;
  return rows[0]?.locked !== true;
}

export async function clearLoginAttempts(db: Prisma.TransactionClient, email: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { email } });
}

/**
 * Registra o código TOTP de um login e diz se ele ainda não tinha sido usado (NIST SP 800-63B: o mesmo código
 * vale uma vez só). Também numa única instrução: dois logins simultâneos com o mesmo código não passam juntos.
 */
export async function claimTotpCode(
  db: Prisma.TransactionClient,
  userId: string,
  code: string,
): Promise<boolean> {
  await db.usedTotpCode.deleteMany({
    where: { userId, usedAt: { lt: new Date(Date.now() - TOTP_REPLAY_WINDOW_SECONDS * 1000) } },
  });
  const claimed = await db.$executeRaw`
    INSERT INTO "UsedTotpCode" ("userId", code, "usedAt")
    VALUES (${userId}, ${code}, now())
    ON CONFLICT ("userId", code) DO UPDATE SET "usedAt" = now()
    WHERE "UsedTotpCode"."usedAt" < now() - make_interval(secs => ${TOTP_REPLAY_WINDOW_SECONDS})`;
  return claimed === 1;
}

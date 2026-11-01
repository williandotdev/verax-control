import type { Prisma } from '../generated/prisma/client.js';

/** Bloqueio por conta (T2.3): 5 senhas erradas em 15 min bloqueiam o e-mail por 15 min. */
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_FAILURE_WINDOW_MINUTES = 15;
export const LOGIN_LOCK_MINUTES = 15;

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email.length > 0 && email.length <= 254 ? email : undefined;
}

export async function isLoginLocked(db: Prisma.TransactionClient, email: string): Promise<boolean> {
  const attempt = await db.loginAttempt.findUnique({ where: { email }, select: { lockedUntil: true } });
  return attempt?.lockedUntil != null && attempt.lockedUntil > new Date();
}

/**
 * Conta uma falha numa única instrução (sem corrida entre requisições simultâneas): reinicia a janela se a
 * anterior passou e bloqueia ao atingir o limite.
 */
export async function registerLoginFailure(db: Prisma.TransactionClient, email: string): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "LoginAttempt" (email, failures, "firstFailureAt", "lockedUntil")
    VALUES (${email}, 1, now(), NULL)
    ON CONFLICT (email) DO UPDATE SET
      failures = CASE
        WHEN "LoginAttempt"."firstFailureAt" > now() - make_interval(mins => ${LOGIN_FAILURE_WINDOW_MINUTES})
          THEN "LoginAttempt".failures + 1
        ELSE 1
      END,
      "firstFailureAt" = CASE
        WHEN "LoginAttempt"."firstFailureAt" > now() - make_interval(mins => ${LOGIN_FAILURE_WINDOW_MINUTES})
          THEN "LoginAttempt"."firstFailureAt"
        ELSE now()
      END,
      "lockedUntil" = CASE
        WHEN "LoginAttempt"."firstFailureAt" > now() - make_interval(mins => ${LOGIN_FAILURE_WINDOW_MINUTES})
          AND "LoginAttempt".failures + 1 >= ${LOGIN_MAX_FAILURES}
          THEN now() + make_interval(mins => ${LOGIN_LOCK_MINUTES})
        ELSE "LoginAttempt"."lockedUntil"
      END`;
}

export async function clearLoginFailures(db: Prisma.TransactionClient, email: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { email } });
}

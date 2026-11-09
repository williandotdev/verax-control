import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { sealedSecretSchema } from './admin-crypto.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password-hash.js';

/**
 * Os prazos e os documentos do login próprio do console do responsável (cp-admin), e as regras puras (bloqueio e
 * validade da sessão) que o serviço aplica e os testes conferem sem Firestore.
 */
const MINUTE_MS = 60_000;

/** Sessão: 30 min sem uso ou 12 h desde o login, o que vier primeiro (os mesmos prazos do painel). */
export const SESSION_IDLE_MS = 30 * MINUTE_MS;
export const SESSION_ABSOLUTE_MS = 12 * 60 * MINUTE_MS;
/** O "visto por último" só é regravado depois de 1 min: uma escrita por minuto de uso, não uma por requisição. */
export const SESSION_TOUCH_MS = MINUTE_MS;

/** Bloqueio por conta: 5 falhas em 15 min bloqueiam o e-mail por 15 min. */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_WINDOW_MS = 15 * MINUTE_MS;
export const LOCKOUT_DURATION_MS = 15 * MINUTE_MS;

/** O cadastro do TOTP (primeiro cadastro ou troca do aplicativo) vale 10 min entre o QR e o código. */
export const ENROLLMENT_TTL_MS = 10 * MINUTE_MS;

/** Os ids opacos (sessão, cadastro pendente): 32 bytes aleatórios em base64url, 43 caracteres. */
const OPAQUE_ID_BYTES = 32;
export const opaqueIdSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

export function newOpaqueId(): string {
  return randomBytes(OPAQUE_ID_BYTES).toString('base64url');
}

/** O id do documento de um valor opaco (sessão ou cadastro): só o SHA-256 dele vai ao Firestore. */
export function opaqueRef(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** E-mail como comparado e guardado: sem espaços nas pontas, em minúsculas. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** O id da conta de um e-mail (o e-mail fica no documento, não no caminho). */
export function accountRef(email: string): string {
  return createHash('sha256')
    .update(`account:${normalizeEmail(email)}`, 'utf8')
    .digest('hex');
}

/**
 * O id do contador de falhas de login de um e-mail, exista a conta ou não: um e-mail desconhecido é bloqueado igual
 * a um conhecido, e a resposta não diz qual é qual. É também o `accountRef` dos logs (os 12 primeiros dígitos).
 */
export function throttleRef(email: string): string {
  return createHash('sha256')
    .update(`login:${normalizeEmail(email)}`, 'utf8')
    .digest('hex');
}

export const ADMIN_SETUP_MARKER = 'owner';

const date = z.date();
const emailField = z.string().min(3).max(254);

export const recoveryCodeEntrySchema = z.strictObject({
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  usedAt: date.optional(),
});

/** `adminAccounts/{accountRef}`: a conta de um responsável. */
export const adminAccountSchema = z.strictObject({
  email: emailField,
  passwordHash: z.string().min(1).max(256),
  totp: sealedSecretSchema,
  /** O passo (RFC 6238) do último código aceito: só um passo posterior vale (contra reuso). */
  lastTotpStep: z.number().int().nonnegative(),
  recoveryCodes: z.array(recoveryCodeEntrySchema).max(20),
  createdAt: date,
  updatedAt: date,
  passwordChangedAt: date,
  totpChangedAt: date,
});
export type AdminAccount = z.infer<typeof adminAccountSchema>;

/** `adminSessions/{sha256 do id}`: a sessão; `expiresAt` é o prazo absoluto (e o campo do TTL). */
export const adminSessionSchema = z.strictObject({
  email: emailField,
  createdAt: date,
  lastSeenAt: date,
  expiresAt: date,
});
export type AdminSession = z.infer<typeof adminSessionSchema>;

/** `adminLoginThrottle/{throttleRef}`: as falhas da janela e o bloqueio. */
export const loginThrottleSchema = z.strictObject({
  failures: z.number().int().nonnegative(),
  windowStartedAt: date,
  lockedUntil: date.optional(),
  expiresAt: date,
});
export type LoginThrottle = z.infer<typeof loginThrottleSchema>;

export const ENROLLMENT_KINDS = ['setup', 'totp_reset'] as const;

/** `adminEnrollments/{sha256 do id}`: um cadastro do TOTP à espera do primeiro código. */
export const adminEnrollmentSchema = z.strictObject({
  kind: z.enum(ENROLLMENT_KINDS),
  email: emailField,
  /** Só no primeiro cadastro: o hash da senha escolhida, que vira a conta na confirmação. */
  passwordHash: z.string().min(1).max(256).optional(),
  totp: sealedSecretSchema,
  /** Só na troca do aplicativo: a sessão que começou (outra sessão não confirma). */
  sessionRef: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  createdAt: date,
  expiresAt: date,
});
export type AdminEnrollment = z.infer<typeof adminEnrollmentSchema>;

/** `adminSetup/owner`: existe depois do primeiro cadastro e fecha o `/configurar`. */
export const adminSetupMarkerSchema = z.strictObject({
  completedAt: date,
  accountRef: z.string().regex(/^[0-9a-f]{64}$/),
});

// Pedidos (zod; os caminhos dos problemas são os nomes dos campos do formulário do console).

const loginCode = z.string().max(16);
const loginRecoveryCode = z.string().max(32);
const currentPassword = z.string().min(1).max(PASSWORD_MAX_LENGTH);
const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: `A senha precisa ter ao menos ${PASSWORD_MIN_LENGTH} caracteres.` })
  .max(PASSWORD_MAX_LENGTH, { error: `A senha pode ter até ${PASSWORD_MAX_LENGTH} caracteres.` });

/** Exatamente um segundo fator: o código do aplicativo ou um código de recuperação. */
function oneSecondFactor(value: { code?: string | undefined; recoveryCode?: string | undefined }): boolean {
  return (value.code === undefined) !== (value.recoveryCode === undefined);
}
const SECOND_FACTOR_ERROR = {
  error: 'Informe o código do aplicativo ou um código de recuperação.',
  path: ['code'],
};

export const loginRequestSchema = z
  .strictObject({
    email: z.string().max(254),
    password: currentPassword,
    code: loginCode.optional(),
    recoveryCode: loginRecoveryCode.optional(),
  })
  .refine(oneSecondFactor, SECOND_FACTOR_ERROR);
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const setupStartRequestSchema = z.strictObject({
  setupToken: z.string().min(1).max(512),
  email: z.email({ error: 'Informe um e-mail válido.' }).max(254),
  password: newPassword,
});

export const enrollmentConfirmRequestSchema = z.strictObject({
  enrollmentId: z.string().max(64),
  code: loginCode,
});

export const passwordChangeRequestSchema = z.strictObject({
  currentPassword,
  code: loginCode,
  newPassword,
});

export const totpResetStartRequestSchema = z
  .strictObject({
    currentPassword,
    code: loginCode.optional(),
    recoveryCode: loginRecoveryCode.optional(),
  })
  .refine(oneSecondFactor, SECOND_FACTOR_ERROR);

/** O código de 6 dígitos sem os espaços que o usuário pode ter digitado (`123 456`). */
export function compactCode(code: string): string {
  return code.replace(/\s/g, '');
}

// Regras puras.

export function isLocked(throttle: LoginThrottle | undefined, now: Date): boolean {
  return throttle?.lockedUntil !== undefined && throttle.lockedUntil.getTime() > now.getTime();
}

/**
 * O contador depois de uma falha: dentro da janela de 15 min soma; fora dela recomeça. Na quinta falha, bloqueia por
 * 15 min (e o contador recomeça do zero quando o bloqueio acabar). Bloqueado, não muda nada (a falha durante o bloqueio
 * não o estende: quem esperou entra).
 */
export function afterFailure(
  previous: LoginThrottle | undefined,
  now: Date,
): { next: LoginThrottle; lockedNow: boolean } {
  if (previous !== undefined && isLocked(previous, now)) return { next: previous, lockedNow: false };
  const at = now.getTime();
  const inWindow =
    previous !== undefined &&
    previous.lockedUntil === undefined &&
    at - previous.windowStartedAt.getTime() < LOCKOUT_WINDOW_MS;
  const failures = inWindow ? previous.failures + 1 : 1;
  const windowStartedAt = inWindow ? previous.windowStartedAt : now;
  if (failures >= LOCKOUT_THRESHOLD) {
    const lockedUntil = new Date(at + LOCKOUT_DURATION_MS);
    return {
      next: { failures: 0, windowStartedAt: now, lockedUntil, expiresAt: lockedUntil },
      lockedNow: true,
    };
  }
  return {
    next: { failures, windowStartedAt, expiresAt: new Date(windowStartedAt.getTime() + LOCKOUT_WINDOW_MS) },
    lockedNow: false,
  };
}

export type SessionState = 'valid' | 'idle' | 'expired';

/** A sessão vale até 30 min depois do último uso e nunca além de 12 h depois do login. */
export function sessionState(session: AdminSession, now: Date): SessionState {
  const at = now.getTime();
  if (at >= session.expiresAt.getTime() || at - session.createdAt.getTime() >= SESSION_ABSOLUTE_MS)
    return 'expired';
  if (at - session.lastSeenAt.getTime() >= SESSION_IDLE_MS) return 'idle';
  return 'valid';
}

export function needsTouch(session: AdminSession, now: Date): boolean {
  return now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_MS;
}

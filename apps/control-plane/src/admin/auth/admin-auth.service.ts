import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../../audit/audit.service.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../../common/config/config.module.js';
import { ApiError } from '../../common/http/api-error.js';
import { COLLECTIONS } from '../../firestore/collections.js';
import {
  DOCUMENT_STORE,
  DocumentAlreadyExistsError,
  type DocumentStore,
  type DocumentTransaction,
  parseDocument,
} from '../../firestore/document-store.js';
import { AdminKeys, newRecoveryCode, normalizeRecoveryCode, RECOVERY_CODE_COUNT } from './admin-crypto.js';
import {
  accountRef,
  ADMIN_SETUP_MARKER,
  type AdminAccount,
  adminAccountSchema,
  type AdminEnrollment,
  adminEnrollmentSchema,
  type AdminSession,
  adminSessionSchema,
  afterFailure,
  compactCode,
  credentialStamp,
  type EnrollmentConfirmRequest,
  ENROLLMENT_TTL_MS,
  isLocked,
  type LoginRequest,
  loginThrottleSchema,
  needsTouch,
  newOpaqueId,
  normalizeEmail,
  opaqueIdSchema,
  opaqueRef,
  type PasswordChangeRequest,
  SESSION_ABSOLUTE_MS,
  sessionState,
  type SetupStartRequest,
  throttleRef,
  type TotpResetStartRequest,
} from './admin-auth.schema.js';
import { ADMIN_SECRETS, type AdminSecretSource, SecretUnavailableError } from './admin-secrets.js';
import { burnPasswordCheck, dummyPasswordHash, hashPassword, verifyPassword } from './password-hash.js';
import { newTotpSecret, totpUri, verifyTotp } from './totp.js';

/** Contexto de uma requisição para a auditoria. */
export interface AuthRequestContext {
  requestId?: string;
}

/** O que a guarda prende à requisição: o responsável e a referência da sessão (o SHA-256, nunca o id). */
export interface AuthenticatedSession {
  email: string;
  sessionRef: string;
}

export type SessionCheck =
  | ({ ok: true } & AuthenticatedSession)
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'not_owner' };

/** O cadastro do TOTP mostrado uma vez (o QR é desenhado no navegador a partir do `otpauthUri`). */
export interface TotpEnrollmentView {
  enrollmentId: string;
  otpauthUri: string;
  secret: string;
  expiresAt: string;
}

export interface SessionGrant {
  email: string;
  /** O id da sessão, para o cookie `__session`; nunca volta no corpo da resposta. */
  sessionId: string;
}

/** A mensagem única de toda falha de login: e-mail desconhecido, senha errada, código errado ou conta bloqueada. */
export const LOGIN_FAILED_MESSAGE =
  'E-mail, senha ou código incorretos. Depois de 5 tentativas erradas, o acesso fica bloqueado por 15 minutos.';
const INVALID_CREDENTIALS_MESSAGE =
  'Senha atual ou código incorretos. Depois de 5 tentativas erradas, o acesso fica bloqueado por 15 minutos.';

type SecondFactor = { code: string } | { recoveryCode: string };

/** O segundo fator conferido fora da transação, a aplicar (e reconferir) dentro dela. */
type FactorUse = { kind: 'totp'; step: number } | { kind: 'recovery'; digest: string };

type FailureReason =
  | 'unknown_account'
  | 'not_owner'
  | 'bad_password'
  | 'bad_code'
  | 'replayed_code'
  | 'bad_recovery_code'
  | 'totp_key_mismatch'
  | 'stale_credentials'
  | 'locked';

/** O segundo fator já foi usado entre a conferência e o commit (outra requisição com o mesmo código). */
class FactorReplayedError extends Error {}

/** A senha ou o aplicativo mudaram entre a conferência e o commit (outra sessão trocou ao mesmo tempo). */
class StaleCredentialsError extends Error {}

function factorOf(request: { code?: string | undefined; recoveryCode?: string | undefined }): SecondFactor {
  return request.recoveryCode === undefined
    ? { code: compactCode(request.code ?? '') }
    : { recoveryCode: request.recoveryCode };
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function sameSecret(given: string, expected: string): boolean {
  // SHA-256 dos dois lados: comprimentos iguais, comparação em tempo constante, nada do segredo vaza pelo tamanho.
  return timingSafeEqual(digest(given), digest(expected));
}

/**
 * O login próprio do console do responsável (cp-admin), no lugar do IAP: e-mail, senha (scrypt) e TOTP, com bloqueio
 * por conta, sessões no Firestore e o primeiro cadastro por um token de uso único do Secret Manager.
 *
 * - **Login** (`login`): uma requisição só, com e-mail, senha e o código do aplicativo (ou um código de recuperação).
 *   Não existe estado "só com a senha". Toda falha tem a mesma resposta (401 `login_failed`, a mesma mensagem) e o
 *   mesmo trabalho (um scrypt sempre, conta existente ou não). Só a senha certa com o segundo fator errado conta no
 *   bloqueio da conta (5 em 15 min bloqueiam por 15 min), e a tentativa é reservada antes de conferir o código, numa
 *   transação: nem em paralelo passam mais de 5 palpites por ciclo. Senha errada não bloqueia a conta (quem só sabe o
 *   e-mail, que é público, não tranca o responsável do lado de fora): ela conta nos limites por IP e global, que só
 *   contam falhas (`admin-auth.controller.ts`). O sucesso só é gravado se as credenciais conferidas ainda são as da
 *   conta (`credentialStamp`). Sucesso: sessão nova (id novo a cada login).
 * - **Sessão** (`authenticate`): 30 min sem uso ou 12 h, o que vier primeiro; o e-mail precisa continuar em
 *   `OWNER_PRINCIPALS`. `logout` apaga a sessão no servidor.
 * - **Primeiro cadastro** (`setupStart`/`setupConfirm`): o token do cofre `cp-admin-setup-token`, um e-mail de
 *   `OWNER_PRINCIPALS` e a senha (12 ou mais); depois o QR e o primeiro código. A confirmação cria o marcador
 *   `adminSetup/owner` na mesma transação da conta: um segundo cadastro nunca passa, nem em corrida.
 * - **Troca de senha e do aplicativo**: só com sessão, a senha atual e o código atual (ou de recuperação, na troca do
 *   aplicativo, para quem perdeu o celular); toda falha (inclusive a senha errada: quem tenta já tem uma sessão) conta
 *   no mesmo bloqueio do login, e as outras sessões caem.
 *
 * Logs (pino, com a limpeza de sempre): `admin_auth_failed` com o motivo, `admin_account_locked`, `admin_login`,
 * `admin_logout`, `admin_setup_completed`, `admin_password_changed`, `admin_totp_reset`, `admin_recovery_code_used`.
 * Nunca a senha, o código, o token, o segredo, o id da sessão nem o e-mail: só os 12 primeiros dígitos do
 * `throttleRef` (`account`), que bastam para achar o contador no Firestore. A auditoria do Firestore registra as
 * ações bem-sucedidas com `owner:<e-mail>`.
 */
@Injectable()
export class AdminAuthService implements OnModuleInit {
  private readonly owners: ReadonlySet<string>;
  private keysCache: AdminKeys | undefined;

  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(ADMIN_SECRETS) private readonly secrets: AdminSecretSource,
    private readonly audit: AuditService,
    @InjectPinoLogger(AdminAuthService.name) private readonly logger: PinoLogger,
  ) {
    this.owners = new Set((config.OWNER_PRINCIPALS ?? []).map(normalizeEmail));
  }

  onModuleInit(): void {
    // O hash fictício do e-mail desconhecido sai já na partida (um scrypt, em segundo plano).
    void dummyPasswordHash();
  }

  isOwner(email: string): boolean {
    return this.owners.has(normalizeEmail(email));
  }

  // Login e sessão.

  async login(request: LoginRequest, context: AuthRequestContext): Promise<SessionGrant> {
    const email = normalizeEmail(request.email);
    const factor = factorOf(request);
    // Sem a chave do cofre ninguém entra; a recusa é igual para todo e-mail (nada se aprende com ela).
    const keys = await this.keys();
    const now = this.clock.now();
    const account = await this.readAccount(email);
    const owner = account !== undefined && this.isOwner(email);
    // Sempre um scrypt, com conta ou sem: o tempo não diz se o e-mail existe.
    const passwordOk = owner
      ? await verifyPassword(request.password, account.passwordHash)
      : await burnPasswordCheck(request.password);
    if (!owner || !passwordOk) {
      // Uma leitura do contador, como no caminho da senha certa (que o reserva), para o tempo não separar os dois.
      await this.peekThrottle(email);
      throw this.loginFailure(
        email,
        account === undefined ? 'unknown_account' : owner ? 'bad_password' : 'not_owner',
      );
    }

    const reservation = await this.reserveAttempt(email, now);
    if (!reservation.ok) throw this.loginFailure(email, 'locked');
    const checked = await this.checkSecondFactor(keys, email, account, factor, now);
    if (!checked.ok) throw this.loginFailure(email, checked.reason, reservation.lockedNow);
    const use = checked.use;
    const stamp = credentialStamp(account);
    let sessionId: string;
    try {
      sessionId = await this.store.runTransaction(async (tx) => {
        const current = await this.readAccountIn(tx, email);
        if (current === undefined || credentialStamp(current) !== stamp) throw new StaleCredentialsError();
        const updated = this.applyFactor(current, use, now);
        tx.set(COLLECTIONS.adminAccounts, accountRef(email), { ...updated, updatedAt: now });
        tx.delete(COLLECTIONS.adminLoginThrottle, throttleRef(email));
        const id = this.createSession(tx, email, now);
        this.audit.record(tx, {
          actor: `owner:${email}`,
          action: 'admin.login',
          details: { secondFactor: use.kind },
          requestId: context.requestId,
        });
        return id;
      });
    } catch (error) {
      const reason = this.raceReason(error, use);
      if (reason === undefined) throw error;
      throw this.loginFailure(email, reason, reservation.lockedNow);
    }
    this.logger.info(
      { event: 'admin_login', account: this.logRef(email), secondFactor: use.kind },
      'login no console',
    );
    if (use.kind === 'recovery') this.logRecoveryUse(email, account, use);
    return { email, sessionId };
  }

  /**
   * Confere o cookie `__session` (os valores do cabeçalho, normalmente um). Sessão vencida (inatividade ou prazo
   * absoluto) é apagada; uma sessão válida tem o "visto por último" regravado no máximo uma vez por minuto, na mesma
   * transação que confere que a conta ainda existe (uma conta apagada derruba as sessões dela em até 1 min).
   */
  async authenticate(cookieValues: readonly string[]): Promise<SessionCheck> {
    const values = cookieValues.filter((value) => opaqueIdSchema.safeParse(value).success);
    if (values.length === 0) return { ok: false, reason: cookieValues.length === 0 ? 'missing' : 'invalid' };
    const now = this.clock.now();
    let sawExpired = false;
    for (const value of values) {
      const ref = opaqueRef(value);
      const data = await this.store.get(COLLECTIONS.adminSessions, ref);
      if (data === undefined) continue;
      const session = parseDocument(adminSessionSchema, COLLECTIONS.adminSessions, ref, data);
      if (sessionState(session, now) !== 'valid') {
        sawExpired = true;
        await this.deleteSession(ref);
        continue;
      }
      if (!this.isOwner(session.email)) return { ok: false, reason: 'not_owner' };
      if (needsTouch(session, now)) {
        const alive = await this.touch(ref, session.email, now);
        if (!alive) continue;
      }
      return { ok: true, email: session.email, sessionRef: ref };
    }
    return { ok: false, reason: sawExpired ? 'expired' : 'invalid' };
  }

  /** Apaga a sessão do cookie (se houver). Sem cookie válido, nada a fazer: a resposta é a mesma. */
  async logout(cookieValues: readonly string[], context: AuthRequestContext): Promise<void> {
    for (const value of cookieValues) {
      if (!opaqueIdSchema.safeParse(value).success) continue;
      const ref = opaqueRef(value);
      const email = await this.store.runTransaction(async (tx) => {
        const data = await tx.get(COLLECTIONS.adminSessions, ref);
        if (data === undefined) return undefined;
        const session = parseDocument(adminSessionSchema, COLLECTIONS.adminSessions, ref, data);
        tx.delete(COLLECTIONS.adminSessions, ref);
        this.audit.record(tx, {
          actor: `owner:${session.email}`,
          action: 'admin.logout',
          requestId: context.requestId,
        });
        return session.email;
      });
      if (email !== undefined) {
        this.logger.info({ event: 'admin_logout', account: this.logRef(email) }, 'saída do console');
      }
    }
  }

  // Primeiro cadastro.

  async setupOpen(): Promise<boolean> {
    return (await this.store.get(COLLECTIONS.adminSetup, ADMIN_SETUP_MARKER)) === undefined;
  }

  async setupStart(request: SetupStartRequest): Promise<TotpEnrollmentView> {
    if (!(await this.setupOpen())) throw setupClosed();
    let expected: string | undefined;
    try {
      expected = await this.secrets.setupToken();
    } catch (error) {
      if (error instanceof SecretUnavailableError) throw unavailable();
      throw error;
    }
    if (expected === undefined || expected.length < 32) {
      this.logger.warn({ event: 'admin_setup_unavailable' }, 'cadastro do console sem o token no cofre');
      throw unavailable();
    }
    const keys = await this.keys();
    const email = normalizeEmail(request.email);
    const tokenOk = sameSecret(request.setupToken, expected);
    if (!tokenOk || !this.isOwner(email)) {
      this.logger.warn(
        { event: 'admin_auth_failed', reason: tokenOk ? 'setup_not_owner' : 'setup_token' },
        'cadastro do console recusado',
      );
      throw new ApiError(HttpStatus.FORBIDDEN, 'Token de cadastro ou e-mail não aceitos.', 'setup_refused');
    }
    const passwordHash = await hashPassword(request.password);
    const view = await this.startEnrollment(keys, { kind: 'setup', email, passwordHash });
    this.logger.info(
      { event: 'admin_setup_started', account: this.logRef(email) },
      'cadastro do console iniciado',
    );
    return view;
  }

  async setupConfirm(
    request: EnrollmentConfirmRequest,
    context: AuthRequestContext,
  ): Promise<SessionGrant & { recoveryCodes: string[] }> {
    const keys = await this.keys();
    const now = this.clock.now();
    const { ref, enrollment, seed } = await this.readEnrollment(keys, request.enrollmentId, now);
    if (enrollment.kind !== 'setup' || enrollment.passwordHash === undefined) throw enrollmentExpired();
    if (!this.isOwner(enrollment.email)) throw enrollmentExpired();
    const step = await verifyTotp(seed, compactCode(request.code), now);
    if (step === undefined) {
      this.logger.warn({ event: 'admin_auth_failed', reason: 'setup_code' }, 'código do cadastro recusado');
      throw invalidCode();
    }
    const email = enrollment.email;
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    const passwordHash = enrollment.passwordHash;
    const sessionId = await this.createOwnerAccount(async (tx) => {
      const marker = await tx.get(COLLECTIONS.adminSetup, ADMIN_SETUP_MARKER);
      const pending = await tx.get(COLLECTIONS.adminEnrollments, ref);
      if (marker !== undefined) throw setupClosed();
      if (pending === undefined) throw enrollmentExpired();
      const account: AdminAccount = {
        email,
        passwordHash,
        totp: keys.sealTotpSecret(seed, accountBinding(email)),
        lastTotpStep: step,
        recoveryCodes: recoveryCodes.map((code) => ({
          digest: keys.recoveryCodeDigest(normalizeRecoveryCode(code) ?? ''),
        })),
        createdAt: now,
        updatedAt: now,
        passwordChangedAt: now,
        totpChangedAt: now,
      };
      // `create` nos dois: se outra confirmação chegou antes, o commit falha e nada é gravado.
      tx.create(COLLECTIONS.adminSetup, ADMIN_SETUP_MARKER, {
        completedAt: now,
        accountRef: accountRef(email),
      });
      tx.create(COLLECTIONS.adminAccounts, accountRef(email), adminAccountSchema.parse(account));
      tx.delete(COLLECTIONS.adminEnrollments, ref);
      const id = this.createSession(tx, email, now);
      this.audit.record(tx, { actor: `owner:${email}`, action: 'admin.setup', requestId: context.requestId });
      return id;
    });
    this.logger.info(
      { event: 'admin_setup_completed', account: this.logRef(email) },
      'primeiro cadastro do console concluído',
    );
    return { email, sessionId, recoveryCodes };
  }

  // Conta (com sessão).

  async changePassword(
    session: AuthenticatedSession,
    request: PasswordChangeRequest,
    context: AuthRequestContext,
  ): Promise<void> {
    const keys = await this.keys();
    const now = this.clock.now();
    const { account, use } = await this.reauthenticate(keys, session.email, request.currentPassword, {
      code: compactCode(request.code),
    });
    const passwordHash = await hashPassword(request.newPassword);
    await this.commitAccountChange(
      session,
      account,
      use,
      now,
      (current) => ({ ...current, passwordHash, passwordChangedAt: now }),
      { action: 'admin.password_change', requestId: context.requestId },
    );
    this.logger.info(
      { event: 'admin_password_changed', account: this.logRef(session.email) },
      'senha do console trocada',
    );
  }

  async totpResetStart(
    session: AuthenticatedSession,
    request: TotpResetStartRequest,
    context: AuthRequestContext,
  ): Promise<TotpEnrollmentView> {
    const keys = await this.keys();
    const now = this.clock.now();
    const { account, use } = await this.reauthenticate(
      keys,
      session.email,
      request.currentPassword,
      factorOf(request),
    );
    // O fator usado aqui (código ou código de recuperação) é gasto já, como num login; as outras sessões só caem na
    // confirmação, com o aplicativo novo.
    await this.commitAccountChange(
      session,
      account,
      use,
      now,
      (current) => current,
      { action: 'admin.totp_reset_started', requestId: context.requestId },
      false,
    );
    // O fator gasto não muda as credenciais: a troca só se completa se elas continuarem estas.
    return this.startEnrollment(keys, {
      kind: 'totp_reset',
      email: session.email,
      sessionRef: session.sessionRef,
      credentialStamp: credentialStamp(account),
    });
  }

  async totpResetConfirm(
    session: AuthenticatedSession,
    request: EnrollmentConfirmRequest,
    context: AuthRequestContext,
  ): Promise<{ recoveryCodes: string[] }> {
    const keys = await this.keys();
    const now = this.clock.now();
    const { ref, enrollment, seed } = await this.readEnrollment(keys, request.enrollmentId, now);
    if (
      enrollment.kind !== 'totp_reset' ||
      enrollment.email !== session.email ||
      enrollment.sessionRef !== session.sessionRef
    ) {
      throw enrollmentExpired();
    }
    const step = await verifyTotp(seed, compactCode(request.code), now);
    if (step === undefined) throw invalidCode();
    const recoveryCodes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
    await this.store.runTransaction(async (tx) => {
      const current = await this.readAccountIn(tx, session.email);
      const pending = await tx.get(COLLECTIONS.adminEnrollments, ref);
      const others = await this.otherSessions(tx, session);
      if (current === undefined || pending === undefined) throw enrollmentExpired();
      // Senha ou aplicativo trocados depois do começo (outra sessão, ao mesmo tempo): o cadastro não vale mais.
      if (credentialStamp(current) !== enrollment.credentialStamp) throw enrollmentExpired();
      tx.set(COLLECTIONS.adminAccounts, accountRef(session.email), {
        ...current,
        totp: keys.sealTotpSecret(seed, accountBinding(session.email)),
        lastTotpStep: step,
        recoveryCodes: recoveryCodes.map((code) => ({
          digest: keys.recoveryCodeDigest(normalizeRecoveryCode(code) ?? ''),
        })),
        totpChangedAt: now,
        updatedAt: now,
      });
      tx.delete(COLLECTIONS.adminEnrollments, ref);
      for (const other of others) tx.delete(COLLECTIONS.adminSessions, other);
      this.audit.record(tx, {
        actor: `owner:${session.email}`,
        action: 'admin.totp_reset',
        details: { sessionsRevoked: others.length },
        requestId: context.requestId,
      });
    });
    this.logger.info(
      { event: 'admin_totp_reset', account: this.logRef(session.email) },
      'aplicativo autenticador do console trocado',
    );
    return { recoveryCodes };
  }

  // Internos.

  /** A transação do primeiro cadastro; o `create` do marcador recusado no commit (outro cadastro antes) é 409. */
  private async createOwnerAccount(fn: (tx: DocumentTransaction) => Promise<string>): Promise<string> {
    try {
      return await this.store.runTransaction(fn);
    } catch (error) {
      if (error instanceof DocumentAlreadyExistsError) throw setupClosed();
      throw error;
    }
  }

  /** A chave mestra do cofre, lida uma vez. Sem ela (cofre vazio ou fora do formato), 503. */
  private async keys(): Promise<AdminKeys> {
    if (this.keysCache !== undefined) return this.keysCache;
    let value: string | undefined;
    try {
      value = await this.secrets.totpKey();
    } catch (error) {
      if (error instanceof SecretUnavailableError) throw unavailable();
      throw error;
    }
    const keys = value === undefined ? undefined : AdminKeys.fromSecret(value);
    if (keys === undefined) {
      this.logger.error(
        { event: 'admin_totp_key_missing', present: value !== undefined },
        'chave do login do console ausente ou fora do formato (cp-admin-totp-key)',
      );
      throw unavailable();
    }
    this.keysCache = keys;
    return keys;
  }

  private async readAccount(email: string): Promise<AdminAccount | undefined> {
    const ref = accountRef(email);
    const data = await this.store.get(COLLECTIONS.adminAccounts, ref);
    return data === undefined
      ? undefined
      : parseDocument(adminAccountSchema, COLLECTIONS.adminAccounts, ref, data);
  }

  private async readAccountIn(tx: DocumentTransaction, email: string): Promise<AdminAccount | undefined> {
    const ref = accountRef(email);
    const data = await tx.get(COLLECTIONS.adminAccounts, ref);
    return data === undefined
      ? undefined
      : parseDocument(adminAccountSchema, COLLECTIONS.adminAccounts, ref, data);
  }

  /** O código do aplicativo (passo posterior ao último aceito) ou um código de recuperação ainda não usado. */
  private async checkSecondFactor(
    keys: AdminKeys,
    email: string,
    account: AdminAccount,
    factor: SecondFactor,
    now: Date,
  ): Promise<{ ok: true; use: FactorUse } | { ok: false; reason: FailureReason }> {
    if ('recoveryCode' in factor) {
      const normalized = normalizeRecoveryCode(factor.recoveryCode);
      const entry =
        normalized === undefined
          ? undefined
          : account.recoveryCodes.find(
              (candidate) =>
                candidate.usedAt === undefined && keys.matchesRecoveryCode(normalized, candidate.digest),
            );
      return entry === undefined
        ? { ok: false, reason: 'bad_recovery_code' }
        : { ok: true, use: { kind: 'recovery', digest: entry.digest } };
    }
    const seed = keys.openTotpSecret(account.totp, accountBinding(email));
    if (seed === undefined) return { ok: false, reason: 'totp_key_mismatch' };
    const step = await verifyTotp(seed, factor.code, now, account.lastTotpStep);
    if (step !== undefined) return { ok: true, use: { kind: 'totp', step } };
    // O mesmo código, já usado (passo igual ou anterior ao último aceito): o motivo no log é outro.
    const replayed = await verifyTotp(seed, factor.code, now);
    return { ok: false, reason: replayed === undefined ? 'bad_code' : 'replayed_code' };
  }

  /** Grava o uso do fator na conta (reconferido na transação: um código não vale duas vezes, nem em corrida). */
  private applyFactor(account: AdminAccount, use: FactorUse, now: Date): AdminAccount {
    if (use.kind === 'totp') {
      if (use.step <= account.lastTotpStep) throw new FactorReplayedError();
      return { ...account, lastTotpStep: use.step };
    }
    const index = account.recoveryCodes.findIndex(
      (entry) => entry.digest === use.digest && entry.usedAt === undefined,
    );
    if (index < 0) throw new FactorReplayedError();
    const recoveryCodes = account.recoveryCodes.map((entry, position) =>
      position === index ? { ...entry, usedAt: now } : entry,
    );
    return { ...account, recoveryCodes };
  }

  /**
   * Senha atual e segundo fator de quem já tem sessão. A tentativa é reservada no contador antes de conferir, e toda
   * falha conta (inclusive a senha errada: quem tenta aqui já tem uma sessão); a falha é 400 (não derruba a sessão).
   */
  private async reauthenticate(
    keys: AdminKeys,
    email: string,
    password: string,
    factor: SecondFactor,
  ): Promise<{ account: AdminAccount; use: FactorUse }> {
    const now = this.clock.now();
    const reservation = await this.reserveAttempt(email, now);
    const account = await this.readAccount(email);
    const passwordOk =
      account === undefined
        ? await burnPasswordCheck(password)
        : await verifyPassword(password, account.passwordHash);
    const lockedNow = reservation.ok && reservation.lockedNow;
    let reason: FailureReason;
    if (!reservation.ok) reason = 'locked';
    else if (account === undefined) reason = 'unknown_account';
    else if (!passwordOk) reason = 'bad_password';
    else {
      const checked = await this.checkSecondFactor(keys, email, account, factor, now);
      if (checked.ok) return { account, use: checked.use };
      reason = checked.reason;
    }
    throw this.reauthFailure(email, reason, lockedNow);
  }

  /**
   * Aplica o fator gasto e a mudança na conta; zera o contador de falhas e, com `revokeOthers`, apaga as outras sessões
   * do responsável (a atual continua).
   */
  private async commitAccountChange(
    session: AuthenticatedSession,
    account: AdminAccount,
    use: FactorUse,
    now: Date,
    change: (current: AdminAccount) => AdminAccount,
    audit: { action: string; requestId?: string | undefined },
    revokeOthers = true,
  ): Promise<void> {
    try {
      await this.store.runTransaction(async (tx) => {
        const current = await this.readAccountIn(tx, session.email);
        const others = revokeOthers ? await this.otherSessions(tx, session) : [];
        if (current === undefined || credentialStamp(current) !== credentialStamp(account)) {
          throw new StaleCredentialsError();
        }
        const updated = change(this.applyFactor(current, use, now));
        tx.set(COLLECTIONS.adminAccounts, accountRef(session.email), { ...updated, updatedAt: now });
        tx.delete(COLLECTIONS.adminLoginThrottle, throttleRef(session.email));
        for (const other of others) tx.delete(COLLECTIONS.adminSessions, other);
        this.audit.record(tx, {
          actor: `owner:${session.email}`,
          action: audit.action,
          details: { secondFactor: use.kind, sessionsRevoked: others.length },
          requestId: audit.requestId,
        });
      });
    } catch (error) {
      const reason = this.raceReason(error, use);
      if (reason === undefined) throw error;
      throw this.reauthFailure(session.email, reason, false);
    }
    if (use.kind === 'recovery') this.logRecoveryUse(session.email, account, use);
  }

  private async otherSessions(tx: DocumentTransaction, session: AuthenticatedSession): Promise<string[]> {
    const docs = await tx.query(COLLECTIONS.adminSessions, {
      where: [{ field: 'email', op: '==', value: session.email }],
    });
    return docs.map((doc) => doc.id).filter((id) => id !== session.sessionRef);
  }

  /**
   * Reserva uma tentativa no contador do e-mail, numa transação: bloqueado, nada feito (`ok: false`); senão conta já
   * como falha (e bloqueia na quinta). O sucesso apaga o contador. Assim o bloqueio não depende de gravar a falha
   * depois de conferir: tentativas em paralelo não passam do limite.
   */
  private async reserveAttempt(
    email: string,
    now: Date,
  ): Promise<{ ok: false } | { ok: true; lockedNow: boolean }> {
    const ref = throttleRef(email);
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.adminLoginThrottle, ref);
      const previous =
        data === undefined
          ? undefined
          : parseDocument(loginThrottleSchema, COLLECTIONS.adminLoginThrottle, ref, data);
      if (isLocked(previous, now)) return { ok: false as const };
      const result = afterFailure(previous, now);
      tx.set(COLLECTIONS.adminLoginThrottle, ref, result.next);
      return { ok: true as const, lockedNow: result.lockedNow };
    });
  }

  /** Só lê o contador (o caminho da senha errada, que não conta no bloqueio da conta). */
  private async peekThrottle(email: string): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      await tx.get(COLLECTIONS.adminLoginThrottle, throttleRef(email));
    });
  }

  /** O motivo de uma corrida na transação do sucesso (código reusado, credenciais trocadas), ou `undefined`. */
  private raceReason(error: unknown, use: FactorUse): FailureReason | undefined {
    if (error instanceof StaleCredentialsError) return 'stale_credentials';
    if (error instanceof FactorReplayedError)
      return use.kind === 'totp' ? 'replayed_code' : 'bad_recovery_code';
    return undefined;
  }

  private logFailure(email: string, reason: FailureReason, lockedNow: boolean): void {
    const account = this.logRef(email);
    this.logger.warn({ event: 'admin_auth_failed', reason, account }, 'login no console recusado');
    if (lockedNow) {
      this.logger.warn(
        { event: 'admin_account_locked', reason, account },
        'acesso ao console bloqueado por 15 minutos depois de 5 falhas',
      );
    }
  }

  private loginFailure(email: string, reason: FailureReason, lockedNow = false): ApiError {
    this.logFailure(email, reason, lockedNow);
    return new ApiError(HttpStatus.UNAUTHORIZED, LOGIN_FAILED_MESSAGE, 'login_failed');
  }

  private reauthFailure(email: string, reason: FailureReason, lockedNow: boolean): ApiError {
    this.logFailure(email, reason, lockedNow);
    return new ApiError(HttpStatus.BAD_REQUEST, INVALID_CREDENTIALS_MESSAGE, 'invalid_credentials');
  }

  private createSession(tx: DocumentTransaction, email: string, now: Date): string {
    const id = newOpaqueId();
    const session: AdminSession = {
      email,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
    };
    tx.create(COLLECTIONS.adminSessions, opaqueRef(id), session);
    return id;
  }

  private async touch(ref: string, email: string, now: Date): Promise<boolean> {
    return this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.adminSessions, ref);
      const account = await tx.get(COLLECTIONS.adminAccounts, accountRef(email));
      if (data === undefined) return false;
      if (account === undefined) {
        tx.delete(COLLECTIONS.adminSessions, ref);
        return false;
      }
      const session = parseDocument(adminSessionSchema, COLLECTIONS.adminSessions, ref, data);
      tx.set(COLLECTIONS.adminSessions, ref, { ...session, lastSeenAt: now });
      return true;
    });
  }

  private async deleteSession(ref: string): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      const data = await tx.get(COLLECTIONS.adminSessions, ref);
      if (data !== undefined) tx.delete(COLLECTIONS.adminSessions, ref);
    });
  }

  private async startEnrollment(
    keys: AdminKeys,
    fields: Pick<AdminEnrollment, 'kind' | 'email' | 'passwordHash' | 'sessionRef' | 'credentialStamp'>,
  ): Promise<TotpEnrollmentView> {
    const now = this.clock.now();
    const id = newOpaqueId();
    const ref = opaqueRef(id);
    const secret = newTotpSecret();
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);
    const enrollment = adminEnrollmentSchema.parse({
      ...fields,
      totp: keys.sealTotpSecret(secret, enrollmentBinding(ref)),
      createdAt: now,
      expiresAt,
    });
    await this.store.runTransaction((tx) => {
      tx.create(COLLECTIONS.adminEnrollments, ref, enrollment);
      return Promise.resolve();
    });
    return {
      enrollmentId: id,
      otpauthUri: totpUri(secret, fields.email),
      secret,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async readEnrollment(
    keys: AdminKeys,
    enrollmentId: string,
    now: Date,
  ): Promise<{ ref: string; enrollment: AdminEnrollment; seed: string }> {
    if (!opaqueIdSchema.safeParse(enrollmentId).success) throw enrollmentExpired();
    const ref = opaqueRef(enrollmentId);
    const data = await this.store.get(COLLECTIONS.adminEnrollments, ref);
    if (data === undefined) throw enrollmentExpired();
    const enrollment = parseDocument(adminEnrollmentSchema, COLLECTIONS.adminEnrollments, ref, data);
    if (enrollment.expiresAt.getTime() <= now.getTime()) throw enrollmentExpired();
    const seed = keys.openTotpSecret(enrollment.totp, enrollmentBinding(ref));
    if (seed === undefined) throw enrollmentExpired();
    return { ref, enrollment, seed };
  }

  private logRecoveryUse(email: string, account: AdminAccount, use: FactorUse & { kind: 'recovery' }): void {
    const left = account.recoveryCodes.filter(
      (entry) => entry.usedAt === undefined && entry.digest !== use.digest,
    ).length;
    this.logger.warn(
      { event: 'admin_recovery_code_used', account: this.logRef(email), left },
      'código de recuperação do console usado',
    );
  }

  /** Os 12 primeiros dígitos do `throttleRef`: identificam o contador sem pôr o e-mail no log. */
  private logRef(email: string): string {
    return throttleRef(email).slice(0, 12);
  }
}

function accountBinding(email: string): string {
  return `${COLLECTIONS.adminAccounts}/${accountRef(email)}`;
}

function enrollmentBinding(ref: string): string {
  return `${COLLECTIONS.adminEnrollments}/${ref}`;
}

function unavailable(): ApiError {
  return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Console indisponível', 'admin_unavailable');
}

function setupClosed(): ApiError {
  return new ApiError(HttpStatus.CONFLICT, 'O console já foi configurado.', 'setup_closed');
}

function enrollmentExpired(): ApiError {
  return new ApiError(HttpStatus.GONE, 'O cadastro expirou. Comece de novo.', 'enrollment_expired');
}

function invalidCode(): ApiError {
  return new ApiError(HttpStatus.BAD_REQUEST, 'Código incorreto.', 'invalid_code');
}

import { PRODUCT_NAME } from '@verax/shared';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, isAPIError } from 'better-auth/api';
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../common/config/config.module.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { MailTransport } from '../mail/mail.types.js';
import { AUTH_AUDIT_ACTIONS, type AuthAuditSink, requestMetadata } from './auth-audit.js';
import {
  AUTH_BASE_PATH,
  AUTH_RATE_LIMIT_RULES,
  BACKUP_CODES_AMOUNT,
  CLIENT_IP_HEADER,
  MFA_CHALLENGE_SECONDS,
  MFA_LOCKOUT_SECONDS,
  MFA_MAX_FAILED_ATTEMPTS,
  PASSWORD_LINK_TTL_SECONDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SESSION_IDLE_TIMEOUT_SECONDS,
  SESSION_REFRESH_AFTER_SECONDS,
} from './auth.constants.js';
import { claimTotpCode, clearLoginAttempts, normalizeEmail, reserveLoginAttempt } from './login-attempts.js';
import { passwordLinkMail } from './password-links.js';

export interface AuthDependencies {
  config: AppConfig;
  prisma: PrismaService;
  logger: Pick<PinoLogger, 'warn' | 'error'>;
  /** Onde gravar os eventos de autenticação (a trilha de auditoria, na aplicação). */
  audit: AuthAuditSink;
  /** Envio do e-mail de redefinição de senha (T2.6). */
  mail: MailTransport;
}

const SIGN_IN_PATH = '/sign-in/email';
const VERIFY_TOTP_PATH = '/two-factor/verify-totp';
const VERIFY_BACKUP_CODE_PATH = '/two-factor/verify-backup-code';
const ACCOUNT_LOCKED_MESSAGE = 'Muitas tentativas. Tente novamente em alguns minutos.';
/** Mesmo erro do Better Auth para senha errada (o teste de login compara as duas respostas). */
const INVALID_CREDENTIALS = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' };
const INVALID_CODE = { code: 'INVALID_CODE', message: 'Invalid code' };

/**
 * Configuração do Better Auth (regra 10: hash de senha, sessão, tokens e TOTP são da biblioteca).
 * Cada opção abaixo tem um motivo de segurança; mudar qualquer uma pede revisão.
 */
export function createAuth({ config, prisma, logger, audit, mail }: AuthDependencies) {
  /** A auditoria nunca derruba o login; uma falha ao gravar vai para o log. */
  const record: AuthAuditSink = async (entry) => {
    try {
      await audit(entry);
    } catch {
      logger.error({ audit: { action: entry.action, outcome: entry.outcome } }, 'falha ao gravar auditoria');
    }
  };

  return betterAuth({
    appName: PRODUCT_NAME,
    baseURL: config.API_ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    // Só o painel pode chamar a autenticação com cookies (checagem de origem contra CSRF).
    trustedOrigins: [config.WEB_ORIGIN],
    database: prismaAdapter(prisma, { provider: 'postgresql', transaction: true }),

    emailAndPassword: {
      enabled: true,
      // Ninguém se cadastra sozinho: a conta é criada pelo administrador, com senha temporária.
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: PASSWORD_LINK_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // Redefinição pelo e-mail (T2.6), onde o nó envia e-mail. Usuário que não está ativo não recebe nada, e a
      // resposta da API é a mesma.
      sendResetPassword: async ({ user, token }) => {
        const message = passwordLinkMail(config.WEB_ORIGIN, user, token);
        if (message) await mail.send(message);
      },
      // A senha definida pela própria pessoa encerra a senha temporária.
      onPasswordReset: async ({ user }) => {
        await prisma.user.update({
          where: { id: user.id },
          data: { mustChangePassword: false, temporaryPasswordExpiresAt: null },
        });
      },
    },

    session: {
      expiresIn: SESSION_IDLE_TIMEOUT_SECONDS,
      updateAge: SESSION_REFRESH_AFTER_SECONDS,
      // Sem cache em cookie: toda requisição consulta o banco, então revogar uma sessão vale na hora.
      cookieCache: { enabled: false },
      additionalFields: {
        // Cliente selecionado por admin_verax (T2.5); só a API altera, nunca o cliente HTTP.
        activeTenantId: { type: 'string', required: false, input: false },
      },
    },

    user: {
      additionalFields: {
        // `input: false`: nenhum endpoint de autenticação aceita estes campos vindos do cliente.
        role: { type: 'string', required: true, input: false },
        tenantId: { type: 'string', required: false, input: false },
        status: { type: 'string', required: true, input: false, defaultValue: 'invited' },
        mustChangePassword: { type: 'boolean', required: false, input: false, defaultValue: false },
        temporaryPasswordExpiresAt: { type: 'date', required: false, input: false },
      },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    // Tokens de redefinição ficam só com hash no banco.
    verification: { storeIdentifier: 'hashed' },

    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // Só usuário ativo, de cliente ativo, recebe sessão (convidado sem senha definida ou desativado não).
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { status: true, tenant: { select: { status: true } } },
            });
            const allowed = user?.status === 'active' && (!user.tenant || user.tenant.status === 'active');
            if (!allowed) {
              // No login, a mesma resposta da senha errada: não revela que a conta existe nem que a senha bateu.
              if (ctx?.path === SIGN_IN_PATH) throw new APIError('UNAUTHORIZED', INVALID_CREDENTIALS);
              return false;
            }
            // Código TOTP vale uma vez (NIST SP 800-63B): um segundo login com o mesmo código é recusado.
            if (ctx?.path === VERIFY_TOTP_PATH) {
              const code = (ctx.body as { code?: unknown } | undefined)?.code;
              if (typeof code !== 'string' || !(await claimTotpCode(prisma, session.userId, code))) {
                throw new APIError('UNAUTHORIZED', INVALID_CODE);
              }
            }
            return undefined;
          },
        },
      },
    },

    // Limite por IP (T2.3). O IP vem do header interno que o AuthController preenche.
    rateLimit: {
      enabled: config.AUTH_RATE_LIMIT_ENABLED,
      storage: 'database',
      window: AUTH_RATE_LIMIT_RULES.default.window,
      max: AUTH_RATE_LIMIT_RULES.default.max,
      customRules: Object.fromEntries(
        Object.entries(AUTH_RATE_LIMIT_RULES).filter(([path]) => path !== 'default'),
      ),
    },

    hooks: {
      // Bloqueio por conta (T2.3): cada tentativa é reservada antes de a senha ser conferida; e-mail bloqueado
      // nem chega à senha.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_PATH) return;
        const email = normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email);
        if (email === undefined || (await reserveLoginAttempt(prisma, email))) return;
        await record({
          actor: { type: 'anonymous' },
          action: AUTH_AUDIT_ACTIONS[SIGN_IN_PATH] ?? SIGN_IN_PATH,
          resourceType: 'login',
          resourceId: email,
          outcome: 'denied',
          statusCode: 429,
          ...requestMetadata(ctx.headers),
        });
        throw new APIError('TOO_MANY_REQUESTS', { message: ACCOUNT_LOCKED_MESSAGE, code: 'ACCOUNT_LOCKED' });
      }),
      // Eventos de login, MFA, senha e sessão na trilha de auditoria (T2.3).
      after: createAuthMiddleware(async (ctx) => {
        const action = AUTH_AUDIT_ACTIONS[ctx.path];
        if (action === undefined) return;
        const returned = ctx.context.returned;
        const statusCode = isAPIError(returned) ? returned.statusCode : 200;
        const user = ctx.context.newSession?.user ?? ctx.context.session?.user;
        const email = normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email);

        // O contador de tentativas zera só com a sessão completa: no login de quem tem MFA, isso acontece na
        // verificação do código (este hook roda antes do plugin do MFA trocar a sessão pelo desafio).
        const newSession = statusCode < 400 ? ctx.context.newSession : null;
        if (newSession) {
          const completed =
            ctx.path === VERIFY_TOTP_PATH ||
            ctx.path === VERIFY_BACKUP_CODE_PATH ||
            (ctx.path === SIGN_IN_PATH && newSession.user.twoFactorEnabled !== true);
          if (completed) await clearLoginAttempts(prisma, newSession.user.email);
        }
        // Senha trocada: as outras sessões caem; a atual continua, com a mesma idade (limite de 12 h).
        const current = ctx.context.session;
        if (ctx.path === '/change-password' && statusCode < 400 && current) {
          await prisma.session.deleteMany({
            where: { userId: current.user.id, id: { not: current.session.id } },
          });
          // A senha temporária acabou: a sessão passa a alcançar o cadastro do MFA e, depois, o painel.
          await prisma.user.update({
            where: { id: current.user.id },
            data: { mustChangePassword: false, temporaryPasswordExpiresAt: null },
          });
        }

        await record({
          actor: user
            ? { type: 'user', id: user.id, tenantId: (user as { tenantId?: string | null }).tenantId ?? null }
            : { type: 'anonymous' },
          action,
          resourceType: ctx.path === SIGN_IN_PATH ? 'login' : undefined,
          resourceId: ctx.path === SIGN_IN_PATH ? email : undefined,
          outcome:
            statusCode < 400 ? 'success' : statusCode === 401 || statusCode === 403 ? 'denied' : 'failure',
          statusCode,
          ...requestMetadata(ctx.headers),
        });
      }),
    },

    plugins: [
      // Senha nova (redefinição e troca) não pode estar em vazamentos conhecidos. Só os 5 primeiros
      // caracteres do SHA-1 vão ao Have I Been Pwned (k-anonimato, com padding). Se o serviço não responder,
      // a troca falha: a senha não é aceita sem a checagem.
      haveIBeenPwned({
        enabled: config.PASSWORD_BREACH_CHECK_ENABLED,
        paths: ['/change-password', '/reset-password'],
        customPasswordCompromisedMessage: 'Esta senha aparece em vazamentos conhecidos. Escolha outra.',
      }),
      // MFA obrigatório (T2.2): TOTP de 6 dígitos e 10 códigos de recuperação. Segredo e códigos são
      // cifrados com a chave do Better Auth antes de ir para o banco.
      twoFactor({
        issuer: PRODUCT_NAME,
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { amount: BACKUP_CODES_AMOUNT, length: 10, storeBackupCodes: 'encrypted' },
        skipVerificationOnEnable: false,
        twoFactorCookieMaxAge: MFA_CHALLENGE_SECONDS,
        accountLockout: {
          enabled: true,
          maxFailedAttempts: MFA_MAX_FAILED_ATTEMPTS,
          durationSeconds: MFA_LOCKOUT_SECONDS,
        },
      }),
    ],

    advanced: {
      useSecureCookies: true,
      cookiePrefix: 'verax',
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'strict', path: '/' },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // O e-mail sai em segundo plano: a resposta do pedido de redefinição leva o mesmo tempo para e-mail
      // existente e inexistente (sem enumeração por tempo de resposta).
      backgroundTasks: {
        handler: (promise) => {
          promise.catch(() => logger.error({ source: 'better-auth' }, 'falha numa tarefa em segundo plano'));
        },
      },
    },
    logger: {
      level: 'warn',
      log: (level, message) => {
        // Só a mensagem: os argumentos extras podem trazer dados da requisição.
        if (level === 'error') logger.error({ source: 'better-auth' }, message);
        else logger.warn({ source: 'better-auth' }, message);
      },
    },
    onAPIError: { throw: false },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;

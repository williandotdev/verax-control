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
import { clearLoginFailures, isLoginLocked, normalizeEmail, registerLoginFailure } from './login-attempts.js';
import { passwordLinkMail } from './password-links.js';

export interface AuthDependencies {
  config: AppConfig;
  prisma: PrismaService;
  logger: Pick<PinoLogger, 'warn' | 'error'>;
  /** Onde gravar os eventos de autenticação (a trilha de auditoria, na aplicação). */
  audit: AuthAuditSink;
  /** Envio dos e-mails de convite e de redefinição de senha (T2.6). */
  mail: MailTransport;
}

const SIGN_IN_PATH = '/sign-in/email';
const ACCOUNT_LOCKED_MESSAGE = 'Muitas tentativas. Tente novamente em alguns minutos.';

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
      // Ninguém se cadastra sozinho: usuário só entra por convite (T2.6).
      disableSignUp: true,
      autoSignIn: false,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      resetPasswordTokenExpiresIn: PASSWORD_LINK_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // Convite e redefinição (T2.6). Usuário desativado não recebe nada, e a resposta da API é a mesma.
      sendResetPassword: async ({ user, token }) => {
        const message = passwordLinkMail(config.WEB_ORIGIN, user, token);
        if (message) await mail.send(message);
      },
      // Definir a senha pelo link do convite ativa a conta.
      onPasswordReset: async ({ user }) => {
        await prisma.user.updateMany({
          where: { id: user.id, status: 'invited' },
          data: { status: 'active' },
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
      },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    account: { accountLinking: { enabled: false } },
    // Tokens de convite e de redefinição ficam só com hash no banco.
    verification: { storeIdentifier: 'hashed' },

    databaseHooks: {
      session: {
        create: {
          // Só usuário ativo, de cliente ativo, recebe sessão (convidado sem senha definida ou desativado não).
          before: async (session) => {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { status: true, tenant: { select: { status: true } } },
            });
            if (user?.status !== 'active') return false;
            if (user.tenant && user.tenant.status !== 'active') return false;
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
      // Bloqueio por conta (T2.3): e-mail bloqueado nem chega a conferir a senha.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_PATH) return;
        const email = normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email);
        if (email === undefined || !(await isLoginLocked(prisma, email))) return;
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

        if (ctx.path === SIGN_IN_PATH && email !== undefined) {
          if (statusCode === 401) await registerLoginFailure(prisma, email);
          else if (statusCode < 400) await clearLoginFailures(prisma, email);
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
      // Senha nova (redefinição, convite e troca) não pode estar em vazamentos conhecidos. Só os 5 primeiros
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

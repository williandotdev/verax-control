import { PRODUCT_NAME } from '@verax/shared';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { haveIBeenPwned } from 'better-auth/plugins/haveibeenpwned';
import { twoFactor } from 'better-auth/plugins/two-factor';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../common/config/config.module.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { MailTransport } from '../mail/mail.types.js';
import { AUTH_AUDIT_ACTIONS, type AuthAuditSink, requestMetadata } from './auth-audit.js';
import { belongsToHost, currentHostTenant } from './host-tenant.js';
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
import { temporaryPasswordExpired } from './temporary-password.js';
import {
  createTurnstileVerifier,
  TURNSTILE_ACTIONS,
  TURNSTILE_FAILED,
  TURNSTILE_REQUIRED,
  TURNSTILE_TOKEN_HEADER,
  TURNSTILE_UNAVAILABLE,
  type TurnstileOutcome,
  type TurnstileVerifier,
} from './turnstile.js';

export interface AuthDependencies {
  config: AppConfig;
  prisma: PrismaService;
  logger: Pick<PinoLogger, 'warn' | 'error'>;
  /** Onde gravar os eventos de autenticação (a trilha de auditoria, na aplicação). */
  audit: AuthAuditSink;
  /** Envio do e-mail de redefinição de senha (T2.6). */
  mail: MailTransport;
  /** Conferência do token do Turnstile. Sem informar, vem da configuração (`undefined` sem a chave secreta). */
  turnstile?: TurnstileVerifier | undefined;
}

/** Resposta de cada recusa do Turnstile. A indisponibilidade do siteverify fecha a porta (503), nunca abre. */
const TURNSTILE_REFUSALS: Record<
  Exclude<TurnstileOutcome, 'ok'>,
  {
    status: 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE';
    statusCode: 400 | 503;
    body: { code: string; message: string };
  }
> = {
  required: { status: 'BAD_REQUEST', statusCode: 400, body: TURNSTILE_REQUIRED },
  failed: { status: 'BAD_REQUEST', statusCode: 400, body: TURNSTILE_FAILED },
  unavailable: { status: 'SERVICE_UNAVAILABLE', statusCode: 503, body: TURNSTILE_UNAVAILABLE },
};

const SIGN_IN_PATH = '/sign-in/email';
const VERIFY_TOTP_PATH = '/two-factor/verify-totp';
const VERIFY_BACKUP_CODE_PATH = '/two-factor/verify-backup-code';
const ACCOUNT_LOCKED_MESSAGE = 'Muitas tentativas. Tente novamente em alguns minutos.';
/** Mesmo erro do Better Auth para senha errada (o teste de login compara as duas respostas). */
const INVALID_CREDENTIALS = { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' };
const INVALID_CODE = { code: 'INVALID_CODE', message: 'Invalid code' };
/** Mesmo erro do Better Auth para o link de redefinição que não vale (o teste da célula compara as duas respostas). */
const INVALID_TOKEN = { code: 'INVALID_TOKEN', message: 'Invalid token' };
const RESET_ROUTE = '/reset-password';
// Senha temporária vencida (72 h): o login recusa dizendo o motivo, para a pessoa pedir outra ao administrador. Só
// chega aqui quem acertou a senha, então o código não ajuda quem não a tem.
const TEMPORARY_EXPIRED = { code: 'TEMPORARY_PASSWORD_EXPIRED', message: 'Temporary password expired' };
// Na troca, a senha nova não pode repetir a atual: a troca obrigatória precisa tirar de uso a senha temporária.
const SAME_AS_CURRENT = {
  code: 'PASSWORD_UNCHANGED',
  message: 'New password must differ from the current one',
};

/**
 * Configuração do Better Auth (regra 10: hash de senha, sessão, tokens e TOTP são da biblioteca).
 * Cada opção abaixo tem um motivo de segurança; mudar qualquer uma pede revisão.
 */
export function createAuth({ config, prisma, logger, audit, mail, ...deps }: AuthDependencies) {
  /** A auditoria nunca derruba o login; uma falha ao gravar vai para o log. */
  const record: AuthAuditSink = async (entry) => {
    try {
      await audit(entry);
    } catch {
      logger.error({ audit: { action: entry.action, outcome: entry.outcome } }, 'falha ao gravar auditoria');
    }
  };

  // Turnstile (desafio nos formulários públicos): só com a chave secreta. Em produção, sem ela, fica o aviso: o login
  // e o "esqueci minha senha" seguem sem o desafio, com o limite por IP e o bloqueio por conta de sempre.
  const turnstile = 'turnstile' in deps ? deps.turnstile : createTurnstileVerifier(config, logger);
  if (config.NODE_ENV === 'production' && !turnstile) {
    logger.warn(
      { turnstile: { enabled: false } },
      'Turnstile desligado: login e "esqueci minha senha" sem o desafio (defina TURNSTILE_SECRET_KEY e TURNSTILE_SITE_KEY)',
    );
  }

  // Célula compartilhada (CE-01): o cliente do endereço da requisição decide quem entra, onde a sessão vale, de que
  // painel vem a chamada e para onde vai o link do e-mail. Fora dela (`cell === null`), tudo segue como no nó dedicado.
  const cell = config.cell;

  /**
   * Na célula, o login olha o usuário só dentro do cliente do endereço, antes de conferir a senha. Quem é de outro
   * cliente (ou o `admin_verax` fora do endereço da equipe) recebe a mesma recusa da senha errada, depois de gastar a
   * tentativa da conta e a do IP, e no mesmo tempo (o hash da senha recebida, como o Better Auth faz para o e-mail que
   * não existe). Nada na resposta diz que a conta existe em outro lugar. O hook `after` não roda quando este lança: o
   * registro da recusa é o mesmo da senha errada, gravado daqui.
   */
  async function refuseOutsideHost(ctx: {
    body?: unknown;
    headers?: Headers | undefined;
    context: { password: { hash: (password: string) => Promise<string> } };
  }): Promise<void> {
    if (cell === null) return;
    const body = ctx.body as { email?: unknown; password?: unknown } | undefined;
    const email = normalizeEmail(body?.email);
    if (email === undefined) return;
    const host = currentHostTenant();
    const user = await prisma.user.findUnique({ where: { email }, select: { role: true, tenantId: true } });
    if (host !== undefined && (user === null || belongsToHost(user, host))) return;
    if (typeof body?.password === 'string') await ctx.context.password.hash(body.password);
    await record({
      actor: { type: 'anonymous' },
      action: AUTH_AUDIT_ACTIONS[SIGN_IN_PATH] ?? SIGN_IN_PATH,
      resourceType: 'login',
      resourceId: email,
      outcome: 'denied',
      statusCode: 401,
      ...requestMetadata(ctx.headers),
    });
    throw new APIError('UNAUTHORIZED', INVALID_CREDENTIALS);
  }

  /**
   * Na célula, o link de redefinição só vale no endereço do cliente de quem o recebeu: antes de a senha mudar (e de as
   * sessões caírem), o dono do token precisa ser do cliente do endereço. O de outro cliente recebe a mesma recusa do
   * token que não existe, sem gastar o token nem mudar nada; o registro na trilha é o mesmo da recusa do Better Auth (o
   * hook `after` não roda quando este lança). O token é procurado como o Better Auth procura (`reset-password:<token>`,
   * no corpo ou na query), pelo adaptador dele, que aplica o hash do identificador.
   */
  async function refuseForeignResetToken(ctx: {
    body?: unknown;
    query?: unknown;
    headers?: Headers | undefined;
    context: {
      internalAdapter: {
        findVerificationValue: (identifier: string) => Promise<{ value: string; expiresAt: Date } | null>;
      };
    };
  }): Promise<void> {
    if (cell === null) return;
    const fromBody = (ctx.body as { token?: unknown } | undefined)?.token;
    const fromQuery = (ctx.query as { token?: unknown } | undefined)?.token;
    const token = typeof fromBody === 'string' && fromBody !== '' ? fromBody : fromQuery;
    // Sem token, ou num formato que o Better Auth recusa sozinho: a recusa dele mesmo.
    if (typeof token !== 'string' || token === '') return;
    const verification = await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`);
    if (verification === null || verification.expiresAt < new Date()) return;
    const host = currentHostTenant();
    const owner = await prisma.user.findUnique({
      where: { id: verification.value },
      select: { role: true, tenantId: true },
    });
    if (host !== undefined && owner !== null && belongsToHost(owner, host)) return;
    await record({
      actor: { type: 'anonymous' },
      action: AUTH_AUDIT_ACTIONS[RESET_ROUTE] ?? RESET_ROUTE,
      outcome: 'failure',
      statusCode: 400,
      ...requestMetadata(ctx.headers),
    });
    throw new APIError('BAD_REQUEST', INVALID_TOKEN);
  }

  /**
   * Confere o token do Turnstile antes de tudo (antes de reservar a tentativa de login e de olhar a senha). O hook
   * `after` não roda quando este lança, então a recusa entra na trilha daqui.
   */
  async function checkTurnstile(ctx: {
    path: string;
    headers?: Headers | undefined;
    body?: unknown;
  }): Promise<void> {
    const expectedAction = TURNSTILE_ACTIONS.get(ctx.path);
    if (!turnstile || expectedAction === undefined) return;
    // Na célula, o token precisa ter sido resolvido no painel do cliente do endereço; sem endereço, recusa.
    const host = cell === null ? undefined : currentHostTenant();
    const outcome =
      cell !== null && host === undefined
        ? 'failed'
        : await turnstile.verify(
            ctx.headers?.get(TURNSTILE_TOKEN_HEADER),
            ctx.headers?.get(CLIENT_IP_HEADER) ?? undefined,
            expectedAction,
            host?.panelHostname,
          );
    if (outcome === 'ok') return;
    const refusal = TURNSTILE_REFUSALS[outcome];
    await record({
      actor: { type: 'anonymous' },
      action: AUTH_AUDIT_ACTIONS[ctx.path] ?? ctx.path,
      resourceType: ctx.path === SIGN_IN_PATH ? 'login' : undefined,
      resourceId:
        ctx.path === SIGN_IN_PATH
          ? normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email)
          : undefined,
      outcome: refusal.statusCode === 503 ? 'failure' : 'denied',
      statusCode: refusal.statusCode,
      ...requestMetadata(ctx.headers),
    });
    throw new APIError(refusal.status, refusal.body);
  }

  return betterAuth({
    appName: PRODUCT_NAME,
    baseURL: config.API_ORIGIN,
    basePath: AUTH_BASE_PATH,
    secret: config.BETTER_AUTH_SECRET,
    // Só o painel pode chamar a autenticação com cookies (checagem de origem contra CSRF). Na célula, o painel do
    // cliente do endereço da requisição.
    trustedOrigins:
      cell === null
        ? [config.WEB_ORIGIN]
        : () => {
            const host = currentHostTenant();
            return host === undefined ? [] : [host.panelOrigin];
          },
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
      // Na célula, só quem é do cliente do endereço recebe, e o link leva ao painel desse cliente; o pedido feito no
      // endereço de outro cliente tem a mesma resposta e não manda nada. O resgate do link também confere o endereço
      // (`refuseForeignResetToken`).
      sendResetPassword: async ({ user, token }) => {
        let webOrigin = config.WEB_ORIGIN;
        if (cell !== null) {
          const host = currentHostTenant();
          const owner = await prisma.user.findUnique({
            where: { id: user.id },
            select: { role: true, tenantId: true },
          });
          if (host === undefined || owner === null || !belongsToHost(owner, host)) return;
          webOrigin = host.panelOrigin;
        }
        const message = passwordLinkMail(webOrigin, user, token);
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
        // Célula (CE-01): o cliente do endereço onde a sessão nasceu, gravado pelo hook de criação. Só existe na célula.
        ...(cell !== null && { hostTenantId: { type: 'string', required: false, input: false } }),
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
              select: {
                status: true,
                role: true,
                tenantId: true,
                mustChangePassword: true,
                temporaryPasswordExpiresAt: true,
                tenant: { select: { status: true } },
              },
            });
            // Na célula, a sessão só nasce no endereço do cliente da pessoa (o login já recusou os outros; aqui cobre
            // também o código do MFA levado a outro endereço) e guarda o cliente do endereço.
            const host = cell === null ? undefined : currentHostTenant();
            const onHost =
              cell === null || (host !== undefined && user !== null && belongsToHost(user, host));
            if (!onHost) {
              // A mesma recusa da senha errada, no login, e do código errado, no MFA: nada diz de onde é a conta.
              if (ctx?.path === SIGN_IN_PATH) throw new APIError('UNAUTHORIZED', INVALID_CREDENTIALS);
              if (ctx?.path === VERIFY_TOTP_PATH || ctx?.path === VERIFY_BACKUP_CODE_PATH) {
                throw new APIError('UNAUTHORIZED', INVALID_CODE);
              }
              return false;
            }
            const allowed = user?.status === 'active' && (!user.tenant || user.tenant.status === 'active');
            if (!allowed) {
              // No login, a mesma resposta da senha errada: não revela que a conta existe nem que a senha bateu.
              if (ctx?.path === SIGN_IN_PATH) throw new APIError('UNAUTHORIZED', INVALID_CREDENTIALS);
              return false;
            }
            // Senha temporária vencida: nenhuma sessão nasce com ela (nem a do desafio do MFA), e o login diz o motivo.
            if (temporaryPasswordExpired(user)) {
              const signingIn = [SIGN_IN_PATH, VERIFY_TOTP_PATH, VERIFY_BACKUP_CODE_PATH].includes(
                ctx?.path ?? '',
              );
              if (signingIn) throw new APIError('UNAUTHORIZED', TEMPORARY_EXPIRED);
              return false;
            }
            // Código TOTP vale uma vez (NIST SP 800-63B): um segundo login com o mesmo código é recusado.
            if (ctx?.path === VERIFY_TOTP_PATH) {
              const code = (ctx.body as { code?: unknown } | undefined)?.code;
              if (typeof code !== 'string' || !(await claimTotpCode(prisma, session.userId, code))) {
                throw new APIError('UNAUTHORIZED', INVALID_CODE);
              }
            }
            return host === undefined ? undefined : { data: { ...session, hostTenantId: host.tenantId } };
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
        if (ctx.path === '/change-password') {
          // Comparadas como a biblioteca guarda (NFKC): a senha em caracteres de largura total vira o mesmo hash.
          const body = ctx.body as { currentPassword?: unknown; newPassword?: unknown } | undefined;
          const same =
            typeof body?.newPassword === 'string' &&
            typeof body.currentPassword === 'string' &&
            body.newPassword.normalize('NFKC') === body.currentPassword.normalize('NFKC');
          if (!same) return;
          // Sem sessão, o próprio endpoint responde 401 (e o hook `after` registra).
          const current = await getSessionFromCtx(ctx);
          if (!current) return;
          // O hook `after` não roda quando este lança: a recusa entra na trilha daqui, como o bloqueio do login.
          await record({
            actor: {
              type: 'user',
              id: current.user.id,
              tenantId: (current.user as { tenantId?: string | null }).tenantId ?? null,
            },
            action: AUTH_AUDIT_ACTIONS['/change-password'] ?? '/change-password',
            outcome: 'failure',
            statusCode: 400,
            ...requestMetadata(ctx.headers),
          });
          throw new APIError('BAD_REQUEST', SAME_AS_CURRENT);
        }
        // Turnstile antes da tentativa de login: uma requisição sem o desafio não gasta nenhuma das 5 tentativas.
        await checkTurnstile(ctx);
        if (ctx.path === RESET_ROUTE) await refuseForeignResetToken(ctx);
        if (ctx.path !== SIGN_IN_PATH) return;
        const email = normalizeEmail((ctx.body as { email?: unknown } | undefined)?.email);
        if (email === undefined) return;
        if (await reserveLoginAttempt(prisma, email)) {
          // A tentativa já foi gasta: na célula, o usuário de outro endereço para aqui, antes da senha.
          await refuseOutsideHost(ctx);
          return;
        }
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

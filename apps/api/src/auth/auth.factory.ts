import { PRODUCT_NAME } from '@verax/shared';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import type { PinoLogger } from 'nestjs-pino';
import type { AppConfig } from '../common/config/config.module.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import {
  AUTH_BASE_PATH,
  CLIENT_IP_HEADER,
  PASSWORD_LINK_TTL_SECONDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SESSION_IDLE_TIMEOUT_SECONDS,
  SESSION_REFRESH_AFTER_SECONDS,
} from './auth.constants.js';

export interface AuthDependencies {
  config: AppConfig;
  prisma: PrismaService;
  logger: Pick<PinoLogger, 'warn' | 'error'>;
}

/**
 * Configuração do Better Auth (regra 10: hash de senha, sessão, tokens e TOTP são da biblioteca).
 * Cada opção abaixo tem um motivo de segurança; mudar qualquer uma pede revisão.
 */
export function createAuth({ config, prisma, logger }: AuthDependencies) {
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
    },

    session: {
      expiresIn: SESSION_IDLE_TIMEOUT_SECONDS,
      updateAge: SESSION_REFRESH_AFTER_SECONDS,
      // Sem cache em cookie: toda requisição consulta o banco, então revogar uma sessão vale na hora.
      cookieCache: { enabled: false },
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

    advanced: {
      useSecureCookies: true,
      cookiePrefix: 'verax',
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'strict', path: '/' },
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
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

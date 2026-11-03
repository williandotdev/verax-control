import {
  All,
  BadRequestException,
  Controller,
  ForbiddenException,
  HttpStatus,
  Inject,
  NotFoundException,
  Req,
  Res,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import {
  AUTH,
  AUTH_BASE_PATH,
  CLIENT_IP_HEADER,
  MFA_REQUIRED_CODE,
  MFA_REQUIRED_MESSAGE,
  PASSWORD_CHANGE_REQUIRED_MESSAGE,
  REQUEST_ID_INTERNAL_HEADER,
} from './auth.constants.js';
import { PASSWORD_CHANGE_REQUIRED_CODE } from '@verax/shared';
import type { Auth } from './auth.factory.js';
import { Public, SelfManaged } from './decorators.js';
import { resolveSession } from './session-validation.js';

/**
 * Rotas do Better Auth expostas pela API. Lista fechada: qualquer outra rota da biblioteca (cadastro,
 * troca de e-mail, exclusão de conta, login social, desligar o MFA, OTP por e-mail etc.) responde 404
 * sem chegar a ela.
 */
export const ALLOWED_AUTH_ROUTES: ReadonlySet<string> = new Set([
  'POST /sign-in/email',
  'POST /sign-out',
  'GET /get-session',
  'POST /request-password-reset',
  'POST /reset-password',
  'POST /change-password',
  'GET /list-sessions',
  'POST /revoke-session',
  'POST /revoke-other-sessions',
  // MFA (T2.2). Não há rota para desligar: o MFA é obrigatório. Nem para reler o segredo depois do cadastro
  // (`get-totp-uri`): o QR sai só na resposta do `enable`.
  'POST /two-factor/enable',
  'POST /two-factor/verify-totp',
  'POST /two-factor/verify-backup-code',
  'POST /two-factor/generate-backup-codes',
]);

/** Rotas que não usam a sessão atual: entrar, pedir e definir senha pelo link, e sair (que só reduz acesso). */
const SESSIONLESS_ROUTES = new Set([
  'POST /sign-in/email',
  'POST /request-password-reset',
  'POST /reset-password',
  'POST /sign-out',
]);

/** Rotas que uma sessão aberta com a senha temporária alcança: a troca de senha (com ou sem MFA). */
const ROUTES_WITH_TEMPORARY_PASSWORD = new Set(['GET /get-session', 'POST /change-password']);

/** Rotas que uma sessão ainda sem MFA alcança: o próprio cadastro do MFA. */
const ROUTES_WITHOUT_MFA = new Set([
  'GET /get-session',
  'POST /two-factor/enable',
  'POST /two-factor/verify-totp',
]);

/**
 * Campos do Better Auth recusados aqui, por rota:
 * - `trustDevice`: "confiar neste dispositivo" pularia o código nos próximos logins;
 * - `rememberMe`: com `false`, a sessão teria 24 h sem renovação, fora do limite de 30 min de inatividade;
 * - `revokeOtherSessions`: criaria uma sessão nova, zerando o limite de 12 h. As outras sessões caem
 *   sempre que a senha muda, pelo hook da autenticação.
 */
const REFUSED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'POST /sign-in/email': ['rememberMe'],
  'POST /two-factor/verify-totp': ['trustDevice'],
  'POST /two-factor/verify-backup-code': ['trustDevice'],
  'POST /change-password': ['revokeOtherSessions'],
};

@Controller('auth')
@Public()
@SelfManaged('O Better Auth valida a entrada; os eventos de login são auditados pelos hooks da autenticação')
export class AuthController {
  private readonly handler: ReturnType<typeof toNodeHandler>;

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {
    this.handler = toNodeHandler(auth);
  }

  @All('*path')
  async handle(@Req() request: Request & { id?: unknown }, @Res() response: Response): Promise<void> {
    const route = `${request.method} ${request.path.slice(AUTH_BASE_PATH.length)}`;
    if (!ALLOWED_AUTH_ROUTES.has(route)) throw new NotFoundException();

    if (request.method === 'POST') {
      // O Better Auth só confere a origem quando já existe cookie. Aqui todo POST exige vir do painel,
      // inclusive o login (evita login CSRF, em que um site loga a vítima na conta do atacante).
      if (request.get('origin') !== this.config.WEB_ORIGIN) throw new ForbiddenException();
      // Só JSON: formulário HTML não chega à autenticação.
      if (request.is('application/json') === false) throw new UnsupportedMediaTypeException();
    }

    const body = (request.body ?? {}) as Record<string, unknown>;
    if ((REFUSED_FIELDS[route] ?? []).some((field) => Object.hasOwn(body, field))) {
      throw new BadRequestException();
    }
    if (!SESSIONLESS_ROUTES.has(route)) await this.checkSession(request, route);

    // Headers internos para o Better Auth (limite por IP e auditoria). Chaves constantes do módulo; os valores
    // vêm do Express e do gerador de request id, e qualquer valor mandado pelo cliente é sobrescrito.
    request.headers[CLIENT_IP_HEADER] = request.ip; // nosemgrep: javascript.express.security.audit.remote-property-injection.remote-property-injection
    request.headers[REQUEST_ID_INTERNAL_HEADER] = typeof request.id === 'string' ? request.id : undefined; // nosemgrep: javascript.express.security.audit.remote-property-injection.remote-property-injection
    await this.handler(request, response);
  }

  /**
   * As rotas de sessão do Better Auth (ler e listar sessões, trocar senha, códigos de recuperação) só checam
   * se a sessão existe. Aqui valem as mesmas regras das rotas da API: 12 h, usuário e cliente ativos, e MFA.
   * Sem sessão, segue: o Better Auth responde 401, ou usa o desafio do MFA no login.
   */
  private async checkSession(request: Request, route: string): Promise<void> {
    const data = await this.auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
      // Só a checagem: quem renova a sessão (e devolve o cookie) é a própria rota.
      query: { disableRefresh: true },
    });
    if (!data) return;
    const auth = await resolveSession(this.prisma, data);
    if (!auth) throw new UnauthorizedException();
    if (auth.mustChangePassword) {
      if (!ROUTES_WITH_TEMPORARY_PASSWORD.has(route)) {
        throw new ApiError(
          HttpStatus.FORBIDDEN,
          PASSWORD_CHANGE_REQUIRED_MESSAGE,
          PASSWORD_CHANGE_REQUIRED_CODE,
        );
      }
      return;
    }
    if (!auth.mfaEnabled && !ROUTES_WITHOUT_MFA.has(route)) {
      throw new ApiError(HttpStatus.FORBIDDEN, MFA_REQUIRED_MESSAGE, MFA_REQUIRED_CODE);
    }
    // Quem já tem MFA não recadastra por aqui: trocar o autenticador é ação de administrador (T3.2).
    if (auth.mfaEnabled && route === 'POST /two-factor/enable') throw new ForbiddenException();
  }
}

import {
  All,
  Controller,
  ForbiddenException,
  Inject,
  NotFoundException,
  Req,
  Res,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { toNodeHandler } from 'better-auth/node';
import type { Request, Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { AUTH, AUTH_BASE_PATH, CLIENT_IP_HEADER } from './auth.constants.js';
import type { Auth } from './auth.factory.js';
import { Public, SelfManaged } from './decorators.js';

/**
 * Rotas do Better Auth expostas pela API. Lista fechada: qualquer outra rota da biblioteca (cadastro,
 * troca de e-mail, exclusão de conta, login social etc.) responde 404 sem chegar a ela.
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
]);

@Controller('auth')
@Public()
@SelfManaged('O Better Auth valida a entrada; os eventos de login são auditados pelos hooks da autenticação')
export class AuthController {
  private readonly handler: ReturnType<typeof toNodeHandler>;

  constructor(
    @Inject(AUTH) auth: Auth,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.handler = toNodeHandler(auth);
  }

  @All('*path')
  async handle(@Req() request: Request, @Res() response: Response): Promise<void> {
    const route = `${request.method} ${request.path.slice(AUTH_BASE_PATH.length)}`;
    if (!ALLOWED_AUTH_ROUTES.has(route)) throw new NotFoundException();
    if (request.method === 'POST') {
      // O Better Auth só confere a origem quando já existe cookie. Aqui todo POST exige vir do painel,
      // inclusive o login (evita login CSRF, em que um site loga a vítima na conta do atacante).
      if (request.get('origin') !== this.config.WEB_ORIGIN) throw new ForbiddenException();
      // Só JSON: formulário HTML não chega à autenticação.
      if (request.is('application/json') === false) throw new UnsupportedMediaTypeException();
    }
    // Chave constante do módulo; o valor é o IP calculado pelo Express, não um dado do cliente.
    request.headers[CLIENT_IP_HEADER] = request.ip; // nosemgrep: javascript.express.security.audit.remote-property-injection.remote-property-injection
    await this.handler(request, response);
  }
}

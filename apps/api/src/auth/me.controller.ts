import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { AllowWithoutMfa } from './decorators.js';

/** Identidade da sessão atual, usada pelo painel para montar menus e decidir o fluxo de MFA. */
@Controller('me')
export class MeController {
  @Get()
  @AllowWithoutMfa()
  me(@Req() request: Request): Omit<RequestAuth, 'sessionId'> {
    const { sessionId: _sessionId, ...identity } = request.auth as RequestAuth;
    return identity;
  }
}

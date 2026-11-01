import { Controller, Get, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { type Permission, permissionsOf } from '@verax/shared';
import { AllowWithoutMfa, Authenticated } from './decorators.js';

/** Identidade da sessão atual, usada pelo painel para montar menus e decidir o fluxo de MFA. */
@Controller('me')
export class MeController {
  @Get()
  @Authenticated()
  @AllowWithoutMfa()
  me(@Req() request: Request): Omit<RequestAuth, 'sessionId'> & { permissions: Permission[] } {
    const { sessionId: _sessionId, ...identity } = request.auth as RequestAuth;
    // As permissões vão junto para o painel esconder o que não cabe; quem decide é sempre a API.
    return { ...identity, permissions: permissionsOf(identity.role) };
  }
}

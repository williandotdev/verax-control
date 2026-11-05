import { Controller, Get, Req } from '@nestjs/common';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/** Quem está no console (o cabeçalho das telas mostra o e-mail): só o e-mail conferido no JWT do IAP, nada mais. */
export interface AdminSession {
  email: string;
}

/**
 * `GET /v1/admin/me`: o responsável autenticado, como a guarda global o leu do JWT do IAP. Sem segredo, sem token e
 * sem o restante das reivindicações do JWT; atrás da mesma `OwnerGuard` de toda rota do console.
 */
@Controller('admin')
export class AdminSessionController {
  @Get('me')
  me(@Req() req: OwnerRequest): AdminSession {
    return { email: ownerOf(req).email };
  }
}

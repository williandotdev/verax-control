import { Controller, Get, Req } from '@nestjs/common';
import { type OwnerRequest, ownerOf } from './owner.guard.js';

/** Quem está no console (o cabeçalho das telas mostra o e-mail): só o e-mail da sessão, nada mais. */
export interface AdminSession {
  email: string;
}

/**
 * `GET /v1/admin/me`: o responsável autenticado, como a guarda global o leu da sessão (cookie `__session`). Sem
 * segredo e sem o id da sessão; atrás da mesma `OwnerGuard` de toda rota do console.
 */
@Controller('admin')
export class AdminSessionController {
  @Get('me')
  me(@Req() req: OwnerRequest): AdminSession {
    return { email: ownerOf(req).email };
  }
}

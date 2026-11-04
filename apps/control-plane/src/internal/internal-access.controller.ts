import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AlreadyRevealedError,
  RevealNotAvailableError,
  StatusAccessNotFoundError,
} from '../access/access-store.js';
import { PasswordExpiredError, RevealService, RevealUnavailableError } from '../access/reveal.service.js';
import { STATUS_TOKEN_KINDS, statusTokenValueSchema } from '../access/status-token.js';
import { forgetLiveSecret } from '../common/logger/sanitize.js';
import { ApiError } from '../common/http/api-error.js';
import { WorkerCallerGuard, WorkerCallers } from './worker-caller.js';

/** O pedido do cp-public: o tipo da credencial e o valor que o cliente apresentou (cookie conferido, ou link). */
export const internalRevealRequestSchema = z.strictObject({
  kind: z.enum(STATUS_TOKEN_KINDS),
  token: statusTokenValueSchema,
});

/** A resposta ao cp-public, que a repassa ao site como veio. */
export interface InternalRevealResponse {
  panelUrl: string;
  adminEmail: string;
  password: string;
  passwordExpiresAt: string;
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** O que o cp-public recebe em cada caso: o código decide a mensagem do site; o texto daqui não sai do plano. */
export function revealErrorToApi(error: unknown): Error {
  if (error instanceof StatusAccessNotFoundError) {
    return new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
  }
  if (error instanceof AlreadyRevealedError) {
    return new ApiError(HttpStatus.CONFLICT, 'Já revelada', 'already_revealed');
  }
  if (error instanceof RevealNotAvailableError) {
    return new ApiError(HttpStatus.CONFLICT, 'Indisponível', 'reveal_not_available');
  }
  if (error instanceof PasswordExpiredError) {
    return new ApiError(HttpStatus.GONE, 'Vencida', 'password_expired');
  }
  if (error instanceof RevealUnavailableError) {
    return new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'reveal_unavailable');
  }
  return error instanceof Error ? error : new Error('falha na revelação');
}

/**
 * `POST /internal/access/reveal`: a revelação única, chamada só pelo cp-public (o token dele, `PUBLIC_SA_EMAIL`),
 * que não tem acesso ao segredo. A destruição da versão já está na fila quando esta resposta sai; a senha deixa a
 * máscara do logger quando a resposta termina.
 */
@Controller('internal/access')
@UseGuards(WorkerCallerGuard)
export class InternalAccessController {
  constructor(private readonly reveals: RevealService) {}

  @Post('reveal')
  @WorkerCallers('public')
  @HttpCode(HttpStatus.OK)
  async reveal(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InternalRevealResponse> {
    const parsed = internalRevealRequestSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
    try {
      const revealed = await this.reveals.reveal(parsed.data.kind, parsed.data.token, {
        requestId: requestIdOf(req),
      });
      res.on('close', () => forgetLiveSecret(revealed.password));
      return {
        panelUrl: revealed.panelUrl,
        adminEmail: revealed.adminEmail,
        password: revealed.password,
        passwordExpiresAt: revealed.passwordExpiresAt.toISOString(),
      };
    } catch (error) {
      throw revealErrorToApi(error);
    }
  }
}

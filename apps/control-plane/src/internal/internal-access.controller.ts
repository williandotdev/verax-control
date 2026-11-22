import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  AlreadyRevealedError,
  RevealConfirmationMismatchError,
  RevealNotAvailableError,
  StatusAccessNotFoundError,
} from '../access/access-store.js';
import {
  PasswordExpiredError,
  type RevealedAccess,
  RevealService,
  RevealUnavailableError,
} from '../access/reveal.service.js';
import { STATUS_TOKEN_KINDS, statusTokenValueSchema } from '../access/status-token.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { forgetLiveSecret } from '../common/logger/sanitize.js';
import { ApiError } from '../common/http/api-error.js';
import { isUlid } from '../common/ulid.js';
import { ownerActorOf, WorkerCallerGuard, WorkerCallers } from './worker-caller.js';

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
  // Só na revelação pelo responsável (a do cp-public não leva subdomínio).
  if (error instanceof RevealConfirmationMismatchError) {
    return new ApiError(
      HttpStatus.BAD_REQUEST,
      'O subdomínio não confere com o do cliente: nada mudou',
      'confirmation_mismatch',
    );
  }
  return error instanceof Error ? error : new Error('falha na revelação');
}

/** O acesso revelado como sai na resposta (a data em texto ISO); a senha sai da máscara quando a resposta termina. */
function revealResponse(revealed: RevealedAccess, res: Response): InternalRevealResponse {
  res.on('close', () => forgetLiveSecret(revealed.password));
  return {
    panelUrl: revealed.panelUrl,
    adminEmail: revealed.adminEmail,
    password: revealed.password,
    passwordExpiresAt: revealed.passwordExpiresAt.toISOString(),
  };
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
      return revealResponse(revealed, res);
    } catch (error) {
      throw revealErrorToApi(error);
    }
  }
}

/** O pedido do responsável: o subdomínio digitado e, quando quem chama é o console, quem agiu. */
export const ownerRevealRequestSchema = z.strictObject({
  confirmSlug: z.string().min(1).max(64),
  actor: z.email().max(254).optional(),
});

/**
 * `POST /internal/tenants/:tenantId/reveal-access` `{confirmSlug, actor?}`: a revelação única pelas mãos do
 * responsável, que copia o painel, o login e a senha temporária e manda ao cliente. Quem chama: o console (`cp-admin`,
 * com quem agiu em `actor`) ou um responsável direto, como as outras operações do responsável; nunca a cp-invoker nem o
 * cp-public. É **a** revelação: marca `access.passwordRevealedAt`, enfileira a destruição das versões do
 * `admin-bootstrap` antes de responder, e depois dela o cookie da página de status e o link do e-mail recebem
 * `already_revealed`. O subdomínio que não confere é recusado (400) sem marcar nada. A senha sai só nesta resposta e
 * deixa a máscara do logger quando ela termina; a auditoria (`access.revealed`, `via: 'owner'`) nunca a leva.
 */
@Controller('internal/tenants')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner', 'console')
export class OwnerRevealController {
  constructor(
    private readonly reveals: RevealService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post(':tenantId/reveal-access')
  @HttpCode(HttpStatus.OK)
  async reveal(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InternalRevealResponse> {
    if (!isUlid(tenantId)) throw new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
    const parsed = ownerRevealRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'Informe o subdomínio do cliente para confirmar',
        'invalid_request',
      );
    }
    const actor = ownerActorOf(req, this.config, parsed.data.actor);
    if (actor === undefined) throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'actor_not_owner');
    try {
      const revealed = await this.reveals.revealForOwner(tenantId, parsed.data.confirmSlug, actor, {
        requestId: requestIdOf(req),
      });
      return revealResponse(revealed, res);
    } catch (error) {
      throw revealErrorToApi(error);
    }
  }
}

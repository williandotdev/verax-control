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
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { forgetLiveSecret } from '../common/logger/sanitize.js';
import { isUlid } from '../common/ulid.js';
import { ownerActorOf, WorkerCallerGuard, WorkerCallers } from '../internal/worker-caller.js';
import {
  type ClaimResponse,
  claimRequestSchema,
  ENROLLMENT_SECRET_PATTERN,
  reportRequestSchema,
} from './enrollment.js';
import { EnrollmentService } from './enrollment.service.js';

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/** O pedido do cp-public no `report`: a chave do nó (do `Authorization` da VM, já conferida lá) e o corpo da VM. */
export const internalReportRequestSchema = z.strictObject({
  nodeKey: z.string().regex(ENROLLMENT_SECRET_PATTERN),
  report: reportRequestSchema,
});

const NOT_FOUND = (): ApiError => new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found');
const UNAUTHENTICATED = (): ApiError =>
  new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
const INVALID = (): ApiError => new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request');
const UNAVAILABLE = (): ApiError =>
  new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'enrollment_unavailable');

/**
 * `POST /internal/node-enrollment/claim|report`: o registro da VM do cliente, chamado só pelo cp-public (o token dele,
 * `PUBLIC_SA_EMAIL`), que recebe as chamadas da VM e não lê nenhum dos segredos. Os segredos da resposta saem da
 * máscara do logger quando ela termina.
 */
@Controller('internal/node-enrollment')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('public')
export class InternalEnrollmentController {
  constructor(private readonly enrollments: EnrollmentService) {}

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClaimResponse> {
    const parsed = claimRequestSchema.safeParse(body);
    if (!parsed.success) throw INVALID();
    let outcome;
    try {
      outcome = await this.enrollments.claim(parsed.data, requestIdOf(req));
    } catch {
      throw UNAVAILABLE();
    }
    if (outcome.ok) {
      const transient = outcome.transient;
      res.on('close', () => {
        for (const value of transient) forgetLiveSecret(value);
      });
      return outcome.response;
    }
    if (outcome.reason === 'not_found') throw NOT_FOUND();
    if (outcome.reason === 'release_mismatch') {
      throw new ApiError(HttpStatus.CONFLICT, 'Versão diferente da esperada', 'release_mismatch');
    }
    throw UNAVAILABLE();
  }

  @Post('report')
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const parsed = internalReportRequestSchema.safeParse(body);
    if (!parsed.success) throw INVALID();
    let outcome;
    try {
      outcome = await this.enrollments.report(parsed.data.nodeKey, parsed.data.report, requestIdOf(req));
    } catch {
      throw UNAVAILABLE();
    }
    if (outcome.ok) return;
    throw outcome.reason === 'unauthorized' ? UNAUTHENTICATED() : UNAVAILABLE();
  }
}

const enrollmentCodeBodySchema = z.strictObject({
  confirmSlug: z.string().min(1).max(64),
  actor: z.email().max(254).optional(),
});

/** A resposta do código de instalação ao console: o código uma vez, o vencimento e a execução, se houver. */
export interface EnrollmentCodeResponse {
  code: string;
  expiresAt: string;
  reinstall: boolean;
  runId?: string;
  step?: string;
}

const REFUSALS = {
  not_found: () => NOT_FOUND(),
  confirmation_mismatch: () =>
    new ApiError(
      HttpStatus.BAD_REQUEST,
      'O subdomínio não confere com o do cliente: nada mudou',
      'confirmation_mismatch',
    ),
  not_customer_hosted: () =>
    new ApiError(
      HttpStatus.CONFLICT,
      'O ambiente deste cliente roda na infraestrutura da Verax: não há instalação para enviar',
      'not_customer_hosted',
    ),
  not_allowed: () =>
    new ApiError(HttpStatus.CONFLICT, 'O cliente não está num estado que permita isso', 'not_allowed'),
} as const;

/**
 * `POST /internal/tenants/:tenantId/enrollment-code` `{confirmSlug, actor?}`: o responsável gera o código de
 * instalação da VM do cliente. Quem chama: o console (`cp-admin`, com quem agiu em `actor`) ou um responsável direto,
 * como as outras operações do responsável; nunca a cp-invoker nem o cp-public. O código sai uma vez, nesta resposta.
 */
@Controller('internal/tenants')
@UseGuards(WorkerCallerGuard)
@WorkerCallers('owner', 'console')
export class EnrollmentCodeController {
  constructor(
    private readonly enrollments: EnrollmentService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @InjectPinoLogger(EnrollmentCodeController.name) private readonly logger: PinoLogger,
  ) {}

  @Post(':tenantId/enrollment-code')
  @HttpCode(HttpStatus.OK)
  async issue(
    @Param('tenantId') tenantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EnrollmentCodeResponse> {
    if (!isUlid(tenantId)) throw NOT_FOUND();
    const parsed = enrollmentCodeBodySchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        'Informe o subdomínio do cliente para confirmar',
        'invalid_request',
      );
    }
    const actor = ownerActorOf(req, this.config, parsed.data.actor);
    if (actor === undefined) throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'actor_not_owner');
    const outcome = await this.enrollments.issueCode(
      tenantId,
      parsed.data.confirmSlug,
      actor,
      requestIdOf(req),
    );
    if (!outcome.issued) {
      if (outcome.reason !== 'not_found') {
        this.logger.info(
          { event: 'enrollment_code_refused', tenantId, code: outcome.reason, requestId: requestIdOf(req) },
          'código de instalação recusado',
        );
      }
      throw REFUSALS[outcome.reason]();
    }
    const code = outcome.code;
    res.on('close', () => forgetLiveSecret(code));
    return {
      code,
      expiresAt: outcome.expiresAt.toISOString(),
      reinstall: outcome.reinstall,
      ...(outcome.run === undefined ? {} : { runId: outcome.run.runId, step: outcome.run.step }),
    };
  }
}

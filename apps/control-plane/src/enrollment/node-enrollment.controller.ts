import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { rateLimitKey, type RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { TenantStore } from '../tenants/tenant-store.js';
import {
  type ClaimResponse,
  claimRequestSchema,
  codeClaimable,
  enrollmentHash,
  nodeKeyFromAuthorization,
  nodeKeyValid,
  reportRequestSchema,
} from './enrollment.js';
import {
  ENROLLMENT_GATEWAY,
  type EnrollmentFailureCode,
  type EnrollmentGateway,
  EnrollmentGatewayError,
} from './enrollment-gateway.js';

/**
 * Limites por IP, em memória por instância (com 2 instâncias o efetivo dobra, como na página de status). O instalador
 * faz um `claim` e poucos `report`; o teto barra a varredura de códigos (que já é inviável: 256 bits) sem custo de
 * Firestore nem de cp-worker.
 */
export const ENROLLMENT_CLAIM_PER_IP: RateLimitRule = { capacity: 10, windowMs: 60 * 60_000 };
export const ENROLLMENT_REPORT_PER_IP: RateLimitRule = { capacity: 30, windowMs: 60 * 60_000 };

export class EnrollmentRateLimits {
  readonly claim: TokenBucketLimiter;
  readonly report: TokenBucketLimiter;

  constructor(clock: Clock) {
    this.claim = new TokenBucketLimiter(ENROLLMENT_CLAIM_PER_IP, clock);
    this.report = new TokenBucketLimiter(ENROLLMENT_REPORT_PER_IP, clock);
  }
}

export const ENROLLMENT_RATE_LIMITS = Symbol('ENROLLMENT_RATE_LIMITS');

export const ENROLLMENT_RATE_LIMITS_PROVIDER = {
  provide: ENROLLMENT_RATE_LIMITS,
  useFactory: (clock: Clock) => new EnrollmentRateLimits(clock),
  inject: [CLOCK],
};

const ERRORS: Readonly<Record<EnrollmentFailureCode, () => ApiError>> = {
  not_found: () => new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found'),
  unauthenticated: () => new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated'),
  release_mismatch: () =>
    new ApiError(HttpStatus.CONFLICT, 'Versão diferente da esperada', 'release_mismatch'),
  invalid_request: () => new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request'),
  unavailable: () => new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'enrollment_unavailable'),
};

function enforce(limiter: TokenBucketLimiter, req: Request, res: Response): void {
  const decision = limiter.take(`ip:${rateLimitKey(req.ip)}`);
  if (decision.allowed) return;
  res.setHeader('Retry-After', String(decision.retryAfterSeconds));
  throw new ApiError(
    HttpStatus.TOO_MANY_REQUESTS,
    'Muitas tentativas. Tente novamente mais tarde.',
    'rate_limited',
  );
}

function requireJson(req: Request): void {
  if (req.is('application/json') !== 'application/json') {
    throw new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'Envie JSON', 'unsupported_media_type');
  }
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * O registro da VM do cliente, lado público (só no `cp-public`; contrato de 18/11/2026). Chamado por máquina: sem
 * cookie e sem CORS (`NO_CORS_PATHS`), só JSON, erro sempre genérico e toda resposta com `Cache-Control: private,
 * no-store` (`app.setup.ts`).
 *
 * - `POST /v1/node-enrollment/claim` `{code, release, host}`: o código de uso único, conferido aqui (hash em tempo
 *   constante, sem acordar o worker por um código qualquer) e de novo na transação do worker. Desconhecido, vencido ou
 *   usado: o mesmo 404. A resposta, uma vez, traz o token do túnel e a chave do nó;
 * - `POST /v1/node-enrollment/report` com `Authorization: Bearer <nodeKey>`: `{status:'ready', version,
 *   adminBootstrapPassword}` ou `{status:'error', code}`. Chave ausente, fora do formato ou desconhecida: 401. 204.
 *
 * Os segredos (o código, a chave, o token, as senhas) entram na máscara do logger antes de qualquer `await` e saem
 * quando a resposta termina.
 */
@Controller('node-enrollment')
export class NodeEnrollmentController {
  constructor(
    private readonly tenants: TenantStore,
    @Inject(ENROLLMENT_GATEWAY) private readonly gateway: EnrollmentGateway,
    @Inject(ENROLLMENT_RATE_LIMITS) private readonly limits: EnrollmentRateLimits,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(NodeEnrollmentController.name) private readonly logger: PinoLogger,
  ) {}

  @Post('claim')
  @HttpCode(HttpStatus.OK)
  async claim(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClaimResponse> {
    enforce(this.limits.claim, req, res);
    requireJson(req);
    const code = (body as { code?: unknown } | null)?.code;
    if (typeof code === 'string') {
      registerLiveSecret(code);
      res.on('close', () => forgetLiveSecret(code));
    }
    const parsed = claimRequestSchema.safeParse(body);
    if (!parsed.success) throw ERRORS.invalid_request();
    const codeHash = enrollmentHash(parsed.data.code);
    const tenant = await this.tenants.findByEnrollmentCodeHash(codeHash);
    if (tenant === undefined || !codeClaimable(tenant, codeHash, this.clock.now())) {
      throw ERRORS.not_found();
    }
    let response: ClaimResponse;
    try {
      response = await this.gateway.claim(parsed.data, requestIdOf(req));
    } catch (error) {
      throw this.failure(error, 'claim');
    }
    const transient = [response.tunnelToken, response.nodeKey];
    res.on('close', () => {
      for (const value of transient) forgetLiveSecret(value);
    });
    return response;
  }

  @Post('report')
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    enforce(this.limits.report, req, res);
    requireJson(req);
    const nodeKey = nodeKeyFromAuthorization(req.headers.authorization);
    if (nodeKey === undefined) throw ERRORS.unauthenticated();
    registerLiveSecret(nodeKey);
    const password = (body as { adminBootstrapPassword?: unknown } | null)?.adminBootstrapPassword;
    if (typeof password === 'string') registerLiveSecret(password);
    res.on('close', () => {
      forgetLiveSecret(nodeKey);
      if (typeof password === 'string') forgetLiveSecret(password);
    });
    const parsed = reportRequestSchema.safeParse(body);
    if (!parsed.success) throw ERRORS.invalid_request();
    const nodeKeyHash = enrollmentHash(nodeKey);
    const tenant = await this.tenants.findByNodeKeyHash(nodeKeyHash);
    if (tenant === undefined || !nodeKeyValid(tenant, nodeKeyHash)) throw ERRORS.unauthenticated();
    try {
      await this.gateway.report(nodeKey, parsed.data, requestIdOf(req));
    } catch (error) {
      throw this.failure(error, 'report');
    }
  }

  private failure(error: unknown, operation: 'claim' | 'report'): ApiError {
    if (error instanceof EnrollmentGatewayError) return ERRORS[error.code]();
    this.logger.error(
      {
        event: 'enrollment_worker_failed',
        operation,
        reason: error instanceof Error ? error.name : 'unknown',
      },
      'o cp-worker não respondeu ao registro da VM',
    );
    return ERRORS.unavailable();
  }
}

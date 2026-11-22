import { Body, Controller, HttpCode, HttpStatus, Inject, Post, Req, Res } from '@nestjs/common';
import { type NodeSyncRequest, type NodeSyncResponse, nodeSyncRequestSchema } from '@verax/shared';
import type { Request, Response } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { rateLimitKey, type RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { nodeSyncCredentialFromAuthorization, plausibleNodeIdentity } from './node-identity.js';
import {
  NODE_SYNC_GATEWAY,
  type NodeSyncFailureCode,
  type NodeSyncGateway,
  NodeSyncGatewayError,
} from './node-sync-gateway.js';

/**
 * Limite por IP, em memória por instância (com 2 instâncias o efetivo dobra, como no registro da VM). O nó chama a cada
 * 5 min (12 por hora, mais a segunda volta depois de aplicar e as novas tentativas); 120 por hora deixa folga para
 * vários nós atrás do mesmo NAT sem custo de Firestore nem de cp-worker para quem passa disso. O limite por cliente
 * (uma chamada a cada 20 s) fica no cp-worker, que sabe quem é o cliente.
 */
export const NODE_SYNC_PER_IP: RateLimitRule = { capacity: 120, windowMs: 60 * 60_000 };

export class NodeSyncRateLimits {
  readonly sync: TokenBucketLimiter;

  constructor(clock: Clock) {
    this.sync = new TokenBucketLimiter(NODE_SYNC_PER_IP, clock);
  }
}

export const NODE_SYNC_RATE_LIMITS = Symbol('NODE_SYNC_RATE_LIMITS');

export const NODE_SYNC_RATE_LIMITS_PROVIDER = {
  provide: NODE_SYNC_RATE_LIMITS,
  useFactory: (clock: Clock) => new NodeSyncRateLimits(clock),
  inject: [CLOCK],
};

const RATE_LIMITED = (): ApiError =>
  new ApiError(
    HttpStatus.TOO_MANY_REQUESTS,
    'Muitas tentativas. Tente novamente mais tarde.',
    'rate_limited',
  );

const ERRORS: Readonly<Record<Exclude<NodeSyncFailureCode, 'too_soon'>, () => ApiError>> = {
  invalid_request: () => new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'invalid_request'),
  clock_skew: () => new ApiError(HttpStatus.BAD_REQUEST, 'Pedido inválido', 'clock_skew'),
  unauthenticated: () => new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated'),
  not_found: () => new ApiError(HttpStatus.NOT_FOUND, 'Não encontrado', 'not_found'),
  stale_sequence: () => new ApiError(HttpStatus.CONFLICT, 'Pedido repetido', 'stale_sequence'),
  unavailable: () => new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'node_sync_unavailable'),
};

/** A credencial do nó na máscara do logger até a resposta terminar. */
function mask(value: string, res: Response): void {
  registerLiveSecret(value);
  res.on('close', () => forgetLiveSecret(value));
}

function requestIdOf(req: Request): string | undefined {
  const id = (req as Request & { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * A sincronização do nó dedicado, lado público (só no `cp-public`; docs/ARQUITETURA.md, "Sincronização com o plano de
 * controle"). Chamada por máquina: sem cookie e sem CORS (`NO_CORS_PATHS`), só JSON até 256 KB (o leitor próprio da
 * rota, `app.setup.ts`; as outras rotas seguem com 16 KB), erro sempre genérico e toda resposta com `Cache-Control:
 * private, no-store`.
 *
 * `POST /v1/node-sync` com `Authorization: Bearer <token do Google | nodeKey>` e o corpo do protocolo
 * (`nodeSyncRequestSchema`). Aqui só o que é barato: o limite por IP, o formato da credencial (e, no token, o `aud`, o
 * `sub` e o prazo, sem a assinatura) e o corpo estrito. Quem confere a credencial de verdade e escolhe o cliente é o
 * cp-worker (`/internal/node-sync/managed` ou `/customer`, pela credencial); o cp-public não lê o Firestore aqui. A credencial entra na máscara do logger
 * antes de qualquer `await` e sai quando a resposta termina.
 */
@Controller('node-sync')
export class NodeSyncController {
  constructor(
    @Inject(NODE_SYNC_GATEWAY) private readonly gateway: NodeSyncGateway,
    @Inject(NODE_SYNC_RATE_LIMITS) private readonly limits: NodeSyncRateLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(NodeSyncController.name) private readonly logger: PinoLogger,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async sync(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NodeSyncResponse> {
    const decision = this.limits.sync.take(`ip:${rateLimitKey(req.ip)}`);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw RATE_LIMITED();
    }
    if (req.is('application/json') !== 'application/json') {
      throw new ApiError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'Envie JSON', 'unsupported_media_type');
    }
    const credential = nodeSyncCredentialFromAuthorization(req.headers.authorization);
    if (credential === undefined) throw ERRORS.unauthenticated();
    // A rota do worker sai do formato do `Authorization` (o token assinado ou a chave do nó). Cada caminho faz as
    // conferências dele aqui, e o cp-worker confere a credencial inteira de novo na rota dela.
    const requestId = requestIdOf(req);
    let forward: (request: NodeSyncRequest) => Promise<NodeSyncResponse>;
    if (credential.kind === 'gcp_identity') {
      const token = credential.token;
      mask(token, res);
      if (!plausibleNodeIdentity(token, this.config.NODE_SYNC_AUDIENCE, this.clock.now())) {
        throw ERRORS.unauthenticated();
      }
      forward = (request) => this.gateway.syncManaged(token, request, requestId);
    } else {
      const nodeKey = credential.nodeKey;
      mask(nodeKey, res);
      forward = (request) => this.gateway.syncCustomer(nodeKey, request, requestId);
    }
    const parsed = nodeSyncRequestSchema.safeParse(body);
    if (!parsed.success) throw ERRORS.invalid_request();
    try {
      return await forward(parsed.data);
    } catch (error) {
      if (error instanceof NodeSyncGatewayError) {
        if (error.code === 'too_soon') {
          res.setHeader('Retry-After', String(error.retryAfterSeconds ?? 20));
          throw RATE_LIMITED();
        }
        throw ERRORS[error.code]();
      }
      this.logger.error(
        { event: 'node_sync_worker_failed', reason: error instanceof Error ? error.name : 'unknown' },
        'o cp-worker não respondeu à sincronização do nó',
      );
      throw ERRORS.unavailable();
    }
  }
}

import {
  type CanActivate,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';

/**
 * Quem pode chamar cada rota interna do cp-worker (plano §2.1 e §2.5). O ingresso do serviço já exige um token de
 * identidade do Google com `run.invoker` (run.tf: a cp-invoker, o cp-public e o responsável); o app separa as rotas
 * por quem chama, para que um token válido para uma não sirva na outra:
 * - `tasks`: as tasks e o Scheduler (`WORKER_SA_EMAIL` e `SCHEDULER_SA_EMAIL`, a cp-invoker) e o responsável
 *   (`OWNER_PRINCIPALS`): os passos, o `tick` e o `reconcile`;
 * - `public`: só a conta do cp-public (`PUBLIC_SA_EMAIL`): a revelação da senha. Um cp-public comprometido não
 *   dispara passo nenhum, e uma task não pede revelação.
 */
export type WorkerCallerGroup = 'tasks' | 'public';

const WORKER_CALLERS_KEY = 'verax:workerCallers';

/** Marca a rota (ou o controlador) com os grupos que podem chamá-la. Sem a marca, a guarda recusa. */
export const WorkerCallers = (...groups: WorkerCallerGroup[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(WORKER_CALLERS_KEY, groups);

/** Emissores dos tokens de identidade do Google. */
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;

const identityClaimsSchema = z.object({
  iss: z.enum(GOOGLE_ISSUERS),
  aud: z.string().max(512),
  email: z.string().max(254),
  email_verified: z.literal(true),
  exp: z.number().int().positive(),
});
export type IdentityClaims = z.infer<typeof identityClaimsSchema>;

/** Um JWT tem três partes base64url; acima disto não é um token de identidade do Google. */
const MAX_TOKEN_LENGTH = 4096;

/**
 * As declarações do token de identidade do cabeçalho `Authorization: Bearer <jwt>`. A assinatura não é conferida
 * aqui, e de propósito: quem a confere é o Cloud Run, na entrada (IAM com `run.invoker`), antes de a requisição chegar
 * ao contêiner, e o serviço não aceita chamada sem token (run.tf não dá `allUsers` ao cp-worker, e o tftest confere).
 * O Cloud Run pode inclusive entregar o token com a assinatura removida. O que o app faz é conferir as declarações
 * (`iss`, `aud`, `exp`, `email`) para separar as rotas por quem chama.
 */
export function readIdentityClaims(authorization: string | undefined): IdentityClaims | undefined {
  if (authorization === undefined || authorization.length > MAX_TOKEN_LENGTH + 7) return undefined;
  const [scheme, jwt, ...rest] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || jwt === undefined || rest.length > 0) return undefined;
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const result = identityClaimsSchema.safeParse(payload);
  return result.success ? result.data : undefined;
}

function normalizeAudience(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Os e-mails aceitos para um grupo, em minúsculas (vazio quando a configuração não os tem: a rota recusa tudo). */
export function allowedCallers(config: AppConfig, groups: readonly WorkerCallerGroup[]): Set<string> {
  const emails: (string | undefined)[] = [];
  for (const group of groups) {
    if (group === 'tasks') {
      emails.push(config.WORKER_SA_EMAIL, config.SCHEDULER_SA_EMAIL, ...(config.OWNER_PRINCIPALS ?? []));
    } else {
      emails.push(config.PUBLIC_SA_EMAIL);
    }
  }
  return new Set(emails.filter((email) => email !== undefined).map((email) => email.toLowerCase()));
}

/**
 * A guarda das rotas internas: token presente, do Google, para este serviço (`aud == WORKER_URL`), no prazo, com
 * e-mail verificado e no grupo da rota. Sem `WORKER_URL`, nada passa (503). Recusas vão ao log só com a rota e o
 * motivo, nunca o token nem o e-mail.
 */
@Injectable()
export class WorkerCallerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(WorkerCallerGuard.name) private readonly logger: PinoLogger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const groups = this.reflector.getAllAndOverride<WorkerCallerGroup[] | undefined>(WORKER_CALLERS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request>();
    const route = request.path;
    if (this.config.WORKER_URL === undefined) {
      this.logger.warn({ event: 'worker_caller_unconfigured', route }, 'rota interna sem WORKER_URL');
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'worker_unconfigured');
    }
    const claims = readIdentityClaims(request.headers.authorization);
    const valid =
      claims !== undefined &&
      normalizeAudience(claims.aud) === normalizeAudience(this.config.WORKER_URL) &&
      claims.exp * 1000 > this.clock.now().getTime();
    if (!valid) {
      this.logger.warn(
        { event: 'worker_caller_refused', route, reason: 'invalid_token' },
        'chamada recusada',
      );
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
    }
    if (groups === undefined || !allowedCallers(this.config, groups).has(claims.email.toLowerCase())) {
      this.logger.warn(
        { event: 'worker_caller_refused', route, reason: 'caller_not_allowed' },
        'chamada recusada',
      );
      throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'forbidden');
    }
    return true;
  }
}

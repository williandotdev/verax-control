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
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { IdentityTokenVerifier, selectValidatedCredential } from './identity-token.js';

/**
 * Quem pode chamar cada rota interna do cp-worker (plano §2.1 e §2.5). O ingresso do serviço já exige um token de
 * identidade do Google com `run.invoker` (run.tf: a cp-invoker, o cp-public e o responsável); o app confere o token de
 * novo (`identity-token.ts`) e separa as rotas por quem chama, para que um token válido para uma não sirva na outra:
 * - `tasks`: as tasks e o Scheduler (`WORKER_SA_EMAIL` e `SCHEDULER_SA_EMAIL`, a cp-invoker) e o responsável
 *   (`OWNER_PRINCIPALS`): os passos, o `tick` e o `reconcile`;
 * - `public`: só a conta do cp-public (`PUBLIC_SA_EMAIL`): a revelação da senha. Um cp-public comprometido não
 *   dispara passo nenhum, e uma task não pede revelação;
 * - `owner`: só o responsável (`OWNER_PRINCIPALS`): as operações dele, como o `resume` do provisionamento (CP-07).
 *   Nem a cp-invoker nem o cp-public: uma task ou o Scheduler não retomam um cliente que falhou.
 */
export type WorkerCallerGroup = 'tasks' | 'public' | 'owner';

/** O e-mail de quem chamou, em minúsculas, que a guarda deixa na requisição para a auditoria (`owner:<e-mail>`). */
export function workerCallerOf(request: Request): string | undefined {
  const caller = (request as Request & { workerCaller?: unknown }).workerCaller;
  return typeof caller === 'string' ? caller : undefined;
}

const WORKER_CALLERS_KEY = 'verax:workerCallers';

/** Marca a rota (ou o controlador) com os grupos que podem chamá-la. Sem a marca, a guarda recusa. */
export const WorkerCallers = (...groups: WorkerCallerGroup[]): ReturnType<typeof SetMetadata> =>
  SetMetadata(WORKER_CALLERS_KEY, groups);

/** Os e-mails aceitos para um grupo, em minúsculas (vazio quando a configuração não os tem: a rota recusa tudo). */
export function allowedCallers(config: AppConfig, groups: readonly WorkerCallerGroup[]): Set<string> {
  const emails: (string | undefined)[] = [];
  for (const group of groups) {
    if (group === 'tasks') {
      emails.push(config.WORKER_SA_EMAIL, config.SCHEDULER_SA_EMAIL, ...(config.OWNER_PRINCIPALS ?? []));
    } else if (group === 'owner') {
      emails.push(...(config.OWNER_PRINCIPALS ?? []));
    } else {
      emails.push(config.PUBLIC_SA_EMAIL);
    }
  }
  return new Set(emails.filter((email) => email !== undefined).map((email) => email.toLowerCase()));
}

/**
 * A guarda das rotas internas: a identidade sai do cabeçalho que o Cloud Run conferiu (os dois juntos são recusados),
 * o token é do Google, para este serviço (`aud == WORKER_URL`), no prazo, com e-mail verificado e assinatura conferida
 * (quando o Cloud Run não a removeu), e o e-mail é do grupo da rota. Sem `WORKER_URL`, nada passa (503). Recusas vão
 * ao log só com a rota e o motivo, nunca o token nem o e-mail.
 */
@Injectable()
export class WorkerCallerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly verifier: IdentityTokenVerifier,
    @InjectPinoLogger(WorkerCallerGuard.name) private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const groups = this.reflector.getAllAndOverride<WorkerCallerGroup[] | undefined>(WORKER_CALLERS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<Request>();
    const route = request.path;
    const audience = this.config.WORKER_URL;
    if (audience === undefined) {
      this.logger.warn({ event: 'worker_caller_unconfigured', route }, 'rota interna sem WORKER_URL');
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Indisponível', 'worker_unconfigured');
    }
    const credential = selectValidatedCredential(request.headers);
    if (credential.kind !== 'single') {
      const reason = credential.kind === 'missing' ? 'missing_token' : 'ambiguous_credentials';
      this.logger.warn({ event: 'worker_caller_refused', route, reason }, 'chamada recusada');
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
    }
    const verification = await this.verifier.verify(credential.header, credential.value, audience);
    if (!verification.ok) {
      this.logger.warn(
        { event: 'worker_caller_refused', route, reason: verification.reason, header: credential.header },
        'chamada recusada',
      );
      throw new ApiError(HttpStatus.UNAUTHORIZED, 'Não autenticado', 'unauthenticated');
    }
    const email = verification.claims.email.toLowerCase();
    if (groups === undefined || !allowedCallers(this.config, groups).has(email)) {
      this.logger.warn(
        { event: 'worker_caller_refused', route, reason: 'caller_not_allowed' },
        'chamada recusada',
      );
      throw new ApiError(HttpStatus.FORBIDDEN, 'Sem permissão', 'forbidden');
    }
    (request as Request & { workerCaller?: string }).workerCaller = email;
    return true;
  }
}

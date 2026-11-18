import { registerLiveSecret } from '../common/logger/sanitize.js';
import type { IdTokenSource } from '../status/id-token.js';
import {
  type ClaimRequest,
  type ClaimResponse,
  claimResponseSchema,
  type ReportRequest,
} from './enrollment.js';

/** Os desfechos do registro que a VM vê pelo código; qualquer outra falha é `unavailable`. */
export type EnrollmentFailureCode =
  'not_found' | 'unauthenticated' | 'release_mismatch' | 'invalid_request' | 'unavailable';

export class EnrollmentGatewayError extends Error {
  constructor(readonly code: EnrollmentFailureCode) {
    super(`registro recusado: ${code}`);
    this.name = 'EnrollmentGatewayError';
  }
}

/**
 * O caminho do cp-public até o registro da VM no cp-worker. O cp-public não lê o token do túnel, a senha do e-mail dos
 * nós nem o cofre da senha do primeiro admin: quem lê e grava é o cp-worker, com a identidade dele (como a revelação
 * da página de status). Implementações: `WorkerEnrollmentGateway` (produção) e, nos testes, um adaptador que chama o
 * `EnrollmentService` direto.
 */
export interface EnrollmentGateway {
  claim(request: ClaimRequest, requestId?: string): Promise<ClaimResponse>;
  report(nodeKey: string, report: ReportRequest, requestId?: string): Promise<void>;
}

export const ENROLLMENT_GATEWAY = Symbol('ENROLLMENT_GATEWAY');

/** Os códigos do worker que a VM pode ver, por status; o resto vira `unavailable`. */
const KNOWN_FAILURES: ReadonlyMap<number, EnrollmentFailureCode> = new Map([
  [400, 'invalid_request'],
  [401, 'unauthenticated'],
  [404, 'not_found'],
  [409, 'release_mismatch'],
]);

/** Até a resposta do worker (com a partida a frio dele): menos que os 60 s do rewrite do Hosting. */
const WORKER_TIMEOUT_MS = 25_000;

/**
 * `POST <WORKER_URL>/internal/node-enrollment/claim|report` com o token de identidade do cp-public. Os segredos da
 * resposta do `claim` (o token do túnel, a senha do e-mail e a chave do nó) entram na máscara do logger assim que o
 * JSON é lido, antes de qualquer outro passo; o texto da resposta nunca vai a log.
 */
export class WorkerEnrollmentGateway implements EnrollmentGateway {
  constructor(
    private readonly workerUrl: string,
    private readonly idTokens: IdTokenSource,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs: number = WORKER_TIMEOUT_MS,
  ) {}

  async claim(request: ClaimRequest, requestId?: string): Promise<ClaimResponse> {
    const text = await this.post('/internal/node-enrollment/claim', request, 200, requestId);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new EnrollmentGatewayError('unavailable');
    }
    const candidate = body as {
      tunnelToken?: unknown;
      nodeKey?: unknown;
      mail?: { password?: unknown } | null;
    } | null;
    for (const value of [candidate?.tunnelToken, candidate?.nodeKey, candidate?.mail?.password]) {
      if (typeof value === 'string') registerLiveSecret(value);
    }
    const parsed = claimResponseSchema.safeParse(body);
    if (!parsed.success) throw new EnrollmentGatewayError('unavailable');
    return parsed.data;
  }

  async report(nodeKey: string, report: ReportRequest, requestId?: string): Promise<void> {
    await this.post('/internal/node-enrollment/report', { nodeKey, report }, 204, requestId);
  }

  private async post(path: string, body: unknown, expected: number, requestId?: string): Promise<string> {
    const identity = await this.idTokens.get(this.workerUrl);
    const response = await this.fetchFn(new URL(path, this.workerUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity}`,
        'content-type': 'application/json',
        ...(requestId === undefined ? {} : { 'x-request-id': requestId }),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (response.status !== expected) {
      throw new EnrollmentGatewayError(KNOWN_FAILURES.get(response.status) ?? 'unavailable');
    }
    return text;
  }
}

/** Sem `WORKER_URL`: o registro responde 503 e nada é marcado. */
export class UnconfiguredEnrollmentGateway implements EnrollmentGateway {
  claim(): Promise<never> {
    return Promise.reject(new EnrollmentGatewayError('unavailable'));
  }

  report(): Promise<never> {
    return Promise.reject(new EnrollmentGatewayError('unavailable'));
  }
}

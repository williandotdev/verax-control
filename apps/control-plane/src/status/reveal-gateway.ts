import { z } from 'zod';
import type { StatusTokenKind } from '../access/status-token.js';
import { registerLiveSecret } from '../common/logger/sanitize.js';
import type { IdTokenSource } from './id-token.js';

export interface RevealRequest {
  kind: StatusTokenKind;
  /** O valor que o cliente apresentou (de dentro do cookie conferido, ou do link do e-mail). */
  token: string;
  requestId?: string;
}

/** A revelação como o site a recebe: uma vez, com `Cache-Control: private, no-store`. */
export interface RevealedAccessView {
  panelUrl: string;
  adminEmail: string;
  password: string;
  passwordExpiresAt: string;
}

/** Os desfechos que o site trata pelo código; qualquer outra falha é `reveal_unavailable`. */
export type RevealFailureCode =
  'not_found' | 'already_revealed' | 'reveal_not_available' | 'password_expired' | 'reveal_unavailable';

export class RevealGatewayError extends Error {
  constructor(readonly code: RevealFailureCode) {
    super(`revelação recusada: ${code}`);
    this.name = 'RevealGatewayError';
  }
}

/**
 * O caminho do cp-public até a revelação. O cp-public não lê o segredo: quem lê é o cp-worker, com a identidade dele
 * (plano §2.2). Implementações: `WorkerRevealGateway` (produção) e, nos testes, um adaptador que chama o
 * `RevealService` direto.
 */
export interface RevealGateway {
  reveal(request: RevealRequest): Promise<RevealedAccessView>;
}

export const REVEAL_GATEWAY = Symbol('REVEAL_GATEWAY');

const revealedSchema = z.strictObject({
  panelUrl: z.url({ protocol: /^https$/ }).max(300),
  adminEmail: z.email().max(254),
  password: z.string().min(1).max(256),
  passwordExpiresAt: z.iso.datetime({ offset: true }),
});

const failureSchema = z.object({ code: z.string().max(64).optional() });

/** Os códigos do worker que o site pode ver; o resto vira `reveal_unavailable`. */
const KNOWN_FAILURES: ReadonlyMap<number, readonly RevealFailureCode[]> = new Map([
  [404, ['not_found']],
  [409, ['already_revealed', 'reveal_not_available']],
  [410, ['password_expired']],
]);

function failureFrom(status: number, text: string): RevealFailureCode {
  const allowed = KNOWN_FAILURES.get(status);
  if (allowed === undefined) return 'reveal_unavailable';
  let code: string | undefined;
  try {
    code = failureSchema.parse(JSON.parse(text)).code;
  } catch {
    code = undefined;
  }
  return allowed.find((candidate) => candidate === code) ?? allowed[0] ?? 'reveal_unavailable';
}

/** Até a resposta do worker (com a partida a frio dele): menos que os 60 s do rewrite do Hosting. */
const WORKER_TIMEOUT_MS = 25_000;

/**
 * `POST <WORKER_URL>/internal/access/reveal` com o token de identidade do cp-public. A senha que volta entra na
 * máscara do logger assim que o JSON é lido, antes de qualquer outro passo; o texto da resposta nunca vai a log.
 */
export class WorkerRevealGateway implements RevealGateway {
  constructor(
    private readonly workerUrl: string,
    private readonly idTokens: IdTokenSource,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs: number = WORKER_TIMEOUT_MS,
  ) {}

  async reveal(request: RevealRequest): Promise<RevealedAccessView> {
    const identity = await this.idTokens.get(this.workerUrl);
    const response = await this.fetchFn(new URL('/internal/access/reveal', this.workerUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${identity}`,
        'content-type': 'application/json',
        ...(request.requestId === undefined ? {} : { 'x-request-id': request.requestId }),
      },
      body: JSON.stringify({ kind: request.kind, token: request.token }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (response.status !== 200) throw new RevealGatewayError(failureFrom(response.status, text));
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RevealGatewayError('reveal_unavailable');
    }
    const candidate = (body as { password?: unknown } | null)?.password;
    if (typeof candidate === 'string') registerLiveSecret(candidate);
    const parsed = revealedSchema.safeParse(body);
    if (!parsed.success) throw new RevealGatewayError('reveal_unavailable');
    return parsed.data;
  }
}

/** Sem `WORKER_URL`: a revelação responde 503 e nada é marcado. */
export class UnconfiguredRevealGateway implements RevealGateway {
  reveal(_request: RevealRequest): Promise<never> {
    return Promise.reject(new RevealGatewayError('reveal_unavailable'));
  }
}

import type { IncomingMessage } from 'node:http';

/** Rotas da página de status (CP-05): as únicas que recebem `credentials: true`, por causa do cookie `__session`. */
export const CREDENTIALED_PATH = '/v1/public/status';

/** O subconjunto das opções do pacote `cors` que o serviço usa. */
export interface CorsDecision {
  /** `false`: nenhum cabeçalho de CORS (o navegador bloqueia a leitura e o preflight cai no 404). */
  origin: boolean;
  credentials: boolean;
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  maxAge: number;
}

export type CorsDelegate = (
  req: IncomingMessage,
  callback: (error: Error | null, options: CorsDecision) => void,
) => void;

function pathOf(url: string | undefined): string {
  return (url ?? '').split('?', 1)[0] ?? '';
}

function isCredentialedPath(path: string): boolean {
  return path === CREDENTIALED_PATH || path.startsWith(`${CREDENTIALED_PATH}/`);
}

/**
 * CORS do `cp-public` (plano §2.4): só as origens do site (`SITE_ORIGINS`, comparadas pela origem normalizada),
 * `credentials` só nas rotas de status e `X-Request-Id` exposto. Função em vez de lista: outra origem não recebe
 * cabeçalho nenhum (nem a lista das permitidas), como na API. Sem origens configuradas, nenhuma é aceita.
 */
export function buildCorsDelegate(siteOrigins: readonly string[]): CorsDelegate {
  const allowed = new Set(siteOrigins.map((origin) => new URL(origin).origin));
  return (req, callback) => {
    const origin = req.headers.origin;
    const accepted = typeof origin === 'string' && allowed.has(origin);
    callback(null, {
      origin: accepted,
      credentials: accepted && isCredentialedPath(pathOf(req.url)),
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
      exposedHeaders: ['X-Request-Id'],
      maxAge: 600,
    });
  };
}

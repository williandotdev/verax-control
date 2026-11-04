import type { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { AppConfig } from '../common/config/config.module.js';

/**
 * Cloudflare Turnstile nos formulários públicos do painel: o widget gera um token no navegador, o painel o manda neste
 * header, e a API o confere no siteverify da Cloudflare antes de olhar a senha (ou o e-mail do pedido de redefinição).
 * Só vale com `TURNSTILE_SECRET_KEY` definida; sem ela, nenhuma destas rotas pede o token.
 */
export const TURNSTILE_TOKEN_HEADER = 'x-turnstile-token';

/** Rotas do Better Auth com o desafio: as que qualquer pessoa, sem sessão, chama a partir de um formulário. */
export const TURNSTILE_PATHS: ReadonlySet<string> = new Set(['/sign-in/email', '/request-password-reset']);

/** O siteverify responde em bem menos que isso; passou, a API recusa o login (fecha, não abre). */
export const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 5_000;

/** Tamanho máximo do token do widget, pela documentação da Cloudflare. Maior que isso nem vai ao siteverify. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** Sem token: o painel não mandou (widget não carregou, ou um cliente que não é o painel). */
export const TURNSTILE_REQUIRED = {
  code: 'TURNSTILE_REQUIRED',
  message: 'Conclua a verificação de segurança e tente de novo',
};
/** Token recusado pela Cloudflare (inválido, vencido ou já usado). */
export const TURNSTILE_FAILED = {
  code: 'TURNSTILE_FAILED',
  message: 'A verificação de segurança não foi aceita. Tente de novo',
};
/** Siteverify fora do ar: a mesma mensagem genérica do filtro de erros da API; o motivo fica só no log. */
export const TURNSTILE_UNAVAILABLE = {
  code: 'TURNSTILE_UNAVAILABLE',
  message: 'Serviço temporariamente indisponível',
};

export type TurnstileOutcome = 'ok' | 'required' | 'failed' | 'unavailable';

/** Resposta do siteverify (entrada externa: validada antes de decidir). Os campos a mais são descartados. */
const siteverifyResponse = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string().max(100)).max(20).default([]),
  challenge_ts: z.string().max(100).optional(),
  hostname: z.string().max(253).optional(),
});

export interface TurnstileVerifier {
  /** Confere o token do widget. Nunca lança: cada saída vira uma resposta própria no hook da autenticação. */
  verify(token: string | null | undefined, remoteIp: string | undefined): Promise<TurnstileOutcome>;
}

type TurnstileConfig = Pick<AppConfig, 'TURNSTILE_SECRET_KEY' | 'TURNSTILE_SITEVERIFY_URL'>;
type TurnstileLogger = Pick<PinoLogger, 'warn' | 'error'>;

/** Só o nome e o código do erro de rede: a mensagem poderia trazer a URL ou o corpo da requisição. */
function errorKind(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'unknown' };
  const cause = error.cause as { code?: unknown } | undefined;
  return { name: error.name, ...(typeof cause?.code === 'string' ? { code: cause.code } : {}) };
}

/**
 * Cliente do siteverify. Devolve `undefined` sem a chave secreta (Turnstile desligado). A chave e o token nunca saem
 * daqui: nem no log, nem na mensagem de erro.
 */
export function createTurnstileVerifier(
  config: TurnstileConfig,
  logger: TurnstileLogger,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): TurnstileVerifier | undefined {
  const { TURNSTILE_SECRET_KEY: secret, TURNSTILE_SITEVERIFY_URL: url } = config;
  if (typeof secret !== 'string') return undefined;

  return {
    async verify(token, remoteIp) {
      if (typeof token !== 'string' || token.length === 0) return 'required';
      if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
        logger.warn(
          { turnstile: { outcome: 'failed', reason: 'token-too-long' } },
          'token do Turnstile recusado',
        );
        return 'failed';
      }

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
          signal: AbortSignal.timeout(TURNSTILE_SITEVERIFY_TIMEOUT_MS),
        });
      } catch (error) {
        logger.error(
          { turnstile: { outcome: 'unavailable', error: errorKind(error) } },
          'siteverify do Turnstile fora do ar',
        );
        return 'unavailable';
      }
      if (!response.ok) {
        logger.error(
          { turnstile: { outcome: 'unavailable', status: response.status } },
          'siteverify do Turnstile respondeu com erro',
        );
        return 'unavailable';
      }

      const parsed = siteverifyResponse.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        logger.error(
          { turnstile: { outcome: 'unavailable', reason: 'invalid-response' } },
          'siteverify do Turnstile fora do formato',
        );
        return 'unavailable';
      }
      if (!parsed.data.success) {
        logger.warn(
          { turnstile: { outcome: 'failed', errorCodes: parsed.data['error-codes'] } },
          'token do Turnstile recusado',
        );
        return 'failed';
      }
      return 'ok';
    },
  };
}

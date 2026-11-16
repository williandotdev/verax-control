import { SSO_CLIENT_ID, type SsoTokenResponse, ssoTokenResponseSchema } from '@verax/shared';

/** O `fetch` usado na troca (o global; os testes trocam por um que chega ao console local). */
export type SsoFetch = (input: string, init: RequestInit) => Promise<Response>;

export const SSO_FETCH = Symbol('SSO_FETCH');

/** Teto da troca: o console responde em milissegundos; 5 s cobrem a partida a frio do Cloud Run sem prender o login. */
export const SSO_EXCHANGE_TIMEOUT_MS = 5_000;

/** A maior resposta lida do console (a real tem cerca de 700 bytes). */
const MAX_RESPONSE_BYTES = 16 * 1024;

export interface TokenExchangeRequest {
  tokenUrl: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export type TokenExchangeResult =
  | { ok: true; response: SsoTokenResponse }
  | { ok: false; reason: 'refused' | 'unavailable' | 'bad_response' };

/**
 * A troca do código pelo token de identidade no `POST /sso/token` do console, de servidor para servidor: só https (a
 * configuração já exige a origem https), JSON, 5 s de limite, sem seguir redirecionamento (uma resposta 3xx é recusa) e
 * com a resposta conferida pelo schema do contrato antes de qualquer uso. Nada da resposta vai a log.
 */
export async function exchangeCode(
  fetcher: SsoFetch,
  request: TokenExchangeRequest,
): Promise<TokenExchangeResult> {
  if (!request.tokenUrl.startsWith('https://')) return { ok: false, reason: 'unavailable' };
  let response: Response;
  try {
    response = await fetcher(request.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: request.code,
        redirect_uri: request.redirectUri,
        client_id: SSO_CLIENT_ID,
        code_verifier: request.codeVerifier,
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(SSO_EXCHANGE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (response.status >= 500) return { ok: false, reason: 'unavailable' };
  if (response.status !== 200) return { ok: false, reason: 'refused' };
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) return { ok: false, reason: 'bad_response' };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'bad_response' };
  }
  const parsed = ssoTokenResponseSchema.safeParse(body);
  return parsed.success ? { ok: true, response: parsed.data } : { ok: false, reason: 'bad_response' };
}

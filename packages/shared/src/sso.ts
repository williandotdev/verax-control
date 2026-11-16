import { z } from 'zod';

/**
 * Entrada única no SIEM da Verax pelo console do responsável (decisão de 15/11/2026; `docs/ARQUITETURA.md`, "Entrada
 * única: o console como provedor de identidade"). O console (`cp-admin`) é o provedor de identidade: o responsável entra
 * nele (e-mail, senha e TOTP) e o painel da equipe da Verax, na célula, aceita esse login. O protocolo é o fluxo de
 * código de autorização do OAuth 2.0 com PKCE (S256), no formato do OpenID Connect, reduzido ao mínimo:
 *
 * 1. a API da célula (`GET /v1/auth/sso/start`, só no endereço da equipe) gera `state`, `nonce` e o verificador do PKCE,
 *    guarda os três no banco presos a um cookie de pré-login e manda o navegador ao `GET /sso/authorize` do console;
 * 2. o console confere o cliente e o endereço de retorno (lista exata), exige a sessão do responsável (sem ela, o login
 *    do próprio console) e devolve um código de uso único, de 60 segundos;
 * 3. a API da célula troca o código no `POST /sso/token` do console, de servidor para servidor, com o verificador, e
 *    recebe um token de identidade assinado (EdDSA, Ed25519) de até 5 minutos;
 * 4. a API confere a assinatura com a chave pública **fixada** na configuração do nó, e não com uma chave baixada, além
 *    de `iss`, `aud`, prazo, `nonce`, `amr` e o `jti` de uso único, e abre a sessão normal do painel para o
 *    `admin_verax` que já existe com aquele e-mail.
 *
 * A célula só confere: a chave privada fica no Secret Manager do plano de controle, lida só pelo cp-admin. Este arquivo
 * é o contrato dos dois lados, sem nada de criptografia (o painel também importa o pacote): a assinatura e a conferência
 * ficam em cada app, com `node:crypto`.
 */

/** O único cliente aceito pelo console: o SIEM da Verax (o painel da equipe na célula). */
export const SSO_CLIENT_ID = 'verax-siem' as const;

/** O único algoritmo de assinatura: EdDSA com Ed25519 (RFC 8037). Nenhum outro é aceito, nem `none`. */
export const SSO_ALG = 'EdDSA' as const;

/** O código de autorização vale 60 segundos e uma vez. */
export const SSO_CODE_TTL_SECONDS = 60;

/** O token de identidade vale no máximo 5 minutos. */
export const SSO_ID_TOKEN_TTL_SECONDS = 300;

/** Folga de relógio entre o console e a célula na conferência do prazo. */
export const SSO_CLOCK_SKEW_SECONDS = 30;

/** O maior token de identidade aceito (o real tem cerca de 600 caracteres). */
export const SSO_ID_TOKEN_MAX_LENGTH = 4096;

/** Como o responsável entrou no console: senha (`pwd`) e código de uso único do aplicativo (`otp`), RFC 8176. */
export const SSO_AMR = ['pwd', 'otp'] as const;

/** Os caminhos do provedor de identidade no console (fora do prefixo `/v1`, como no OpenID Connect). */
export const SSO_PATHS = {
  authorize: '/sso/authorize',
  token: '/sso/token',
  jwks: '/sso/jwks',
} as const;

/**
 * Um valor aleatório de 32 bytes em base64url, sem preenchimento (43 caracteres): o `state`, o `nonce`, o código, o
 * `jti` e o desafio do PKCE (o SHA-256 do verificador).
 */
export const ssoOpaqueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** O verificador do PKCE (RFC 7636): 43 a 128 caracteres do alfabeto sem reserva. */
export const ssoCodeVerifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);

/** O endereço de retorno: texto curto, comparado por igualdade exata com a lista do console. */
const redirectUriField = z.string().min(1).max(200);

/** `GET /sso/authorize`: os parâmetros, todos obrigatórios, nenhum a mais. */
export const ssoAuthorizeQuerySchema = z.strictObject({
  response_type: z.literal('code'),
  client_id: z.string().max(64),
  redirect_uri: redirectUriField,
  state: ssoOpaqueSchema,
  nonce: ssoOpaqueSchema,
  code_challenge: ssoOpaqueSchema,
  code_challenge_method: z.literal('S256'),
});
export type SsoAuthorizeQuery = z.infer<typeof ssoAuthorizeQuerySchema>;

/** `POST /sso/token` (JSON, de servidor para servidor). */
export const ssoTokenRequestSchema = z.strictObject({
  grant_type: z.literal('authorization_code'),
  code: ssoOpaqueSchema,
  redirect_uri: redirectUriField,
  client_id: z.string().max(64),
  code_verifier: ssoCodeVerifierSchema,
});
export type SsoTokenRequest = z.infer<typeof ssoTokenRequestSchema>;

/** A resposta do `POST /sso/token`: só o token de identidade (não há token de acesso). */
export const ssoTokenResponseSchema = z.strictObject({
  id_token: z.string().min(1).max(SSO_ID_TOKEN_MAX_LENGTH),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(SSO_ID_TOKEN_TTL_SECONDS),
});
export type SsoTokenResponse = z.infer<typeof ssoTokenResponseSchema>;

/** O id da chave (`kid`): a impressão digital RFC 7638 da chave pública, SHA-256 em base64url. */
export const ssoKeyIdSchema = ssoOpaqueSchema;

/**
 * O cabeçalho do token: exatamente `alg`, `typ` e `kid`. Qualquer outro campo (`jku`, `jwk`, `x5u`, `crit`...) é
 * recusado, para nada no token dizer de onde vem a chave.
 */
export const ssoIdTokenHeaderSchema = z.strictObject({
  alg: z.literal(SSO_ALG),
  typ: z.literal('JWT'),
  kid: ssoKeyIdSchema,
});
export type SsoIdTokenHeader = z.infer<typeof ssoIdTokenHeaderSchema>;

const epochSeconds = z.number().int().positive().max(4_102_444_800);

/** As declarações do token de identidade. Estritas: um campo a mais recusa o token. */
export const ssoIdTokenClaimsSchema = z.strictObject({
  /** A origem do console (`https://admin...`). */
  iss: z.string().min(1).max(200),
  /** Sempre o cliente (texto, nunca lista). */
  aud: z.string().min(1).max(64),
  /** O id estável da conta do responsável no console (SHA-256 em hexadecimal). */
  sub: z.string().regex(/^[0-9a-f]{64}$/),
  email: z.email().max(254),
  nonce: ssoOpaqueSchema,
  iat: epochSeconds,
  exp: epochSeconds,
  /** Quando o responsável entrou no console (o login com senha e código). */
  auth_time: epochSeconds,
  jti: ssoOpaqueSchema,
  amr: z
    .array(z.string().regex(/^[a-z]{2,8}$/))
    .min(1)
    .max(4),
});
export type SsoIdTokenClaims = z.infer<typeof ssoIdTokenClaimsSchema>;

/** Uma chave pública no JWKS do console (`GET /sso/jwks`). */
export const ssoJwkSchema = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: ssoOpaqueSchema,
  kid: ssoKeyIdSchema,
  alg: z.literal(SSO_ALG),
  use: z.literal('sig'),
});
export type SsoJwk = z.infer<typeof ssoJwkSchema>;

export const ssoJwksSchema = z.strictObject({ keys: z.array(ssoJwkSchema).min(1).max(2) });

/**
 * O JSON da impressão digital RFC 7638 de uma chave Ed25519: só os membros obrigatórios, em ordem alfabética, sem
 * espaços. O SHA-256 dele, em base64url, é o `kid` (cada app calcula o hash com o próprio `node:crypto`).
 */
export function ssoThumbprintInput(x: string): string {
  return JSON.stringify({ crv: 'Ed25519', kty: 'OKP', x });
}

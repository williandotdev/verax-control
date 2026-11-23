import {
  CLOUDFLARE_OAUTH_ISSUER,
  cloudflareOauthCallbackError,
  cloudflareOauthCodeSchema,
  parseCloudflareOauthState,
} from '@verax/shared';

/** O retorno do Cloudflare conferido: o que segue ao painel, e o subdomínio de qual painel. */
export interface CloudflareCallback {
  slug: string;
  /** O fragmento para o painel, já codificado, sem o `#`. */
  fragment: string;
}

/** O maior código, o `state` e os parâmetros descartados, codificados (`%XX`), com folga. */
export const CALLBACK_QUERY_MAX_LENGTH = 8192;
const IGNORED_VALUE_MAX_LENGTH = 2048;
const ERROR_MAX_LENGTH = 64;

/**
 * Parâmetros que o Cloudflare pode mandar e ninguém usa: os escopos concedidos (o worker do nó confere os da troca) e a
 * explicação do erro, que nunca é repassada.
 */
const IGNORED_PARAMETERS: ReadonlySet<string> = new Set([
  'scope',
  'error_description',
  'error_uri',
  'error_hint',
  'error_debug',
]);
const USED_PARAMETERS: ReadonlySet<string> = new Set(['code', 'state', 'iss', 'error']);

/** Os parâmetros, cada um uma vez; repetido, desconhecido ou grande demais: `null`. */
function readParameters(raw: string): Map<string, string> | null {
  if (raw.length > CALLBACK_QUERY_MAX_LENGTH) return null;
  const values = new Map<string, string>();
  for (const [name, value] of new URLSearchParams(raw)) {
    if (values.has(name)) return null;
    if (!USED_PARAMETERS.has(name) && !IGNORED_PARAMETERS.has(name)) return null;
    if (value.length > IGNORED_VALUE_MAX_LENGTH) return null;
    values.set(name, value);
  }
  return values;
}

/**
 * Confere a query do retorno, lida crua: o leitor de query do Express (listas, objetos) não participa. Parâmetro
 * repetido ou desconhecido, fora do alfabeto ou do tamanho, sem `state`, com `code` e `error` juntos ou sem nenhum dos
 * dois: `null`. O `iss`, quando vem, só passa se for o do Cloudflare; quando não vem, quem decide é a API do nó.
 */
export function parseCallbackQuery(raw: string): CloudflareCallback | null {
  const values = readParameters(raw);
  if (values === null) return null;
  const state = values.get('state');
  const parsed = state === undefined ? null : parseCloudflareOauthState(state);
  if (state === undefined || parsed === null) return null;
  const iss = values.get('iss');
  if (iss !== undefined && iss !== CLOUDFLARE_OAUTH_ISSUER) return null;

  const fragment = new URLSearchParams();
  const code = values.get('code');
  const error = values.get('error');
  if (code !== undefined && error === undefined) {
    if (!cloudflareOauthCodeSchema.safeParse(code).success) return null;
    fragment.set('code', code);
  } else if (error !== undefined && code === undefined) {
    if (error === '' || error.length > ERROR_MAX_LENGTH) return null;
    fragment.set('error', cloudflareOauthCallbackError(error));
  } else {
    return null;
  }
  fragment.set('state', state);
  if (iss !== undefined) fragment.set('iss', iss);
  return { slug: parsed.slug, fragment: fragment.toString() };
}

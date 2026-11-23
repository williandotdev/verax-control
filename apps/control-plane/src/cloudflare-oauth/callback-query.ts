import {
  CLOUDFLARE_OAUTH_ISSUER,
  cloudflareOauthCallbackError,
  cloudflareOauthCodeSchema,
  parseCloudflareOauthState,
} from '@verax/shared';
import { z } from 'zod';

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

/** Um parâmetro que o Cloudflare pode mandar e ninguém usa: aceito e descartado. */
const ignored = z.string().max(IGNORED_VALUE_MAX_LENGTH).optional();

/** O `state` com o subdomínio dele, conferidos. */
const stateSchema = z.string().transform((state, context) => {
  const parsed = parseCloudflareOauthState(state);
  if (parsed !== null) return { state, slug: parsed.slug };
  context.addIssue({ code: 'custom', message: 'state inválido' });
  return z.NEVER;
});

/**
 * O retorno inteiro, estrito: um `state`, e o `code` ou o `error` (nunca os dois). O `iss`, quando vem, é o do Cloudflare.
 * Os escopos concedidos (o worker do nó confere os da troca) e a explicação do erro são descartados: nunca seguem.
 */
const querySchema = z
  .strictObject({
    state: stateSchema,
    code: cloudflareOauthCodeSchema.optional(),
    error: z.string().min(1).max(ERROR_MAX_LENGTH).transform(cloudflareOauthCallbackError).optional(),
    iss: z.literal(CLOUDFLARE_OAUTH_ISSUER).optional(),
    scope: ignored,
    error_description: ignored,
    error_uri: ignored,
    error_hint: ignored,
    error_debug: ignored,
  })
  .refine(({ code, error }) => (code === undefined) !== (error === undefined), { error: 'code ou error' });

/**
 * Confere a query do retorno, lida crua: o leitor de query do Express (listas, objetos) não participa. Parâmetro
 * repetido ou desconhecido, fora do alfabeto ou do tamanho, sem `state`, com `code` e `error` juntos ou sem nenhum dos
 * dois: `null`. Sem `iss`, quem decide é a API do nó.
 */
export function parseCallbackQuery(raw: string): CloudflareCallback | null {
  if (raw.length > CALLBACK_QUERY_MAX_LENGTH) return null;
  const entries = [...new URLSearchParams(raw)];
  const names = new Set(entries.map(([name]) => name));
  if (names.size !== entries.length) return null;
  const parsed = querySchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) return null;

  const { state, code, error, iss } = parsed.data;
  const fragment = new URLSearchParams(
    Object.entries({ code, error, state: state.state, iss }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return { slug: state.slug, fragment: fragment.toString() };
}

import { type CloudflareOauthComplete, cloudflareOauthCompleteSchema } from '@verax/shared';
import { z } from 'zod';

/**
 * O retorno do Cloudflare chega ao painel no fragmento (`#code=…&state=…&iss=…` ou `#error=…&state=…`), repassado pelo
 * plano de controle. O fragmento não vai a servidor nenhum, nem ao log ou ao `Referer`.
 *
 * - `none`: a página foi aberta sem fragmento (recarregada, ou pelo histórico depois de tratada);
 * - `invalid`: fragmento fora do formato (campo repetido, desconhecido ou fora do alfabeto): nada é enviado à API;
 * - `return`: o que vai no `complete`.
 */
export type CloudflareReturn =
  { kind: 'none' } | { kind: 'invalid' } | { kind: 'return'; input: CloudflareOauthComplete };

const CODE_FIELDS = ['code', 'iss', 'state'] as const;
const ERROR_FIELDS = ['error', 'state'] as const;
/** O repasse manda o `iss` quando o Cloudflare o manda, também com o erro; ali ele não decide nada e não segue. */
const ERROR_WITH_ISSUER_FIELDS = ['error', 'iss', 'state'] as const;
/** O fragmento inteiro tem teto: o código (até 1.024), o `state`, o emissor e os nomes cabem com folga. */
const MAX_FRAGMENT_LENGTH = 2_048;

/**
 * Lê o retorno de um fragmento (sem o `#`). Só aceita exatamente os campos de um dos formatos, uma vez cada. O código sem
 * o `iss` não é aceito: a API o recusaria do mesmo jeito (emissor ausente é recusa).
 */
export function parseCloudflareReturn(fragment: string): CloudflareReturn {
  if (fragment === '') return { kind: 'none' };
  if (fragment.length > MAX_FRAGMENT_LENGTH) return { kind: 'invalid' };
  const params = new URLSearchParams(fragment);
  const keys = [...params.keys()].sort();
  if (new Set(keys).size !== keys.length) return { kind: 'invalid' };
  const same = (expected: readonly string[]) =>
    keys.length === expected.length && expected.every((key, index) => keys[index] === key);
  if (same(ERROR_WITH_ISSUER_FIELDS)) params.delete('iss');
  else if (!same(CODE_FIELDS) && !same(ERROR_FIELDS)) return { kind: 'invalid' };
  const parsed = cloudflareOauthCompleteSchema.safeParse(Object.fromEntries(params));
  return parsed.success ? { kind: 'return', input: parsed.data } : { kind: 'invalid' };
}

/**
 * Lê o retorno uma única vez e o apaga da barra de endereço na hora (antes de qualquer chamada à API), para ele não ficar
 * no histórico, numa captura de tela ou num favorito. Nada dele vai para armazenamento nenhum.
 */
export function takeCloudflareReturn(): CloudflareReturn {
  const fragment = window.location.hash.slice(1);
  if (window.location.hash !== '') {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }
  return parseCloudflareReturn(fragment);
}

/** O parâmetro da tentativa já tratada: a página volta a acompanhá-la se for recarregada. Não é segredo. */
export const ATTEMPT_PARAM = 'tentativa';
const attemptIdSchema = z.uuid();

export function attemptIdOf(search: string): string | null {
  const id = new URLSearchParams(search).get(ATTEMPT_PARAM);
  const parsed = attemptIdSchema.safeParse(id);
  return parsed.success ? parsed.data : null;
}

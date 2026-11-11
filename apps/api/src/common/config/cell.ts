/**
 * Célula compartilhada (CE-01): um nó que atende vários clientes do Plataforma. Cada cliente continua com o próprio
 * endereço, como no nó dedicado: o painel em `https://<slug>.control.<domínio>` e a API em `api-<slug>.<domínio>`. Os
 * nomes `api-*` apontam todos para o túnel da célula, que repassa o `Host` como veio; a API amarra cada requisição ao
 * cliente desse endereço (`auth/host-tenant.ts`).
 *
 * Aqui ficam só as regras puras (sem banco nem Nest), usadas pela configuração e pela API: o formato do subdomínio, o
 * do domínio e os endereços derivados dos dois. Nenhum domínio fica escrito no código: vem de `CELL_DOMAIN`.
 */

/** Modo do nó: `dedicated` (um cliente por nó, o padrão de sempre) ou `cell` (célula compartilhada). */
export const NODE_MODES = ['dedicated', 'cell'] as const;
export type NodeMode = (typeof NODE_MODES)[number];

/** A célula: o domínio dos endereços e o subdomínio da equipe da Verax (o único onde o `admin_verax` entra). */
export interface CellConfig {
  domain: string;
  staffSlug: string;
}

/**
 * Subdomínio de cliente: a regra do `slugSchema` do plano de controle e do `isTenantSlug` do painel (3 a 16 caracteres
 * entre `a-z`, `0-9` e `-`, começando por letra e terminando em letra ou dígito, sem hífen na 3.ª e na 4.ª posições).
 * A expressão é ancorada e sem repetição aninhada: o tempo é linear no tamanho do texto, que vem do header `Host`.
 */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;

export function isTenantSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && value.slice(2, 4) !== '--';
}

/** Rótulo de DNS em minúsculas: 1 a 63 caracteres entre `a-z`, `0-9` e `-`, sem hífen nas pontas. */
const DNS_LABEL_CHARS = /^[a-z0-9-]{1,63}$/;
const DOMAIN_MAX_LENGTH = 200;

function isDnsLabel(label: string): boolean {
  return DNS_LABEL_CHARS.test(label) && !label.startsWith('-') && !label.endsWith('-');
}

/** Domínio da célula: dois ou mais rótulos em minúsculas, sem ponto no fim (`exemplo.com.br`). */
export function isCellDomain(value: string): boolean {
  if (value.length === 0 || value.length > DOMAIN_MAX_LENGTH) return false;
  const labels = value.split('.');
  return labels.length >= 2 && labels.every(isDnsLabel);
}

/** Nome da API de um cliente na célula: `api-<slug>.<domínio>` (o mesmo que o painel deriva do próprio endereço). */
export function cellApiHost(cell: Pick<CellConfig, 'domain'>, slug: string): string {
  return `api-${slug}.${cell.domain}`;
}

/** Origem do painel de um cliente na célula: `https://<slug>.control.<domínio>`. */
export function cellPanelOrigin(cell: Pick<CellConfig, 'domain'>, slug: string): string {
  return `https://${slug}.control.${cell.domain}`;
}

/** O maior `Host` possível: `api-`, o subdomínio mais longo, o ponto e o domínio mais longo. */
const HOST_MAX_LENGTH = 'api-'.length + 16 + 1 + DOMAIN_MAX_LENGTH;

/**
 * Subdomínio do cliente a partir do `Host` da requisição. Estrito: exatamente `api-<slug>.<domínio>`, sem porta, sem
 * ponto no fim, sem maiúsculas e sem nada além disso. Qualquer outra forma (IP, `localhost`, outro domínio, um rótulo a
 * mais) devolve `undefined`, e a requisição recebe 404. Nada é normalizado: só comparado.
 */
export function slugFromApiHost(cell: Pick<CellConfig, 'domain'>, host: unknown): string | undefined {
  if (typeof host !== 'string' || host.length > HOST_MAX_LENGTH) return undefined;
  const suffix = `.${cell.domain}`;
  if (!host.startsWith('api-') || !host.endsWith(suffix)) return undefined;
  const slug = host.slice('api-'.length, host.length - suffix.length);
  return isTenantSlug(slug) ? slug : undefined;
}

/**
 * Painel de build único: o mesmo bundle serve todos os clientes. `VITE_API_URL` pode trazer o marcador `{tenant}`
 * (`https://api-{tenant}.veraxsistemas.com.br`), trocado em tempo de execução pelo cliente do endereço do painel:
 * `<cliente>.control.veraxsistemas.com.br` chama `https://api-<cliente>.veraxsistemas.com.br`.
 *
 * A troca é estrita: exatamente um rótulo antes do domínio dos painéis, e esse rótulo segue a regra do subdomínio do
 * cliente. Em qualquer outro endereço (o bundle copiado para outro domínio, o `<site>.web.app` do Firebase, um IP), o
 * painel não deriva API nenhuma: mostra um aviso e não chama nada (`main.tsx`). Sem o marcador (build de um destino
 * só, a demonstração e o desenvolvimento local), a URL vale como está, em qualquer endereço, como antes.
 *
 * Sem dependências e sem `window`: o mesmo código roda no navegador, no build (`build-guards.ts`) e nos testes.
 */

export const TENANT_PLACEHOLDER = '{tenant}';

/** Domínio dos painéis de cliente: um site do Firebase Hosting por cliente, em `<cliente>.control...`. */
export const PANEL_DOMAIN = 'control.veraxsistemas.com.br';

/**
 * Domínios locais aceitos além do domínio dos painéis, com a mesma regra de um rótulo só: `<cliente>.localhost`, que
 * o navegador sempre resolve para a própria máquina (RFC 6761). Serve para experimentar o build único sem DNS;
 * nenhum servidor de fora responde por esses nomes.
 */
export const LOCAL_PANEL_DOMAINS: readonly string[] = ['localhost'];

const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 16;

const isLowercaseLetter = (char: string): boolean => char >= 'a' && char <= 'z';
const isDigit = (char: string): boolean => char >= '0' && char <= '9';

/**
 * Subdomínio de cliente: 3 a 16 caracteres entre `a-z`, `0-9` e `-`, começando por letra e terminando em letra ou
 * dígito (a regra do `slugSchema` do plano de controle). Recusa também hífen na 3.ª e na 4.ª posições: são os rótulos
 * reservados do DNS (RFC 5891), como o `xn--` dos domínios internacionalizados, que o navegador mostraria com outros
 * caracteres. Laço por caractere, linear, em vez de expressão regular sobre texto vindo do endereço.
 */
export function isTenantSlug(value: string): boolean {
  if (value.length < SLUG_MIN_LENGTH || value.length > SLUG_MAX_LENGTH) return false;
  if (value.charAt(2) === '-' && value.charAt(3) === '-') return false;
  const last = value.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const char = value.charAt(index);
    if (isLowercaseLetter(char)) continue;
    if (index === 0) return false;
    if (isDigit(char)) continue;
    if (char === '-' && index !== last) continue;
    return false;
  }
  return true;
}

/**
 * Cliente do endereço do painel: o primeiro rótulo de `<cliente>.control.veraxsistemas.com.br` (ou de
 * `<cliente>.localhost`), se ele for um subdomínio válido. Qualquer outra forma devolve `undefined`: rótulos a mais,
 * o domínio dos painéis sem cliente, letra maiúscula, ponto final, IP. O `location.hostname` do navegador já chega
 * em minúsculas e em punycode; aqui nada é normalizado, só comparado.
 */
export function tenantFromHostname(hostname: string): string | undefined {
  const dot = hostname.indexOf('.');
  if (dot <= 0) return undefined;
  const parent = hostname.slice(dot + 1);
  if (parent !== PANEL_DOMAIN && !LOCAL_PANEL_DOMAINS.includes(parent)) return undefined;
  const label = hostname.slice(0, dot);
  return isTenantSlug(label) ? label : undefined;
}

/** Troca o marcador pelo cliente. O cliente passa pela regra do subdomínio antes de entrar em qualquer endereço. */
export function fillTenant(template: string, tenant: string): string {
  if (!isTenantSlug(tenant)) throw new Error('Subdomínio de cliente inválido');
  return template.replaceAll(TENANT_PLACEHOLDER, tenant);
}

export type ApiAddress = { ok: true; url: string } | { ok: false };

/**
 * URL da API do painel aberto em `hostname`. Sem o marcador, a URL configurada vale como está. Com ele, só um
 * endereço de cliente resolve; nos outros, `{ ok: false }` e o painel não chama nada.
 */
export function resolveApiUrl(configured: string, hostname: string): ApiAddress {
  if (!configured.includes(TENANT_PLACEHOLDER)) return { ok: true, url: configured };
  const tenant = tenantFromHostname(hostname);
  return tenant === undefined ? { ok: false } : { ok: true, url: fillTenant(configured, tenant) };
}

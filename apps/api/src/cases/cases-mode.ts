import { CASE_MODES, type Role } from '@verax/shared';

/**
 * `CASES_MODE`, a chave dos casos. A mesma no ambiente do worker e no da API, conferida na partida:
 * - `off` (padrão): no worker, nenhuma tarefa dos casos roda, e o nó fica como antes deles; na API, as rotas dos casos
 *   não existem para ninguém;
 * - `shadow`: os alertas ganham caso, e só a equipe da Verax lê os casos, para conferir a medição no nó piloto;
 * - `on`: todos os papéis leem os casos do próprio cliente (os avisos por caso vêm depois).
 */
export const CASES_MODES = CASE_MODES;
export type CasesMode = (typeof CASES_MODES)[number];

/**
 * Os casos existem para quem está vendo? Com `shadow`, só para a equipe da Verax. Quem dela está vendo o painel como o
 * cliente (`STAFF_CUSTOMER_VIEW`) vale como o cliente.
 */
export function casesVisibleTo(mode: CasesMode, role: Role): boolean {
  return mode === 'on' || (mode === 'shadow' && role === 'admin_verax');
}

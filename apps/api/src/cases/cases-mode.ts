import { CASE_MODES, type Role } from '@verax/shared';

/**
 * `CASES_MODE`, a chave dos casos. A mesma no ambiente do worker e no da API, conferida na partida:
 * - `off` (padrão): no worker, nenhuma tarefa dos casos roda, e o nó fica como antes deles; na API, as rotas dos casos
 *   não existem para ninguém;
 * - `shadow`: os alertas ganham caso, e só a equipe da Verax lê os casos, para conferir a medição no nó piloto;
 * - `on`: todos os papéis leem os casos do próprio cliente, quem faz triagem opera em massa, e os avisos por e-mail dos
 *   alertas são por caso, e não mais um por alerta.
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

/**
 * As escritas dos casos (triagem em massa, dividir um caso) existem? Só com `on`: na medição (`shadow`) ninguém opera, nem
 * a equipe da Verax, e o worker não roda a fila delas.
 */
export function casesOperable(mode: CasesMode): boolean {
  return mode === 'on';
}

/**
 * Os avisos por e-mail dos alertas são por caso? Só com `on`: com `off` e com `shadow`, o `FindingStore` avisa alerta por
 * alerta, como antes dos casos.
 */
export function casesNoticed(mode: CasesMode): boolean {
  return mode === 'on';
}

/**
 * `CASES_MODE`, a chave dos casos no worker:
 * - `off` (padrão): nenhuma tarefa dos casos roda, e o nó fica como antes deles;
 * - `shadow`: os alertas ganham caso, e nada usa os casos;
 * - `on`: o mesmo, por enquanto (a leitura, a tela e os avisos por caso vêm depois).
 */
export const CASES_MODES = ['off', 'shadow', 'on'] as const;
export type CasesMode = (typeof CASES_MODES)[number];

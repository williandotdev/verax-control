/** Um valor de célula do CSV. */
export type CsvCell = string | number | boolean | null | undefined;

/**
 * Texto que uma planilha leria como fórmula (`=`, `+`, `-`, `@`, tabulação ou retorno no começo) ganha um apóstrofo:
 * um nome de usuário ou recurso vindo do alerta nunca vira fórmula ao abrir o arquivo (injeção de CSV).
 */
function neutralize(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  // Identificador só de dígitos (conta AWS, regra do Wazuh) vai como ="012345678901", que a planilha mostra como
  // texto: sem isso, o Excel o converte em número, tira o zero à esquerda e mostra a conta em notação científica.
  // Só dígitos entram nessa forma, então ela nunca leva conteúdo do alerta para dentro de uma fórmula.
  if (typeof value === 'string' && /^\d+$/.test(value)) return `"=""${value}"""`;
  const text = typeof value === 'string' ? neutralize(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Marca de ordem de bytes do UTF-8: sem ela, o Excel lê os acentos errado. */
export const BOM = String.fromCharCode(0xfeff);

/**
 * Separador de campos: ponto e vírgula, o separador de lista do Excel em português (com vírgula, o arquivo aberto com
 * dois cliques cai inteiro na primeira coluna). Os números dos relatórios são inteiros: não há conflito com a vírgula
 * decimal.
 */
export const SEPARATOR = ';';

/** CSV com cabeçalho, separado por ponto e vírgula, linhas em CRLF e BOM do UTF-8 (para o Excel ler os acentos). */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return `${BOM}${[header, ...rows].map((row) => row.map(cell).join(SEPARATOR)).join('\r\n')}\r\n`;
}

/** Baixa o CSV no navegador, sem passar por servidor. */
export function downloadCsv(filename: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

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
  const text = typeof value === 'string' ? neutralize(value) : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** Marca de ordem de bytes do UTF-8: sem ela, o Excel lê os acentos errado. */
export const BOM = String.fromCharCode(0xfeff);

/** CSV com cabeçalho, separado por vírgula, linhas em CRLF e BOM do UTF-8 (para o Excel ler os acentos). */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  return `${BOM}${[header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
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

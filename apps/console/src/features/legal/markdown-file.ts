import { MAX_LEGAL_TEXT_BYTES } from './kinds';

/**
 * Exportar e importar o texto de uma versão como arquivo Markdown (`.md`), para o responsável mandar ao advogado e
 * trazer de volta a revisão. A validação de verdade é a da API, na gravação.
 */
export function downloadMarkdown(filename: string, text: string): void {
  const blob = new Blob([text.endsWith('\n') ? text : `${text}\n`], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export class MarkdownImportError extends Error {}

/** O texto do arquivo, sem a marca de ordem de bytes do início e com as quebras de linha do Windows trocadas. */
export async function readMarkdownFile(file: File): Promise<string> {
  if (file.size > MAX_LEGAL_TEXT_BYTES) {
    throw new MarkdownImportError('O arquivo passa de 100 KB, o teto de um texto legal.');
  }
  const text = await file.text();
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n?/g, '\n');
}

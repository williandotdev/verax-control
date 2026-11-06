/**
 * Exportar e importar o conteúdo de uma versão como arquivo JSON, para o responsável guardar os números fora do
 * repositório (que é público) e começar a primeira versão a partir do arquivo dele. A importação aceita o conteúdo
 * puro ou o registro exportado (`{ version, content }`); a validação de verdade é a da API, na gravação.
 */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export class ImportError extends Error {}

export async function readJsonContent(file: File): Promise<unknown> {
  if (file.size > 256 * 1024)
    throw new ImportError('O arquivo passa de 256 KB: não parece uma versão do console.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new ImportError('O arquivo não é um JSON válido.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ImportError('O arquivo precisa ter um objeto JSON.');
  }
  const record = parsed as Record<string, unknown>;
  if ('content' in record && typeof record['content'] === 'object' && record['content'] !== null) {
    return record['content'];
  }
  return record;
}

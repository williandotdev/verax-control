import { describe, expect, it } from 'vitest';
import workflow from '../../../../../.github/workflows/painel.yml?raw';
import source from './aws-reader-template.ts?raw';

/** Os caminhos do filtro `on.push.paths` do workflow, na ordem em que estão escritos. */
function pushPaths(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf('    paths:');
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^ {6}- '([^']+)'$/.exec(line);
    if (match?.[1] === undefined) break;
    paths.push(match[1]);
  }
  return paths;
}

/**
 * O template do papel de leitura entra no bundle do painel como recurso (`aws-reader-template.ts`): a demonstração
 * publicada serve o arquivo do commit em que foi construída. Uma mudança só no template, sem tocar em `apps/web`, tem
 * de publicar a demonstração de novo; senão, ela seguiria servindo (e preenchendo) o template anterior.
 */
describe('o template do papel de leitura embutido no painel', () => {
  it('o arquivo que o painel importa está no filtro de caminhos do workflow que publica a demonstração', () => {
    // O caminho importado, a partir da raiz do repositório.
    const imported = /from '(?:\.\.\/)+(infra\/[^'?]+)\?url';/.exec(source)?.[1];
    expect(imported).toBe('infra/cloudformation/verax-control-reader.yaml');
    const paths = pushPaths(workflow);
    expect(paths).toContain(imported);
    // O filtro continua cobrindo o painel e o contrato compartilhado.
    expect(paths).toEqual(expect.arrayContaining(['apps/web/**', 'packages/shared/**', 'pnpm-lock.yaml']));
  });
});

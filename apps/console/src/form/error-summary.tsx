import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ValidationIssue } from '@/lib/api-types';
import { plural } from '@/lib/format';

/**
 * O resumo dos problemas que a API apontou na gravação, no alto do formulário: recebe o foco quando aparece (o leitor
 * de tela anuncia), e cada item leva o foco ao campo do caminho. Problema sem campo próprio (ex.: `lookup_key`
 * repetido) fica só aqui.
 */
export function ErrorSummary({ issues, title }: { issues: readonly ValidationIssue[]; title?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (issues.length > 0) ref.current?.focus();
  }, [issues]);
  if (issues.length === 0) return null;
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      aria-labelledby="resumo-erros-titulo"
      className="space-y-2 rounded-lg border border-critical/40 bg-critical/5 p-4"
    >
      <p id="resumo-erros-titulo" className="flex items-center gap-2 font-medium">
        <TriangleAlert aria-hidden className="size-4 text-critical" />
        {title ?? `A API recusou o rascunho: ${plural(issues.length, 'problema', 'problemas')}.`}
      </p>
      <ul className="space-y-1 text-sm">
        {issues.map((issue, index) => (
          <li key={`${issue.path}-${index}`}>
            <button
              type="button"
              className="text-left underline-offset-2 hover:underline"
              onClick={() => document.getElementById(`campo-${issue.path}`)?.focus()}
            >
              <span className="font-mono text-xs">{issue.path}</span>: {issue.message}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

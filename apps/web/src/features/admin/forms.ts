import type { z } from 'zod';

/** Mensagem padrão do zod (em inglês) trocada por uma em português; as mensagens dos schemas já vêm em português. */
function messageOf(issue: z.core.$ZodIssue): string {
  const english = /^(Invalid|Too |Expected|Unrecognized|String must|Number must)/.test(issue.message);
  if (!english) return issue.message;
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'string' && Number(issue.minimum) <= 1
        ? 'Preencha este campo.'
        : `Mínimo de ${String(issue.minimum)}.`;
    case 'too_big':
      return issue.origin === 'string'
        ? `Máximo de ${String(issue.maximum)} caracteres.`
        : `Máximo de ${String(issue.maximum)}.`;
    case 'invalid_format':
      return issue.format === 'email' ? 'E-mail inválido.' : 'Formato inválido.';
    default:
      return 'Valor inválido.';
  }
}

/** Erros de validação por campo (`a.b` para campos aninhados), o primeiro de cada um. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.map(String).join('.') || 'form';
    errors[key] ??= messageOf(issue);
  }
  return errors;
}

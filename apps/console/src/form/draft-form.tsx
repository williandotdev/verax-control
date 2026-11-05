import { type ReactNode, useMemo } from 'react';
import type { ValidationIssue } from '@/lib/api-types';
import { FormContext, issuesByPath } from './form-context';

/** Liga os campos de dentro ao rascunho (`form-context.ts`). */
export function DraftForm({
  value,
  onChange,
  issues,
  readOnly,
  children,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  issues: readonly ValidationIssue[];
  readOnly: boolean;
  children: ReactNode;
}) {
  const state = useMemo(
    () => ({ value, onChange, issues: issuesByPath(issues), readOnly }),
    [value, onChange, issues, readOnly],
  );
  return <FormContext.Provider value={state}>{children}</FormContext.Provider>;
}

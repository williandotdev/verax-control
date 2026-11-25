import type { Author, Me, TriageOperationView } from '@verax/shared';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { BulkDialog } from './bulk-dialog';
import type { CaseModeState } from './cases-api';
import { type BulkRequest, type CaseMemory, CasesContext, type CasesContextValue } from './cases-context';
import { UndoAllDialog, UndoDialog } from './undo-dialog';

type OpenDialog =
  | { kind: 'bulk'; request: BulkRequest }
  | { kind: 'undo'; operation: Pick<TriageOperationView, 'id' | 'action' | 'status' | 'changed'> }
  | { kind: 'undo-all'; author: Author }
  | null;

const NO_MEMORY: CaseMemory = { filters: {}, opened: null };

/**
 * Os casos para a tela Detecções inteira: o modo, o que quem vê pode fazer e os diálogos da triagem em massa, que abrem da
 * lista, do painel de detalhe e do histórico. Com os casos desligados, não acrescenta nada à tela.
 */
export function CasesProvider({
  cases,
  me,
  children,
}: {
  cases: CaseModeState;
  me: Pick<Me, 'role' | 'userId' | 'permissions'> | undefined;
  children: ReactNode;
}) {
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const memory = useRef(new Map<string, CaseMemory>());
  // Cada diálogo aberto começa do zero, mesmo sobre o mesmo alvo.
  const [opened, setOpened] = useState(0);

  const { mode, loading, status } = cases;
  const role = me?.role ?? null;
  const userId = me?.userId ?? null;
  const canTriage = mode === 'on' && me?.permissions.includes('findings:triage') === true;
  const canPromote = canTriage && me.permissions.includes('incidents:write');
  const value = useMemo((): CasesContextValue => {
    const show = (next: OpenDialog) => {
      setDialog(next);
      setOpened((count) => count + 1);
    };
    return {
      mode,
      loading,
      status,
      canTriage,
      canPromote,
      role,
      userId,
      openBulk: (request) => show({ kind: 'bulk', request }),
      openUndo: (operation) => show({ kind: 'undo', operation }),
      openUndoAll: (author) => show({ kind: 'undo-all', author }),
      memoryOf: (caseId) => memory.current.get(caseId) ?? NO_MEMORY,
      remember: (caseId, change) => {
        memory.current.set(caseId, { ...(memory.current.get(caseId) ?? NO_MEMORY), ...change });
      },
    };
  }, [mode, loading, status, canTriage, canPromote, role, userId]);

  const close = () => setDialog(null);
  return (
    <CasesContext value={value}>
      {children}
      {dialog?.kind === 'bulk' && <BulkDialog key={opened} request={dialog.request} onClose={close} />}
      {dialog?.kind === 'undo' && <UndoDialog key={opened} operation={dialog.operation} onClose={close} />}
      {dialog?.kind === 'undo-all' && <UndoAllDialog key={opened} author={dialog.author} onClose={close} />}
    </CasesContext>
  );
}

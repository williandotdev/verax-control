import type { Author, CaseMode, CaseStatus, Role, TriageFilter, TriageOperationView } from '@verax/shared';
import { createContext, useContext } from 'react';
import type { BulkAction, BulkScope } from './bulk';
import type { CaseFindingFilters } from './cases-api';

/** O que o diálogo da triagem em massa abre: um alvo já contado, ou um filtro (a prévia da API conta). */
export type BulkRequest = (
  | { kind: 'scope'; scope: BulkScope }
  | {
      kind: 'filter';
      filter: TriageFilter;
      /** De onde veio, para o título: "casos do filtro", "pacote openssl". */
      label: string;
    }
) & {
  action?: BulkAction;
  /** Depois de a API aceitar o pedido (na hora ou na fila): a seleção que o originou não vale mais. */
  onAccepted?: () => void;
};

/** O que fica da tela de um caso enquanto um alerta dele está aberto no lugar. */
export interface CaseMemory {
  filters: CaseFindingFilters;
  /** O alerta aberto a partir do caso, para o foco voltar a ele. */
  opened: string | null;
}

export interface CasesContextValue {
  mode: CaseMode;
  /** Ainda não se sabe o modo: o que muda com os casos espera, para não pedir duas vezes. */
  loading: boolean;
  status: CaseStatus | null;
  /** Quem vê pode tratar em massa: os casos ligados e a permissão da triagem. */
  canTriage: boolean;
  /** Pode também abrir e alimentar incidentes em massa. */
  canPromote: boolean;
  role: Role | null;
  userId: string | null;
  openBulk: (request: BulkRequest) => void;
  openUndo: (operation: Pick<TriageOperationView, 'id' | 'action' | 'status' | 'changed'>) => void;
  openUndoAll: (author: Author) => void;
  memoryOf: (caseId: string) => CaseMemory;
  remember: (caseId: string, memory: Partial<CaseMemory>) => void;
}

const nothing = () => undefined;

/** Fora da tela Detecções, ou com os casos desligados: nada. */
export const CasesContext = createContext<CasesContextValue>({
  mode: 'off',
  loading: false,
  status: null,
  canTriage: false,
  canPromote: false,
  role: null,
  userId: null,
  openBulk: nothing,
  openUndo: nothing,
  openUndoAll: nothing,
  memoryOf: () => ({ filters: {}, opened: null }),
  remember: nothing,
});

export const useCasesContext = (): CasesContextValue => useContext(CasesContext);

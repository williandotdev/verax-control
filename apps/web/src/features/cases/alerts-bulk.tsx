import { type Finding, MAX_TRIAGE_FINDINGS } from '@verax/shared';
import { CheckSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertsList, FILL_COLUMN, type ListPage } from '@/features/detections/detection-list';
import type { DetectionSelection } from '@/features/detections/url-state';
import { cn } from '@/lib/cn';
import { addPending, isActionable, NO_PENDING, scopeOfFindings, selectionNote } from './bulk';
import { BulkBar } from './bulk-bar';
import type { OpenItem } from './case-list';
import { useCasesContext } from './cases-context';
import { alertCount } from './labels';
import { useListSelection } from './use-list-selection';

interface AlertsProps {
  page: ListPage<Finding>;
  selection: DetectionSelection;
  onOpen: OpenItem;
  /** Os filtros da lista: mudaram, a seleção recomeça. */
  resetKey: string;
  /** As linhas ainda são dos filtros anteriores. */
  stale: boolean;
}

/** A lista de alertas, com a triagem em massa dos que forem marcados para quem pode fazê-la. Sem os casos, é a de sempre. */
export function BulkAlertsList({ resetKey, stale, ...props }: AlertsProps) {
  const { canTriage } = useCasesContext();
  if (!canTriage) return <AlertsList {...props} />;
  return <SelectableAlerts resetKey={resetKey} stale={stale} {...props} />;
}

const blocked = (finding: Finding): string | null => {
  if (finding.incidentId !== null) return 'já está num incidente';
  return isActionable(finding) ? null : 'já tratado';
};

function SelectableAlerts({ page, selection, onOpen, resetKey, stale }: AlertsProps) {
  const { openBulk } = useCasesContext();
  const selected = useListSelection<Finding>({ limit: MAX_TRIAGE_FINDINGS, resetKey, blocked, stale });
  // Um alerta que deixou de poder ser tratado (alguém tratou) sai da conta, e a API o pula de qualquer forma.
  const items = selected.items(page.rows ?? []).filter(isActionable);
  return (
    <div className={cn(FILL_COLUMN, 'space-y-3')}>
      <Button
        variant="secondary"
        size="sm"
        className="h-11 md:hidden"
        aria-pressed={selected.selecting}
        onClick={() => selected.setSelecting(!selected.selecting)}
      >
        <CheckSquare aria-hidden />
        {selected.selecting ? 'Cancelar a seleção' : 'Selecionar'}
      </Button>
      <AlertsList page={page} selection={selection} onOpen={onOpen} select={selected.select} />
      {items.length > 0 && (
        <BulkBar
          summary={alertCount(items.length)}
          pending={addPending(items.map((row) => ({ ...NO_PENDING, [row.severity]: 1 })))}
          note={selectionNote(selected.refused, MAX_TRIAGE_FINDINGS, 'alertas')}
          onAction={(action) =>
            openBulk({
              kind: 'scope',
              scope: scopeOfFindings(items),
              ...(action && { action }),
              onAccepted: selected.clear,
            })
          }
          onClear={selected.clear}
        />
      )}
    </div>
  );
}

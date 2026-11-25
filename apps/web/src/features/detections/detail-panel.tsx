import { ArrowLeft, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/sheet';
import { CaseDetailView } from '@/features/cases/case-detail';
import { useCase } from '@/features/cases/cases-api';
import { alertCount, QUEUE_LABELS } from '@/features/cases/labels';
import { FindingDetailView } from '@/features/findings/finding-detail';
import { useFinding } from '@/features/findings/findings-api';
import { FINDING_SOURCE_LABELS, findingOriginLabel } from '@/features/findings/labels';
import { IncidentDetailView } from '@/features/incidents/incident-detail';
import { useIncident } from '@/features/incidents/incidents-api';
import { incidentTitle } from '@/features/incidents/narrative';
import { useMe } from '@/features/session/session';
import { plural } from '@/lib/format';
import type { DetectionSelection } from './url-state';

interface PanelContent {
  title: ReactNode;
  description?: ReactNode;
  body: ReactNode;
}

function useIncidentContent(id: string | null): PanelContent {
  const { data: me } = useMe();
  const incident = useIncident(id ?? '', id !== null);
  if (incident.isError) {
    return {
      title: 'Incidente',
      body: <ErrorState error={incident.error} onRetry={() => void incident.refetch()} />,
    };
  }
  if (!incident.data)
    return { title: 'Incidente', body: <LoadingState rows={6} label="Carregando o incidente" /> };
  return {
    title: incidentTitle(incident.data),
    description: `Incidente · ${plural(incident.data.findingCount, 'alerta', 'alertas')}`,
    body: (
      <IncidentDetailView
        key={incident.data.id}
        incident={incident.data}
        canWrite={me?.permissions.includes('incidents:write') === true}
      />
    ),
  };
}

function useFindingContent(id: string | null): PanelContent {
  const finding = useFinding(id);
  if (finding.isError) {
    return {
      title: 'Alerta',
      body: <ErrorState error={finding.error} onRetry={() => void finding.refetch()} />,
    };
  }
  if (!finding.data) return { title: 'Alerta', body: <LoadingState rows={6} label="Carregando o alerta" /> };
  return {
    title: finding.data.title,
    description: `${FINDING_SOURCE_LABELS[finding.data.source]} · ${findingOriginLabel(finding.data.accountId)}`,
    body: <FindingDetailView key={finding.data.id} finding={finding.data} />,
  };
}

function useCaseContent(id: string | null): PanelContent {
  const detail = useCase(id);
  if (detail.isError) {
    return {
      title: 'Caso',
      body: <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />,
    };
  }
  if (!detail.data) return { title: 'Caso', body: <LoadingState rows={6} label="Carregando o caso" /> };
  return {
    title: detail.data.title,
    description: `Caso · ${QUEUE_LABELS[detail.data.queue]} · ${alertCount(detail.data.counts.total)}`,
    body: <CaseDetailView key={detail.data.id} detail={detail.data} />,
  };
}

/**
 * O detalhe do item escolhido na lista: o caso (o que os alertas têm em comum, o que foge do padrão, os alertas), o incidente (resumo, primeiro passo, tratamento, linha do tempo, ativos e
 * MITRE) ou o alerta (campos, validação, triagem, exceção, comentários e o evento bruto). Na tela larga, fica ao lado da lista,
 * sem cobrir nada; na estreita, numa gaveta (o diálogo acessível de sempre).
 */
export function DetectionDetailPanel({
  selection,
  side,
  onClose,
  onBack,
}: {
  selection: DetectionSelection;
  /** Ao lado da lista (tela larga) ou numa gaveta. */
  side: boolean;
  onClose: () => void;
  /** O item foi aberto de dentro de um caso: o botão que volta a ele. */
  onBack?: (() => void) | undefined;
}) {
  const incident = useIncidentContent(selection?.kind === 'incident' ? selection.id : null);
  const finding = useFindingContent(selection?.kind === 'finding' ? selection.id : null);
  const openCase = useCaseContent(selection?.kind === 'case' ? selection.id : null);
  const content = { incident, finding, case: openCase }[selection?.kind ?? 'finding'];
  const back = onBack && (
    <Button variant="ghost" size="sm" className="-ml-3 max-md:h-11" onClick={onBack}>
      <ArrowLeft aria-hidden />
      Voltar ao caso
    </Button>
  );

  if (!side) {
    return (
      <Sheet
        open={selection !== null}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={content.title}
        description={content.description}
      >
        {back}
        {content.body}
      </Sheet>
    );
  }
  if (selection === null) return null;
  return (
    <SidePanel key={`${selection.kind}:${selection.id}`} content={content} back={back} onClose={onClose} />
  );
}

/** O painel ao lado da lista: o foco vai para o título ao abrir, Esc ou o botão fecham. */
function SidePanel({
  content,
  back,
  onClose,
}: {
  content: PanelContent;
  back?: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <aside
      aria-labelledby={titleId}
      aria-describedby={content.description ? descriptionId : undefined}
      onKeyDown={onKeyDown}
      className="sticky top-4 flex max-h-[calc(100vh-2rem)] flex-col rounded-xl border bg-surface shadow-xs"
    >
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0 space-y-1">
          {back}
          <h2
            ref={title}
            id={titleId}
            tabIndex={-1}
            className="text-lg font-semibold wrap-anywhere focus:outline-none"
          >
            {content.title}
          </h2>
          {content.description && (
            <p id={descriptionId} className="text-sm text-muted-foreground">
              {content.description}
            </p>
          )}
        </div>
        <Button variant="ghost" size="icon" aria-label="Fechar o detalhe" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </header>
      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">{content.body}</div>
    </aside>
  );
}

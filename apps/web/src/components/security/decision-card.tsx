import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Severity } from '@/design/severity';
import { SeverityBadge } from './severity-badge';

export interface DecisionCardProps {
  severity: Severity;
  title: string;
  description: string;
  /** Contexto curto: cliente, conta, há quanto tempo. */
  meta?: ReactNode;
  actionLabel: string;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
  /** Ação em andamento: o botão fica desabilitado para não disparar duas vezes. */
  busy?: boolean;
}

/** Card de decisão da Torre: o que exige uma decisão agora, por quê, e o botão para agir. */
export function DecisionCard({
  severity,
  title,
  description,
  meta,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
  busy = false,
}: DecisionCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold">{title}</h3>
        <SeverityBadge severity={severity} />
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>
      {meta && <div className="text-xs text-muted-foreground">{meta}</div>}
      <div className="mt-auto flex flex-wrap gap-2">
        <Button onClick={onAction} disabled={busy} aria-busy={busy}>
          {actionLabel}
        </Button>
        {secondaryLabel && onSecondary && (
          <Button variant="secondary" onClick={onSecondary} disabled={busy}>
            {secondaryLabel}
          </Button>
        )}
      </div>
    </Card>
  );
}

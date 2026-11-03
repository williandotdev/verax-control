import type { AuditOutcome } from '@verax/shared';
import { cn } from '@/lib/cn';
import { AUDIT_OUTCOME_LABELS } from './labels';

/** Resultado da operação: ícone e texto, em tinta neutra (o resultado nunca depende só da cor). */
export function AuditOutcomeBadge({ outcome, className }: { outcome: AuditOutcome; className?: string }) {
  const { label, icon: Icon } = AUDIT_OUTCOME_LABELS[outcome];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        outcome === 'success' ? 'text-muted-foreground' : 'text-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  );
}

import type { FindingStatus } from '@verax/shared';
import { cn } from '@/lib/cn';
import { FINDING_STATUS_LABELS } from './labels';

/** Status do achado: ícone próprio e texto, em tinta neutra (a cor fica para a severidade). */
export function FindingStatusBadge({ status, className }: { status: FindingStatus; className?: string }) {
  const { label, icon: Icon } = FINDING_STATUS_LABELS[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground',
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  );
}

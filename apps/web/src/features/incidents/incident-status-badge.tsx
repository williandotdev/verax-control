import type { IncidentStatus } from '@verax/shared';
import { cn } from '@/lib/cn';
import { INCIDENT_STATUS_LABELS } from './labels';

export function IncidentStatusBadge({ status, className }: { status: IncidentStatus; className?: string }) {
  const { label, icon: Icon } = INCIDENT_STATUS_LABELS[status];
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

import { type Severity, SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';

export type SemaphoreState = 'red' | 'yellow' | 'green';

const STATE: Record<SemaphoreState, { severity: Severity; label: string; lamp: string }> = {
  red: { severity: 'critical', label: 'Crítico', lamp: 'bg-critical' },
  yellow: { severity: 'medium', label: 'Atenção', lamp: 'bg-medium' },
  green: { severity: 'ok', label: 'Normal', lamp: 'bg-ok' },
};

const ORDER: SemaphoreState[] = ['red', 'yellow', 'green'];

/**
 * Semáforo da Torre. A posição da luz acesa (em cima, no meio, embaixo), o ícone e o rótulo dizem o
 * estado; a cor só reforça (daltonismo e impressão).
 */
export function Semaphore({
  state,
  reason,
  className,
}: {
  state: SemaphoreState;
  reason?: string;
  className?: string;
}) {
  const { severity, label } = STATE[state];
  const { icon: Icon, tone } = SEVERITY_STYLES[severity];
  return (
    <div
      role="status"
      aria-label={`Situação: ${label}${reason ? `. ${reason}` : ''}`}
      className={cn('flex items-center gap-4', className)}
    >
      <div aria-hidden className="flex flex-col gap-1.5 rounded-xl border bg-surface-raised p-2">
        {ORDER.map((lamp) => (
          <span
            key={lamp}
            data-lit={lamp === state}
            className={cn('size-5 rounded-full', lamp === state ? STATE[lamp].lamp : 'bg-foreground/10')}
          />
        ))}
      </div>
      <div>
        <p className="flex items-center gap-1.5 text-xl font-semibold">
          <Icon aria-hidden className={cn('size-5', tone)} />
          {label}
        </p>
        {reason && <p className="text-sm text-muted-foreground">{reason}</p>}
      </div>
    </div>
  );
}

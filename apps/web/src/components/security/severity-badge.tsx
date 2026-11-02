import { type Severity, SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';

/** Selo de severidade: ícone de forma própria + rótulo; a cor reforça, nunca decide sozinha. */
export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  const { label, icon: Icon, tone, surface } = SEVERITY_STYLES[severity];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-foreground',
        surface,
        className,
      )}
    >
      <Icon aria-hidden className={cn('size-3.5', tone)} />
      {label}
    </span>
  );
}

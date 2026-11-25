import { type CaseSummary, FINDING_SEVERITIES } from '@verax/shared';
import { History, type LucideIcon, Search, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { type PendingCounts, sumPending } from './bulk';
import { recurrenceLabel } from './labels';

/** Quantos de cada severidade, só as que têm algum: ícone próprio, número e o nome para o leitor de tela. */
export function SeverityCounts({ counts, className }: { counts: PendingCounts; className?: string }) {
  if (sumPending(counts) === 0) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs', className)}>
      {FINDING_SEVERITIES.filter((severity) => counts[severity] > 0).map((severity) => {
        const { icon: Icon, tone, label } = SEVERITY_STYLES[severity];
        return (
          <span key={severity} title={label} className="inline-flex items-center gap-0.5 whitespace-nowrap">
            <Icon aria-hidden className={cn('size-3.5', tone)} />
            {formatCount(counts[severity])}
            <span className="sr-only"> {label.toLowerCase()}</span>
          </span>
        );
      })}
    </span>
  );
}

function Badge({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium text-foreground">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {children}
    </span>
  );
}

/** Item protegido, em análise, voltou: em tinta neutra (a cor fica para a severidade). */
export function CaseBadges({
  row,
  treatedBefore,
}: {
  row: Pick<CaseSummary, 'protected' | 'counts' | 'queue' | 'recurrence' | 'recurrenceTreated'>;
  /** No detalhe: quantos dos casos anteriores foram tratados. */
  treatedBefore?: number;
}) {
  const recurrence = recurrenceLabel(row, treatedBefore);
  if (!row.protected && row.counts.investigating === 0 && recurrence === null) return null;
  return (
    <span className="flex flex-wrap gap-1.5">
      {row.protected && <Badge icon={ShieldAlert}>Item protegido</Badge>}
      {row.counts.investigating > 0 && (
        <Badge icon={Search}>Em análise ({formatCount(row.counts.investigating)})</Badge>
      )}
      {recurrence !== null && <Badge icon={History}>{recurrence}</Badge>}
    </span>
  );
}

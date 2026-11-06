import type { CollectionState } from '@verax/shared';
import type { ReactNode } from 'react';
import { COLLECTION_STATE_STYLES } from '@/design/collection';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

/**
 * Uma fonte na "Saúde da coleta": o nome (e o que ela cobre), o estado com ícone e rótulo (`COLLECTION_STATE_STYLES`)
 * e o último dado que prova a coleta. A fonte não configurada fica discreta, sem horário.
 */
export function SourceHealthRow({
  name,
  description,
  state,
  lastDataAt,
  note,
  now,
}: {
  name: string;
  /** O que a fonte cobre ("CloudTrail, GuardDuty e WAF"). */
  description?: string;
  state: CollectionState;
  lastDataAt: string | null;
  /** Uma linha a mais (na AWS, o último alerta). */
  note?: ReactNode;
  /** O agora do cálculo do "há quanto tempo" (os testes fixam). */
  now?: Date;
}) {
  const { label, icon: Icon, tone } = COLLECTION_STATE_STYLES[state];
  const quiet = state === 'not_configured';
  // Em pilha, alinhada à esquerda: o nome e o estado na primeira linha, depois o que a fonte cobre e os horários. Cabe
  // na coluna estreita da Torre e no celular sem quebrar uma linha pela metade.
  return (
    <div className="py-2">
      <div className="flex items-start justify-between gap-3">
        <p className={cn('min-w-0 text-sm font-medium', quiet && 'text-muted-foreground')}>{name}</p>
        <p className="flex shrink-0 items-center gap-1.5 text-sm">
          <Icon aria-hidden className={cn('size-4 shrink-0', tone)} />
          <span className={cn(quiet && 'text-muted-foreground')}>{label}</span>
        </p>
      </div>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {!quiet && lastDataAt && (
        <p className="text-xs text-muted-foreground">último dado {formatRelative(lastDataAt, now)}</p>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

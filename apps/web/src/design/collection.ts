import type { CollectionState } from '@verax/shared';
import { CircleDashed, Clock, type LucideIcon } from 'lucide-react';
import { SEVERITY_STYLES } from './severity';

/**
 * Como cada estado da coleta de uma fonte aparece (a "Saúde da coleta" da Torre): ícone de forma própria, rótulo e a
 * cor só de reforço. "Coletando" usa o tom de "ok", "atrasada" o de médio e "parada" o de alto (é estado de verdade,
 * como a severidade); aguardando e não configurada ficam na tinta discreta, porque não pedem nada a ninguém.
 */
export const COLLECTION_STATE_STYLES: Readonly<
  Record<CollectionState, { label: string; icon: LucideIcon; tone: string }>
> = {
  collecting: { label: 'Coletando', icon: SEVERITY_STYLES.ok.icon, tone: SEVERITY_STYLES.ok.tone },
  delayed: { label: 'Atrasada', icon: SEVERITY_STYLES.medium.icon, tone: SEVERITY_STYLES.medium.tone },
  stalled: { label: 'Parada', icon: SEVERITY_STYLES.high.icon, tone: SEVERITY_STYLES.high.tone },
  waiting: { label: 'Aguardando o primeiro dado', icon: Clock, tone: 'text-subtle-foreground' },
  not_configured: { label: 'Não configurada', icon: CircleDashed, tone: 'text-subtle-foreground' },
};

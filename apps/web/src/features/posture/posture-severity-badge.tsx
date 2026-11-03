import type { PostureSeverity } from '@verax/shared';
import { Info } from 'lucide-react';
import { SeverityBadge } from '@/components/security/severity-badge';

/** Severidade da checagem: as quatro do painel e a informativa, que não pesa na nota (selo neutro). */
export function PostureSeverityBadge({ severity }: { severity: PostureSeverity }) {
  if (severity !== 'informational') return <SeverityBadge severity={severity} />;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <Info aria-hidden className="size-3.5" />
      Informativa
    </span>
  );
}

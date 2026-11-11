import { CircleCheck, CircleDashed, Archive, OctagonAlert, Star, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import type { VersionStatus } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { STATUS_LABELS } from '@/lib/format';
import { marginLevel } from '@/lib/margins';
import { formatRatio } from '@/lib/numbers';

function Badge({ icon, children, className }: { icon: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}

const STATUS_ICONS: Readonly<Record<VersionStatus, ReactNode>> = {
  draft: <CircleDashed aria-hidden className="size-3.5" />,
  published: <CircleCheck aria-hidden className="size-3.5 text-ok" />,
  retired: <Archive aria-hidden className="size-3.5 text-subtle-foreground" />,
};

/** Situação de uma versão, sempre com ícone e texto (nunca só a cor). */
export function StatusBadge({ status }: { status: VersionStatus }) {
  return <Badge icon={STATUS_ICONS[status]}>{STATUS_LABELS[status]}</Badge>;
}

/** Uma versão do modelo de preço anterior: só na lista, sem abrir. */
export function LegacyBadge() {
  return (
    <Badge icon={<Archive aria-hidden className="size-3.5 text-subtle-foreground" />}>Modelo anterior</Badge>
  );
}

export function CurrentBadge() {
  return (
    <Badge icon={<Star aria-hidden className="size-3.5" />} className="border-primary/40 text-foreground">
      Vigente
    </Badge>
  );
}

/** A margem com o selo do nível: abaixo da mínima, abaixo do alerta ou dentro da meta. */
export function MarginBadge({
  ratio,
  margins,
}: {
  ratio: number;
  margins: { minimum: number; alert: number };
}) {
  const level = marginLevel(ratio, margins);
  if (level === 'below_minimum') {
    return (
      <Badge
        icon={<OctagonAlert aria-hidden className="size-3.5 text-critical" />}
        className="border-critical/50 bg-critical/5 text-critical-text"
      >
        Abaixo da mínima ({formatRatio(margins.minimum)})
      </Badge>
    );
  }
  if (level === 'below_alert') {
    return (
      <Badge
        icon={<TriangleAlert aria-hidden className="size-3.5 text-high" />}
        className="border-high/60 bg-high/10"
      >
        Abaixo do alerta ({formatRatio(margins.alert)})
      </Badge>
    );
  }
  return (
    <Badge icon={<CircleCheck aria-hidden className="size-3.5 text-ok" />} className="border-ok/50">
      Dentro da meta
    </Badge>
  );
}

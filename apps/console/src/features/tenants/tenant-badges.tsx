import {
  Building2,
  CircleCheck,
  CircleDashed,
  CirclePause,
  FilePen,
  Hourglass,
  LoaderCircle,
  OctagonAlert,
  Server,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { BillingMode, Hosting, TenantState } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { BILLING_LABELS, HOSTING_LABELS, STATE_LABELS } from './labels';

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

const STATE_ICONS: Readonly<Record<TenantState, ReactNode>> = {
  pending: <CircleDashed aria-hidden className="size-3.5" />,
  provisioning: <LoaderCircle aria-hidden className="size-3.5" />,
  provisioning_failed: <OctagonAlert aria-hidden className="size-3.5 text-critical" />,
  waiting_customer_install: <Hourglass aria-hidden className="size-3.5" />,
  waiting_customer_connection: <CircleCheck aria-hidden className="size-3.5 text-ok" />,
  active: <CircleCheck aria-hidden className="size-3.5 text-ok" />,
  past_due: <OctagonAlert aria-hidden className="size-3.5 text-high" />,
  suspended: <CirclePause aria-hidden className="size-3.5 text-high" />,
  canceled: <CirclePause aria-hidden className="size-3.5 text-subtle-foreground" />,
  deleted: <CirclePause aria-hidden className="size-3.5 text-subtle-foreground" />,
};

/** O estado do cliente, sempre com ícone e texto (nunca só a cor). */
export function TenantStateBadge({ state }: { state: TenantState }) {
  return (
    <Badge
      icon={STATE_ICONS[state]}
      className={
        state === 'provisioning_failed' ? 'border-critical/50 bg-critical/5 text-critical-text' : undefined
      }
    >
      {STATE_LABELS[state]}
    </Badge>
  );
}

/** Onde o ambiente roda: na infraestrutura da Verax ou na do cliente (só contrato direto). */
export function HostingBadge({ hosting }: { hosting: Hosting }) {
  return (
    <Badge
      icon={
        hosting === 'customer' ? (
          <Building2 aria-hidden className="size-3.5" />
        ) : (
          <Server aria-hidden className="size-3.5" />
        )
      }
      className={hosting === 'customer' ? 'border-primary/40' : undefined}
    >
      {HOSTING_LABELS[hosting]}
    </Badge>
  );
}

export function BillingBadge({ mode }: { mode: BillingMode }) {
  return (
    <Badge
      icon={mode === 'contract' ? <FilePen aria-hidden className="size-3.5" /> : undefined}
      className={mode === 'contract' ? 'border-primary/40' : undefined}
    >
      {BILLING_LABELS[mode]}
    </Badge>
  );
}

import { Link } from 'react-router';
import type { Severity } from '@/design/severity';
import { SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/format';

export interface TimelineEvent {
  id: string;
  at: string | Date;
  title: string;
  description?: string;
  severity?: Severity;
  /** Quem fez ou de onde veio (usuário, IP, regra). */
  source?: string;
  /** Leva ao detalhe do evento (por exemplo, o achado). */
  href?: string;
}

/** Linha do tempo de um incidente ou recurso, na ordem recebida (o chamador ordena). */
export function Timeline({ events, className }: { events: TimelineEvent[]; className?: string }) {
  return (
    // wrap-anywhere: tipos do GuardDuty e ARNs são tokens longos sem espaço e, no celular, alargariam a página.
    <ol className={cn('relative space-y-4 border-l border-border-strong pl-5 wrap-anywhere', className)}>
      {events.map((event) => {
        const style = event.severity ? SEVERITY_STYLES[event.severity] : undefined;
        const Icon = style?.icon;
        return (
          <li key={event.id} className="relative">
            <span
              aria-hidden
              className="absolute -left-[27px] top-0.5 flex size-3.5 items-center justify-center rounded-full border border-border-strong bg-surface"
            >
              {Icon ? <Icon className={cn('size-3', style.tone)} /> : null}
            </span>
            <time dateTime={new Date(event.at).toISOString()} className="block text-xs text-muted-foreground">
              {formatTimestamp(event.at)}
            </time>
            <p className="text-sm font-medium">
              {event.href ? (
                <Link to={event.href} className="hover:underline">
                  {event.title}
                </Link>
              ) : (
                event.title
              )}
              {style && <span className="sr-only"> (severidade {style.label})</span>}
            </p>
            {event.description && <p className="text-sm text-muted-foreground">{event.description}</p>}
            {event.source && <p className="text-xs text-subtle-foreground">{event.source}</p>}
          </li>
        );
      })}
    </ol>
  );
}

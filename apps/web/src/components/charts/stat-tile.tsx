import { ArrowRight } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Link } from 'react-router';
import { cn } from '@/lib/cn';

/**
 * Cartão de número (o "Pulso da operação" da Torre): o rótulo, o valor em destaque (já formatado, compacto em pt-BR),
 * um detalhe curto e, quando houver, o minigráfico e o link para a tela do detalhe. O link fica à parte do gráfico
 * (que recebe foco próprio), nunca envolvendo o cartão inteiro. A tinta do texto é sempre a neutra.
 */
export function StatTile({
  label,
  value,
  detail,
  link,
  children,
  className,
}: {
  label: string;
  value: string;
  /** Uma linha de contexto abaixo do valor ("9 esperados", "mediana de 24 h"). */
  detail?: ReactNode;
  /** Para onde levar o detalhe, com o nome do link. */
  link?: { to: string; label: string };
  /** O minigráfico, quando o número tem tendência. */
  children?: ReactNode;
  className?: string;
}) {
  const labelId = useId();
  return (
    <section
      aria-labelledby={labelId}
      className={cn('flex min-w-0 flex-col gap-1 rounded-xl border bg-surface p-4 shadow-xs', className)}
    >
      <h3 id={labelId} className="text-sm font-medium text-muted-foreground">
        {label}
      </h3>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {detail && <div className="text-xs text-muted-foreground">{detail}</div>}
      {children && <div className="mt-1">{children}</div>}
      {link && (
        <Link
          to={link.to}
          className="mt-auto inline-flex min-h-6 items-center gap-1 self-start pt-1 text-xs font-medium underline underline-offset-2"
        >
          {link.label}
          <ArrowRight aria-hidden className="size-3" />
        </Link>
      )}
    </section>
  );
}

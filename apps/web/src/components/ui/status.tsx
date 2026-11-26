import { CircleDashed, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { type Severity, SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';

/**
 * As peças de estado do painel (E-12 da auditoria de UX): o ícone de um tom, o selo (ícone e texto), o aviso em
 * destaque e a etiqueta de borda. Uma peça só para cada uma, usada pelas telas aos poucos, uma área por vez. O tom
 * nunca aparece só como cor: vem sempre com um ícone de forma própria e com o texto ao lado (a regra das severidades
 * do painel). O que está andando sozinho gira; quem pediu menos movimento ao sistema vê o ícone parado.
 */

/** O tom de um estado: a mesma escala das severidades, e `progress` para o que está andando sozinho. */
export type Tone = Severity | 'progress' | 'idle';

const TONE_STYLES: Readonly<Record<Tone, { icon: LucideIcon; tone: string; surface: string }>> = {
  critical: SEVERITY_STYLES.critical,
  high: SEVERITY_STYLES.high,
  medium: SEVERITY_STYLES.medium,
  low: SEVERITY_STYLES.low,
  ok: SEVERITY_STYLES.ok,
  progress: {
    icon: LoaderCircle,
    tone: 'text-low motion-safe:animate-spin',
    surface: 'bg-low/10 border-low/50',
  },
  idle: { icon: CircleDashed, tone: 'text-subtle-foreground', surface: 'bg-foreground/[0.03]' },
};

export function ToneIcon({ tone, className }: { tone: Tone; className?: string }) {
  const { icon: Icon, tone: color } = TONE_STYLES[tone];
  return <Icon aria-hidden className={cn('size-4 shrink-0', color, className)} />;
}

/** Selo com ícone e texto, numa linha. */
export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-sm', className)}>
      <ToneIcon tone={tone} />
      <span>{children}</span>
    </span>
  );
}

/** Um aviso em destaque: o ícone, o título e o que fazer. */
export function Notice({
  tone,
  title,
  children,
  className,
  ...props
}: Omit<ComponentProps<'div'>, 'title'> & { tone: Tone; title?: ReactNode }) {
  return (
    <div
      className={cn('flex gap-2 rounded-md border p-3 text-sm', TONE_STYLES[tone].surface, className)}
      {...props}
    >
      <ToneIcon tone={tone} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-1">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/** Um pequeno rótulo de borda (a marca "recomendada", "sensível", "cadastrada manualmente", "Cadastrada pela Verax"). */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-full border px-1.5 py-0.5 text-[0.7rem] font-medium leading-none">
      {children}
    </span>
  );
}

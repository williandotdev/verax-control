import { CircleDashed, ExternalLink, LoaderCircle, type LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { SEVERITY_STYLES } from '@/design/severity';
import type { Tone } from '@/features/admin/aws-onboarding-labels';
import { cn } from '@/lib/cn';

/**
 * As peças visuais da seção da AWS. O tom nunca aparece só como cor: vem sempre com um ícone de forma própria e com o
 * texto ao lado (a regra das severidades do painel). O que está andando sozinho gira; quem pediu menos movimento ao
 * sistema vê o ícone parado.
 */
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
export function ToneBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 text-sm">
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

/** Uma seção da tela da conta, com o título ligado a ela (região nomeada para o leitor de tela). */
export function Section({
  id,
  title,
  children,
  className,
}: {
  id: string;
  title: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-titulo`}
      className={cn('space-y-3 rounded-md border p-3', className)}
    >
      <h3 id={`${id}-titulo`} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Uma tabela dentro do quadro que rola de lado quando ela não cabe (no celular, ou com um texto mais largo). Toda
 * tabela desta seção passa por aqui, para nenhuma ficar sem o que o quadro precisa: ele é uma região com o nome da
 * tabela e recebe o foco do teclado, com o contorno de foco à vista. Sem mouse, é o foco no quadro que deixa rolar
 * até as colunas da direita (uma tabela só de texto não tem outro ponto de foco). O mesmo padrão das outras tabelas do
 * painel (`report-table.tsx`, `chart-table.tsx`).
 */
export function ScrollTable({
  caption,
  className,
  tableClassName,
  children,
}: {
  /** O nome da tabela, um para cada tabela da tela: a legenda dela e, com "Tabela: " na frente, o nome do quadro. */
  caption: string;
  className?: string;
  tableClassName?: string;
  /** O cabeçalho e o corpo da tabela (`thead` e `tbody`). */
  children: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={`Tabela: ${caption}`}
      tabIndex={0}
      className={cn(
        'overflow-x-auto rounded-md border focus-visible:outline-2 focus-visible:outline-ring',
        className,
      )}
    >
      <table className={cn('w-full', tableClassName)}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

/** Link para fora do painel, em outra aba, sem dar à página aberta acesso a esta. */
export function OutLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-1 underline', className)}
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
    </a>
  );
}

/** Um termo do console da AWS em inglês, entre parênteses depois do nome em português. */
export function ConsoleTerm({ pt, en }: { pt: string; en: string }) {
  return (
    <>
      <strong className="font-semibold">{pt}</strong> (<span lang="en">{en}</span>)
    </>
  );
}

/** Um pequeno rótulo de borda (a marca "recomendada", "sensível", "cadastrada manualmente"). */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-full border px-1.5 py-0.5 text-[0.7rem] font-medium leading-none">
      {children}
    </span>
  );
}

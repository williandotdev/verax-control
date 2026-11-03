import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { LOGO_TRANSFORM, SYMBOL_PATHS, SYMBOL_VIEWBOX, WORDMARK_PATHS, WORDMARK_VIEWBOX } from './logo-paths';

/** Nome do produto, como o leitor de tela anuncia a marca. */
export const PRODUCT_NAME = 'Verax Control';

interface LogoProps extends Omit<ComponentProps<'svg'>, 'children' | 'role' | 'viewBox'> {
  /** Nome acessível. Sem ele a logo é decorativa (`aria-hidden`): use assim quando o texto ao lado já nomeia. */
  label?: string;
}

/**
 * SVG em linha e na cor do texto em volta (`currentColor`): a mesma logo serve nos dois temas e sobre o navy da
 * marca, sem arquivo à parte. A altura vem da classe; a largura sai da proporção do desenho.
 */
function LogoSvg({
  viewBox,
  paths,
  label,
  className,
  ...props
}: LogoProps & { viewBox: string; paths: readonly string[] }) {
  return (
    <svg
      viewBox={viewBox}
      fill="currentColor"
      className={cn('block w-auto shrink-0', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...props}
    >
      <g transform={LOGO_TRANSFORM}>
        {paths.map((d, index) => (
          <path key={index} d={d} />
        ))}
      </g>
    </svg>
  );
}

/** A palavra VERAX, como no cabeçalho do site. */
export function VeraxWordmark({ className, ...props }: LogoProps) {
  return (
    <LogoSvg
      viewBox={WORDMARK_VIEWBOX}
      paths={WORDMARK_PATHS}
      className={cn('aspect-[6480/1680] h-6', className)}
      {...props}
    />
  );
}

/** Só o símbolo X da Verax (o do ícone do site). */
export function VeraxSymbol({ className, ...props }: LogoProps) {
  return (
    <LogoSvg
      viewBox={SYMBOL_VIEWBOX}
      paths={SYMBOL_PATHS}
      className={cn('aspect-[1760/1680] h-6', className)}
      {...props}
    />
  );
}

const LOCKUP_SIZES = {
  md: { wordmark: 'h-5', tag: 'pl-3 text-[10px]' },
  lg: { wordmark: 'h-7', tag: 'pl-3.5 text-xs' },
} as const;

/**
 * Marca do painel no padrão do site: a palavra VERAX e, depois de uma borda fina, a etiqueta do produto pequena,
 * espaçada e em caixa alta (no site, "SISTEMAS"; aqui, "CONTROL"). Para o leitor de tela é uma imagem só, com o
 * nome do produto. Fica na cor do texto em volta: sobre o navy da marca, a tinta clara.
 */
export function BrandLockup({
  size = 'md',
  className,
}: {
  size?: keyof typeof LOCKUP_SIZES;
  className?: string;
}) {
  const { wordmark, tag } = LOCKUP_SIZES[size];
  return (
    <span
      role="img"
      aria-label={PRODUCT_NAME}
      className={cn('inline-flex shrink-0 items-center gap-3 whitespace-nowrap', className)}
    >
      <VeraxWordmark className={wordmark} />
      <span
        className={cn(
          'border-l border-foreground/25 font-mono font-semibold leading-none tracking-[0.28em] text-muted-foreground',
          tag,
        )}
      >
        CONTROL
      </span>
    </span>
  );
}

import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { ChartTable } from './chart-table';
import { type ChartUnit, countOf, formatCount, useElementWidth, useKeepInside } from './chart-utils';

const HEIGHT = 40;
const TOP = 4;
/** Coluna de no máximo 24 px, com o vão de 2 px na cor da superfície entre vizinhas. */
const MAX_BAR = 24;
const GAP = 2;
const FALLBACK_WIDTH = 200;

/**
 * Minigráfico de colunas por hora, de uma série só (o "Pulso da operação"): uma coluna por hora, da mais antiga à
 * atual, na tinta discreta, com a hora atual (ou a escolhida) na tinta principal. Sem eixo nem legenda: o título do
 * cartão diz o que é. O mouse, o toque e as setas com o gráfico em foco mostram o valor de cada hora; os números estão
 * na tabela de "Ver tabela". As tintas são passos da rampa neutra validada dos gráficos (`INK_RAMP`: a de 50% fica a
 * 3:1 ou mais da superfície nos dois temas), nunca uma cor de severidade nem a da ação principal.
 */
export function MiniBars({
  title,
  values,
  labels,
  unit,
  className,
}: {
  /** Nome do gráfico: vai no nome acessível e na tabela. */
  title: string;
  /** Do intervalo mais antigo ao atual. */
  values: readonly number[];
  /** O rótulo de cada intervalo (a hora), na mesma ordem. */
  labels: readonly string[];
  unit: ChartUnit;
  className?: string;
}) {
  const [frameRef, width, frame] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const tipRef = useKeepInside<HTMLDivElement>(frame, `${selected}:${width}`);

  const lastIndex = values.length - 1;
  const total = values.reduce((sum, value) => sum + value, 0);
  const max = Math.max(1, ...values);
  const slot = width / Math.max(1, values.length);
  const bar = Math.max(1, Math.min(MAX_BAR, slot - GAP));
  const x = (index: number) => index * slot + (slot - bar) / 2;
  const height = (value: number) => (value / max) * (HEIGHT - TOP);
  const label = (index: number) => labels[index] ?? '';

  const peak = values.indexOf(Math.max(...values));
  const summary =
    total === 0
      ? `${title}: nenhum ${unit.one}.`
      : `${title}: ${countOf(total, unit)} no total; a hora com mais foi a das ${label(peak)}, com ${formatCount(values[peak] ?? 0)}. Use as setas para ver cada hora.`;

  const active = selected !== null && selected <= lastIndex ? selected : null;
  const fromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const index = Math.floor(((event.clientX - box.left) / box.width) * values.length);
    setSelected(Math.min(lastIndex, Math.max(0, index)));
  };
  const fromKeys = (event: KeyboardEvent<SVGSVGElement>) => {
    const moves: Record<string, (current: number) => number> = {
      ArrowLeft: (current) => current - 1,
      ArrowRight: (current) => current + 1,
      Home: () => 0,
      End: () => lastIndex,
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setSelected((current) => Math.min(lastIndex, Math.max(0, move(current ?? lastIndex))));
  };
  // Em destaque: o intervalo escolhido ou, sem escolha, o atual.
  const highlighted = active ?? lastIndex;
  const flip = active !== null && x(active) > width / 2;

  return (
    <figure className={cn('min-w-0', className)}>
      <div ref={frameRef} className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block h-10 w-full touch-pan-y"
          preserveAspectRatio="none"
          role="img"
          tabIndex={0}
          aria-label={summary}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          onPointerLeave={(event) => event.pointerType === 'mouse' && setSelected(null)}
          onKeyDown={fromKeys}
          onFocus={() => setSelected((current) => current ?? lastIndex)}
          onBlur={() => setSelected(null)}
        >
          <line
            x1={0}
            x2={width}
            y1={HEIGHT - 0.5}
            y2={HEIGHT - 0.5}
            className="stroke-border-strong"
            strokeWidth={1}
            shapeRendering="crispEdges"
          />
          {values.map((value, index) =>
            value === 0 ? null : (
              <path
                key={index}
                data-bar={index}
                d={columnPath(x(index), bar, height(value))}
                className={index === highlighted ? 'fill-foreground' : 'fill-foreground/50'}
              />
            ),
          )}
        </svg>
        {active !== null && (
          <div
            ref={tipRef}
            aria-hidden
            className={cn(
              'pointer-events-none absolute bottom-full z-10 mb-1 rounded-md border bg-surface-raised px-2 py-1 text-xs whitespace-nowrap shadow-sm',
              flip && '-translate-x-full',
            )}
            style={{ left: x(active) + (flip ? bar : 0) }}
          >
            <strong className="font-semibold tabular-nums">{formatCount(values[active] ?? 0)}</strong>{' '}
            <span className="text-muted-foreground">{label(active)}</span>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {active !== null ? `${label(active)}: ${countOf(values[active] ?? 0, unit)}.` : ''}
      </p>
      <ChartTable
        title={title}
        headers={['Hora', unit.many.charAt(0).toUpperCase() + unit.many.slice(1)]}
        rows={values
          .map((value, index) => ({ key: String(index), cells: [label(index), formatCount(value)] }))
          .reverse()}
      />
    </figure>
  );
}

/** Coluna que nasce da linha de base, quadrada embaixo e com os cantos de cima arredondados (até 2 px). */
function columnPath(left: number, width: number, height: number): string {
  const bottom = HEIGHT;
  const top = bottom - Math.max(1, height);
  const radius = Math.min(2, width / 2, bottom - top);
  return [
    `M${left},${bottom}`,
    `V${top + radius}`,
    `Q${left},${top} ${left + radius},${top}`,
    `H${left + width - radius}`,
    `Q${left + width},${top} ${left + width},${top + radius}`,
    `V${bottom}`,
    'Z',
  ].join(' ');
}

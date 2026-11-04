import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, useState } from 'react';
import { cn } from '@/lib/cn';
import { type ChartUnit, countOf, formatCount, formatShare, textWidth, useKeepInside } from './chart-utils';

export interface PieSlice {
  key: string;
  label: string;
  value: number;
  /** Classe do preenchimento da fatia (`fill-*`). */
  fill: string;
  /** Classe de fundo da amostra na legenda (`bg-*`), o mesmo tom da fatia. */
  swatch: string;
  /** Classe do percentual escrito dentro da fatia (`fill-*`), legível sobre o tom dela. */
  ink: string;
  /** Ícone de forma própria ao lado do nome na legenda. */
  icon?: LucideIcon;
}

const SIZE = 160;
const CENTER = SIZE / 2;
/** Sobra em volta do círculo para a fatia em destaque sair um pouco, sem passar da caixa. */
const RADIUS = 74;
const LIFT = 4;
/** Onde vai o percentual dentro da fatia (fração do raio). */
const LABEL_AT = 0.62;
const FONT = 11;

interface Arc {
  slice: PieSlice;
  index: number;
  share: number;
  start: number;
  end: number;
}

/** Ponto no círculo: a fração da volta (0 no topo, sentido horário) e o raio. */
function point(turn: number, radius: number): [number, number] {
  const angle = turn * 2 * Math.PI - Math.PI / 2;
  return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)];
}

/**
 * Gráfico de pizza (parte de um todo), a pedido do responsável pelo produto. As fatias seguem a ordem dada, a partir
 * do topo e no sentido horário, a mesma da legenda, e são separadas por 2 px da cor da superfície; fatia zerada não é
 * desenhada. A legenda é a tabela dos números (nome, quantidade e percentual), sempre visível: a cor nunca identifica
 * sozinha, e nada depende do mouse. O percentual também vai dentro da fatia quando cabe com folga. Passar o mouse,
 * tocar ou usar as setas com o gráfico em foco destaca a fatia e a linha dela na legenda, com a dica.
 */
export function PieChart({
  title,
  slices,
  unit,
  columns,
  empty = 'Nada no período.',
  className,
}: {
  title: string;
  slices: readonly PieSlice[];
  unit: ChartUnit;
  /** Cabeçalhos da tabela da legenda (lidos pelo leitor de tela): a categoria e a quantidade. */
  columns: { category: string; value: string };
  empty?: string;
  className?: string;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const tipRef = useKeepInside<HTMLDivElement>(frame, active);

  const total = slices.reduce((sum, slice) => sum + slice.value, 0);
  if (total === 0) {
    return (
      <figure className={className}>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </figure>
    );
  }

  const arcs: Arc[] = [];
  let cursor = 0;
  for (const [index, slice] of slices.entries()) {
    const share = slice.value / total;
    arcs.push({ slice, index, share, start: cursor, end: cursor + share });
    cursor += share;
  }
  const drawn = arcs.filter((arc) => arc.share > 0);
  const order = drawn.map((arc) => arc.index);
  const current = active === null ? undefined : arcs[active];

  const summary = `${title}: ${arcs
    .map((arc) => `${arc.slice.label}, ${countOf(arc.slice.value, unit)} (${formatShare(arc.share)})`)
    .join('; ')}. Use as setas para ver cada fatia.`;

  const fromKeys = (event: KeyboardEvent<SVGSVGElement>) => {
    const position = active === null ? -1 : order.indexOf(active);
    const moves: Record<string, () => number> = {
      ArrowRight: () => Math.min(order.length - 1, position + 1),
      ArrowDown: () => Math.min(order.length - 1, position + 1),
      ArrowLeft: () => Math.max(0, position - 1),
      ArrowUp: () => Math.max(0, position - 1),
      Home: () => 0,
      End: () => order.length - 1,
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    setActive(order[move()] ?? null);
  };

  /** Centro do rótulo e da dica: no meio da fatia, a LABEL_AT do raio (no centro, se for a única). */
  const anchor = (arc: Arc): [number, number] =>
    arc.share >= 1 ? [CENTER, CENTER] : point((arc.start + arc.end) / 2, RADIUS * LABEL_AT);
  /** O percentual só entra se a corda da fatia, na altura do rótulo, tem folga para o texto em qualquer direção. */
  const fits = (arc: Arc, text: string) =>
    arc.share >= 0.5 || 2 * RADIUS * LABEL_AT * Math.sin(Math.PI * arc.share) >= textWidth(text, FONT) + 6;

  return (
    <figure className={cn('min-w-0', className)}>
      <div ref={setFrame} className="flex flex-wrap items-center gap-x-6 gap-y-4">
        <div className="relative shrink-0">
          <svg
            width={SIZE}
            height={SIZE}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="block"
            role="img"
            tabIndex={0}
            aria-label={summary}
            onKeyDown={fromKeys}
            onFocus={() => setActive((value) => value ?? order[0] ?? null)}
            onBlur={() => setActive(null)}
            // No toque, a dica fica depois de soltar o dedo; sai quando o gráfico perde o foco (toque fora).
            onPointerLeave={(event) => event.pointerType === 'mouse' && setActive(null)}
          >
            {drawn.map((arc) => {
              const lifted = arc.index === active;
              const [dx, dy] =
                lifted && arc.share < 1 ? point((arc.start + arc.end) / 2, LIFT) : [CENTER, CENTER];
              const common = {
                'data-slice': arc.slice.key,
                className: cn(arc.slice.fill, 'stroke-surface motion-safe:transition-transform'),
                strokeWidth: 2,
                strokeLinejoin: 'round' as const,
                style: lifted ? { transform: `translate(${dx - CENTER}px, ${dy - CENTER}px)` } : undefined,
                onPointerEnter: () => setActive(arc.index),
              };
              if (arc.share >= 1)
                return <circle key={arc.slice.key} cx={CENTER} cy={CENTER} r={RADIUS} {...common} />;
              const [x0, y0] = point(arc.start, RADIUS);
              const [x1, y1] = point(arc.end, RADIUS);
              const large = arc.share > 0.5 ? 1 : 0;
              return (
                <path
                  key={arc.slice.key}
                  d={`M${CENTER},${CENTER} L${x0},${y0} A${RADIUS},${RADIUS} 0 ${large} 1 ${x1},${y1} Z`}
                  {...common}
                />
              );
            })}
            {drawn.map((arc) => {
              const text = formatShare(arc.share);
              if (!fits(arc, text)) return null;
              const [x, y] = anchor(arc);
              return (
                <text
                  key={arc.slice.key}
                  x={x}
                  y={y + 4}
                  textAnchor="middle"
                  className={cn('pointer-events-none text-[11px] font-semibold tabular-nums', arc.slice.ink)}
                >
                  {text}
                </text>
              );
            })}
          </svg>
          {current && (
            <div
              ref={tipRef}
              aria-hidden
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border bg-surface-raised px-2.5 py-1.5 text-xs whitespace-nowrap shadow-sm"
              style={{ left: anchor(current)[0], top: anchor(current)[1] - 10 }}
            >
              <strong className="block font-semibold">{countOf(current.slice.value, unit)}</strong>
              <span className="text-muted-foreground">
                {current.slice.label} · {formatShare(current.share)}
              </span>
            </div>
          )}
        </div>
        <table className="min-w-40 flex-1 text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">{columns.category}</th>
              <th scope="col">{columns.value}</th>
              <th scope="col">Percentual</th>
            </tr>
          </thead>
          <tbody>
            {arcs.map((arc) => {
              const Icon = arc.slice.icon;
              return (
                <tr
                  key={arc.slice.key}
                  data-active={arc.index === active || undefined}
                  className="data-active:bg-foreground/5"
                  onPointerEnter={() => arc.share > 0 && setActive(arc.index)}
                  onPointerLeave={() => setActive(null)}
                >
                  <th scope="row" className="py-1 pr-3 pl-1 text-left font-normal">
                    <span className="flex items-center gap-2">
                      <span aria-hidden className={cn('size-3 shrink-0 rounded-sm', arc.slice.swatch)} />
                      {Icon && <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
                      {arc.slice.label}
                    </span>
                  </th>
                  <td className="py-1 pr-3 text-right font-medium tabular-nums">
                    {formatCount(arc.slice.value)}
                  </td>
                  <td className="py-1 pr-1 text-right text-muted-foreground tabular-nums">
                    {formatShare(arc.share)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="sr-only" aria-live="polite">
        {current
          ? `${current.slice.label}: ${countOf(current.slice.value, unit)}, ${formatShare(current.share)} do total.`
          : ''}
      </p>
    </figure>
  );
}

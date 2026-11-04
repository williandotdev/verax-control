import type { LucideIcon } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { ChartTable } from './chart-table';
import {
  type ChartUnit,
  countOf,
  countTicks,
  formatCount,
  formatDate,
  formatShortDate,
  textWidth,
  useElementWidth,
  useKeepInside,
} from './chart-utils';

export interface LineSeries<K extends string> {
  key: K;
  label: string;
  /** Classe do traço da linha (`stroke-*`). */
  stroke: string;
  /** Classe do preenchimento do marcador (`fill-*`). */
  fill: string;
  /** Classe de fundo da chave da legenda e da dica (`bg-*`). */
  swatch: string;
  /** Ícone de forma própria ao lado do nome na legenda (a série não depende só da cor). */
  icon?: LucideIcon;
  iconClass?: string;
}

export type LineRow<K extends string> = { date: string } & Readonly<Record<K, number>>;

const HEIGHT = 208;
const TOP = 12;
const BOTTOM = 26;
const FONT = 11;
/** Distância mínima entre dois rótulos no fim das linhas; mais perto que isso, nenhum dos dois aparece. */
const LABEL_GAP = 14;
/** Espaço mínimo por data no eixo horizontal ("05/10" e um respiro). */
const DATE_SLOT = 72;
const FALLBACK_WIDTH = 640;

/**
 * Gráfico de linhas por dia, uma linha por série, sobre um eixo de contagem que começa no zero. A legenda fica sempre
 * (chave de linha, ícone e nome); o nome também vai no fim de cada linha quando cabe sem encostar em outro. Passar o
 * mouse, tocar ou usar as setas com o gráfico em foco mostra todas as séries do dia; os números estão na tabela de
 * "Ver tabela". A largura acompanha o quadro, para o texto ficar no tamanho real em qualquer tela.
 */
export function LineChart<K extends string>({
  title,
  rows,
  series,
  unit,
  empty = 'Nada no período.',
  className,
}: {
  title: string;
  /** Do dia mais antigo ao mais recente. */
  rows: readonly LineRow<K>[];
  series: readonly LineSeries<K>[];
  unit: ChartUnit;
  empty?: string;
  className?: string;
}) {
  const [frameRef, width, frame] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setActive] = useState<number | null>(null);
  const tipRef = useKeepInside<HTMLDivElement>(frame, `${selected}:${width}`);

  const totals = rows.map((row) => series.reduce((sum, item) => sum + row[item.key], 0));
  const grandTotal = totals.reduce((sum, value) => sum + value, 0);
  const first = rows[0];
  const lastIndex = rows.length - 1;
  const last = rows[lastIndex];

  if (!first || !last || grandTotal === 0) {
    return (
      <figure className={className}>
        <p className="text-sm text-muted-foreground">{empty}</p>
      </figure>
    );
  }

  // Eixo vertical: números redondos do zero ao primeiro passo que cobre o maior valor de qualquer série.
  const max = Math.max(...rows.flatMap((row) => series.map((item) => row[item.key])));
  const ticks = countTicks(max);
  const top = ticks[ticks.length - 1] ?? 1;
  const plotBottom = HEIGHT - BOTTOM;
  const y = (value: number) => TOP + ((top - value) * (plotBottom - TOP)) / top;

  // Rótulos no fim das linhas: só os que ficam a LABEL_GAP de todos os outros. Linhas que terminam juntas ficam
  // com a legenda e a dica, sem rótulo empilhado.
  const ends = series.map((item) => ({ item, y: y(last[item.key]) }));
  const labeled = ends.filter((end) =>
    ends.every((other) => other === end || Math.abs(other.y - end.y) >= LABEL_GAP),
  );
  const single = rows.length === 1;
  const left = Math.ceil(Math.max(...ticks.map((tick) => textWidth(formatCount(tick), FONT)))) + 10;
  const right =
    labeled.length > 0 && !single
      ? Math.ceil(Math.max(...labeled.map((end) => textWidth(end.item.label, FONT)))) + 20
      : 12;
  const plotWidth = Math.max(1, width - left - right);
  const x = (index: number) => (single ? left + plotWidth / 2 : left + (index * plotWidth) / lastIndex);

  const dateTicks = single ? [0] : dateTickIndexes(lastIndex, plotWidth);

  const peak = totals.indexOf(Math.max(...totals));
  const peakRow = rows[peak] ?? last;
  const summary = single
    ? `${title}, em ${formatDate(last.date)}: ${countOf(grandTotal, unit)}.`
    : `${title}, de ${formatDate(first.date)} a ${formatDate(last.date)}: ${countOf(grandTotal, unit)} no total; o dia com mais ${unit.many} foi ${formatDate(peakRow.date)}, com ${formatCount(totals[peak] ?? 0)}. Use as setas para ver cada dia.`;

  // O dia em destaque; um índice de antes da troca de período que não existe mais é ignorado.
  const active = selected !== null && selected <= lastIndex ? selected : null;
  const shown = active === null ? undefined : rows[active];
  const describe = (row: LineRow<K>, index: number) =>
    `${formatDate(row.date)}: ${series.map((item) => `${item.label} ${formatCount(row[item.key])}`).join(', ')}; total ${countOf(totals[index] ?? 0, unit)}.`;

  const fromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const position = ((event.clientX - box.left) / box.width) * width;
    const index = single ? 0 : Math.round(((position - left) / plotWidth) * lastIndex);
    setActive(Math.min(lastIndex, Math.max(0, index)));
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
    setActive((current) => Math.min(lastIndex, Math.max(0, move(current ?? lastIndex))));
  };

  // A mais grave por cima: desenha da última série para a primeira.
  const drawOrder = [...series].reverse();
  const flip = active !== null && x(active) > width / 2;

  return (
    <figure className={cn('min-w-0', className)}>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {series.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.key} className="flex items-center gap-1.5">
              <span aria-hidden className={cn('h-0.5 w-4 rounded-full', item.swatch)} />
              {Icon && <Icon aria-hidden className={cn('size-3.5', item.iconClass)} />}
              {item.label}
            </li>
          );
        })}
      </ul>
      <div ref={frameRef} className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block h-auto w-full touch-pan-y"
          role="img"
          tabIndex={0}
          aria-label={summary}
          onPointerMove={fromPointer}
          onPointerDown={fromPointer}
          // No toque, a dica fica depois de soltar o dedo; sai quando o gráfico perde o foco (toque fora).
          onPointerLeave={(event) => event.pointerType === 'mouse' && setActive(null)}
          onKeyDown={fromKeys}
          onFocus={() => setActive((current) => current ?? lastIndex)}
          onBlur={() => setActive(null)}
        >
          {ticks.map((tick) => (
            <g key={tick}>
              <line
                x1={left}
                x2={left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
                className={tick === 0 ? 'stroke-border-strong' : 'stroke-gridline'}
                strokeWidth={1}
                shapeRendering="crispEdges"
              />
              <text
                x={left - 8}
                y={y(tick) + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[11px] tabular-nums"
              >
                {formatCount(tick)}
              </text>
            </g>
          ))}
          {dateTicks.map((index) => (
            <text
              key={index}
              x={x(index)}
              y={HEIGHT - 8}
              textAnchor={single ? 'middle' : index === 0 ? 'start' : index === lastIndex ? 'end' : 'middle'}
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {formatShortDate((rows[index] ?? last).date)}
            </text>
          ))}
          {active !== null && (
            <line
              x1={x(active)}
              x2={x(active)}
              y1={TOP}
              y2={plotBottom}
              className="stroke-border-strong"
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
          )}
          {!single &&
            drawOrder.map((item) => (
              <path
                key={item.key}
                data-series={item.key}
                d={rows
                  .map((row, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(row[item.key])}`)
                  .join(' ')}
                fill="none"
                className={item.stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          {/* Marcadores: o fim das linhas com rótulo, o único dia (sem linha) e o dia em destaque. */}
          {drawOrder
            .filter((item) => single || labeled.some((end) => end.item === item))
            .map((item) => (
              <Marker key={item.key} item={item} cx={x(lastIndex)} cy={y(last[item.key])} />
            ))}
          {active !== null &&
            shown &&
            drawOrder.map((item) => (
              <Marker key={item.key} item={item} cx={x(active)} cy={y(shown[item.key])} />
            ))}
          {labeled.map((end) => (
            <text
              key={end.item.key}
              x={x(lastIndex) + 10}
              y={Math.min(plotBottom, Math.max(TOP + 4, end.y + 4))}
              className="fill-foreground text-[11px]"
            >
              {end.item.label}
            </text>
          ))}
        </svg>
        {active !== null && shown && (
          <div
            ref={tipRef}
            aria-hidden
            className={cn(
              'pointer-events-none absolute z-10 rounded-md border bg-surface-raised px-2.5 py-2 text-xs whitespace-nowrap shadow-sm',
              flip && '-translate-x-full',
            )}
            style={{ left: x(active) + (flip ? -10 : 10), top: TOP }}
          >
            <p className="mb-1 font-medium">{formatDate(shown.date)}</p>
            <ul className="grid grid-cols-[auto_auto_auto] items-center gap-x-2 gap-y-0.5">
              {series.map((item) => (
                <li key={item.key} className="contents">
                  <span className={cn('h-0.5 w-3 rounded-full', item.swatch)} />
                  <strong className="text-right font-semibold tabular-nums">
                    {formatCount(shown[item.key])}
                  </strong>
                  <span className="text-muted-foreground">{item.label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1 border-t pt-1 text-muted-foreground">
              Total{' '}
              <strong className="font-semibold text-foreground">{formatCount(totals[active] ?? 0)}</strong>
            </p>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {active !== null && shown ? describe(shown, active) : ''}
      </p>
      <ChartTable
        title={title}
        headers={['Dia', ...series.map((item) => item.label)]}
        rows={[...rows].reverse().map((row) => ({
          key: row.date,
          cells: [formatDate(row.date), ...series.map((item) => formatCount(row[item.key]))],
        }))}
      />
    </figure>
  );
}

/** Ponto de 8 px com o anel da cor da superfície, legível onde cruza outra linha. */
function Marker<K extends string>({ item, cx, cy }: { item: LineSeries<K>; cx: number; cy: number }) {
  return (
    <circle
      data-marker={item.key}
      cx={cx}
      cy={cy}
      r={4}
      className={cn(item.fill, 'stroke-surface')}
      strokeWidth={2}
    />
  );
}

/** Passos do eixo de datas, em dias: um intervalo que o leitor reconhece (a cada 2, 3 dias, por semana...). */
const DATE_STEPS = [1, 2, 3, 7, 14, 30, 60, 90];

/**
 * Índices das datas do eixo: a primeira e, dali, a cada passo fixo de dias, o menor que deixa DATE_SLOT px entre
 * duas datas. A última data sempre aparece; a anterior sai se ficaria encostada nela.
 */
function dateTickIndexes(lastIndex: number, plotWidth: number): number[] {
  const perDay = plotWidth / lastIndex;
  const step = DATE_STEPS.find((days) => days * perDay >= DATE_SLOT) ?? lastIndex;
  const indexes: number[] = [];
  for (let index = 0; index < lastIndex; index += step) indexes.push(index);
  const previous = indexes[indexes.length - 1] ?? 0;
  if (indexes.length > 1 && (lastIndex - previous) * perDay < DATE_SLOT) indexes.pop();
  indexes.push(lastIndex);
  return indexes;
}

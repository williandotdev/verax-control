import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface ScorePoint {
  /** Data da varredura (AAAA-MM-DD). */
  date: string;
  score: number;
}

const W = 320;
const H = 104;
// À direita, uma margem só para o rótulo do limite, que assim nunca encosta na linha.
const PAD = { top: 8, right: 36, bottom: 20, left: 26 };
const day = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
const dateLabel = (date: string): string => day.format(new Date(`${date}T00:00:00Z`));

/**
 * Evolução da nota de postura (0 a 100) ao longo dos dias. Uma série só, então sem legenda: o título do cartão a
 * nomeia. Linha fina, grade discreta e o limite de atenção tracejado. Passar o mouse (ou as setas, com o gráfico em
 * foco) mostra a nota de cada dia; os mesmos números estão numa tabela para leitor de tela.
 */
export function ScoreTrend({
  points,
  label,
  warningBelow = 70,
  className,
}: {
  points: readonly ScorePoint[];
  label: string;
  warningBelow?: number;
  className?: string;
}) {
  const tableId = useId();
  const svgRef = useRef<SVGSVGElement>(null);
  const [active, setActive] = useState<number | null>(null);

  if (points.length < 2) {
    return (
      <p className={cn('text-xs text-muted-foreground', className)}>
        A evolução aparece a partir da segunda varredura.
      </p>
    );
  }

  const last = points.length - 1;
  const x = (index: number) => PAD.left + (index * (W - PAD.left - PAD.right)) / last;
  const y = (score: number) => PAD.top + ((100 - score) * (H - PAD.top - PAD.bottom)) / 100;
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point.score)}`)
    .join(' ');
  const first = points[0] as ScorePoint;
  const latest = points[last] as ScorePoint;
  const shown = active === null ? null : points[active];

  const fromPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0) return;
    const viewX = ((event.clientX - box.left) / box.width) * W;
    const index = Math.round(((viewX - PAD.left) / (W - PAD.left - PAD.right)) * last);
    setActive(Math.min(last, Math.max(0, index)));
  };
  const fromKeys = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' ? -1 : 1;
    setActive((current) => Math.min(last, Math.max(0, (current ?? last) + step)));
  };

  return (
    <figure className={cn('relative', className)}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block h-auto w-full touch-none focus:outline-2 focus:outline-offset-2 focus:outline-ring"
        role="img"
        tabIndex={0}
        aria-label={`${label}: de ${first.score} em ${dateLabel(first.date)} para ${latest.score} em ${dateLabel(latest.date)}. Use as setas para ver cada dia.`}
        aria-describedby={tableId}
        onPointerMove={fromPointer}
        onPointerLeave={() => setActive(null)}
        onKeyDown={fromKeys}
        onBlur={() => setActive(null)}
      >
        {[0, 50, 100].map((value) => (
          <g key={value}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(value)}
              y2={y(value)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 6}
              y={y(value) + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px]"
            >
              {value}
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(warningBelow)}
          y2={y(warningBelow)}
          className="stroke-medium"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
        <text x={W - PAD.right + 4} y={y(warningBelow) - 1} className="fill-muted-foreground text-[9px]">
          limite
        </text>
        <text x={W - PAD.right + 4} y={y(warningBelow) + 9} className="fill-muted-foreground text-[9px]">
          {warningBelow}
        </text>
        <path
          d={line}
          fill="none"
          className="stroke-primary"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle
          cx={x(last)}
          cy={y(latest.score)}
          r={4}
          className="fill-primary stroke-surface"
          strokeWidth={2}
        />
        {[0, last].map((index) => (
          <text
            key={index}
            x={x(index)}
            y={H - 5}
            textAnchor={index === 0 ? 'start' : 'end'}
            className="fill-muted-foreground text-[9px]"
          >
            {dateLabel((points[index] as ScorePoint).date)}
          </text>
        ))}
        {active !== null && shown && (
          <g aria-hidden>
            <line
              x1={x(active)}
              x2={x(active)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              className="stroke-border-strong"
              strokeWidth={1}
            />
            <circle
              cx={x(active)}
              cy={y(shown.score)}
              r={4}
              className="fill-primary stroke-surface"
              strokeWidth={2}
            />
          </g>
        )}
      </svg>
      {active !== null && shown && (
        <div
          aria-live="polite"
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded border bg-surface-raised px-2 py-1 text-xs shadow-sm"
          style={{ left: `${(x(active) / W) * 100}%` }}
        >
          {dateLabel(shown.date)} · nota <strong>{shown.score}</strong>
        </div>
      )}
      <table id={tableId} className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Nota</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point) => (
            <tr key={point.date}>
              <td>{dateLabel(point.date)}</td>
              <td>{point.score}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

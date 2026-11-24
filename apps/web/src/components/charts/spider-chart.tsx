import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, type To, useNavigate } from 'react-router';
import { cn } from '@/lib/cn';
import { useElementWidth, useKeepInside } from './chart-utils';
import {
  type PlacedLabel,
  type Point,
  pointOn,
  polygonPoints,
  ringPoints,
  sharePoint,
  SPIDER_RINGS,
  type SpiderLabel,
  spiderLayout,
} from './spider-geometry';

export interface SpiderAxis extends SpiderLabel {
  key: string;
  /** A participação do eixo no total, de 0 a 1. */
  share: number;
  /** O nome falado do eixo, com os números: tudo o que a dica mostra. */
  description: string;
  /** O conteúdo da dica. */
  tip: ReactNode;
  /** Para onde leva o eixo. Sem ele, o eixo só mostra a dica. */
  to?: To;
}

interface Active {
  key: string;
  /** A dica fica junto do nome ou do ponto, o que o mouse ou o dedo apontou. */
  at: 'label' | 'point';
  /** Mostrada por um toque: o leitor de tela ouve a dica, e ela diz que o segundo toque abre. */
  touched: boolean;
}

/** Largura antes da primeira medida (e no jsdom). */
const FALLBACK_WIDTH = 560;
/** Raio da área de toque do ponto: 24 px de lado. */
const POINT_HIT_RADIUS = 12;
/** Distância entre a dica e o nome ou o centro do ponto. */
const TIP_GAP = { label: 6, point: 14 } as const;

/**
 * Gráfico de teia: a participação de cada categoria no total, um eixo por categoria, na escala de raiz quadrada (veja
 * `spider-geometry.ts`), com anéis poligonais a 5%, 25%, 50% e 100%, e uma série só na tinta neutra. Não é severidade: o
 * âmbar passaria por "alto" ou "médio", e o azul por "baixo", ao lado dos selos. O nome e o ponto de cada eixo são o
 * mesmo alvo: mostram a dica com o mouse, o foco ou o primeiro toque, e levam ao link com o clique, o Enter ou o segundo
 * toque.
 *
 * Eixo zerado não ganha ponto: todos cairiam no centro, um em cima do outro, e pareceriam um dado. O nome dele fica na
 * tinta discreta e continua no percurso do teclado, com a dica.
 */
export function SpiderChart({
  label,
  axes,
  touchHint,
  className,
}: {
  /** O resumo falado do gráfico. */
  label: string;
  /** A partir do topo, no sentido horário. */
  axes: readonly SpiderAxis[];
  /** O que o segundo toque faz, na dica do toque: "Toque de novo para ver os alertas". */
  touchHint?: string;
  className?: string;
}) {
  const navigate = useNavigate();
  const [frameRef, width, frame] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const layout = useMemo(() => spiderLayout(width, axes), [width, axes]);
  const [active, setActive] = useState<Active | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const pointerType = useRef<string>('mouse');
  const pointedAt = useRef<Active['at']>('label');
  // No toque, o eixo que já mostra a dica pelo toque anterior: só ele abre no próximo. Fica à parte de `active`, que o
  // foco do próprio toque também marca antes do clique.
  const armed = useRef<string | null>(null);
  const tipRef = useKeepInside<HTMLDivElement>(
    frame,
    active && `${active.key}:${active.at}:${active.touched}:${width}`,
  );

  // Esc fecha a dica (do foco ou do mouse), e o toque fora do gráfico também: no celular, o eixo pode não ter o foco.
  const open = active !== null;
  useEffect(() => {
    if (!open) return undefined;
    const close = () => {
      armed.current = null;
      setActive(null);
    };
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !frame?.contains(event.target)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, frame]);

  const count = axes.length;
  const { center, radius } = layout;
  const points = axes.map((axis, index) => sharePoint(layout, axis.share, index, count));
  const hasData = axes.some((axis) => axis.share > 0);
  const currentIndex = axes.findIndex((axis) => axis.key === active?.key);
  const current = axes[currentIndex];
  // A parada do teclado: o eixo escolhido pelas setas ou, sem escolha, o primeiro com valor.
  const tabStop =
    axes.find((axis) => axis.key === focusKey) ?? axes.find((axis) => axis.share > 0) ?? axes[0];

  const onKeyDown = (event: KeyboardEvent<Element>, index: number) => {
    pointerType.current = 'mouse';
    if (event.key === 'Enter') {
      const to = axes[index]?.to;
      // Com Ctrl, Shift ou Cmd, fica com o navegador (outra aba, outra janela).
      if (to === undefined || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      void navigate(to);
      return;
    }
    // Em volta da teia: do último eixo, volta ao primeiro.
    const moves: Record<string, number> = {
      ArrowRight: (index + 1) % count,
      ArrowDown: (index + 1) % count,
      ArrowLeft: (index + count - 1) % count,
      ArrowUp: (index + count - 1) % count,
      Home: 0,
      End: count - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    frame?.querySelectorAll<SVGElement>('[data-axis]')[target]?.focus();
  };

  const onPointed = (event: PointerEvent<Element>, key: string, at: Active['at']) => {
    pointerType.current = event.pointerType;
    pointedAt.current = at;
    // O mouse mostra a dica ao passar; no toque e na caneta, quem decide é o clique (abaixo).
    if (event.pointerType === 'mouse') setActive({ key, at, touched: false });
  };

  const onClick = (event: MouseEvent<Element>, axis: SpiderAxis) => {
    if (pointerType.current === 'mouse') return;
    // No toque, o primeiro toque num eixo mostra a dica; o segundo, no mesmo eixo, segue o link.
    if (armed.current === axis.key && axis.to !== undefined) {
      armed.current = null;
      return;
    }
    event.preventDefault();
    armed.current = axis.key;
    setActive({ key: axis.key, at: pointedAt.current, touched: true });
  };

  const tipAt = current ? tipPosition(layout.labels[currentIndex], points[currentIndex], active?.at) : null;
  const tipBelow = tipAt !== null && tipAt.middle < center.y;
  const gap = TIP_GAP[active?.at ?? 'label'];

  return (
    <div ref={frameRef} className={cn('relative w-full', className)}>
      <svg
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        className="block h-auto w-full"
        role="group"
        aria-label={label}
        data-compact={layout.compact || undefined}
      >
        <g aria-hidden className="pointer-events-none">
          {SPIDER_RINGS.map((ratio) => (
            <polygon
              key={ratio}
              points={ringPoints(layout, ratio, count)}
              className="fill-none stroke-border-strong"
              strokeWidth={1}
            />
          ))}
          {axes.map((axis, index) => {
            const end = pointOn(center, radius, index, count);
            return (
              <line
                key={axis.key}
                x1={center.x}
                y1={center.y}
                x2={end.x}
                y2={end.y}
                className={axis.key === active?.key ? 'stroke-foreground/60' : 'stroke-border-strong'}
                strokeWidth={1}
              />
            );
          })}
          {hasData && (
            <polygon
              data-series
              points={polygonPoints(
                layout,
                axes.map((axis) => axis.share),
              )}
              className="fill-foreground/12 stroke-foreground"
              strokeWidth={2}
              strokeLinejoin="round"
            />
          )}
          {layout.chips.map((chip) => (
            <g key={chip.ratio}>
              <rect
                x={chip.left}
                y={chip.top}
                width={chip.width}
                height={chip.height}
                rx={3}
                className="fill-surface"
              />
              <text
                x={chip.left + chip.width / 2}
                y={chip.top + chip.height / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={layout.chipSize}
                className="fill-muted-foreground tabular-nums"
              >
                {chip.label}
              </text>
            </g>
          ))}
        </g>
        {axes.map((axis, index) => {
          const placed = layout.labels[index];
          const point = points[index];
          if (!placed || !point) return null;
          const shared = {
            'data-axis': axis.key,
            'data-active': axis.key === active?.key || undefined,
            'aria-label': axis.description,
            tabIndex: axis.key === tabStop?.key ? 0 : -1,
            onPointerLeave: (event: PointerEvent<Element>) => {
              if (event.pointerType === 'mouse') setActive(null);
            },
            onClick: (event: MouseEvent<Element>) => onClick(event, axis),
            onKeyDown: (event: KeyboardEvent<Element>) => onKeyDown(event, index),
            onFocus: () => {
              setFocusKey(axis.key);
              setActive({ key: axis.key, at: 'label', touched: false });
            },
            onBlur: () => {
              armed.current = null;
              setActive(null);
            },
          };
          const body = (
            <AxisMark
              axis={axis}
              placed={placed}
              point={point}
              dotRadius={layout.dotRadius}
              fontSize={layout.fontSize}
              lineHeight={layout.lineHeight}
              onPointed={(event, at) => onPointed(event, axis.key, at)}
            />
          );
          return axis.to === undefined ? (
            <g key={axis.key} role="img" className="group outline-none" {...shared}>
              {body}
            </g>
          ) : (
            <Link key={axis.key} to={axis.to} className="group cursor-pointer outline-none" {...shared}>
              {body}
            </Link>
          );
        })}
      </svg>
      {current && tipAt && (
        <div
          ref={tipRef}
          aria-hidden
          data-spider-tip
          className={cn(
            'pointer-events-none absolute z-10 w-max max-w-60 -translate-x-1/2 rounded-md border bg-surface-raised px-2.5 py-1.5 text-xs shadow-sm',
            !tipBelow && '-translate-y-full',
          )}
          style={{
            left: tipAt.x,
            top: tipBelow ? tipAt.bottom + gap : tipAt.top - gap,
          }}
        >
          {current.tip}
          {active?.touched && current.to !== undefined && touchHint && (
            <p className="mt-1 text-muted-foreground">{touchHint}</p>
          )}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {current && active?.touched ? current.description : ''}
      </p>
    </div>
  );
}

/** O nome e o ponto de um eixo, com as áreas de toque (maiores que o desenho) e o anel do foco e do destaque. */
function AxisMark({
  axis,
  placed,
  point,
  dotRadius,
  fontSize,
  lineHeight,
  onPointed,
}: {
  axis: SpiderAxis;
  placed: PlacedLabel;
  point: Point;
  dotRadius: number;
  fontSize: number;
  lineHeight: number;
  onPointed: (event: PointerEvent<Element>, at: Active['at']) => void;
}) {
  const ring =
    'pointer-events-none fill-none stroke-ring opacity-0 group-focus-visible:opacity-100 group-data-active:opacity-100';
  const hasValue = axis.share > 0;
  return (
    <>
      <rect
        x={placed.hit.left}
        y={placed.hit.top}
        width={placed.hit.width}
        height={placed.hit.height}
        className="fill-transparent"
        onPointerEnter={(event) => onPointed(event, 'label')}
        onPointerDown={(event) => onPointed(event, 'label')}
      />
      <text
        textAnchor={placed.anchor}
        fontSize={fontSize}
        className={cn(
          'pointer-events-none',
          hasValue ? 'fill-foreground font-medium' : 'fill-muted-foreground',
        )}
      >
        {placed.lines.map((line, index) => (
          <tspan
            key={index}
            x={placed.x}
            y={placed.top + (index + 0.5) * lineHeight}
            dominantBaseline="central"
          >
            {line}
          </tspan>
        ))}
      </text>
      <rect
        x={placed.hit.left + 1}
        y={placed.hit.top + 1}
        width={placed.hit.width - 2}
        height={placed.hit.height - 2}
        rx={4}
        className={ring}
        strokeWidth={2}
      />
      {hasValue && (
        <>
          <circle
            cx={point.x}
            cy={point.y}
            r={POINT_HIT_RADIUS}
            className="fill-transparent"
            onPointerEnter={(event) => onPointed(event, 'point')}
            onPointerDown={(event) => onPointed(event, 'point')}
          />
          <circle
            data-dot
            cx={point.x}
            cy={point.y}
            r={dotRadius}
            className="pointer-events-none fill-foreground stroke-surface"
            strokeWidth={2}
            paintOrder="stroke"
          />
          <circle cx={point.x} cy={point.y} r={dotRadius + 4} className={ring} strokeWidth={2} />
        </>
      )}
    </>
  );
}

/** Onde vai a dica: junto do nome ou do ponto, o que foi apontado. */
function tipPosition(
  placed: PlacedLabel | undefined,
  point: Point | undefined,
  at: Active['at'] | undefined,
): { x: number; top: number; middle: number; bottom: number } | null {
  if (at === 'point' && point) {
    return { x: point.x, top: point.y, middle: point.y, bottom: point.y };
  }
  if (!placed) return null;
  const { left, top, width, height } = placed.hit;
  return { x: left + width / 2, top, middle: top + height / 2, bottom: top + height };
}

import { ChevronRight, OctagonAlert, Pause, Play } from 'lucide-react';
import {
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { formatCompact, formatHour, useElementWidth } from '@/components/charts/chart-utils';
import { Button } from '@/components/ui/button';
import { SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';
import { formatCount, formatList, plural } from '@/lib/format';
import { shapePoints } from './radar-geometry';
import { COUNTRY_POINTS, WORLD_LAND_PATH, WORLD_MAP_HEIGHT, WORLD_MAP_WIDTH } from './world-map-data';
import {
  COMPACT_WIDTH,
  type CountryTraffic,
  countryName,
  dotAt,
  hasPoint,
  MAX_PULSING,
  momentText,
  type OriginCounts,
  outerRadius,
  pulsingCodes,
  shareOf,
  summarize,
  tipPosition,
  TOP_COUNT,
  type TrafficSummary,
  type WorldDot,
  worldDots,
  type WorldTraffic,
} from './world-map-model';
import { useWorldMapMotion } from './world-map-preference';

/** Largura antes da primeira medida (e no jsdom). */
const FALLBACK_WIDTH = 960;

interface Active {
  code: string;
  /** Mostrado por um toque: o leitor de tela ouve a dica. */
  touched: boolean;
}

const requests = (value: number) => plural(value, 'requisição', 'requisições');
const suspicious = (value: number) => plural(value, 'suspeita', 'suspeitas');
const blockedText = (value: number) => plural(value, 'bloqueada', 'bloqueadas');
const windowText = (hours: number) =>
  hours === 1 ? 'na última hora' : `nas últimas ${formatCount(hours)} horas`;
const recentText = (minutes: number) =>
  minutes === 1 ? 'no último minuto' : `nos últimos ${formatCount(minutes)} minutos`;

/** O país dito por extenso: o nome falado do ponto, com tudo o que a dica mostra. */
function describe(country: CountryTraffic, total: number, recentMinutes: number): string {
  const recent = country.recentRequests === 0 ? 'nenhuma' : formatCount(country.recentRequests);
  const recentFlagged = country.recentFlagged > 0 ? ` (${suspicious(country.recentFlagged)})` : '';
  return (
    `${countryName(country.code)}: ${requests(country.requests)}, ${shareOf(country.requests, total)} do total; ` +
    `${blockedText(country.blocked)}, ${suspicious(country.flagged)}; ` +
    `${recent} ${recentText(recentMinutes)}${recentFlagged}`
  );
}

/**
 * Mapa de origens: de que países vieram as requisições da janela, num mapa-múndi sem fronteiras, com um ponto por país. O
 * raio é o volume (escala logarítmica); a cor e a forma são o que veio (o comum na tinta neutra, num círculo; o suspeito na
 * cor do crítico, num octógono com anel); a onda, só em quem teve requisição nos últimos minutos. Nada depende da cor, do
 * mouse ou da animação: tudo está na lista e na tabela, e a animação tem botão de pausa.
 *
 * O país é o do endereço. O que não tem país (desconhecido, rede interna, CDN e proxy) não some: fica numa linha à parte, e
 * o percentual é sobre a soma de tudo.
 */
export function WorldMap({ traffic, userId }: { traffic: WorldTraffic; userId: string }) {
  const [paused, setPaused] = useWorldMapMotion(userId);
  const summary = useMemo(() => summarize(traffic), [traffic]);
  const pulsing = useMemo(() => pulsingCodes(summary.countries), [summary]);
  const [active, setActive] = useState<Active | null>(null);
  const onHover = useCallback(
    (code: string | null) => setActive(code === null ? null : { code, touched: false }),
    [],
  );
  // Sem log novo, ou com a atualização falhando, "agora" não é agora: nada pulsa.
  const live = traffic.state !== 'stale' && !traffic.refreshFailed;
  const recentCodes = live ? pulsing.codes : NO_CODES;
  const showList = summary.total.requests > 0;

  return (
    <div data-world-map className="@container space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-60">
          <Headline summary={summary} windowHours={traffic.windowHours} />
          <p className="text-xs text-muted-foreground">Atualizado às {formatHour(traffic.generatedAt)}</p>
        </div>
        {recentCodes.size > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setPaused(!paused)}>
            {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {paused ? 'Retomar' : 'Pausar'} <span className="sr-only">a animação do mapa</span>
          </Button>
        )}
      </div>
      {traffic.state === 'stale' && (
        <Notice>
          <strong className="font-semibold">
            {traffic.lastLogAt
              ? `Sem logs novos desde ${momentText(traffic.lastLogAt, traffic.generatedAt)}.`
              : 'Sem logs novos.'}
          </strong>{' '}
          O mapa mostra só o que chegou até lá.
        </Notice>
      )}
      {traffic.refreshFailed && (
        <Notice>
          <strong className="font-semibold">Não foi possível atualizar agora.</strong> Os números são das{' '}
          {formatHour(traffic.generatedAt)}.
        </Notice>
      )}
      <div
        className={cn(
          'grid gap-4',
          showList &&
            '@4xl:grid-cols-[minmax(0,1fr)_17rem] @4xl:grid-rows-[auto_1fr] @4xl:gap-x-6 @7xl:grid-cols-[minmax(0,1fr)_20rem]',
        )}
      >
        <div className="min-w-0 overflow-hidden rounded-panel border bg-map-ocean">
          <MapFrame
            summary={summary}
            windowHours={traffic.windowHours}
            recentMinutes={traffic.recentMinutes}
            recentCodes={recentCodes}
            paused={paused}
            active={active}
            onActive={setActive}
          />
          {summary.countries.length > 0 && (
            <Legend recentMinutes={traffic.recentMinutes} showRecent={recentCodes.size > 0} paused={paused} />
          )}
        </div>
        {showList && (
          <div className="min-w-0 space-y-3 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-1">
            <TopOrigins summary={summary} onHover={onHover} />
            <OffMap summary={summary} />
          </div>
        )}
        {showList && (
          <Notes
            traffic={traffic}
            summary={summary}
            capped={live && pulsing.active > MAX_PULSING ? pulsing.active : null}
          />
        )}
      </div>
      {showList && (
        <OriginTable
          summary={summary}
          windowHours={traffic.windowHours}
          recentMinutes={traffic.recentMinutes}
        />
      )}
    </div>
  );
}

const NO_CODES: ReadonlySet<string> = new Set();

function Headline({ summary, windowHours }: { summary: TrafficSummary; windowHours: number }) {
  const { total, countries } = summary;
  if (total.requests === 0) return <p className="text-sm">Nenhuma requisição {windowText(windowHours)}.</p>;
  return (
    <p className="text-sm">
      <strong className="font-semibold">{requests(total.requests)}</strong> {windowText(windowHours)}
      {countries.length > 0 &&
        `, de ${plural(countries.length, 'país identificado', 'países identificados')}`}
      :{' '}
      <strong className="font-semibold">
        {total.flagged === 0 ? 'nenhuma suspeita' : suspicious(total.flagged)}
      </strong>
      {total.flagged > 0 &&
        summary.flaggedCountries > 0 &&
        ` (em ${plural(summary.flaggedCountries, 'país', 'países')})`}{' '}
      e {total.blocked === 0 ? 'nenhuma bloqueada' : blockedText(total.blocked)}.
    </p>
  );
}

function Notice({ children }: { children: ReactNode }) {
  const { icon: Icon, tone, surface } = SEVERITY_STYLES.medium;
  return (
    <p role="status" className={cn('flex items-start gap-2 rounded-md border p-2 text-sm', surface)}>
      <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', tone)} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** A terra: um desenho só, que não muda com os dados nem com a largura. */
const Land = memo(function Land() {
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${WORLD_MAP_WIDTH} ${WORLD_MAP_HEIGHT}`}
      className="absolute inset-0 block size-full"
    >
      <path
        data-land
        d={WORLD_LAND_PATH}
        fillRule="evenodd"
        className="fill-map-land stroke-map-coast"
        strokeWidth={0.75}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
      />
    </svg>
  );
});

/** As ondas dos países ativos agora: elementos à parte, só com `transform` e `opacity`, que a placa de vídeo anima. */
const Pulses = memo(function Pulses({ dots }: { dots: readonly WorldDot[] }) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {dots.map((dot) => {
        const reach = outerRadius(dot) * 1.6 + 7;
        return (
          <span
            key={dot.code}
            data-pulse={dot.code}
            className={cn(
              'world-map-pulse absolute rounded-full border-2 border-current bg-current/15',
              dot.recentFlagged ? 'text-critical-text' : 'text-muted-foreground',
            )}
            style={{
              left: dot.x - reach,
              top: dot.y - reach,
              width: 2 * reach,
              height: 2 * reach,
              animationDelay: `${-dot.phase}ms`,
            }}
          />
        );
      })}
    </div>
  );
});

function MapFrame({
  summary,
  windowHours,
  recentMinutes,
  recentCodes,
  paused,
  active,
  onActive,
}: {
  summary: TrafficSummary;
  windowHours: number;
  recentMinutes: number;
  recentCodes: ReadonlySet<string>;
  paused: boolean;
  active: Active | null;
  onActive: (active: Active | null) => void;
}) {
  const [frameRef, width, frame] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);
  const height = (width * WORLD_MAP_HEIGHT) / WORLD_MAP_WIDTH;
  const compact = width < COMPACT_WIDTH;
  const svgRef = useRef<SVGSVGElement>(null);
  const pointerType = useRef<string>('mouse');
  const [focusCode, setFocusCode] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const { countries, total } = summary;
  const dots = useMemo(
    () => worldDots(countries, recentCodes, COUNTRY_POINTS, WORLD_MAP_WIDTH, width),
    [countries, recentCodes, width],
  );
  const pulses = useMemo(() => dots.filter((dot) => dot.recent), [dots]);
  const labels = useMemo(
    () => new Map(countries.map((item) => [item.code, describe(item, total.requests, recentMinutes)])),
    [countries, total, recentMinutes],
  );

  const current = dots.find((dot) => dot.code === active?.code);
  const currentCountry = current && countries.find((item) => item.code === current.code);
  const focusedDot = dots.find((dot) => dot.code === focused);
  // A parada do teclado: o país escolhido pelas setas ou, sem escolha (ou se ele saiu do mapa), o de maior volume.
  const tabStop = dots.some((dot) => dot.code === focusCode) ? focusCode : dots[0]?.code;

  // Esc fecha a dica (do foco ou do mouse), e o toque fora do mapa também.
  const open = active !== null;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onActive(null);
    };
    const onDown = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !frame?.contains(event.target)) onActive(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, frame, onActive]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>, code: string) => {
      const position = dots.findIndex((dot) => dot.code === code);
      const moves: Record<string, number> = {
        ArrowRight: position + 1,
        ArrowDown: position + 1,
        ArrowLeft: position - 1,
        ArrowUp: position - 1,
        Home: 0,
        End: dots.length - 1,
      };
      const target = moves[event.key];
      if (target === undefined) return;
      event.preventDefault();
      // Nas pontas não há próximo: o foco fica onde está.
      const next = dots[target];
      if (next) svgRef.current?.querySelector<SVGGElement>(`[data-country="${next.code}"]`)?.focus();
    },
    [dots],
  );
  const onFocus = useCallback(
    (code: string) => {
      setFocusCode(code);
      setFocused(code);
      onActive({ code, touched: false });
    },
    [onActive],
  );
  const onBlur = useCallback(() => {
    setFocused(null);
    onActive(null);
  }, [onActive]);

  /** O ponto sob o ponteiro. Quem decide é a conta (o mais perto), e não a ordem dos elementos na tela. */
  const pointed = (event: MouseEvent<SVGSVGElement>): WorldDot | null => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return null;
    const scale = width / box.width;
    return dotAt(dots, (event.clientX - box.left) * scale, (event.clientY - box.top) * scale);
  };
  // O mouse mostra a dica ao passar; no toque e na caneta, quem decide é o toque (o clique).
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (event.pointerType !== 'mouse') return;
    const code = pointed(event)?.code ?? null;
    if (code !== (active?.code ?? null)) onActive(code === null ? null : { code, touched: false });
  };
  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    if (pointerType.current === 'mouse') return;
    const code = pointed(event)?.code ?? null;
    onActive(code === null ? null : { code, touched: true });
  };

  const facts = currentCountry && (
    <Facts country={currentCountry} total={total.requests} recentMinutes={recentMinutes} compact={compact} />
  );
  const empty =
    total.requests === 0
      ? `Nenhuma requisição ${windowText(windowHours)}.`
      : countries.length === 0
        ? 'Nenhuma requisição com país identificado.'
        : dots.length === 0
          ? 'Nenhum dos países tem ponto no mapa: veja a lista e a tabela.'
          : null;

  return (
    <>
      {/* No máximo uns 480 px de altura: numa tela larga, o mar continua dos lados e o mapa segue uma faixa. */}
      <div ref={frameRef} className="relative mx-auto aspect-[100/41] w-full max-w-[73rem] overflow-hidden">
        <Land />
        {!paused && <Pulses dots={pulses} />}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${width} ${height}`}
          className="absolute inset-0 block size-full"
          role="group"
          aria-label={mapLabel(summary, dots.length, windowHours)}
          onPointerMove={onPointerMove}
          onPointerDown={(event) => {
            pointerType.current = event.pointerType;
          }}
          onPointerLeave={(event) => event.pointerType === 'mouse' && onActive(null)}
          onClick={onClick}
        >
          <Halos dots={dots} compact={compact} />
          {dots.map((dot) => (
            <DotMark
              key={dot.code}
              dot={dot}
              label={labels.get(dot.code) ?? ''}
              tabbable={dot.code === tabStop}
              still={paused}
              onKeyDown={onKeyDown}
              onFocus={onFocus}
              onBlur={onBlur}
            />
          ))}
          {[focusedDot, current === focusedDot ? undefined : current].map(
            (dot, index) =>
              dot && (
                <circle
                  key={index}
                  data-ring={dot.code}
                  cx={dot.x}
                  cy={dot.y}
                  r={outerRadius(dot) + 3.5}
                  className="pointer-events-none fill-none stroke-ring"
                  strokeWidth={2}
                />
              ),
          )}
        </svg>
        {empty !== null && (
          <p className="absolute top-1/2 left-1/2 w-max max-w-[85%] -translate-1/2 rounded-md border bg-surface-raised px-3 py-2 text-center text-sm">
            {empty}
          </p>
        )}
        {current && facts && !compact && (
          <MapTip dot={current} width={width} height={height}>
            {facts}
          </MapTip>
        )}
      </div>
      {compact && dots.length > 0 && (
        <div
          aria-hidden
          data-map-readout
          className="flex min-h-27 flex-col justify-center border-t bg-surface @md:min-h-20 px-3 py-2 text-xs"
        >
          {facts ?? <p className="text-muted-foreground">Toque num ponto para ver os números do país.</p>}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {currentCountry && active?.touched ? labels.get(currentCountry.code) : ''}
      </p>
    </>
  );
}

function mapLabel(summary: TrafficSummary, shown: number, windowHours: number): string {
  if (shown === 0) return `Mapa de origens: nenhum país no mapa ${windowText(windowHours)}.`;
  const top = summary.countries
    .slice(0, 3)
    .map((item) => `${countryName(item.code)} (${shareOf(item.requests, summary.total.requests)})`);
  return (
    `Mapa de origens ${windowText(windowHours)}: ${plural(shown, 'país', 'países')} no mapa; ` +
    `com mais requisições, ${formatList(top)}. Use as setas para percorrer os países, do maior volume ao menor.`
  );
}

/**
 * O brilho em volta dos pontos, só no tema escuro: um gradiente (barato mesmo com 250 pontos), e não um filtro de desfoque.
 * Vai todo embaixo das marcas, para o brilho de um país não tingir o vizinho.
 */
const Halos = memo(function Halos({ dots, compact }: { dots: readonly WorldDot[]; compact: boolean }) {
  const id = useId();
  return (
    <g aria-hidden className="pointer-events-none hidden dark:block">
      <defs>
        <HaloGradient id={`${id}-comum`} className="text-muted-foreground" strength={0.35} />
        <HaloGradient id={`${id}-suspeito`} className="text-critical" strength={0.9} />
      </defs>
      {dots.map((dot) => (
        <circle
          key={dot.code}
          cx={dot.x}
          cy={dot.y}
          r={compact ? outerRadius(dot) * 1.3 + 2 : outerRadius(dot) * 1.5 + 4}
          fill={`url(#${id}-${dot.flagged ? 'suspeito' : 'comum'})`}
        />
      ))}
    </g>
  );
});

function HaloGradient({ id, className, strength }: { id: string; className: string; strength: number }) {
  return (
    <radialGradient id={id} className={className}>
      <stop offset="0.3" stopColor="currentColor" stopOpacity={strength} />
      <stop offset="1" stopColor="currentColor" stopOpacity={0} />
    </radialGradient>
  );
}

interface DotProps {
  dot: WorldDot;
  label: string;
  tabbable: boolean;
  /** Com a animação parada: quem pulsaria mostra um anel tracejado. */
  still: boolean;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, code: string) => void;
  onFocus: (code: string) => void;
  onBlur: () => void;
}

/**
 * Um ponto do mapa. Memorizado: passar o mouse não redesenha nenhum. O fundo da cor do mar em volta da marca a separa da
 * terra e dos vizinhos. Não recebe o ponteiro (quem acerta é a conta de `dotAt`), só o foco.
 */
const DotMark = memo(function DotMark({ dot, label, tabbable, still, onKeyDown, onFocus, onBlur }: DotProps) {
  const { code, x, y, radius, flagged } = dot;
  return (
    <g
      data-country={code}
      data-flagged={flagged || undefined}
      role="img"
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      className="pointer-events-none outline-none"
      onKeyDown={(event) => onKeyDown(event, code)}
      onFocus={() => onFocus(code)}
      onBlur={onBlur}
    >
      <DotShape x={x} y={y} radius={radius} ring={dot.ring} />
      {still && dot.recent && (
        <circle
          data-still-ring
          cx={x}
          cy={y}
          r={outerRadius(dot) + 2.5}
          className={cn('fill-none', dot.recentFlagged ? 'stroke-critical-text' : 'stroke-muted-foreground')}
          strokeWidth={1.25}
          strokeDasharray="2.5 2"
        />
      )}
    </g>
  );
});

/** A marca: o comum é um círculo na tinta neutra; o suspeito, um octógono na cor do crítico com um anel em volta. */
function DotShape({ x, y, radius, ring }: { x: number; y: number; radius: number; ring: number }) {
  if (ring === 0)
    return (
      <circle
        data-dot
        cx={x}
        cy={y}
        r={radius}
        className="fill-muted-foreground stroke-map-ocean"
        strokeWidth={1.5}
        paintOrder="stroke"
      />
    );
  return (
    <>
      <circle cx={x} cy={y} r={radius + ring + 0.5} className="fill-map-ocean" />
      <circle
        data-flagged-ring
        cx={x}
        cy={y}
        r={radius + ring - 0.65}
        className="fill-none stroke-critical-text"
        strokeWidth={1.3}
      />
      <polygon data-dot points={shapePoints('octagon', x, y, radius)} className="fill-critical" />
    </>
  );
}

/** A dica solta, ao lado do ponto e sempre dentro do mapa: medida e posta no lugar antes da pintura (CSSOM, aceito pela CSP). */
function MapTip({
  dot,
  width,
  height,
  children,
}: {
  dot: WorldDot;
  width: number;
  height: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { left, top } = tipPosition(
      dot,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width, height },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
  });
  return (
    <div
      ref={ref}
      aria-hidden
      data-map-tip
      className="pointer-events-none absolute z-10 w-max max-w-60 rounded-md border bg-surface-raised px-2.5 py-1.5 text-xs shadow-sm"
    >
      {children}
    </div>
  );
}

/** Os números de um país, na dica (em lista) ou embaixo do mapa (em duas colunas). */
function Facts({
  country,
  total,
  recentMinutes,
  compact,
}: {
  country: CountryTraffic;
  total: number;
  recentMinutes: number;
  compact: boolean;
}) {
  const rows = [
    ['Requisições', `${formatCount(country.requests)} (${shareOf(country.requests, total)})`],
    ['Bloqueadas', formatCount(country.blocked)],
    ['Suspeitas', formatCount(country.flagged)],
    [
      `Últimos ${formatCount(recentMinutes)} min`,
      `${formatCount(country.recentRequests)}${country.recentFlagged > 0 ? ` (${suspicious(country.recentFlagged)})` : ''}`,
    ],
  ] as const;
  return (
    <>
      <p className="flex items-center gap-1.5 font-semibold text-foreground">
        {country.flagged > 0 && <OctagonAlert className="size-3.5 shrink-0 text-critical" />}
        {countryName(country.code)}
      </p>
      <dl className={cn('mt-1 grid gap-y-0.5', compact && 'gap-x-4 @md:grid-cols-2')}>
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-medium text-foreground tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** A chave do mapa: o tamanho, as duas marcas e a onda. */
function Legend({
  recentMinutes,
  showRecent,
  paused,
}: {
  recentMinutes: number;
  showRecent: boolean;
  paused: boolean;
}) {
  return (
    <ul
      aria-label="Legenda do mapa"
      className="flex flex-wrap gap-x-4 gap-y-1.5 border-t px-3 py-2.5 text-xs text-foreground sm:px-4"
    >
      <LegendItem text="Tamanho: volume (escala logarítmica)">
        <circle cx={4} cy={10} r={3} className="fill-muted-foreground" />
        <circle cx={16} cy={10} r={7} className="fill-muted-foreground" />
      </LegendItem>
      <LegendItem text="Requisições comuns">
        <DotShape x={12} y={10} radius={5} ring={0} />
      </LegendItem>
      <LegendItem text="Com requisições suspeitas">
        <DotShape x={12} y={10} radius={5} ring={3.5} />
      </LegendItem>
      {showRecent && (
        <LegendItem text={`${paused ? 'Anel tracejado' : 'Onda'}: requisições ${recentText(recentMinutes)}`}>
          <circle cx={12} cy={10} r={3} className="fill-muted-foreground" />
          <circle
            cx={12}
            cy={10}
            r={8}
            className={cn('stroke-muted-foreground', paused ? 'fill-none' : 'fill-muted-foreground/15')}
            strokeWidth={1.25}
            strokeDasharray={paused ? '2.5 2' : undefined}
          />
        </LegendItem>
      )}
    </ul>
  );
}

function LegendItem({ text, children }: { text: string; children: ReactNode }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg aria-hidden width={24} height={20} viewBox="0 0 24 20" className="shrink-0">
        {children}
      </svg>
      {text}
    </li>
  );
}

const TopOrigins = memo(function TopOrigins({
  summary,
  onHover,
}: {
  summary: TrafficSummary;
  onHover: (code: string | null) => void;
}) {
  const titleId = useId();
  const { countries, total } = summary;
  if (countries.length === 0) return null;
  const top = countries.slice(0, TOP_COUNT);
  const rest = countries.length - top.length;
  const busiest = top[0]?.requests ?? 1;
  return (
    <section aria-labelledby={titleId}>
      <h3 id={titleId} className="text-sm font-semibold">
        Principais origens
      </h3>
      <ol className="mt-1 gap-6 @xl:columns-2 @4xl:columns-1">
        {top.map((country) => (
          <li
            key={country.code}
            data-origin={country.code}
            className="break-inside-avoid py-1"
            onPointerEnter={(event) => event.pointerType === 'mouse' && onHover(country.code)}
            onPointerLeave={(event) => event.pointerType === 'mouse' && onHover(null)}
          >
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 wrap-anywhere">
                {countryName(country.code)}
                {country.flagged > 0 && (
                  <>
                    <OctagonAlert
                      aria-hidden
                      className="ml-1.5 inline size-3.5 -translate-y-px text-critical"
                    />
                    <span className="sr-only"> (com requisições suspeitas)</span>
                  </>
                )}
              </span>
              <span className="shrink-0 tabular-nums">
                <span className="font-medium">{formatCompact(country.requests)}</span>{' '}
                <span className="inline-block min-w-11 text-right text-muted-foreground">
                  {shareOf(country.requests, total.requests)}
                </span>
              </span>
            </div>
            <div aria-hidden className="mt-1 h-1 overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-muted-foreground"
                style={{ width: `${Math.max(1, (country.requests / busiest) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ol>
      {rest > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          e mais {plural(rest, 'país', 'países')}, na tabela
        </p>
      )}
    </section>
  );
});

/** Uma linha só, honesta, do que não está no mapa. */
function OffMap({ summary }: { summary: TrafficSummary }) {
  const total = summary.total.requests;
  const part = (counts: OriginCounts, text: string) =>
    counts.requests > 0
      ? [`${formatCount(counts.requests)} ${text} (${shareOf(counts.requests, total)})`]
      : [];
  const parts = [
    ...part(summary.unknown, 'de origem desconhecida'),
    ...part(summary.internal, 'de endereço interno'),
    ...part(summary.throughProxy, 'por CDN ou proxy'),
  ];
  const noPoint = summary.countries.filter((item) => !hasPoint(item.code, COUNTRY_POINTS));
  if (parts.length === 0 && noPoint.length === 0) return null;
  return (
    <p data-off-map className="text-sm text-muted-foreground">
      {parts.length > 0 && (
        <>
          <span className="font-medium text-foreground">Fora do mapa:</span> {formatList(parts)}.{' '}
        </>
      )}
      {noPoint.length > 0 && (
        <>
          <span className="font-medium text-foreground">Sem ponto no mapa</span> (só na lista e na tabela):{' '}
          {formatList(noPoint.map((item) => countryName(item.code)))}.
        </>
      )}
    </p>
  );
}

function Notes({
  traffic,
  summary,
  capped,
}: {
  traffic: WorldTraffic;
  summary: TrafficSummary;
  /** Quantos países tiveram requisição agora, quando passam do limite de ondas. */
  capped: number | null;
}) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground @4xl:col-start-1">
      <p>
        O país é o do endereço que fez a requisição: VPN, proxy e nuvem podem esconder a origem real. Suspeita
        é a requisição com sinal de sondagem, de ferramenta de ataque ou de falha de login. O percentual é
        sobre todas as requisições da janela.
      </p>
      {summary.throughProxy.requests > 0 && (
        <p>
          Por CDN ou proxy, o log traz o endereço da CDN, e não o país de quem acessou: essas requisições
          ficam fora do mapa.
        </p>
      )}
      {capped !== null && (
        <p>
          A marca de atividade fica só nos {MAX_PULSING} países com mais requisições{' '}
          {recentText(traffic.recentMinutes)}, de {formatCount(capped)} com requisições nesse tempo.
        </p>
      )}
    </div>
  );
}

/**
 * Todos os países e o que está fora do mapa, em tabela: o mapa sem depender da cor, do mouse ou da animação. Memorizada:
 * passar o mouse no mapa não refaz as linhas.
 */
const OriginTable = memo(function OriginTable({
  summary,
  windowHours,
  recentMinutes,
}: {
  summary: TrafficSummary;
  windowHours: number;
  recentMinutes: number;
}) {
  const title = `Origem das requisições ${windowText(windowHours)}`;
  const total = summary.total.requests;
  const rows = [
    ...summary.countries.map((item) => ({
      key: item.code,
      name: countryName(item.code),
      note: hasPoint(item.code, COUNTRY_POINTS) ? null : 'sem ponto no mapa',
      counts: item,
      recent: formatCount(item.recentRequests),
    })),
    ...(
      [
        ['unknown', 'Origem desconhecida', summary.unknown],
        ['internal', 'Endereço interno', summary.internal],
        ['proxy', 'Por CDN ou proxy', summary.throughProxy],
      ] as const
    )
      .filter(([, , counts]) => counts.requests > 0)
      .map(([key, name, counts]) => ({ key, name, note: 'fora do mapa', counts, recent: '—' })),
  ];
  const head = 'px-3 py-2 text-right font-medium whitespace-nowrap';
  const cell = 'px-3 py-2 text-right tabular-nums whitespace-nowrap';
  return (
    <details className="group">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded py-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 group-open:rotate-90 motion-safe:transition-transform"
        />
        Ver em tabela
        {summary.countries.length > 0 && ` (${plural(summary.countries.length, 'país', 'países')})`}
        <span className="sr-only">: {title}</span>
      </summary>
      <div
        role="region"
        aria-label={`Tabela: ${title}`}
        tabIndex={0}
        className="mt-2 max-h-96 overflow-auto rounded-md border"
      >
        <table className="w-full text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="sticky top-0 bg-surface-raised text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Origem
              </th>
              <th scope="col" className={head}>
                Requisições
              </th>
              <th scope="col" className={head}>
                % do total
              </th>
              <th scope="col" className={head}>
                Bloqueadas
              </th>
              <th scope="col" className={head}>
                Suspeitas
              </th>
              <th scope="col" className={head}>
                Últimos {formatCount(recentMinutes)} min
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t">
                <th scope="row" className="min-w-40 px-3 py-2 text-left font-normal">
                  {row.name}
                  {row.note && <span className="text-muted-foreground"> ({row.note})</span>}
                </th>
                <td className={cell}>{formatCount(row.counts.requests)}</td>
                <td className={cell}>{shareOf(row.counts.requests, total)}</td>
                <td className={cell}>{formatCount(row.counts.blocked)}</td>
                <td className={cell}>{formatCount(row.counts.flagged)}</td>
                <td className={cell}>{row.recent}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
});

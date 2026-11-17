import { RADAR_SECTORS, type RadarDetection, type RadarSector, type TowerRadar } from '@verax/shared';
import { ChevronRight } from 'lucide-react';
import { type KeyboardEvent, memo, type PointerEvent, useCallback, useMemo, useRef, useState } from 'react';
import { Link, type To, useNavigate } from 'react-router';
import { formatHour, useKeepInside } from '@/components/charts/chart-utils';
import { SEVERITY_MARKS, SEVERITY_STYLES } from '@/design/severity';
import { FINDING_SOURCE_LABELS, FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { cn } from '@/lib/cn';
import { formatList, formatRelative, plural } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-reduced-motion';
import { SeverityBadge } from './severity-badge';
import {
  type Blip,
  BLIP_SHAPES,
  capNotice,
  echoDelay,
  freshIds,
  RADAR_CENTER,
  RADAR_RADIUS,
  RADAR_SIZE,
  radarBlips,
  radarRings,
  shapePoints,
} from './radar-geometry';

/** Nome curto de cada setor, no canto do radar e na tabela. */
const RADAR_SECTOR_LABELS: Readonly<Record<RadarSector, string>> = {
  aws: 'AWS',
  gcp: 'GCP',
  cloudflare: 'Cloudflare',
  agents: 'Agentes',
};

/** Canto de cada setor (o setor do topo à direita é o primeiro, no sentido horário). */
const SECTOR_CORNERS: Readonly<Record<RadarSector, { x: number; y: number; anchor: 'start' | 'end' }>> = {
  aws: { x: RADAR_SIZE - 6, y: 18, anchor: 'end' },
  gcp: { x: RADAR_SIZE - 6, y: RADAR_SIZE - 22, anchor: 'end' },
  cloudflare: { x: 6, y: RADAR_SIZE - 22, anchor: 'start' },
  agents: { x: 6, y: 18, anchor: 'start' },
};

/** Quantas detecções a lista ao lado do radar mostra; as outras ficam na tabela. */
const RECENT_COUNT = 5;

/** Para onde levam a detecção, o incidente dela e o "ver todas": o detalhe e a lista da tela Detecções. */
export interface RadarLinks {
  finding: (id: string) => To;
  incident: (id: string) => To;
  all: To;
}

const DEFAULT_LINKS: RadarLinks = {
  finding: (id) => `/?alerta=${id}`,
  incident: (id) => `/?incidente=${id}`,
  all: '/?periodo=24h',
};

function incidentText(detection: RadarDetection): string | null {
  if (!detection.incident) return null;
  return detection.incident.open ? 'Em incidente aberto' : 'Em incidente resolvido';
}

/** A descrição falada de uma detecção (nome do ponto no radar), na mesma ordem da dica. */
function describe(detection: RadarDetection, now: Date): string {
  return [
    `${SEVERITY_STYLES[detection.severity].label}: ${detection.title}`,
    `${FINDING_SOURCE_LABELS[detection.source]}, ${formatRelative(detection.occurredAt, now)} (${formatHour(detection.occurredAt)})`,
    FINDING_STATUS_LABELS[detection.status].label,
    incidentText(detection),
  ]
    .filter(Boolean)
    .join('. ');
}

/**
 * Radar de detecções da Torre: os achados das últimas 24 horas num radar que gira, como o de navegação. O ângulo é a
 * origem (um setor por fonte), a distância do centro é a idade (o centro é agora, o anel de fora o começo da janela) e
 * a forma, o tamanho e a cor são a severidade. O incidente aberto ganha um anel em volta do ponto. A varredura e o
 * brilho são só CSS; com menos movimento pedido, o radar fica parado e completo. Tudo o que o radar mostra está
 * também na lista e na tabela ao lado, com link para o achado: nada depende da cor, do mouse ou da animação.
 */
export function DetectionRadar({
  radar,
  generatedAt,
  links = DEFAULT_LINKS,
  compact = false,
}: {
  radar: TowerRadar;
  generatedAt: string;
  links?: RadarLinks;
  /** No resumo da tela Detecções: o radar em destaque, sem a lista das mais recentes (a lista da tela está logo abaixo). */
  compact?: boolean;
}) {
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const now = useMemo(() => new Date(generatedAt), [generatedAt]);
  const blips = useMemo(() => radarBlips(radar, generatedAt), [radar, generatedAt]);
  const pulsing = usePulsing(radar.detections, generatedAt);
  const capped = capNotice(radar);
  const open = useCallback((id: string) => void navigate(links.finding(id)), [navigate, links]);

  // A divisão por severidade é da janela inteira (vem da API), não só das detecções desenhadas.
  const bySeverity = (['critical', 'high', 'medium', 'low'] as const)
    .map((severity) => ({ severity, count: radar.bySeverity[severity] }))
    .filter((item) => item.count > 0);

  return (
    <div
      className={cn(
        'grid gap-4',
        compact ? 'items-start' : 'lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start',
      )}
    >
      <div
        className={cn('brand-surface rounded-panel p-3 sm:p-4', compact && 'mx-auto w-full max-w-[28rem]')}
      >
        <RadarScope
          blips={blips}
          counts={radar.bySector}
          windowHours={radar.windowHours}
          total={radar.total}
          shown={radar.detections.length}
          now={now}
          pulsing={pulsing}
          motion={!reducedMotion}
          onOpen={open}
        />
        <RadarLegend windowHours={radar.windowHours} />
      </div>
      <div className="min-w-0 space-y-3">
        <p className="text-sm">
          {radar.total === 0 ? (
            `Nenhuma detecção nas últimas ${radar.windowHours} horas.`
          ) : (
            <>
              <strong className="font-semibold">{plural(radar.total, 'detecção', 'detecções')}</strong> nas
              últimas {radar.windowHours} horas
              {bySeverity.length > 0 &&
                `: ${bySeverity
                  .map(({ severity, count }) => `${count} ${SEVERITY_STYLES[severity].label.toLowerCase()}`)
                  .join(', ')}`}
              .
            </>
          )}
        </p>
        {capped && (
          <p className="rounded-md border bg-foreground/[0.03] p-2 text-sm text-muted-foreground">
            O radar mostra as {capped.shown} mais recentes de {plural(capped.total, 'detecção', 'detecções')}.{' '}
            <Link className="text-foreground underline underline-offset-2" to={links.all}>
              Ver todas na lista
            </Link>
          </p>
        )}
        {radar.detections.length > 0 && !compact && (
          <>
            <h3 className="text-sm font-medium text-muted-foreground">Mais recentes</h3>
            <ul className="divide-y rounded-md border">
              {radar.detections.slice(0, RECENT_COUNT).map((detection) => (
                <li key={detection.id}>
                  <DetectionLink detection={detection} now={now} links={links} />
                </li>
              ))}
            </ul>
            <RadarTable detections={radar.detections} now={now} links={links} />
          </>
        )}
        {radar.detections.length > 0 && compact && (
          <RadarTable detections={radar.detections} now={now} links={links} />
        )}
      </div>
    </div>
  );
}

/**
 * Quais pontos pulsam agora. Na primeira leitura, os dos últimos minutos; a cada atualização da Torre, só os que não
 * estavam na anterior. Ajustado durante a renderização, quando a leitura muda (o padrão do React para estado que
 * depende de prop), para o pulso não sumir no meio da animação.
 */
function usePulsing(detections: readonly RadarDetection[], generatedAt: string): ReadonlySet<string> {
  const [state, setState] = useState<{
    key: string;
    seen: ReadonlySet<string>;
    fresh: ReadonlySet<string>;
  } | null>(null);
  if (state?.key !== generatedAt) {
    const fresh = freshIds(detections, state?.seen ?? null, generatedAt);
    setState({ key: generatedAt, seen: new Set(detections.map((detection) => detection.id)), fresh });
    return fresh;
  }
  return state.fresh;
}

function RadarScope({
  blips,
  counts,
  windowHours,
  total,
  shown,
  now,
  pulsing,
  motion,
  onOpen,
}: {
  blips: readonly Blip[];
  counts: Record<RadarSector, number>;
  windowHours: number;
  total: number;
  shown: number;
  now: Date;
  pulsing: ReadonlySet<string>;
  motion: boolean;
  onOpen: (id: string) => void;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const pointerType = useRef<string>('mouse');
  // No toque, o ponto que já mostra a dica pelo toque anterior: só ele abre no próximo toque. Fica à parte de `active`,
  // que o foco do próprio toque também marca antes do clique.
  const armed = useRef<string | null>(null);
  const tipRef = useKeepInside<HTMLDivElement>(frame, active);

  const current = blips.find((blip) => blip.detection.id === active);
  // A parada do teclado: o ponto escolhido pelas setas ou, sem escolha (ou se ele saiu do radar), o mais recente.
  const tabStop = blips.some((blip) => blip.detection.id === focusId)
    ? focusId
    : (blips[0]?.detection.id ?? null);
  const rings = useMemo(() => radarRings(windowHours), [windowHours]);

  const focusBlip = useCallback(
    (id: string) => {
      setFocusId(id);
      frame?.querySelector<SVGGElement>(`[data-blip="${id}"]`)?.focus();
    },
    [frame],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<SVGGElement>, id: string) => {
      const position = blips.findIndex((blip) => blip.detection.id === id);
      const moves: Record<string, number> = {
        ArrowRight: position + 1,
        ArrowDown: position + 1,
        ArrowLeft: position - 1,
        ArrowUp: position - 1,
        Home: 0,
        End: blips.length - 1,
      };
      if (event.key === 'Enter') {
        event.preventDefault();
        onOpen(id);
        return;
      }
      if (event.key === 'Escape') {
        setActive(null);
        return;
      }
      const target = moves[event.key];
      if (target === undefined) return;
      event.preventDefault();
      const next = blips[Math.min(blips.length - 1, Math.max(0, target))];
      if (next) focusBlip(next.detection.id);
    },
    [blips, focusBlip, onOpen],
  );

  // O mouse mostra a dica ao passar; no toque e na caneta, quem decide é o clique (abaixo).
  const onPointer = useCallback((event: PointerEvent<SVGGElement>, id: string | null) => {
    pointerType.current = event.pointerType;
    if (event.pointerType !== 'mouse') return;
    setActive(id);
  }, []);

  const onClick = useCallback(
    (id: string) => {
      // No toque, o primeiro toque num ponto mostra a dica; o segundo, no mesmo ponto, abre o achado.
      if (pointerType.current !== 'mouse' && armed.current !== id) {
        armed.current = id;
        setActive(id);
        return;
      }
      armed.current = null;
      onOpen(id);
    },
    [onOpen],
  );

  // Perder o foco (tocar fora) fecha a dica e desarma o ponto: o próximo toque nele mostra a dica de novo.
  const onFocusBlip = useCallback((id: string | null) => {
    if (id === null) armed.current = null;
    setActive(id);
  }, []);

  const label =
    total === 0
      ? `Radar de detecções: nenhuma nas últimas ${windowHours} horas.`
      : `Radar de detecções das últimas ${windowHours} horas: ${plural(total, 'detecção', 'detecções')}${
          shown < total ? `, ${shown} mais recentes no radar` : ''
        }; ${RADAR_SECTORS.map((sector) => `${RADAR_SECTOR_LABELS[sector]} ${counts[sector]}`).join(', ')}. O centro é agora e o anel de fora, ${windowHours} horas atrás. Use as setas para percorrer as detecções e Enter para abrir.`;

  return (
    <div ref={setFrame} className="relative mx-auto aspect-square w-full max-w-[26rem]">
      <div aria-hidden className="absolute inset-[10%] rounded-full border border-border-strong bg-surface" />
      {motion && (
        <div
          aria-hidden
          data-radar-sweep
          className="radar-sweep pointer-events-none absolute inset-[10%] rounded-full"
        />
      )}
      <svg
        viewBox={`0 0 ${RADAR_SIZE} ${RADAR_SIZE}`}
        className="absolute inset-0 block size-full overflow-visible"
        role="group"
        aria-label={label}
        onPointerLeave={(event) => event.pointerType === 'mouse' && setActive(null)}
      >
        <g aria-hidden className="pointer-events-none">
          {rings.map((ring) => (
            <circle
              key={ring.hours}
              cx={RADAR_CENTER}
              cy={RADAR_CENTER}
              r={ring.radius}
              className="fill-none stroke-border-strong"
              strokeWidth={1}
              strokeDasharray={ring.hours === windowHours ? undefined : '2 4'}
            />
          ))}
          <line
            x1={RADAR_CENTER}
            y1={RADAR_CENTER - RADAR_RADIUS}
            x2={RADAR_CENTER}
            y2={RADAR_CENTER + RADAR_RADIUS}
            className="stroke-border-strong"
            strokeWidth={1}
          />
          <line
            x1={RADAR_CENTER - RADAR_RADIUS}
            y1={RADAR_CENTER}
            x2={RADAR_CENTER + RADAR_RADIUS}
            y2={RADAR_CENTER}
            className="stroke-border-strong"
            strokeWidth={1}
          />
          <circle cx={RADAR_CENTER} cy={RADAR_CENTER} r={2.5} className="fill-muted-foreground" />
          {rings.map((ring) => (
            <text
              key={ring.hours}
              x={RADAR_CENTER + 4}
              y={RADAR_CENTER - ring.radius - 3}
              className="fill-muted-foreground text-[12px] tabular-nums"
            >
              {ring.hours} h
            </text>
          ))}
          {RADAR_SECTORS.map((sector) => {
            const corner = SECTOR_CORNERS[sector];
            return (
              <text key={sector} x={corner.x} y={corner.y} textAnchor={corner.anchor} className="text-[13px]">
                <tspan className="fill-foreground font-semibold">{RADAR_SECTOR_LABELS[sector]}</tspan>
                <tspan x={corner.x} dy={15} className="fill-muted-foreground text-[12px] tabular-nums">
                  {plural(counts[sector], 'detecção', 'detecções')}
                </tspan>
              </text>
            );
          })}
        </g>
        {/* Do mais antigo ao mais novo: o recente fica por cima quando dois pontos se encostam. */}
        {[...blips].reverse().map((blip) => (
          <BlipMark
            key={blip.detection.id}
            blip={blip}
            label={describe(blip.detection, now)}
            active={blip.detection.id === active}
            tabbable={blip.detection.id === tabStop}
            pulsing={motion && pulsing.has(blip.detection.id)}
            motion={motion}
            onPointer={onPointer}
            onClick={onClick}
            onKeyDown={onKeyDown}
            onFocusBlip={onFocusBlip}
            onFocusChange={setFocusId}
          />
        ))}
      </svg>
      {current && (
        <div
          ref={tipRef}
          aria-hidden
          data-radar-tip
          className="pointer-events-none absolute z-10 w-max max-w-64 -translate-x-1/2 -translate-y-full rounded-md border bg-surface-raised px-2.5 py-1.5 text-xs shadow-sm"
          style={{
            left: `${(current.x / RADAR_SIZE) * 100}%`,
            top: `calc(${(current.y / RADAR_SIZE) * 100}% - 12px)`,
          }}
        >
          <strong className="block font-semibold text-foreground">{current.detection.title}</strong>
          <span className="mt-1 flex items-center gap-1 text-muted-foreground">
            <TipSeverity detection={current.detection} />
            <span>· {FINDING_SOURCE_LABELS[current.detection.source]}</span>
          </span>
          <span className="block text-muted-foreground">
            {formatRelative(current.detection.occurredAt, now)}, às {formatHour(current.detection.occurredAt)}{' '}
            · {FINDING_STATUS_LABELS[current.detection.status].label}
          </span>
          {incidentText(current.detection) && (
            <span className="block text-muted-foreground">{incidentText(current.detection)}</span>
          )}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {current ? describe(current.detection, now) : ''}
      </p>
    </div>
  );
}

function TipSeverity({ detection }: { detection: RadarDetection }) {
  const { icon: Icon, tone, label } = SEVERITY_STYLES[detection.severity];
  return (
    <span className="inline-flex items-center gap-1 text-foreground">
      <Icon aria-hidden className={cn('size-3.5', tone)} />
      {label}
    </span>
  );
}

interface BlipProps {
  blip: Blip;
  label: string;
  active: boolean;
  tabbable: boolean;
  pulsing: boolean;
  motion: boolean;
  onPointer: (event: PointerEvent<SVGGElement>, id: string | null) => void;
  onClick: (id: string) => void;
  onKeyDown: (event: KeyboardEvent<SVGGElement>, id: string) => void;
  onFocusBlip: (id: string | null) => void;
  onFocusChange: (id: string) => void;
}

/**
 * Um ponto do radar. Memorizado: a varredura não redesenha nada, e a dica só redesenha os dois pontos que mudam de
 * estado. A área de toque (32 unidades, uns 24 px no celular) é maior que a marca; o anel da cor do fundo separa a marca da cunha da varredura e
 * dos vizinhos (contraste da marca sempre contra o fundo do radar).
 */
const BlipMark = memo(function BlipMark({
  blip,
  label,
  active,
  tabbable,
  pulsing,
  motion,
  onPointer,
  onClick,
  onKeyDown,
  onFocusBlip,
  onFocusChange,
}: BlipProps) {
  const { detection, x, y } = blip;
  const id = detection.id;
  const { shape, radius } = BLIP_SHAPES[detection.severity];
  const marks = SEVERITY_MARKS[detection.severity];
  const mark =
    shape === 'circle' ? (
      <circle cx={x} cy={y} r={radius} className={cn(marks.fill, 'stroke-brand')} strokeWidth={2} />
    ) : (
      <polygon
        points={shapePoints(shape, x, y, radius)}
        className={cn(marks.fill, 'stroke-brand')}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    );
  return (
    <g
      data-blip={id}
      data-severity={detection.severity}
      data-active={active || undefined}
      role="link"
      tabIndex={tabbable ? 0 : -1}
      aria-label={label}
      className="cursor-pointer outline-none"
      onPointerEnter={(event) => onPointer(event, id)}
      onPointerDown={(event) => onPointer(event, id)}
      onClick={() => onClick(id)}
      onKeyDown={(event) => onKeyDown(event, id)}
      onFocus={() => {
        onFocusChange(id);
        onFocusBlip(id);
      }}
      onBlur={() => onFocusBlip(null)}
    >
      <circle cx={x} cy={y} r={16} className="fill-transparent" />
      {motion && (
        <circle
          cx={x}
          cy={y}
          r={radius + 1}
          className={cn('radar-echo pointer-events-none', marks.fill)}
          style={{ animationDelay: `${echoDelay(blip.angle)}ms` }}
        />
      )}
      {pulsing && (
        <circle
          data-pulse
          cx={x}
          cy={y}
          r={radius + 2}
          className={cn('radar-pulse pointer-events-none fill-none', marks.stroke)}
          strokeWidth={1.5}
        />
      )}
      {detection.incident?.open && (
        <circle
          data-incident-ring
          cx={x}
          cy={y}
          r={radius + 4}
          className="pointer-events-none fill-none stroke-muted-foreground"
          strokeWidth={1.25}
        />
      )}
      {mark}
      {active && (
        <circle
          cx={x}
          cy={y}
          r={radius + 7.5}
          className="pointer-events-none fill-none stroke-ring"
          strokeWidth={2}
        />
      )}
    </g>
  );
});

/** A chave do radar: a forma de cada severidade, o anel do incidente aberto e como ler a distância. */
function RadarLegend({ windowHours }: { windowHours: number }) {
  return (
    <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
      <ul className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Legenda do radar">
        {(['critical', 'high', 'medium', 'low'] as const).map((severity) => {
          const { shape, radius } = BLIP_SHAPES[severity];
          const size = 16;
          const c = size / 2;
          return (
            <li key={severity} className="flex items-center gap-1.5">
              <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                {shape === 'circle' ? (
                  <circle cx={c} cy={c} r={radius} className={SEVERITY_MARKS[severity].fill} />
                ) : (
                  <polygon
                    points={shapePoints(shape, c, c, radius)}
                    className={SEVERITY_MARKS[severity].fill}
                    strokeLinejoin="round"
                  />
                )}
              </svg>
              <span className="text-foreground">{SEVERITY_STYLES[severity].label}</span>
            </li>
          );
        })}
        <li className="flex items-center gap-1.5">
          <svg aria-hidden width={16} height={16} viewBox="0 0 16 16">
            <circle cx={8} cy={8} r={6} className="fill-none stroke-muted-foreground" strokeWidth={1.25} />
            <circle cx={8} cy={8} r={2.5} className="fill-muted-foreground" />
          </svg>
          <span className="text-foreground">Em incidente aberto</span>
        </li>
      </ul>
      <p>
        Centro: agora. Anéis a {formatList(radarRings(windowHours).map((ring) => `${ring.hours}`))} horas
        atrás (as horas recentes têm mais espaço). O setor é a origem da detecção.
      </p>
    </div>
  );
}

function DetectionLink({
  detection,
  now,
  links,
}: {
  detection: RadarDetection;
  now: Date;
  links: RadarLinks;
}) {
  return (
    <Link
      to={links.finding(detection.id)}
      className="flex items-start gap-3 px-3 py-2 text-sm hover:bg-foreground/5"
    >
      <SeverityBadge severity={detection.severity} className="mt-0.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium wrap-anywhere">{detection.title}</span>
        <span className="block text-xs text-muted-foreground">
          {FINDING_SOURCE_LABELS[detection.source]} · {formatRelative(detection.occurredAt, now)}
          {incidentText(detection) && ` · ${incidentText(detection)}`}
        </span>
      </span>
    </Link>
  );
}

/** Todas as detecções do radar, em tabela, atrás de "Ver em tabela": o radar sem depender da cor, do mouse ou da animação. */
function RadarTable({
  detections,
  now,
  links,
}: {
  detections: readonly RadarDetection[];
  now: Date;
  links: RadarLinks;
}) {
  const title = 'Detecções do radar';
  return (
    <details className="group">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded py-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 group-open:rotate-90 motion-safe:transition-transform"
        />
        Ver em tabela ({detections.length})<span className="sr-only">: {title}</span>
      </summary>
      <div
        role="region"
        aria-label={`Tabela: ${title}`}
        tabIndex={0}
        className="mt-2 overflow-x-auto rounded-md border"
      >
        <table className="w-full text-sm">
          <caption className="sr-only">{title}</caption>
          <thead className="bg-foreground/[0.03] text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Detecção
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Severidade
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Origem
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium whitespace-nowrap">
                Quando
              </th>
              <th scope="col" className="px-3 py-2 text-left font-medium">
                Incidente
              </th>
            </tr>
          </thead>
          <tbody>
            {detections.map((detection) => (
              <tr key={detection.id} className="border-t">
                <th scope="row" className="min-w-48 px-3 py-2 text-left font-normal">
                  <Link className="underline underline-offset-2" to={links.finding(detection.id)}>
                    {detection.title}
                  </Link>
                </th>
                <td className="px-3 py-2">
                  <SeverityBadge severity={detection.severity} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap">{FINDING_SOURCE_LABELS[detection.source]}</td>
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                  {formatHour(detection.occurredAt)}{' '}
                  <span className="text-muted-foreground">({formatRelative(detection.occurredAt, now)})</span>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {detection.incident ? (
                    <Link className="underline underline-offset-2" to={links.incident(detection.incident.id)}>
                      {detection.incident.open ? 'Aberto' : 'Resolvido'}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

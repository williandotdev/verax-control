import {
  type FindingSeverity,
  RADAR_SECTORS,
  type RadarCase,
  type RadarDetection,
  type RadarSector,
  type TowerRadar,
  type TowerRadarCases,
} from '@verax/shared';
import { ChevronRight } from 'lucide-react';
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, type To, useNavigate } from 'react-router';
import { formatHour, useKeepInside } from '@/components/charts/chart-utils';
import { SEVERITY_MARKS, SEVERITY_STYLES } from '@/design/severity';
import { FINDING_SOURCE_LABELS, FINDING_STATUS_LABELS } from '@/features/findings/labels';
import { cn } from '@/lib/cn';
import { formatCount, formatList, formatRelative, plural } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-reduced-motion';
import { SeverityBadge } from './severity-badge';
import {
  type Blip,
  BLIP_SHAPES,
  type BlipPosition,
  capNotice,
  type CaseBlip,
  echoDelay,
  freshIds,
  RADAR_CENTER,
  RADAR_RADIUS,
  RADAR_SIZE,
  radarBlips,
  radarCaseBlips,
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

/** Para onde levam a detecção (ou o caso), o incidente dela e o "ver todas": o detalhe e a lista da tela Detecções. */
export interface RadarLinks {
  finding: (id: string) => To;
  incident: (id: string) => To;
  all: To;
  case: (id: string) => To;
  allCases: To;
}

const DEFAULT_LINKS: RadarLinks = {
  finding: (id) => `/?alerta=${id}`,
  incident: (id) => `/?incidente=${id}`,
  all: '/?periodo=24h',
  case: (id) => `/?caso=${id}`,
  allCases: '/?estado=todos&periodo=24h',
};

function incidentText(detection: { incident: { open: boolean } | null }): string | null {
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

const alerts = (count: number): string => plural(count, 'alerta', 'alertas');

/** A gravidade do caso: a pior pendente ou, sem nada pendente, a do incidente aberto em que ele está. */
const caseSeverity = (item: RadarCase): FindingSeverity | null =>
  item.severity ?? (item.incident?.open ? item.incident.severity : null);

const NOTHING_PENDING = 'Nada pendente';
const caseSeverityText = (item: RadarCase): string => {
  const severity = caseSeverity(item);
  return severity === null ? NOTHING_PENDING : SEVERITY_STYLES[severity].label;
};

/** De onde vêm os alertas do caso; de uma fonte que não se conhece, o setor. */
const caseOrigin = (item: RadarCase): string =>
  item.sources.length > 0
    ? formatList(item.sources.map((source) => FINDING_SOURCE_LABELS[source]))
    : RADAR_SECTOR_LABELS[item.sector];

/** "20.000 alertas, 12 pendentes, 4 nas últimas 24 horas" (os guardados, os pendentes e os da janela). */
function caseCounts(item: RadarCase, windowHours: number): string {
  return [
    alerts(item.total),
    ...(item.pending > 0 ? [plural(item.pending, 'pendente', 'pendentes')] : []),
    `${formatCount(item.recent)} nas últimas ${windowHours} horas`,
  ].join(', ');
}

/** A descrição falada de um caso, na mesma ordem da dica. */
function describeCase(item: RadarCase, windowHours: number, now: Date): string {
  return [
    `${caseSeverityText(item)}: ${item.title}`,
    `${caseOrigin(item)}, última atividade ${formatRelative(item.lastActivityAt, now)} (${formatHour(item.lastActivityAt)})`,
    caseCounts(item, windowHours),
    incidentText(item),
  ]
    .filter(Boolean)
    .join('. ');
}

/** Um ponto do radar, seja uma detecção ou um caso. */
interface RadarPoint extends BlipPosition {
  id: string;
  severity: FindingSeverity | null;
  scale: number;
  /** Em incidente aberto: o anel em volta. */
  ringed: boolean;
  /** A descrição falada. */
  label: string;
}

const detectionPoint = (blip: Blip, now: Date): RadarPoint => ({
  id: blip.detection.id,
  severity: blip.detection.severity,
  scale: 1,
  ringed: blip.detection.incident?.open === true,
  label: describe(blip.detection, now),
  sector: blip.sector,
  angle: blip.angle,
  radius: blip.radius,
  x: blip.x,
  y: blip.y,
});

const casePoint = (blip: CaseBlip, windowHours: number, now: Date): RadarPoint => ({
  id: blip.item.id,
  severity: caseSeverity(blip.item),
  scale: blip.scale,
  ringed: blip.item.incident?.open === true,
  label: describeCase(blip.item, windowHours, now),
  sector: blip.sector,
  angle: blip.angle,
  radius: blip.radius,
  x: blip.x,
  y: blip.y,
});

/**
 * Radar de detecções da Torre: os achados das últimas 24 horas num radar que gira, como o de navegação. O ângulo é a
 * origem (um setor por fonte), a distância do centro é a idade (o centro é agora, o anel de fora o começo da janela) e
 * a forma, o tamanho e a cor são a severidade. O incidente aberto ganha um anel em volta do ponto. A varredura e o
 * brilho são só CSS; com menos movimento pedido, o radar fica parado e completo. Tudo o que o radar mostra está
 * também na lista e na tabela ao lado, com link para o achado: nada depende da cor, do mouse ou da animação.
 *
 * Com os casos (`radar.cases`), os pontos são os casos de detecção ativos na janela, do tamanho dos alertas que guardam, e
 * levam ao caso; as contagens por severidade e por origem continuam sendo de alertas. Sem eles, é o radar de sempre.
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
  const { cases } = radar;
  const points = useMemo(
    () =>
      cases
        ? radarCaseBlips(cases, radar, generatedAt).map((blip) => casePoint(blip, radar.windowHours, now))
        : radarBlips(radar, generatedAt).map((blip) => detectionPoint(blip, now)),
    [cases, radar, generatedAt, now],
  );
  const arrivals = useMemo(
    () =>
      cases
        ? cases.items.map((item) => ({ id: item.id, occurredAt: item.lastActivityAt }))
        : radar.detections,
    [cases, radar],
  );
  const pulsing = usePulsing(arrivals, generatedAt);
  const capped = cases ? null : capNotice(radar);
  const open = useCallback(
    (id: string) => void navigate(cases ? links.case(id) : links.finding(id)),
    [navigate, links, cases],
  );
  const tipOf = (id: string): ReactNode => {
    if (cases) {
      const item = cases.items.find((candidate) => candidate.id === id);
      return item && <CaseTip item={item} windowHours={radar.windowHours} now={now} />;
    }
    const detection = radar.detections.find((candidate) => candidate.id === id);
    return detection && <DetectionTip detection={detection} now={now} />;
  };

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
          points={points}
          counts={radar.bySector}
          windowHours={radar.windowHours}
          label={scopeLabel(radar)}
          tipOf={tipOf}
          pulsing={pulsing}
          motion={!reducedMotion}
          onOpen={open}
        />
        <RadarLegend
          windowHours={radar.windowHours}
          cases={cases !== undefined}
          treated={cases?.items.some((item) => caseSeverity(item) === null) === true}
        />
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
        {cases && radar.total > 0 && <CasesSentence cases={cases} total={radar.total} links={links} />}
        {capped && (
          <p className="rounded-md border bg-foreground/[0.03] p-2 text-sm text-muted-foreground">
            O radar mostra as {capped.shown} mais recentes de {plural(capped.total, 'detecção', 'detecções')}.{' '}
            <Link className="text-foreground underline underline-offset-2" to={links.all}>
              Ver todas na lista
            </Link>
          </p>
        )}
        {cases && cases.items.length > 0 && (
          <CasesTable cases={cases.items} windowHours={radar.windowHours} now={now} links={links} />
        )}
        {!cases && radar.detections.length > 0 && !compact && (
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
        {!cases && radar.detections.length > 0 && compact && (
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
function usePulsing(
  detections: readonly Pick<RadarDetection, 'id' | 'occurredAt'>[],
  generatedAt: string,
): ReadonlySet<string> {
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

/** O nome acessível do radar: o que ele mostra, os totais e como usar. */
function scopeLabel({ cases, detections, total, windowHours, bySector }: TowerRadar): string {
  const sectors = RADAR_SECTORS.map((sector) => `${RADAR_SECTOR_LABELS[sector]} ${bySector[sector]}`).join(
    ', ',
  );
  const scale = `O centro é agora e o anel de fora, ${windowHours} horas atrás.`;
  if (cases) {
    if (cases.items.length === 0) return `Radar de casos: nenhum ativo nas últimas ${windowHours} horas.`;
    return `Radar de casos das últimas ${windowHours} horas: ${plural(cases.total, 'caso de detecção', 'casos de detecção')}, com ${alerts(cases.alerts)} nesse tempo${
      cases.items.length < cases.total ? `, ${cases.items.length} mais graves no radar` : ''
    }. Alertas por origem: ${sectors}. ${scale} Use as setas para percorrer os casos e Enter para abrir.`;
  }
  return total === 0
    ? `Radar de detecções: nenhuma nas últimas ${windowHours} horas.`
    : `Radar de detecções das últimas ${windowHours} horas: ${plural(total, 'detecção', 'detecções')}${
        detections.length < total ? `, ${detections.length} mais recentes no radar` : ''
      }; ${sectors}. ${scale} Use as setas para percorrer as detecções e Enter para abrir.`;
}

/** "N alertas em M casos de detecção", e onde estão os outros alertas do período. */
function CasesSentence({
  cases,
  total,
  links,
}: {
  cases: TowerRadarCases;
  total: number;
  links: RadarLinks;
}) {
  const rest = total - cases.alerts;
  return (
    <p className="text-sm">
      {cases.total === 0 ? (
        'Nenhum caso de detecção ativo.'
      ) : (
        <>
          <strong className="font-semibold">
            {alerts(cases.alerts)} em {plural(cases.total, 'caso', 'casos')}
          </strong>{' '}
          de detecção.
        </>
      )}
      {rest > 0 && (
        <span className="text-muted-foreground">
          {' '}
          {cases.total === 0
            ? rest === 1
              ? 'O alerta é de vulnerabilidade ou de postura, ou não tem caso.'
              : 'Os alertas são de vulnerabilidade e de postura, ou não têm caso.'
            : rest === 1
              ? 'O outro é de vulnerabilidade ou de postura, ou não tem caso.'
              : `Os outros ${formatCount(rest)} são de vulnerabilidade e de postura, ou não têm caso.`}
        </span>
      )}
      {cases.items.length < cases.total && (
        <>
          {' '}
          O radar mostra os {cases.items.length} mais graves.{' '}
          <Link className="underline underline-offset-2" to={links.allCases}>
            Ver todos os casos
          </Link>
        </>
      )}
    </p>
  );
}

function RadarScope({
  points,
  counts,
  windowHours,
  label,
  tipOf,
  pulsing,
  motion,
  onOpen,
}: {
  points: readonly RadarPoint[];
  counts: Record<RadarSector, number>;
  windowHours: number;
  /** O nome acessível do radar inteiro. */
  label: string;
  /** A dica de um ponto. */
  tipOf: (id: string) => ReactNode;
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

  const current = points.find((point) => point.id === active);
  // A parada do teclado: o ponto escolhido pelas setas ou, sem escolha (ou se ele saiu do radar), o primeiro (a detecção
  // mais recente, ou o caso mais grave).
  const tabStop = points.some((point) => point.id === focusId) ? focusId : (points[0]?.id ?? null);
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
      const position = points.findIndex((point) => point.id === id);
      const moves: Record<string, number> = {
        ArrowRight: position + 1,
        ArrowDown: position + 1,
        ArrowLeft: position - 1,
        ArrowUp: position - 1,
        Home: 0,
        End: points.length - 1,
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
      const next = points[Math.min(points.length - 1, Math.max(0, target))];
      if (next) focusBlip(next.id);
    },
    [points, focusBlip, onOpen],
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

  // O primeiro da lista fica por cima quando dois pontos se encostam. Com os casos, os grandes ficam embaixo: um caso de
  // milhares de alertas não esconde o pequeno ao lado.
  const drawn = [...points].reverse().sort((a, b) => b.scale - a.scale);

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
        {drawn.map((point) => (
          <BlipMark
            key={point.id}
            point={point}
            active={point.id === active}
            tabbable={point.id === tabStop}
            pulsing={motion && pulsing.has(point.id)}
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
          {tipOf(current.id)}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {current?.label ?? ''}
      </p>
    </div>
  );
}

function DetectionTip({ detection, now }: { detection: RadarDetection; now: Date }) {
  return (
    <>
      <strong className="block font-semibold text-foreground">{detection.title}</strong>
      <span className="mt-1 flex items-center gap-1 text-muted-foreground">
        <TipSeverity severity={detection.severity} />
        <span>· {FINDING_SOURCE_LABELS[detection.source]}</span>
      </span>
      <span className="block text-muted-foreground">
        {formatRelative(detection.occurredAt, now)}, às {formatHour(detection.occurredAt)} ·{' '}
        {FINDING_STATUS_LABELS[detection.status].label}
      </span>
      {incidentText(detection) && (
        <span className="block text-muted-foreground">{incidentText(detection)}</span>
      )}
    </>
  );
}

function CaseTip({ item, windowHours, now }: { item: RadarCase; windowHours: number; now: Date }) {
  const severity = caseSeverity(item);
  return (
    <>
      <strong className="block font-semibold text-foreground">{item.title}</strong>
      <span className="mt-1 flex items-center gap-1 text-muted-foreground">
        {severity === null ? (
          <span className="text-foreground">{NOTHING_PENDING}</span>
        ) : (
          <TipSeverity severity={severity} />
        )}
        <span>· {caseOrigin(item)}</span>
      </span>
      <span className="block text-foreground">{caseCounts(item, windowHours)}</span>
      <span className="block text-muted-foreground">
        Última atividade {formatRelative(item.lastActivityAt, now)}, às {formatHour(item.lastActivityAt)}
      </span>
      {incidentText(item) && <span className="block text-muted-foreground">{incidentText(item)}</span>}
    </>
  );
}

function TipSeverity({ severity }: { severity: FindingSeverity }) {
  const { icon: Icon, tone, label } = SEVERITY_STYLES[severity];
  return (
    <span className="inline-flex items-center gap-1 text-foreground">
      <Icon aria-hidden className={cn('size-3.5', tone)} />
      {label}
    </span>
  );
}

/** O caso sem nada pendente: um círculo vazado, em tinta neutra. */
const TREATED_SHAPE = { shape: 'circle', radius: 4.5 } as const;
const TREATED_MARKS = {
  fill: 'fill-muted-foreground',
  stroke: 'stroke-muted-foreground',
  mark: 'fill-surface stroke-muted-foreground',
} as const;

const shapeOf = (severity: FindingSeverity | null) =>
  severity === null ? TREATED_SHAPE : BLIP_SHAPES[severity];
const marksOf = (severity: FindingSeverity | null) => {
  if (severity === null) return TREATED_MARKS;
  const { fill, stroke } = SEVERITY_MARKS[severity];
  return { fill, stroke, mark: `${fill} stroke-brand` };
};

interface BlipProps {
  point: RadarPoint;
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
  point,
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
  const { id, x, y, severity } = point;
  const { shape, radius: base } = shapeOf(severity);
  const radius = base * point.scale;
  const marks = marksOf(severity);
  const mark =
    shape === 'circle' ? (
      <circle cx={x} cy={y} r={radius} className={marks.mark} strokeWidth={2} />
    ) : (
      <polygon
        points={shapePoints(shape, x, y, radius)}
        className={marks.mark}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    );
  return (
    <g
      data-blip={id}
      data-severity={severity ?? 'none'}
      data-active={active || undefined}
      role="link"
      tabIndex={tabbable ? 0 : -1}
      aria-label={point.label}
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
      <circle cx={x} cy={y} r={Math.max(16, radius + 4)} className="fill-transparent" />
      {motion && (
        <circle
          cx={x}
          cy={y}
          r={radius + 1}
          className={cn('radar-echo pointer-events-none', marks.fill)}
          style={{ animationDelay: `${echoDelay(point.angle)}ms` }}
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
      {point.ringed && (
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
function RadarLegend({
  windowHours,
  cases,
  treated,
}: {
  windowHours: number;
  /** Os pontos são casos. */
  cases: boolean;
  /** Há caso sem nada pendente no radar. */
  treated: boolean;
}) {
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
        {treated && (
          <li className="flex items-center gap-1.5">
            <svg aria-hidden width={16} height={16} viewBox="0 0 16 16">
              <circle cx={8} cy={8} r={TREATED_SHAPE.radius} className={TREATED_MARKS.mark} strokeWidth={2} />
            </svg>
            <span className="text-foreground">{NOTHING_PENDING}</span>
          </li>
        )}
      </ul>
      <p>
        Centro: agora. Anéis a {formatList(radarRings(windowHours).map((ring) => `${ring.hours}`))} horas
        atrás (as horas recentes têm mais espaço).{' '}
        {cases
          ? 'Cada ponto é um caso de detecção: o tamanho é quantos alertas ele reúne, e o setor, a origem.'
          : 'O setor é a origem da detecção.'}
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
  return (
    <TableFrame
      title="Detecções do radar"
      count={detections.length}
      columns={[
        { header: 'Detecção' },
        { header: 'Severidade' },
        { header: 'Origem' },
        { header: 'Quando', nowrap: true },
        { header: 'Incidente' },
      ]}
    >
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
          <WhenCell at={detection.occurredAt} now={now} />
          <IncidentCell incident={detection.incident} links={links} />
        </tr>
      ))}
    </TableFrame>
  );
}

/** Todos os casos do radar, em tabela, com os mesmos números dos pontos. */
function CasesTable({
  cases,
  windowHours,
  now,
  links,
}: {
  cases: readonly RadarCase[];
  windowHours: number;
  now: Date;
  links: RadarLinks;
}) {
  return (
    <TableFrame
      title="Casos do radar"
      count={cases.length}
      columns={[
        { header: 'Caso' },
        { header: 'Severidade' },
        { header: 'Alertas' },
        { header: 'Pendentes' },
        { header: `Em ${windowHours} h`, nowrap: true },
        { header: 'Origem' },
        { header: 'Última atividade', nowrap: true },
        { header: 'Incidente' },
      ]}
    >
      {cases.map((item) => (
        <tr key={item.id} className="border-t">
          <th scope="row" className="min-w-48 px-3 py-2 text-left font-normal">
            <Link className="underline underline-offset-2" to={links.case(item.id)}>
              {item.title}
            </Link>
          </th>
          <td className="px-3 py-2">
            <CaseSeverityCell item={item} />
          </td>
          {[item.total, item.pending, item.recent].map((value, index) => (
            <td key={index} className="px-3 py-2 tabular-nums">
              {formatCount(value)}
            </td>
          ))}
          <td className="px-3 py-2 whitespace-nowrap">{caseOrigin(item)}</td>
          <WhenCell at={item.lastActivityAt} now={now} />
          <IncidentCell incident={item.incident} links={links} />
        </tr>
      ))}
    </TableFrame>
  );
}

function CaseSeverityCell({ item }: { item: RadarCase }) {
  const severity = caseSeverity(item);
  if (severity === null) return <span className="whitespace-nowrap">{NOTHING_PENDING}</span>;
  return <SeverityBadge severity={severity} />;
}

function WhenCell({ at, now }: { at: string; now: Date }) {
  return (
    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
      {formatHour(at)} <span className="text-muted-foreground">({formatRelative(at, now)})</span>
    </td>
  );
}

function IncidentCell({
  incident,
  links,
}: {
  incident: Pick<NonNullable<RadarDetection['incident']>, 'id' | 'open'> | null;
  links: RadarLinks;
}) {
  return (
    <td className="px-3 py-2 whitespace-nowrap">
      {incident ? (
        <Link className="underline underline-offset-2" to={links.incident(incident.id)}>
          {incident.open ? 'Aberto' : 'Resolvido'}
        </Link>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </td>
  );
}

/** O quadro de uma tabela do radar, atrás de "Ver em tabela": rola por dentro, com o foco do teclado. */
function TableFrame({
  title,
  count,
  columns,
  children,
}: {
  title: string;
  count: number;
  columns: readonly { header: string; nowrap?: boolean }[];
  children: ReactNode;
}) {
  return (
    <details className="group">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded py-1 text-xs font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden
          className="size-3.5 group-open:rotate-90 motion-safe:transition-transform"
        />
        Ver em tabela ({count})<span className="sr-only">: {title}</span>
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
              {columns.map(({ header, nowrap }) => (
                <th
                  key={header}
                  scope="col"
                  className={cn('px-3 py-2 text-left font-medium', nowrap && 'whitespace-nowrap')}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </details>
  );
}

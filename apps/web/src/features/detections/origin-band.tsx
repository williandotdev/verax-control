import { WEB_TRAFFIC_WINDOWS, type WebTraffic, type WebTrafficWindow } from '@verax/shared';
import { ChevronDown, ChevronRight, Hourglass } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { formatCompact } from '@/components/charts/chart-utils';
import { LazyWorldMap } from '@/components/security/world-map-lazy';
import { isFlagged, momentText } from '@/components/security/world-map-model';
import { WorldMapSkeleton } from '@/components/security/world-map-skeleton';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { SEVERITY_STYLES } from '@/design/severity';
import { cn } from '@/lib/cn';
import { formatList, plural } from '@/lib/format';
import { forgetOriginPlace, readOriginPlace, rememberOriginPlace } from './origin-place';
import { toWorldTraffic, useOriginTraffic } from './origin-traffic';
import { useOriginBandPreference } from './strip-preference';

const WINDOW_LABELS: Readonly<Record<WebTrafficWindow, { short: string; long: string }>> = {
  '24h': { short: '24 horas', long: 'Últimas 24 horas' },
  '7d': { short: '7 dias', long: 'Últimos 7 dias' },
  '30d': { short: '30 dias', long: 'Últimos 30 dias' },
};

interface OriginBandProps {
  scope: string;
  userId: string;
  /** Quem chega por um link direto (um alerta, um incidente, uma análise): a faixa começa recolhida, só daquela vez. */
  startCollapsed: boolean;
}

/**
 * "Origem das requisições", no topo da tela Detecções (decisão do responsável, 24/11/2026): o mapa-múndi com um ponto por
 * país, do volume real dos logs dos balanceadores. Larga e recolhível (a escolha fica neste navegador, por pessoa; no
 * celular, começa recolhida).
 *
 * Só existe para quem tem balanceador com a leitura autorizada: sem ele, ou num nó que não tem o mapa, a página é a de
 * sempre, sem nada no lugar. O desenho do mundo só é baixado com a faixa aberta, e o lugar dela na página é guardado
 * (`origin-place.ts`): a lista não pula enquanto ela carrega.
 */
export function OriginBand({ scope, userId, startCollapsed }: OriginBandProps) {
  const [expanded, setExpanded] = useOriginBandPreference(userId, startCollapsed);
  const [period, setPeriod] = useState<WebTrafficWindow>('24h');
  const [place] = useState(() => readOriginPlace(userId, scope));
  // As 24 horas dizem se a faixa existe, e são o resumo dela recolhida; a outra janela, só com ela aberta.
  const other = expanded && period !== '24h';
  const day = useOriginTraffic(scope, '24h', { polling: !other });
  const chosen = useOriginTraffic(scope, period, { enabled: other });
  const query = other ? chosen : day;

  // O que a API disse por último, de qualquer janela: null no nó que não tem o mapa, undefined enquanto não respondeu.
  const latest = other && chosen.data !== undefined ? chosen.data : day.data;
  const exists = latest === undefined ? undefined : latest !== null && latest.state !== 'no_source';
  useEffect(() => {
    if (exists === true) rememberOriginPlace(userId, scope);
    if (exists === false) forgetOriginPlace(userId, scope);
  }, [exists, userId, scope]);

  // Sem resposta ainda (ou com a primeira falhando), só aparece para quem tinha a faixa da última vez.
  if (exists === false || (exists === undefined && place === null)) return null;

  const skeleton = (
    <div className="overflow-hidden" style={place?.height == null ? undefined : { height: place.height }}>
      <WorldMapSkeleton />
    </div>
  );
  return (
    <Band
      expanded={expanded}
      onExpandedChange={setExpanded}
      summary={<CompactSummary traffic={day.data ?? null} failed={day.isError} />}
      about={<About traffic={latest ?? null} />}
      controls={
        latest?.state !== 'waiting' && (
          <WindowPicker value={period} onChange={setPeriod} busy={query.isPending} />
        )
      }
    >
      {query.isError && !query.data ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !latest ? (
        skeleton
      ) : latest.state === 'waiting' ? (
        <Waiting traffic={latest} />
      ) : (
        <Measured userId={userId} scope={scope}>
          <LazyWorldMap traffic={toWorldTraffic(latest, query.isError)} userId={userId} fallback={skeleton} />
        </Measured>
      )}
    </Band>
  );
}

/** A moldura: o título, o resumo (recolhida) ou a explicação (aberta), a janela e o botão de recolher. */
function Band({
  expanded,
  onExpandedChange,
  summary,
  about,
  controls,
  children,
}: {
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  summary: ReactNode;
  about: ReactNode;
  controls: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  const contentId = useId();
  return (
    <section
      aria-labelledby={titleId}
      data-tour="deteccoes-origens"
      className="rounded-xl border bg-surface shadow-xs"
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3">
        <div className={cn('min-w-0 flex-1', expanded && 'basis-56')}>
          <h2 id={titleId} className="text-base font-semibold">
            Origem das requisições
          </h2>
          {expanded ? about : summary}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {expanded && controls}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            {expanded ? 'Recolher' : 'Mostrar'}
            <span className="sr-only"> o mapa de origens</span>
          </Button>
        </div>
      </header>
      <div id={contentId} hidden={!expanded} className="border-t p-4">
        {expanded && children}
      </div>
    </section>
  );
}

/** Recolhida: os números de 24 horas, numa linha. */
function CompactSummary({ traffic, failed }: { traffic: WebTraffic | null; failed: boolean }) {
  const parts = [
    ...(traffic ? compactParts(traffic) : []),
    ...(failed ? ['não foi possível atualizar agora'] : []),
  ];
  return <p className="text-sm text-muted-foreground">{parts.join(' · ')}</p>;
}

function compactParts(traffic: WebTraffic): string[] {
  if (traffic.state === 'waiting') return ['aguardando os primeiros logs'];
  const groups = [
    ...traffic.countries,
    traffic.unknown,
    traffic.unverified,
    traffic.throughProxy,
    traffic.internal,
  ];
  const total = groups.reduce((sum, group) => sum + group.requests, 0);
  const flagged = traffic.countries.filter((country) => isFlagged(country, traffic.windowHours)).length;
  const parts = [
    `${formatCompact(total)} ${total === 1 ? 'requisição' : 'requisições'} em 24 h`,
    plural(traffic.countries.length, 'país', 'países'),
  ];
  if (flagged > 0) parts.push(`${plural(flagged, 'país', 'países')} com muitas suspeitas`);
  if (traffic.state === 'stale') {
    parts.push(
      traffic.lastLogAt
        ? `sem logs novos desde ${momentText(traffic.lastLogAt, traffic.generatedAt)}`
        : 'sem logs novos',
    );
  }
  return parts;
}

/** Aberta: de onde saem os números, e o que na leitura pede atenção. */
function About({ traffic }: { traffic: WebTraffic | null }) {
  if (!traffic) {
    return (
      <p className="text-xs text-muted-foreground">
        De que países vieram as requisições, pelos logs de acesso dos balanceadores da AWS.
      </p>
    );
  }
  const { authorized, collecting, observing, failing } = traffic.sources;
  const notes = [];
  if (traffic.state === 'ok' && collecting < authorized)
    notes.push(`leitura em dia em ${collecting} de ${authorized}`);
  if (observing === authorized) notes.push('só observando, sem abrir alertas');
  else if (observing > 0) notes.push(`${observing} só observando, sem abrir alertas`);
  const { icon: Icon, tone } = SEVERITY_STYLES.medium;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p>
        De que países vieram as requisições, pelos logs de acesso de{' '}
        {plural(authorized, 'balanceador', 'balanceadores')} da AWS
        {notes.length > 0 && ` (${formatList(notes)})`}.
      </p>
      {failing > 0 && (
        <p className="flex items-start gap-1.5">
          <Icon aria-hidden className={cn('mt-px size-3.5 shrink-0', tone)} />
          <span>
            {plural(failing, 'balanceador', 'balanceadores')} com problema na leitura: veja o motivo em{' '}
            <Link to="/cadastros/contas" className="underline underline-offset-2">
              Contas cloud
            </Link>
            .
          </span>
        </p>
      )}
    </div>
  );
}

function WindowPicker({
  value,
  onChange,
  busy,
}: {
  value: WebTrafficWindow;
  onChange: (value: WebTrafficWindow) => void;
  busy: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Período do mapa de origens"
      aria-busy={busy}
      className="inline-flex rounded-md border p-0.5"
    >
      {WEB_TRAFFIC_WINDOWS.map((window) => (
        <button
          key={window}
          type="button"
          aria-pressed={value === window}
          className={cn(
            'rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
            value === window && 'bg-foreground/10 font-medium text-foreground',
          )}
          onClick={() => onChange(window)}
        >
          <span aria-hidden>{WINDOW_LABELS[window].short}</span>
          <span className="sr-only">{WINDOW_LABELS[window].long}</span>
        </button>
      ))}
    </div>
  );
}

/** Autorizado e ainda sem nenhum log: o que esperar. */
function Waiting({ traffic }: { traffic: WebTraffic }) {
  const failing = traffic.sources.failing > 0;
  const { icon: Icon, tone } = SEVERITY_STYLES.medium;
  return (
    <div role="status" className="flex items-start gap-3 text-sm">
      {failing ? (
        <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', tone)} />
      ) : (
        <Hourglass aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="max-w-prose space-y-1">
        <p className="font-medium">Aguardando os primeiros logs</p>
        <p className="text-muted-foreground">
          {failing
            ? 'A leitura está com problema, e nenhum log chegou ainda. O mapa aparece quando ela voltar.'
            : traffic.lastClosedAt !== null
              ? 'A leitura está em dia, e nenhum log chegou ainda: sem requisição, o balanceador não grava log. O mapa aparece cerca de 15 minutos depois da primeira.'
              : 'A AWS entrega os logs em blocos de 5 minutos, com atraso: o mapa aparece cerca de 15 minutos depois das primeiras requisições.'}
        </p>
      </div>
    </div>
  );
}

/** Guarda a altura do mapa pronto, para a próxima visita. A da tabela aberta não conta: ela sempre começa fechada. */
function Measured({ userId, scope, children }: { userId: string; scope: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (!element.querySelector('[data-world-map]') || element.querySelector('details[open]')) return;
      rememberOriginPlace(userId, scope, element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [userId, scope]);
  return <div ref={ref}>{children}</div>;
}

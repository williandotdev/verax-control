import { agentIdOfRef, type DetectionRow, type Finding, type Incident } from '@verax/shared';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Pagination } from '@/components/data-table';
import { SeverityBadge } from '@/components/security/severity-badge';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { type RowSelect, SelectCell, SelectHeader } from '@/features/cases/select-cells';
import { FindingStatusBadge } from '@/features/findings/finding-status-badge';
import { FINDING_SOURCE_LABELS, findingOriginId, findingOriginLabel } from '@/features/findings/labels';
import { IncidentStatusBadge } from '@/features/incidents/incident-status-badge';
import { useIncident } from '@/features/incidents/incidents-api';
import { incidentTitle } from '@/features/incidents/narrative';
import { cn } from '@/lib/cn';
import { formatRelative, formatTimestamp, plural } from '@/lib/format';
import type { DetectionSelection } from './url-state';

export interface ListPage<T> {
  rows: T[] | undefined;
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onPageChange: (page: number) => void;
  emptyTitle: string;
  emptyDescription: string;
  /** Com o painel aberto ao lado, a tabela esconde as colunas que se repetem no detalhe. */
  compact?: boolean;
  /** Ao lado do radar: as colunas que não cabem (a origem, a hora) vão numa linha embaixo do título. */
  dense?: boolean;
}

export const HEAD = 'px-3 py-2 text-left font-medium';
export const CELL = 'px-3 py-2 align-top max-md:py-3';
/**
 * Ao lado do radar ou do detalhe (`data-fill`, em `detections-page.tsx`), a lista ocupa a altura do quadro da esquerda: cada
 * elemento entre a coluna e a tabela leva esta classe, e só a tabela rola.
 */
export const FILL_COLUMN = 'in-data-[fill=true]:flex in-data-[fill=true]:grow in-data-[fill=true]:flex-col';
/** Coluna que sai com o painel aberto ao lado (o detalhe mostra o mesmo). */
export const OPTIONAL = 'group-data-[compact=true]:hidden';
/** Coluna que, ao lado do radar, vira uma linha embaixo do título (`DenseMeta`). */
export const ROOMY = 'group-data-[dense=true]:hidden';
/** A coluna do título. */
export const TITLE = 'md:min-w-64 group-data-[dense=true]:md:min-w-40';
/** Coluna da tela média para cima: no celular, a severidade, o status e a hora vão embaixo do título. */
export const WIDE = 'hidden md:table-cell';

/** No celular, embaixo do título: a severidade, o status e quando. */
export function MobileMeta({ children }: { children: ReactNode }) {
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground md:hidden">
      {children}
    </span>
  );
}

/** Ao lado do radar, embaixo do título: o que saiu das colunas. No celular, o `MobileMeta` já diz. */
export function DenseMeta({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 hidden text-xs wrap-anywhere text-muted-foreground md:block">{children}</span>
  );
}

export function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={formatTimestamp(at)} className="whitespace-nowrap">
      {formatRelative(at)}
    </time>
  );
}

/** O botão do título, que abre o item no painel ao lado. Fica marcado enquanto o item está aberto. */
export function OpenButton({
  selected,
  onOpen,
  children,
  label,
  rowTarget = false,
}: {
  selected: boolean;
  onOpen: (opener: HTMLElement) => void;
  children: ReactNode;
  label: string;
  /** No celular, o toque em qualquer ponto da linha abre o item (a linha precisa ser `max-md:relative`). */
  rowTarget?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'text-left font-medium hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
        // E-02: no celular, a linha inteira é o alvo do toque (a área do botão cobre a linha, que precisa ser `relative`).
        rowTarget && "max-md:after:absolute max-md:after:inset-0 max-md:after:content-['']",
      )}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {children}
    </button>
  );
}

export function Frame<T>({
  page,
  label,
  caption,
  header,
  children,
}: {
  page: ListPage<T>;
  /** O nome da área que rola: "Lista de alertas". */
  label: string;
  /** A descrição da tabela para leitor de tela. */
  caption: string;
  header: ReactNode;
  children: (rows: T[]) => ReactNode;
}) {
  // A tabela que rola por dentro começa do topo na página seguinte.
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (region.current) region.current.scrollTop = 0;
  }, [page.page]);
  let body: ReactNode;
  if (page.error) body = <ErrorState error={page.error} onRetry={page.onRetry} />;
  else if (!page.rows) body = <LoadingState rows={5} label="Carregando as detecções" />;
  else if (page.rows.length === 0)
    body = <EmptyState title={page.emptyTitle} description={page.emptyDescription} />;
  else
    body = (
      // Rola por dentro quando não cabe: o foco pelo teclado deixa ler as colunas da direita sem mouse.
      <div
        ref={region}
        data-tour="deteccoes-lista"
        role="region"
        aria-label={label}
        tabIndex={0}
        // `relative`: os textos só para leitor de tela (posição absoluta) ficam presos à área que rola, e não alargam a página.
        className={cn(
          'relative overflow-x-auto rounded-lg border focus-visible:outline-2 focus-visible:outline-ring',
          // A altura vem do quadro ao lado, e não das linhas; num quadro baixo, há um mínimo para ler.
          'in-data-[fill=true]:h-0 in-data-[fill=true]:min-h-96 in-data-[fill=true]:shrink-0 in-data-[fill=true]:grow in-data-[fill=true]:basis-0',
          'in-data-[fill=true]:overflow-y-auto in-data-[fill=true]:rounded-none in-data-[fill=true]:border-0',
        )}
        aria-busy={page.loading}
      >
        <table
          data-compact={page.compact === true}
          data-dense={page.dense === true}
          className={cn(
            'group w-full text-sm',
            !page.dense && 'md:min-w-[40rem]',
            page.loading && 'opacity-60',
          )}
        >
          <caption className="sr-only">{caption}</caption>
          <thead className="bg-foreground/[0.03] text-xs text-muted-foreground in-data-[fill=true]:sticky in-data-[fill=true]:top-0 in-data-[fill=true]:z-10 in-data-[fill=true]:bg-surface">
            <tr>{header}</tr>
          </thead>
          <tbody className="tabular-nums">{children(page.rows)}</tbody>
        </table>
      </div>
    );
  return (
    <div
      data-list-frame=""
      className={cn(
        FILL_COLUMN,
        'space-y-3 in-data-[fill=true]:space-y-0 in-data-[fill=true]:overflow-hidden in-data-[fill=true]:rounded-xl in-data-[fill=true]:border in-data-[fill=true]:bg-surface',
      )}
    >
      {body}
      {/* E-11: no celular, os botões da paginação com 44 px. */}
      <div className="in-data-[fill=true]:mt-auto in-data-[fill=true]:border-t in-data-[fill=true]:px-3 in-data-[fill=true]:py-2 max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11">
        <Pagination
          page={page.page}
          pageSize={page.pageSize}
          total={page.total}
          onPageChange={page.onPageChange}
          busy={page.loading}
        />
      </div>
    </div>
  );
}

function originsText(incident: Incident): string {
  if (incident.accounts.length === 1) return findingOriginLabel(incident.accounts[0] ?? '');
  return incident.accounts.some((origin) => agentIdOfRef(origin) !== null)
    ? plural(incident.accounts.length, 'origem', 'origens')
    : plural(incident.accounts.length, 'conta', 'contas');
}

function assetsText(incident: Incident): ReactNode {
  if (incident.resources.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="break-all text-xs">
      {incident.resources[0]}
      {incident.resources.length > 1 && ` e mais ${incident.resources.length - 1}`}
    </span>
  );
}

/**
 * Visão "Incidentes": cada incidente confirmado numa linha (nota, severidade, status, responsável, ativos e alertas),
 * que abre os alertas dele logo abaixo. O título abre o painel. A API sem `kind=incident` também manda os alertas fora
 * de incidente, que ganham linhas próprias.
 */
export function IncidentsList({
  page,
  selection,
  onOpen,
  filtered,
}: {
  page: ListPage<DetectionRow>;
  selection: DetectionSelection;
  onOpen: (selection: NonNullable<DetectionSelection>, opener: HTMLElement) => void;
  /** Há filtro de conteúdo: o incidente diz quantos dos alertas dele batem. */
  filtered: boolean;
}) {
  return (
    <Frame
      page={page}
      label="Lista de incidentes"
      caption="Incidentes do cliente, com os alertas de cada um"
      header={
        <>
          <th scope="col" className={cn(HEAD, 'w-10')}>
            <span className="sr-only">Abrir os alertas</span>
          </th>
          <th scope="col" className={cn(HEAD, TITLE)}>
            Incidente
          </th>
          <th scope="col" className={cn(HEAD, WIDE)}>
            Severidade
          </th>
          <th scope="col" className={cn(HEAD, WIDE)}>
            Status
          </th>
          <th scope="col" className={cn(HEAD, WIDE, OPTIONAL)}>
            Responsável
          </th>
          <th scope="col" className={cn(HEAD, WIDE, OPTIONAL)}>
            Ativos
          </th>
          <th scope="col" className={cn(HEAD, WIDE, ROOMY, 'whitespace-nowrap')}>
            Última atividade
          </th>
        </>
      }
    >
      {(rows) =>
        rows.map((row) =>
          row.kind === 'incident' ? (
            <IncidentRows
              key={row.incident.id}
              incident={row.incident}
              matched={filtered ? row.matchedFindings : null}
              dense={page.dense === true}
              compact={page.compact === true}
              selection={selection}
              onOpen={onOpen}
            />
          ) : (
            <tr
              key={row.finding.id}
              className={cn('border-t', selection?.id === row.finding.id && 'bg-primary/5')}
            >
              <td className={CELL} />
              <td className={CELL}>
                <OpenButton
                  selected={selection?.id === row.finding.id}
                  label={`Abrir o alerta: ${row.finding.title}`}
                  onOpen={(opener) => onOpen({ kind: 'finding', id: row.finding.id }, opener)}
                >
                  {row.finding.title}
                </OpenButton>
                <span className="block text-xs text-muted-foreground">
                  Alerta fora de incidente · {FINDING_SOURCE_LABELS[row.finding.source]} ·{' '}
                  {findingOriginLabel(row.finding.accountId)}
                </span>
                {page.dense && (
                  <DenseMeta>
                    {page.compact && row.finding.resource && <>{row.finding.resource} · </>}
                    <When at={row.finding.occurredAt} />
                  </DenseMeta>
                )}
                <MobileMeta>
                  <SeverityBadge severity={row.finding.severity} />
                  <FindingStatusBadge status={row.finding.status} />
                  <When at={row.finding.occurredAt} />
                </MobileMeta>
              </td>
              <td className={cn(CELL, WIDE)}>
                <SeverityBadge severity={row.finding.severity} />
              </td>
              <td className={cn(CELL, WIDE)}>
                <FindingStatusBadge status={row.finding.status} />
              </td>
              <td className={cn(CELL, WIDE, OPTIONAL, 'text-muted-foreground')}>—</td>
              <td className={cn(CELL, WIDE, OPTIONAL, 'min-w-40 max-w-64')}>
                {row.finding.resource ? (
                  <span className="break-all text-xs">{row.finding.resource}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className={cn(CELL, WIDE, ROOMY)}>
                <When at={row.finding.occurredAt} />
              </td>
            </tr>
          ),
        )
      }
    </Frame>
  );
}

function IncidentRows({
  incident,
  matched,
  dense,
  compact,
  selection,
  onOpen,
}: {
  incident: Incident;
  matched: number | null;
  dense: boolean;
  /** Sem as colunas do responsável e dos ativos: eles vão na linha embaixo do título. */
  compact: boolean;
  selection: DetectionSelection;
  onOpen: (selection: NonNullable<DetectionSelection>, opener: HTMLElement) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const childrenId = useId();
  const title = incidentTitle(incident);
  return (
    <>
      <tr className={cn('border-t', selection?.id === incident.id && 'bg-primary/5')}>
        <td className={CELL}>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={childrenId}
            aria-label={`${expanded ? 'Fechar' : 'Abrir'} os alertas do incidente: ${title}`}
            className="flex size-8 items-center justify-center rounded-md hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring max-md:size-11"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight aria-hidden className={cn('size-4', expanded && 'rotate-90')} />
          </button>
        </td>
        <td className={CELL}>
          <OpenButton
            selected={selection?.id === incident.id}
            label={`Abrir o incidente: ${title}`}
            onOpen={(opener) => onOpen({ kind: 'incident', id: incident.id }, opener)}
          >
            {title}
          </OpenButton>
          <span className="block text-xs text-muted-foreground">
            Incidente · nota de risco {incident.riskScore} ·{' '}
            {matched !== null && matched < incident.findingCount
              ? `${matched} de ${plural(incident.findingCount, 'alerta', 'alertas')} nos filtros`
              : plural(incident.findingCount, 'alerta', 'alertas')}{' '}
            · {originsText(incident)}
          </span>
          {dense && (
            <DenseMeta>
              {incident.assignee?.name ?? 'Sem responsável'} ·{' '}
              {compact && incident.resources.length > 0 && (
                <>
                  {incident.resources[0]}
                  {incident.resources.length > 1 && ` e mais ${incident.resources.length - 1}`} ·{' '}
                </>
              )}
              <When at={incident.lastSeenAt} />
            </DenseMeta>
          )}
          <MobileMeta>
            <SeverityBadge severity={incident.severity} />
            <IncidentStatusBadge status={incident.status} />
            <span>{incident.assignee?.name ?? 'sem responsável'}</span>
            <When at={incident.lastSeenAt} />
          </MobileMeta>
        </td>
        <td className={cn(CELL, WIDE)}>
          <SeverityBadge severity={incident.severity} />
        </td>
        <td className={cn(CELL, WIDE)}>
          <IncidentStatusBadge status={incident.status} />
        </td>
        <td className={cn(CELL, WIDE, OPTIONAL)}>
          {incident.assignee?.name ?? <span className="text-muted-foreground">Ninguém</span>}
        </td>
        <td className={cn(CELL, WIDE, OPTIONAL, 'min-w-40 max-w-64')}>{assetsText(incident)}</td>
        <td className={cn(CELL, WIDE, ROOMY)}>
          <When at={incident.lastSeenAt} />
        </td>
      </tr>
      <tr id={childrenId} hidden={!expanded}>
        <td />
        <td colSpan={6} className="px-3 pb-3">
          {expanded && <IncidentFindings id={incident.id} selection={selection} onOpen={onOpen} />}
        </td>
      </tr>
    </>
  );
}

/** Os alertas do incidente aberto na lista, do mais recente ao mais antigo, cada um abrindo no painel. */
function IncidentFindings({
  id,
  selection,
  onOpen,
}: {
  id: string;
  selection: DetectionSelection;
  onOpen: (selection: NonNullable<DetectionSelection>, opener: HTMLElement) => void;
}) {
  const incident = useIncident(id, true);
  if (incident.isError) return <ErrorState error={incident.error} onRetry={() => void incident.refetch()} />;
  if (!incident.data) return <LoadingState rows={2} label="Carregando os alertas do incidente" />;
  return (
    <ul className="divide-y rounded-md border bg-foreground/[0.02]">
      {[...incident.data.findings].reverse().map((finding) => (
        <li
          key={finding.id}
          className={cn(
            'flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2',
            selection?.id === finding.id && 'bg-primary/5',
          )}
        >
          <SeverityBadge severity={finding.severity} className="shrink-0" />
          <span className="min-w-0 flex-1">
            <OpenButton
              selected={selection?.id === finding.id}
              label={`Abrir o alerta: ${finding.title}`}
              onOpen={(opener) => onOpen({ kind: 'finding', id: finding.id }, opener)}
            >
              {finding.title}
            </OpenButton>
            <span className="block text-xs text-muted-foreground">
              {FINDING_SOURCE_LABELS[finding.source]} · {finding.actor.user ?? finding.actor.ip ?? '—'}
            </span>
          </span>
          <FindingStatusBadge status={finding.status} />
          <span className="text-xs text-muted-foreground">
            <When at={finding.occurredAt} />
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Visão "Alertas" (o padrão): todos os alertas, os que esperam validação e os já validados; o que foi confirmado num
 * incidente leva a marca "Em incidente", que abre o incidente no painel.
 */
export function AlertsList({
  page,
  selection,
  onOpen,
  select,
}: {
  page: ListPage<Finding>;
  selection: DetectionSelection;
  onOpen: (selection: NonNullable<DetectionSelection>, opener: HTMLElement) => void;
  /** A seleção para a triagem em massa; sem ela (casos desligados, quem só lê), a lista é só a lista. */
  select?: RowSelect<Finding>;
}) {
  return (
    <Frame
      page={page}
      label="Lista de alertas"
      caption="Alertas do cliente"
      header={
        <>
          {select && <SelectHeader select={select} rows={page.rows ?? []} noun="alertas" />}
          <th scope="col" className={cn(HEAD, WIDE)}>
            Severidade
          </th>
          <th scope="col" className={cn(HEAD, TITLE)}>
            Alerta
          </th>
          <th scope="col" className={cn(HEAD, WIDE, OPTIONAL)}>
            Conta
          </th>
          <th scope="col" className={cn(HEAD, WIDE, ROOMY)}>
            Origem
          </th>
          <th scope="col" className={cn(HEAD, WIDE, OPTIONAL)}>
            Usuário ou IP
          </th>
          <th scope="col" className={cn(HEAD, WIDE, ROOMY)}>
            Quando
          </th>
          <th scope="col" className={cn(HEAD, WIDE)}>
            Status
          </th>
          <th scope="col" className={cn(HEAD, WIDE)}>
            Incidente
          </th>
        </>
      }
    >
      {(rows) =>
        rows.map((row) => (
          <tr
            key={row.id}
            className={cn('border-t max-md:relative', selection?.id === row.id && 'bg-primary/5')}
          >
            {select && <SelectCell select={select} rows={rows} row={row} label={row.title} />}
            <td className={cn(CELL, WIDE)}>
              <SeverityBadge severity={row.severity} />
            </td>
            <td className={CELL}>
              <OpenButton
                selected={selection?.id === row.id}
                label={`Abrir o alerta: ${row.title}`}
                onOpen={(opener) => onOpen({ kind: 'finding', id: row.id }, opener)}
                rowTarget
              >
                {row.title}
              </OpenButton>
              {row.eventName && (
                <span className="block text-xs wrap-anywhere text-muted-foreground">{row.eventName}</span>
              )}
              {page.dense && (
                <DenseMeta>
                  {[
                    // Sem a coluna da conta (enxuta), ela vem nesta linha: nenhuma informação some.
                    page.compact ? findingOriginId(row.accountId) : null,
                    FINDING_SOURCE_LABELS[row.source],
                    row.actor.user ?? row.actor.ip,
                  ]
                    .filter(Boolean)
                    .join(' · ')}{' '}
                  · <When at={row.occurredAt} />
                </DenseMeta>
              )}
              <MobileMeta>
                <SeverityBadge severity={row.severity} />
                <FindingStatusBadge status={row.status} />
                <When at={row.occurredAt} />
                {row.incidentId && <span>em incidente</span>}
              </MobileMeta>
            </td>
            <td className={cn(CELL, WIDE, OPTIONAL)}>
              <span className="font-mono text-xs">{findingOriginId(row.accountId)}</span>
            </td>
            <td className={cn(CELL, WIDE, ROOMY)}>{FINDING_SOURCE_LABELS[row.source]}</td>
            <td className={cn(CELL, WIDE, OPTIONAL, 'max-w-48')}>
              <span className="break-all">{row.actor.user ?? row.actor.ip ?? '—'}</span>
            </td>
            <td className={cn(CELL, WIDE, ROOMY)}>
              <When at={row.occurredAt} />
            </td>
            <td className={cn(CELL, WIDE)}>
              <FindingStatusBadge status={row.status} />
            </td>
            <td className={cn(CELL, WIDE)}>
              {row.incidentId ? (
                <button
                  type="button"
                  className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={(event) =>
                    onOpen({ kind: 'incident', id: row.incidentId ?? '' }, event.currentTarget)
                  }
                >
                  Em incidente<span className="sr-only">: abrir o incidente do alerta {row.title}</span>
                </button>
              ) : (
                <span className="text-muted-foreground">
                  {row.status === 'new' || row.status === 'investigating' ? 'A validar' : '—'}
                </span>
              )}
            </td>
          </tr>
        ))
      }
    </Frame>
  );
}

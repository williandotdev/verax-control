import type { CaseSummary } from '@verax/shared';
import type { ReactNode } from 'react';
import { SeverityBadge } from '@/components/security/severity-badge';
import {
  CELL,
  DenseMeta,
  Frame,
  HEAD,
  type ListPage,
  MobileMeta,
  OpenButton,
  OPTIONAL,
  ROOMY,
  TITLE,
  When,
  WIDE,
} from '@/features/detections/detection-list';
import type { DetectionSelection } from '@/features/detections/url-state';
import { findingOriginId } from '@/features/findings/labels';
import { cn } from '@/lib/cn';
import { formatCount } from '@/lib/format';
import { sumPending } from './bulk';
import { CaseBadges, SeverityCounts } from './case-badges';
import { caseName, mainSubjects } from './labels';
import { type RowSelect, SelectCell, SelectHeader } from './select-cells';

export type OpenItem = (selection: NonNullable<DetectionSelection>, opener: HTMLElement) => void;

/** Quem, onde e de onde: texto do evento, cortado na tela (o detalhe mostra inteiro). `omit`: o que a linha já diz. */
export function CaseSubjects({ row, omit }: { row: CaseSummary; omit?: string }): ReactNode {
  const subjects = mainSubjects(row).filter((subject) => subject.label !== omit);
  if (subjects.length === 0) return null;
  return (
    <span className="mt-0.5 line-clamp-3 text-xs wrap-anywhere text-muted-foreground md:line-clamp-2">
      {subjects.map((subject, index) => (
        <span key={subject.label}>
          {index > 0 && ' · '}
          {subject.label}: {subject.value}
          {subject.more && ' e outros'}
        </span>
      ))}
    </span>
  );
}

/** Os alertas pendentes do caso; sem nenhum, quantos ele guarda. */
export function PendingCell({ row }: { row: CaseSummary }) {
  const pending = sumPending(row.pending);
  if (pending === 0) {
    return (
      <span className="text-xs whitespace-nowrap text-muted-foreground">
        Nenhum de {formatCount(row.counts.total)}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="font-medium">{formatCount(pending)}</span>
      <SeverityCounts counts={row.pending} />
    </span>
  );
}

const accountText = (row: CaseSummary): string => {
  const [first] = row.preview.accounts;
  if (first === undefined) return '—';
  return row.preview.accounts.length > 1 ? `${findingOriginId(first)} e outras` : findingOriginId(first);
};

/**
 * Visão "Casos": cada caso numa linha, com a pior severidade pendente, o que o identifica, quantos alertas esperam (por
 * severidade), a conta e a atividade. O título abre o detalhe no painel.
 */
export function CaseTable({
  page,
  label,
  caption,
  selection,
  onOpen,
  select,
}: {
  page: ListPage<CaseSummary>;
  label: string;
  caption: string;
  selection: DetectionSelection;
  onOpen: OpenItem;
  select?: RowSelect<CaseSummary> | undefined;
}) {
  return (
    <Frame
      page={page}
      label={label}
      caption={caption}
      header={
        <>
          {select && <SelectHeader select={select} rows={page.rows ?? []} noun="casos" />}
          <th scope="col" className={cn(HEAD, WIDE)}>
            Severidade
          </th>
          <th scope="col" className={cn(HEAD, TITLE)}>
            Caso
          </th>
          <th scope="col" className={cn(HEAD, WIDE)}>
            Alertas pendentes
          </th>
          <th scope="col" className={cn(HEAD, WIDE, OPTIONAL)}>
            Conta
          </th>
          <th scope="col" className={cn(HEAD, WIDE, ROOMY, 'whitespace-nowrap')}>
            Último alerta
          </th>
          <th scope="col" className={cn(HEAD, WIDE, OPTIONAL, 'whitespace-nowrap')}>
            Primeiro alerta
          </th>
        </>
      }
    >
      {(rows) =>
        rows.map((row) => {
          const name = caseName(row);
          const selected = selection?.id === row.id;
          return (
            <tr key={row.id} className={cn('border-t', selected && 'bg-primary/5')}>
              {select && <SelectCell select={select} rows={rows} row={row} label={name} />}
              <td className={cn(CELL, WIDE)}>
                {row.severity ? (
                  <SeverityBadge severity={row.severity} />
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className={CELL}>
                <OpenButton
                  selected={selected}
                  label={`Abrir o caso: ${name}`}
                  onOpen={(opener) => onOpen({ kind: 'case', id: row.id }, opener)}
                >
                  {row.title}
                </OpenButton>
                <CaseSubjects row={row} />
                {page.dense && (
                  <DenseMeta>
                    {accountText(row)} · <When at={row.lastSeenAt} />
                  </DenseMeta>
                )}
                <MobileMeta>
                  {row.severity && <SeverityBadge severity={row.severity} />}
                  <SeverityCounts counts={row.pending} />
                  <When at={row.lastSeenAt} />
                </MobileMeta>
                <span className="mt-1 block empty:hidden">
                  <CaseBadges row={row} />
                </span>
              </td>
              <td className={cn(CELL, WIDE)}>
                <PendingCell row={row} />
              </td>
              <td className={cn(CELL, WIDE, OPTIONAL)}>
                <span className="font-mono text-xs break-all">{accountText(row)}</span>
              </td>
              <td className={cn(CELL, WIDE, ROOMY)}>
                <When at={row.lastSeenAt} />
              </td>
              <td className={cn(CELL, WIDE, OPTIONAL)}>
                <When at={row.firstSeenAt} />
              </td>
            </tr>
          );
        })
      }
    </Frame>
  );
}

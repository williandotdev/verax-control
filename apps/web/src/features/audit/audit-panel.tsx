import type { AuditEntryDetail } from '@verax/shared';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Sheet } from '@/components/ui/sheet';
import { useMe } from '@/features/session/session';
import { formatRelative, formatTimestamp } from '@/lib/format';
import { AuditActorName } from './audit-actor';
import { useAuditEntry } from './audit-api';
import { AuditOutcomeBadge } from './audit-outcome-badge';
import { actionLabel, resourceLabel } from './labels';

/** Um registro da trilha num painel lateral: quem, o quê, de onde e o estado antes e depois. */
export function AuditPanel({ id, onClose }: { id: string | null; onClose: () => void }) {
  const entry = useAuditEntry(id);
  return (
    <Sheet
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={entry.data ? actionLabel(entry.data.action) : 'Registro de auditoria'}
      description={entry.data ? formatTimestamp(entry.data.occurredAt) : undefined}
    >
      {entry.isError ? (
        <ErrorState error={entry.error} onRetry={() => void entry.refetch()} />
      ) : !entry.data ? (
        <LoadingState rows={6} label="Carregando o registro" />
      ) : (
        <AuditDetailView entry={entry.data} />
      )}
    </Sheet>
  );
}

function AuditDetailView({ entry }: { entry: AuditEntryDetail }) {
  const { data: me } = useMe();
  const fields: [string, ReactNode][] = [
    ['Quando', `${formatTimestamp(entry.occurredAt)} (${formatRelative(entry.occurredAt)})`],
    ['Quem', <AuditActorName key="quem" actor={entry.actor} />],
    [
      'Ação',
      <code key="acao" className="text-xs">
        {entry.action}
      </code>,
    ],
    ['Área', resourceLabel(entry.resourceType)],
    [
      'Recurso',
      entry.resourceId && (
        <span key="recurso" className="break-all font-mono text-xs">
          {entry.resourceId}
        </span>
      ),
    ],
    [
      'Resultado',
      <span key="resultado" className="inline-flex items-center gap-2">
        <AuditOutcomeBadge outcome={entry.outcome} />
        {entry.statusCode !== null && (
          <span className="text-xs text-muted-foreground">HTTP {entry.statusCode}</span>
        )}
      </span>,
    ],
    ['IP', entry.ip],
    [
      'Navegador',
      entry.userAgent && (
        <span key="navegador" className="break-all">
          {entry.userAgent}
        </span>
      ),
    ],
    [
      'Requisição',
      entry.requestId && (
        <span key="requisicao" className="break-all font-mono text-xs">
          {entry.requestId}
        </span>
      ),
    ],
  ];
  // O cliente não vê o IP nem o navegador de quem é da Verax: avisa, para a ausência não parecer falha.
  const hidden = entry.actor.verax && me?.role !== 'admin_verax';
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {fields
          .filter(([, value]) => value !== null && value !== '')
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
      </dl>
      {hidden && (
        <p className="text-xs text-muted-foreground">
          O IP e o navegador de quem é da equipe da Verax não aparecem para o cliente.
        </p>
      )}
      {entry.before === null && entry.after === null ? (
        <p className="text-sm text-muted-foreground">Esta ação não grava estado anterior nem novo.</p>
      ) : (
        <div className="space-y-3">
          <StateBlock title="Antes" state={entry.before} />
          <StateBlock title="Depois" state={entry.after} />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Os registros de auditoria não podem ser alterados nem apagados. Senhas, tokens e segredos nunca são
        gravados.
      </p>
    </>
  );
}

function StateBlock({ title, state }: { title: string; state: AuditEntryDetail['before'] }) {
  return (
    <section className="min-w-0 space-y-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      {state === null ? (
        <p className="text-sm text-muted-foreground">Nada.</p>
      ) : (
        // Rola por dentro quando o estado é grande: recebe foco, para quem usa só o teclado conseguir rolar.
        <div
          role="region"
          aria-label={`Estado ${title.toLowerCase()} da alteração`}
          tabIndex={0}
          className="max-h-72 overflow-auto rounded-md border bg-foreground/[0.03] p-3"
        >
          <pre className="text-xs">{JSON.stringify(state, null, 2)}</pre>
        </div>
      )}
    </section>
  );
}

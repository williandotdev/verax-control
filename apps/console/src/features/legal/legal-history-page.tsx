import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import type { LegalAuditEntry } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { NotFoundPage } from '@/not-found-page';
import { configOfSlug, formatBytes, LEGAL_ROOT, type LegalKindConfig } from './kinds';
import { useLegalAudit } from './queries';

const EVENT_LABELS: Readonly<Record<LegalAuditEntry['event'], string>> = {
  'draft.created': 'Rascunho criado',
  'draft.updated': 'Rascunho editado',
  published: 'Publicada',
};

/** Quem agiu, sem o prefixo da trilha (`owner:`). */
function actorOf(actor: string): string {
  return actor.startsWith('owner:') ? actor.slice('owner:'.length) : actor;
}

/** A trilha de auditoria de um texto (`/textos-legais/:texto/historico`). */
export function LegalHistoryPage() {
  const { kind: slug } = useParams();
  const config = configOfSlug(slug);
  if (config === undefined) return <NotFoundPage />;
  return <History key={config.kind} config={config} />;
}

/**
 * O que aconteceu com um texto, do mais novo ao mais antigo (os últimos 100 registros): rascunho criado (e de qual
 * versão veio), cada gravação (com o tamanho) e a publicação (com o SHA-256 do texto publicado), com quem e quando.
 * O texto em si nunca vai à trilha.
 */
function History({ config }: { config: LegalKindConfig }) {
  const audit = useLegalAudit(config.kind);
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <p className="text-sm">
          <Link to={LEGAL_ROOT} className="text-primary underline-offset-2 hover:underline">
            Textos legais
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Histórico: {config.title}</h1>
      </header>
      {audit.isPending && <LoadingState label="Carregando o histórico" />}
      {audit.isError && <ErrorState error={audit.error} onRetry={() => void audit.refetch()} />}
      {audit.data?.length === 0 && <EmptyState title="Nada registrado ainda" />}
      {audit.data !== undefined && audit.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">{`Histórico: ${config.title}`}</caption>
            <thead className="bg-foreground/[0.03] text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Quando
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  O quê
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Versão
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Quem
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Detalhe
                </th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((entry) => (
                <tr key={entry.id} className="border-t align-top">
                  <td className="px-3 py-2 tabular-nums">{formatDateTime(entry.at)}</td>
                  <td className="px-3 py-2">{EVENT_LABELS[entry.event]}</td>
                  <td className="px-3 py-2">
                    <Link
                      to={`${config.basePath}/${encodeURIComponent(entry.version)}`}
                      className="font-mono text-primary underline-offset-2 hover:underline"
                    >
                      {entry.version}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{actorOf(entry.actor)}</td>
                  <td className="px-3 py-2 text-xs">
                    {entry.basedOn !== undefined && <span className="block">Cópia de {entry.basedOn}</span>}
                    {entry.bytes !== undefined && <span className="block">{formatBytes(entry.bytes)}</span>}
                    {entry.contentSha256 !== undefined && (
                      <span className="block font-mono break-all">SHA-256 {entry.contentSha256}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { FilePlus2 } from 'lucide-react';
import { Link } from 'react-router';
import { CurrentBadge, StatusBadge } from '@/components/badges';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { buttonVariants } from '@/components/ui/button-variants';
import { formatDateTime } from '@/lib/format';
import type { KindConfig } from './kinds';
import { useVersions } from './queries';

/** A lista de versões de um tipo: situação, vigência, quem publicou e a última edição; e o botão do rascunho novo. */
export function VersionListPage({ config }: { config: KindConfig }) {
  const versions = useVersions(config.kind);
  const current = versions.data?.find((entry) => entry.current);
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-1">
          <h1 className="text-2xl font-semibold">{config.title}</h1>
          <p className="text-sm text-muted-foreground">{config.description}</p>
        </div>
        <Link to={`${config.basePath}/novo`} className={buttonVariants()}>
          <FilePlus2 aria-hidden />
          Novo rascunho
        </Link>
      </header>

      {current !== undefined && (
        <p className="text-sm">
          Vigente:{' '}
          <Link
            to={`${config.basePath}/${current.version}`}
            className="font-mono text-primary underline-offset-2 hover:underline"
          >
            {current.version}
          </Link>
          , desde {formatDateTime(current.effectiveFrom)}.
        </p>
      )}

      {versions.isPending && <LoadingState label="Carregando as versões" />}
      {versions.isError && <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />}
      {versions.data?.length === 0 && (
        <EmptyState
          title={`Nenhum ${config.singular} ainda`}
          description="Crie o primeiro rascunho em branco ou a partir de um arquivo JSON seu (guardado fora do repositório). Os números nunca vão ao código."
        />
      )}
      {versions.data !== undefined && versions.data.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-surface">
          <table className="w-full text-sm">
            <caption className="sr-only">{`Versões: ${config.title.toLowerCase()}`}</caption>
            <thead className="bg-foreground/[0.03] text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Versão
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Situação
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Vigência
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Publicada por
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Última edição
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.data.map((entry) => (
                <tr key={entry.version} className="border-t">
                  <th scope="row" className="px-3 py-2 text-left font-medium">
                    <Link
                      to={`${config.basePath}/${entry.version}`}
                      className="font-mono text-primary underline-offset-2 hover:underline"
                    >
                      {entry.version}
                    </Link>
                  </th>
                  <td className="px-3 py-2">
                    <span className="flex flex-wrap gap-1">
                      <StatusBadge status={entry.status} />
                      {entry.current && <CurrentBadge />}
                    </span>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {entry.effectiveFrom === undefined ? '—' : formatDateTime(entry.effectiveFrom)}
                    {entry.retiredAt !== undefined && (
                      <span className="block text-xs text-muted-foreground">
                        até {formatDateTime(entry.retiredAt)}
                        {entry.supersededBy !== undefined && ` (substituída por ${entry.supersededBy})`}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{entry.publishedBy ?? '—'}</td>
                  <td className="px-3 py-2 tabular-nums">
                    {formatDateTime(entry.updatedAt)}
                    <span className="block text-xs text-muted-foreground">{entry.updatedBy}</span>
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

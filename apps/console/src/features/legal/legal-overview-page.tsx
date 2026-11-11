import { FilePlus2, History, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { CurrentBadge, StatusBadge } from '@/components/badges';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { buttonVariants } from '@/components/ui/button-variants';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { LegalVersionSummary } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { formatBytes, LEGAL_KIND_CONFIGS, type LegalKindConfig } from './kinds';
import { useLegalOverview } from './queries';

function VersionsTable({ config, versions }: { config: LegalKindConfig; versions: LegalVersionSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <caption className="sr-only">{`Versões: ${config.title}`}</caption>
        <thead className="bg-foreground/[0.03] text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Versão
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Situação
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Publicada
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Última edição
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Tamanho
            </th>
          </tr>
        </thead>
        <tbody>
          {versions.map((entry) => (
            <tr key={entry.version} className="border-t">
              <th scope="row" className="px-3 py-2 text-left font-medium">
                <Link
                  to={`${config.basePath}/${encodeURIComponent(entry.version)}`}
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
                {entry.publishedAt === undefined ? '—' : formatDateTime(entry.publishedAt)}
                {entry.publishedBy !== undefined && (
                  <span className="block text-xs text-muted-foreground">{entry.publishedBy}</span>
                )}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {formatDateTime(entry.updatedAt)}
                <span className="block text-xs text-muted-foreground">{entry.updatedBy}</span>
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{formatBytes(entry.bytes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindCard({ config, versions }: { config: LegalKindConfig; versions: LegalVersionSummary[] }) {
  const current = versions.find((entry) => entry.current);
  const headingId = `texto-${config.kind}`;
  return (
    <Card aria-labelledby={headingId}>
      <CardHeader>
        <div className="max-w-3xl space-y-1">
          <CardTitle id={headingId}>{config.title}</CardTitle>
          <CardDescription>{config.description}</CardDescription>
          <p className="text-xs text-muted-foreground">
            No site: <span className="font-mono">{config.sitePath}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to={`${config.basePath}/novo`} className={buttonVariants({ size: 'sm' })}>
            <FilePlus2 aria-hidden />
            Novo rascunho
            <span className="sr-only">: {config.title}</span>
          </Link>
          <Link
            to={`${config.basePath}/historico`}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <History aria-hidden />
            Histórico
            <span className="sr-only">: {config.title}</span>
          </Link>
        </div>
      </CardHeader>
      {current === undefined ? (
        <p className="mb-3 flex items-start gap-2 rounded-lg border border-high/60 bg-high/10 p-3 text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-high" />
          Nenhuma versão publicada: o site não tem o que mostrar em {config.sitePath} e o checkout fica
          fechado até as três publicadas.
        </p>
      ) : (
        <p className="mb-3 text-sm">
          Vigente:{' '}
          <Link
            to={`${config.basePath}/${encodeURIComponent(current.version)}`}
            className="font-mono text-primary underline-offset-2 hover:underline"
          >
            {current.version}
          </Link>
          , publicada em {formatDateTime(current.publishedAt)}.
        </p>
      )}
      {versions.length === 0 ? (
        <EmptyState
          title="Nenhuma versão ainda"
          description="Crie o primeiro rascunho e cole o texto (ou importe o arquivo Markdown)."
        />
      ) : (
        <VersionsTable config={config} versions={versions} />
      )}
    </Card>
  );
}

/**
 * Os textos legais que o cliente aceita no checkout: os três, cada um com as versões (rascunho e publicada), a vigente
 * e o aviso quando falta publicar. A vigente é a publicada mais recente; publicada, uma versão não muda mais.
 */
export function LegalOverviewPage() {
  const overview = useLegalOverview();
  const missing = LEGAL_KIND_CONFIGS.filter(
    (config) => overview.data !== undefined && !overview.data[config.kind].some((entry) => entry.current),
  );
  return (
    <div className="space-y-4">
      <header className="max-w-3xl space-y-1">
        <h1 className="text-2xl font-semibold">Textos legais</h1>
        <p className="text-sm text-muted-foreground">
          Termos de uso, Política de privacidade e DPA, em Markdown. O site mostra a versão vigente de cada
          um, e o checkout exige o aceite das três vigentes. Publicar uma versão nova vale na hora: quem
          comprar depois aceita a nova; quem já é cliente continua com a que aceitou.
        </p>
      </header>
      {overview.isPending && <LoadingState label="Carregando os textos" />}
      {overview.isError && <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />}
      {missing.length > 0 && (
        <p role="status" className="text-sm font-medium">
          Falta publicar: {missing.map((config) => config.title).join(', ')}. Sem os três, o checkout responde
          &quot;indisponível&quot;.
        </p>
      )}
      {overview.data !== undefined &&
        LEGAL_KIND_CONFIGS.map((config) => (
          <KindCard key={config.kind} config={config} versions={overview.data[config.kind]} />
        ))}
    </div>
  );
}

import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ErrorSummary } from '@/form/error-summary';
import { NotFoundPage } from '@/not-found-page';
import { ApiError, legalApi } from '@/lib/api';
import type { ValidationIssue } from '@/lib/api-types';
import { configOfSlug, LEGAL_ROOT, type LegalKindConfig, suggestLegalVersion } from './kinds';
import { invalidateLegal, useLegalOverview } from './queries';

const BLANK = '__em-branco__';

/** A página do rascunho novo de um texto (`/textos-legais/:texto/novo`). */
export function LegalNewPage() {
  const { kind: slug } = useParams();
  const config = configOfSlug(slug);
  if (config === undefined) return <NotFoundPage />;
  return <NewDraft key={config.kind} config={config} />;
}

/**
 * O rascunho novo: a versão (sugerida pelo dia de hoje) e o ponto de partida, que por padrão é a cópia da vigente; ou
 * outra versão, ou em branco. O texto se escreve (ou se importa de um arquivo) na página do rascunho, depois de criado.
 */
function NewDraft({ config }: { config: LegalKindConfig }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const ids = useId();
  const overview = useLegalOverview();
  const versions = overview.data?.[config.kind];
  const current = versions?.find((entry) => entry.current)?.version;
  const defaultSource = params.get('de') ?? current ?? BLANK;
  const [chosenSource, setChosenSource] = useState<string | undefined>(undefined);
  const source = chosenSource ?? defaultSource;
  const [version, setVersion] = useState<string | undefined>(undefined);
  const versionValue = version ?? suggestLegalVersion(versions?.map((entry) => entry.version) ?? []);
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [error, setError] = useState<unknown>(undefined);
  const [saving, setSaving] = useState(false);
  const versionIssues = issues.filter((issue) => issue.path === 'version').map((issue) => issue.message);

  async function create(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await legalApi.create(config.kind, {
        version: versionValue,
        ...(source === BLANK ? {} : { from: source }),
      });
      await invalidateLegal(client);
      await navigate(`${config.basePath}/${encodeURIComponent(versionValue)}`, { state: { created: true } });
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length > 0) setIssues(caught.issues);
      else {
        setIssues([]);
        setError(caught);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm">
          <Link to={LEGAL_ROOT} className="text-primary underline-offset-2 hover:underline">
            Textos legais
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Novo rascunho: {config.title}</h1>
      </header>

      {overview.isPending && <LoadingState label="Carregando as versões" />}
      {overview.isError && <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />}
      <ErrorSummary issues={issues} />
      {error !== undefined && <ErrorState error={error} />}

      {versions !== undefined && (
        <section
          className="grid max-w-3xl gap-4 rounded-xl border bg-surface p-4 sm:grid-cols-2"
          aria-label="Versão e ponto de partida"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor="campo-version" className="text-sm font-medium">
              Versão
            </label>
            <input
              id="campo-version"
              className="h-9 rounded-md border border-border-strong bg-surface-raised px-3 font-mono text-sm aria-invalid:border-critical"
              value={versionValue}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={versionIssues.length > 0 || undefined}
              aria-describedby={`${ids}-versao-dica${versionIssues.length > 0 ? ` ${ids}-versao-erro` : ''}`}
              onChange={(event) => setVersion(event.target.value)}
            />
            <p id={`${ids}-versao-dica`} className="text-xs text-muted-foreground">
              Minúsculas, números e traço (ex.: 2026-11-10). É o que o cliente vê no aceite do checkout.
            </p>
            {versionIssues.length > 0 && (
              <p id={`${ids}-versao-erro`} className="text-xs text-critical-text">
                {versionIssues.join(' · ')}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-origem`} className="text-sm font-medium">
              Começar de
            </label>
            <select
              id={`${ids}-origem`}
              className="h-9 rounded-md border border-border-strong bg-surface-raised px-2 text-sm"
              value={source}
              onChange={(event) => setChosenSource(event.target.value)}
            >
              {versions.map((entry) => (
                <option key={entry.version} value={entry.version}>
                  {`Cópia de ${entry.version}${entry.current ? ' (vigente)' : entry.status === 'draft' ? ' (rascunho)' : ''}`}
                </option>
              ))}
              <option value={BLANK}>Em branco</option>
            </select>
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void create()} disabled={saving || versions === undefined}>
          {saving ? 'Criando…' : 'Criar rascunho'}
        </Button>
        <Link to={LEGAL_ROOT} className="text-sm text-primary underline-offset-2 hover:underline">
          Cancelar
        </Link>
      </div>
    </div>
  );
}

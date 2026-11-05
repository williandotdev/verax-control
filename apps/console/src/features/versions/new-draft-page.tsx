import { useQueryClient } from '@tanstack/react-query';
import { type ComponentType, useId, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DraftForm } from '@/form/draft-form';
import { ErrorSummary } from '@/form/error-summary';
import { FormErrorBoundary } from '@/form/form-error-boundary';
import { ApiError, api } from '@/lib/api';
import type { ValidationIssue } from '@/lib/api-types';
import { ImportError, readJsonContent } from './json-file';
import { type KindConfig, suggestVersion } from './kinds';
import { invalidateVersions, useVersion, useVersions } from './queries';
import { shapeIssues } from './shape';

const BLANK = '__em-branco__';
const IMPORTED = '__arquivo__';

/**
 * O rascunho novo: a versão (sugerida `AAAA-MM-vN`) e o ponto de partida, que por padrão é a cópia da vigente
 * ("clonar a vigente"); também outra versão, o esqueleto em branco ou um arquivo JSON do responsável. O conteúdo fica
 * só na tela até "Criar rascunho": a API valida tudo e devolve os problemas por campo.
 */
export function NewDraftPage({ config, Form }: { config: KindConfig; Form: ComponentType }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const versions = useVersions(config.kind);
  const ids = useId();
  const current = versions.data?.find((entry) => entry.current)?.version;
  const requested = params.get('de');
  const defaultSource = requested ?? current ?? (versions.data === undefined ? undefined : BLANK);

  const [chosenSource, setChosenSource] = useState<string | undefined>(undefined);
  const source = chosenSource ?? defaultSource;
  const sourceRecord = useVersion(
    config.kind,
    source === undefined || source === BLANK || source === IMPORTED ? undefined : source,
  );

  const [version, setVersion] = useState<string | undefined>(undefined);
  const suggested = suggestVersion(versions.data?.map((entry) => entry.version) ?? []);
  const versionValue = version ?? suggested;

  const [draft, setDraft] = useState<unknown>(undefined);
  const [loadedFrom, setLoadedFrom] = useState<string | undefined>(undefined);
  // O ponto de partida mudou (ou acabou de carregar): o rascunho na tela passa a ser a cópia dele.
  if (source !== undefined && source !== loadedFrom && source !== IMPORTED) {
    if (source === BLANK) {
      setLoadedFrom(source);
      setDraft(config.blank());
    } else if (sourceRecord.data !== undefined && sourceRecord.data.version === source) {
      setLoadedFrom(source);
      setDraft(structuredClone(sourceRecord.data.content));
    }
  }

  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  /** Os problemas vêm do arquivo importado (conferidos na tela) ou da API (na gravação). */
  const [issuesFromImport, setIssuesFromImport] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const versionIssues = issues.filter((issue) => issue.path === 'version').map((issue) => issue.message);

  async function create(): Promise<void> {
    setSaving(true);
    setError(undefined);
    try {
      await api.create(config.kind, versionValue, draft);
      await invalidateVersions(client);
      await navigate(`${config.basePath}/${encodeURIComponent(versionValue)}`, {
        state: { created: true },
      });
    } catch (caught) {
      setIssuesFromImport(false);
      if (caught instanceof ApiError && caught.issues.length > 0) setIssues(caught.issues);
      else {
        setIssues([]);
        setError(caught);
      }
    } finally {
      setSaving(false);
    }
  }

  async function importFile(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    setImportError(undefined);
    try {
      const content = await readJsonContent(file);
      setDraft(content);
      setChosenSource(IMPORTED);
      setLoadedFrom(IMPORTED);
      setIssues(shapeIssues(config.kind, content));
      setIssuesFromImport(true);
    } catch (caught) {
      setImportError(caught instanceof ImportError ? caught.message : 'Não foi possível ler o arquivo.');
    }
  }

  const sourceOptions = [
    ...(versions.data ?? []).map((entry) => ({
      value: entry.version,
      label: `Cópia de ${entry.version}${entry.current ? ' (vigente)' : ''}`,
    })),
    { value: BLANK, label: 'Em branco (só a forma)' },
    ...(source === IMPORTED ? [{ value: IMPORTED, label: 'Arquivo importado' }] : []),
  ];

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm">
          <Link to={config.basePath} className="text-primary underline-offset-2 hover:underline">
            {config.title}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">Novo rascunho: {config.singular}</h1>
      </header>

      {versions.isError && <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />}

      <section
        className="grid gap-4 rounded-xl border bg-surface p-4 sm:grid-cols-3"
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
            Minúsculas, números e traço (ex.: 2026-11-v1). É também o nome do documento.
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
            value={source ?? ''}
            onChange={(event) => {
              setChosenSource(event.target.value);
              setIssues([]);
            }}
          >
            {source === undefined && <option value="">Carregando…</option>}
            {sourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={`${ids}-arquivo`} className="text-sm font-medium">
            Ou importar um arquivo JSON
          </label>
          <input
            id={`${ids}-arquivo`}
            type="file"
            accept="application/json,.json"
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface-raised file:px-3 file:py-1.5"
            aria-describedby={`${ids}-arquivo-dica`}
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
          <p id={`${ids}-arquivo-dica`} className="text-xs text-muted-foreground">
            O exportado de uma versão, ou o seu arquivo com os números (fora do repositório).
          </p>
          {importError !== undefined && (
            <p role="alert" className="text-xs text-critical-text">
              {importError}
            </p>
          )}
        </div>
      </section>

      <ErrorSummary
        issues={issues}
        {...(issuesFromImport
          ? {
              title:
                'O arquivo importado não tem a forma esperada: corrija ou tire os itens apontados antes de gravar.',
            }
          : {})}
      />
      {error !== undefined && <ErrorState error={error} />}
      {sourceRecord.isError && <ErrorState error={sourceRecord.error} />}

      {draft === undefined ? (
        <LoadingState label="Preparando o rascunho" />
      ) : (
        <FormErrorBoundary
          onReset={() => {
            setChosenSource(BLANK);
            setLoadedFrom(undefined);
            setIssues([]);
          }}
        >
          <DraftForm value={draft} onChange={setDraft} issues={issues} readOnly={false}>
            <Form />
          </DraftForm>
        </FormErrorBoundary>
      )}

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t bg-background/95 py-3">
        <Button onClick={() => void create()} disabled={saving || draft === undefined}>
          {saving ? 'Criando…' : 'Criar rascunho'}
        </Button>
        <Link to={config.basePath} className="text-sm text-primary underline-offset-2 hover:underline">
          Cancelar
        </Link>
      </div>
    </div>
  );
}

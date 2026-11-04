import { useQueryClient } from '@tanstack/react-query';
import { Download, FilePlus2, Upload } from 'lucide-react';
import { type ComponentType, type ReactNode, useId, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { CurrentBadge, StatusBadge } from '@/components/badges';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { DraftForm } from '@/form/draft-form';
import { ErrorSummary } from '@/form/error-summary';
import { ApiError, api } from '@/lib/api';
import type { PublishCheck, ValidationIssue, VersionedRecord } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { formatInteger, formatRatio } from '@/lib/numbers';
import { downloadJson, ImportError, readJsonContent } from './json-file';
import type { KindConfig } from './kinds';
import { PublishPanel } from './publish-panel';
import { invalidateVersions, useVersion, useVersions } from './queries';

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  );
}

function PublishCheckSummary({ check }: { check: PublishCheck }) {
  return (
    <p className="text-sm">
      Checagem na publicação ({formatDateTime(check.at)}): {check.ok ? 'aprovada' : 'reprovada'}, tabela{' '}
      {check.priceTableVersion} com o modelo {check.costModelVersion};{' '}
      {formatInteger(check.checkedConfigurations)} configurações conferidas,{' '}
      {formatInteger(check.belowMinimum)} abaixo da mínima e {formatInteger(check.belowAlert)} abaixo do
      alerta
      {check.worstMargin === null ? '' : `; pior margem ${formatRatio(check.worstMargin)}`}.
    </p>
  );
}

function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Uma versão: o cabeçalho (situação, vigência, quem publicou e editou), o formulário (editável só no rascunho), salvar
 * e descartar, exportar e importar o JSON, o rascunho novo a partir dela e, no rascunho salvo, as ações do tipo (a
 * checagem da tabela de preços) e a publicação.
 */
export function VersionEditorPage({
  config,
  Form,
  Actions,
}: {
  config: KindConfig;
  Form: ComponentType;
  /** Ações a mais no rascunho (a tabela de preços tem a checagem); recebem por que estão bloqueadas, se estiverem. */
  Actions?: ComponentType<{ version: string; blockedReason?: string }>;
}) {
  const { version = '' } = useParams();
  const location = useLocation();
  const client = useQueryClient();
  const ids = useId();
  const versions = useVersions(config.kind);
  const record = useVersion(config.kind, version);
  const [draft, setDraft] = useState<unknown>(undefined);
  const [base, setBase] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(
    (location.state as { created?: boolean } | null)?.created === true ? 'Rascunho criado.' : undefined,
  );
  const [saving, setSaving] = useState(false);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [publishedHere, setPublishedHere] = useState(false);

  // A versão carregou ou mudou no servidor (outra gravação, a publicação): o formulário volta a ela.
  const stamp = record.data === undefined ? undefined : `${record.data.version}@${record.data.updatedAt}`;
  if (record.data !== undefined && stamp !== base) {
    setBase(stamp);
    setDraft(structuredClone(record.data.content));
    setIssues([]);
  }

  if (record.isPending) return <LoadingState label="Carregando a versão" />;
  if (record.isError) {
    return (
      <div className="space-y-3">
        <BackLink config={config} />
        <ErrorState error={record.error} onRetry={() => void record.refetch()} />
      </div>
    );
  }
  const data = record.data;
  const editable = data.status === 'draft';
  const dirty = editable && !sameContent(draft, data.content);
  const current = versions.data?.find((entry) => entry.version === data.version)?.current === true;

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(undefined);
    setNotice(undefined);
    try {
      const saved = await api.update(config.kind, version, draft);
      client.setQueryData<VersionedRecord<unknown>>(['version', config.kind, version], saved);
      await invalidateVersions(client);
      setIssues([]);
      setNotice('Rascunho salvo.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length > 0) setIssues(caught.issues);
      else setSaveError(caught);
    } finally {
      setSaving(false);
    }
  }

  async function importFile(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    setImportError(undefined);
    try {
      setDraft(await readJsonContent(file));
      setIssues([]);
      setNotice('Arquivo importado no formulário: confira e salve.');
    } catch (caught) {
      setImportError(caught instanceof ImportError ? caught.message : 'Não foi possível ler o arquivo.');
    }
  }

  const blockedReason = dirty ? 'Salve as alterações antes de conferir ou publicar.' : undefined;
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <BackLink config={config} />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">
            <span className="sr-only">{config.title}: </span>
            <span className="font-mono">{data.version}</span>
          </h1>
          <StatusBadge status={data.status} />
          {current && <CurrentBadge />}
        </div>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Vigência">
            {data.effectiveFrom === undefined ? '—' : formatDateTime(data.effectiveFrom)}
            {data.retiredAt !== undefined && ` até ${formatDateTime(data.retiredAt)}`}
          </Meta>
          <Meta label="Publicada">
            {data.publishedAt === undefined
              ? '—'
              : `${formatDateTime(data.publishedAt)} por ${data.publishedBy ?? '—'}`}
          </Meta>
          <Meta label="Criada">{`${formatDateTime(data.createdAt)} por ${data.createdBy}`}</Meta>
          <Meta label="Última edição">{`${formatDateTime(data.updatedAt)} por ${data.updatedBy}`}</Meta>
          {data.supersededBy !== undefined && (
            <Meta label="Substituída por">
              <Link
                to={`${config.basePath}/${data.supersededBy}`}
                className="font-mono text-primary underline-offset-2 hover:underline"
              >
                {data.supersededBy}
              </Link>
            </Meta>
          )}
        </dl>
        {data.publishCheck !== undefined && <PublishCheckSummary check={data.publishCheck} />}
        <div className="flex flex-wrap gap-2">
          <Link
            to={`${config.basePath}/novo?de=${encodeURIComponent(data.version)}`}
            className={buttonVariants({ variant: 'secondary', size: 'sm' })}
          >
            <FilePlus2 aria-hidden />
            Novo rascunho a partir desta versão
          </Link>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              downloadJson(`${config.kind}-${data.version}.json`, { version: data.version, content: draft })
            }
          >
            <Download aria-hidden />
            Exportar JSON
          </Button>
          {editable && (
            <label
              htmlFor={`${ids}-importar`}
              className={buttonVariants({
                variant: 'secondary',
                size: 'sm',
                className: 'cursor-pointer focus-within:outline-2 focus-within:outline-ring',
              })}
            >
              <Upload aria-hidden />
              Importar JSON
              <input
                id={`${ids}-importar`}
                type="file"
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) => void importFile(event.target.files?.[0])}
              />
            </label>
          )}
        </div>
        {importError !== undefined && (
          <p role="alert" className="text-sm text-critical-text">
            {importError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          O arquivo exportado tem os valores desta versão: guarde fora do repositório, que é público.
        </p>
        {!editable && (
          <p className="text-sm">
            Versão {data.status === 'published' ? 'publicada' : 'aposentada'}: não muda mais. Para ajustar,
            crie um rascunho novo a partir dela.
          </p>
        )}
      </header>

      <ErrorSummary issues={issues} />
      {saveError !== undefined && <ErrorState error={saveError} />}
      {notice !== undefined && (
        <p role="status" className="text-sm font-medium">
          {notice}
        </p>
      )}

      {draft !== undefined && (
        <DraftForm value={draft} onChange={setDraft} issues={issues} readOnly={!editable}>
          <Form />
        </DraftForm>
      )}

      {editable && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t bg-background/95 py-3">
          <Button onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Salvando…' : 'Salvar rascunho'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(structuredClone(data.content));
              setIssues([]);
            }}
            disabled={!dirty || saving}
          >
            Descartar alterações
          </Button>
          <span className="text-sm text-muted-foreground" aria-live="polite">
            {dirty ? 'Alterações não salvas.' : 'Tudo salvo.'}
          </span>
        </div>
      )}

      {editable && Actions !== undefined && <Actions version={data.version} blockedReason={blockedReason} />}
      {(editable || publishedHere) && (
        <PublishPanel
          config={config}
          version={data.version}
          blockedReason={blockedReason}
          canPublish={editable}
          onPublished={() => setPublishedHere(true)}
        />
      )}
    </div>
  );
}

function BackLink({ config }: { config: KindConfig }) {
  return (
    <p className="text-sm">
      <Link to={config.basePath} className="text-primary underline-offset-2 hover:underline">
        {config.title}
      </Link>
    </p>
  );
}

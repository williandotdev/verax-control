import { useQueryClient } from '@tanstack/react-query';
import { Download, FilePlus2, Upload } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { CurrentBadge, StatusBadge } from '@/components/badges';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { ErrorSummary } from '@/form/error-summary';
import { ApiError, legalApi } from '@/lib/api';
import type { LegalTextRecord, LegalVersionSummary, ValidationIssue } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { NotFoundPage } from '@/not-found-page';
import {
  configOfSlug,
  formatBytes,
  LEGAL_ROOT,
  type LegalKindConfig,
  MAX_LEGAL_TEXT_BYTES,
  textBytes,
} from './kinds';
import { MarkdownPreview } from './markdown';
import { downloadMarkdown, MarkdownImportError, readMarkdownFile } from './markdown-file';
import { invalidateLegal, useLegalOverview, useLegalText } from './queries';

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm tabular-nums">{children}</dd>
    </div>
  );
}

/** A página de uma versão de um texto (`/textos-legais/:texto/:versao`). */
export function LegalEditorPage() {
  const { kind: slug, version } = useParams();
  const config = configOfSlug(slug);
  if (config === undefined || version === undefined) return <NotFoundPage />;
  return <Editor key={`${config.kind}/${version}`} config={config} version={version} />;
}

/**
 * Uma versão de um texto legal: o cabeçalho (situação, quem publicou e editou, o hash do publicado), o texto em
 * Markdown ao lado da prévia, salvar e descartar, exportar e importar o arquivo `.md`, o rascunho novo a partir dela e,
 * no rascunho salvo, a publicação. A gravação leva a revisão lida (`updatedAt`): se o rascunho mudou em outra aba, a API
 * recusa (`draft_changed`) e a página oferece recarregar.
 */
function Editor({ config, version }: { config: LegalKindConfig; version: string }) {
  const location = useLocation();
  const client = useQueryClient();
  const ids = useId();
  const record = useLegalText(config.kind, version);
  const overview = useLegalOverview();
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [base, setBase] = useState<string | undefined>(undefined);
  const [issues, setIssues] = useState<readonly ValidationIssue[]>([]);
  const [saveError, setSaveError] = useState<unknown>(undefined);
  const [notice, setNotice] = useState<string | undefined>(
    (location.state as { created?: boolean } | null)?.created === true ? 'Rascunho criado.' : undefined,
  );
  const [saving, setSaving] = useState(false);
  const [importError, setImportError] = useState<string | undefined>(undefined);
  const [publishedHere, setPublishedHere] = useState(false);

  // A versão carregou ou mudou no servidor (outra gravação, a publicação): o texto na tela volta a ela.
  const stamp = record.data === undefined ? undefined : `${record.data.version}@${record.data.updatedAt}`;
  if (record.data !== undefined && stamp !== base) {
    setBase(stamp);
    setDraft(record.data.content);
    setIssues([]);
  }

  if (record.isPending) return <LoadingState label="Carregando o texto" />;
  if (record.isError) {
    return (
      <div className="space-y-3">
        <BackLink />
        <ErrorState error={record.error} onRetry={() => void record.refetch()} />
      </div>
    );
  }
  const data = record.data;
  const text = draft ?? data.content;
  const editable = data.status === 'draft';
  const dirty = editable && text !== data.content;
  const current =
    overview.data?.[config.kind].find((entry) => entry.version === data.version)?.current === true;
  const bytes = textBytes(text);
  const tooBig = bytes > MAX_LEGAL_TEXT_BYTES;
  const contentIssues = issues.filter((issue) => issue.path === 'content').map((issue) => issue.message);
  const draftChanged = saveError instanceof ApiError && saveError.code === 'draft_changed';

  async function save(): Promise<void> {
    setSaving(true);
    setSaveError(undefined);
    setNotice(undefined);
    try {
      const submitted = text;
      const saved = await legalApi.update(config.kind, version, {
        content: submitted,
        expectedUpdatedAt: data.updatedAt,
      });
      // O que foi digitado durante a gravação fica na tela (e segue sem salvar): só o texto enviado vira o salvo. A base
      // muda antes do cache, para a sincronização acima não trocar o editor pelo texto gravado.
      setBase(`${saved.version}@${saved.updatedAt}`);
      setDraft((now) => (now === undefined || now === submitted ? saved.content : now));
      client.setQueryData<LegalTextRecord>(['legal-text', config.kind, version], saved);
      await invalidateLegal(client);
      setIssues([]);
      setNotice('Rascunho salvo.');
    } catch (caught) {
      if (caught instanceof ApiError && caught.issues.length > 0) setIssues(caught.issues);
      else setSaveError(caught);
    } finally {
      setSaving(false);
    }
  }

  /** Depois do `draft_changed`: relê o rascunho salvo e descarta o que está na tela. */
  async function reload(): Promise<void> {
    setSaveError(undefined);
    setBase(undefined);
    await record.refetch();
  }

  async function importFile(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    setImportError(undefined);
    try {
      setDraft(await readMarkdownFile(file));
      setIssues([]);
      setNotice('Arquivo importado no editor: confira a prévia e salve.');
    } catch (caught) {
      setImportError(
        caught instanceof MarkdownImportError ? caught.message : 'Não foi possível ler o arquivo.',
      );
    }
  }

  const blockedReason = dirty
    ? 'Salve as alterações antes de publicar.'
    : data.content.trim() === ''
      ? 'O texto está em branco: escreva ou importe o arquivo e salve antes de publicar.'
      : undefined;
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">
            {config.title}: <span className="font-mono">{data.version}</span>
          </h1>
          <StatusBadge status={data.status} />
          {current && <CurrentBadge />}
        </div>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Publicada">
            {data.publishedAt === undefined
              ? '—'
              : `${formatDateTime(data.publishedAt)} por ${data.publishedBy ?? '—'}`}
          </Meta>
          <Meta label="Criada">
            {`${formatDateTime(data.createdAt)} por ${data.createdBy}`}
            {data.basedOn !== undefined && ` (cópia de ${data.basedOn})`}
          </Meta>
          <Meta label="Última edição">{`${formatDateTime(data.updatedAt)} por ${data.updatedBy}`}</Meta>
          {data.contentSha256 !== undefined && (
            <Meta label="SHA-256 do texto publicado">
              <span className="font-mono text-xs break-all">{data.contentSha256}</span>
            </Meta>
          )}
        </dl>
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
            onClick={() => downloadMarkdown(`${config.kind}-${data.version}.md`, text)}
          >
            <Download aria-hidden />
            Exportar .md
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
              Importar .md
              <input
                id={`${ids}-importar`}
                type="file"
                accept=".md,text/markdown,text/plain"
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
        {!editable && (
          <p className="text-sm">
            Versão publicada: não muda mais (é o que os clientes aceitaram). Para ajustar, crie um rascunho
            novo a partir dela.
          </p>
        )}
      </header>

      <ErrorSummary issues={issues} />
      {saveError !== undefined && <ErrorState error={saveError} />}
      {draftChanged && (
        <Button variant="secondary" onClick={() => void reload()}>
          Recarregar o rascunho salvo (descarta o que está na tela)
        </Button>
      )}
      {notice !== undefined && (
        <p role="status" className="text-sm font-medium">
          {notice}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="campo-content" className="text-sm font-medium">
            Texto (Markdown)
          </label>
          <textarea
            id="campo-content"
            className="min-h-[28rem] w-full rounded-md border border-border-strong bg-surface-raised p-3 font-mono text-sm leading-relaxed read-only:bg-surface aria-invalid:border-critical"
            value={text}
            readOnly={!editable}
            spellCheck
            lang="pt-BR"
            aria-invalid={contentIssues.length > 0 || tooBig || undefined}
            aria-describedby={`${ids}-tamanho${contentIssues.length > 0 ? ` ${ids}-texto-erro` : ''}`}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p
            id={`${ids}-tamanho`}
            className={tooBig ? 'text-xs text-critical-text' : 'text-xs text-muted-foreground'}
          >
            {formatBytes(bytes)} de {formatBytes(MAX_LEGAL_TEXT_BYTES)}
            {tooBig ? ': acima do teto, a API recusa.' : '.'} Títulos com #, listas com - ou 1., negrito com
            **, links com [texto](https://...).
          </p>
          {contentIssues.length > 0 && (
            <p id={`${ids}-texto-erro`} className="text-xs text-critical-text">
              {contentIssues.join(' · ')}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <h2 id={`${ids}-previa`} className="text-sm font-medium">
            Prévia
          </h2>
          <div
            role="region"
            aria-labelledby={`${ids}-previa`}
            tabIndex={0}
            className="max-h-[36rem] min-h-[28rem] overflow-auto rounded-md border bg-surface p-4"
          >
            {text.trim() === '' ? (
              <p className="text-sm text-muted-foreground">O texto está em branco.</p>
            ) : (
              <MarkdownPreview source={text} />
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            A prévia mostra o Markdown básico; o site desenha o mesmo texto com o estilo dele.
          </p>
        </div>
      </div>

      {editable && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t bg-background/95 py-3">
          <Button onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? 'Salvando…' : 'Salvar rascunho'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDraft(data.content);
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

      {(editable || publishedHere) && (
        <LegalPublishPanel
          config={config}
          record={data}
          blockedReason={blockedReason}
          canPublish={editable}
          onPublished={() => setPublishedHere(true)}
        />
      )}
    </div>
  );
}

/**
 * Publicar o rascunho salvo: a confirmação fica aberta na própria página (sem janela modal), com a versão digitada de
 * novo; a API confere a versão e a revisão. Publicada, a versão vira a vigente na hora.
 */
function LegalPublishPanel({
  config,
  record,
  blockedReason,
  canPublish,
  onPublished,
}: {
  config: LegalKindConfig;
  record: LegalTextRecord;
  blockedReason?: string;
  canPublish: boolean;
  onPublished: () => void;
}) {
  const ids = useId();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<LegalVersionSummary | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const matches = typed === record.version;

  async function publish(): Promise<void> {
    if (blockedReason !== undefined || busy || !matches) return;
    setBusy(true);
    setError(undefined);
    try {
      const published = await legalApi.publish(config.kind, record.version, {
        expectedUpdatedAt: record.updatedAt,
        confirmVersion: typed,
      });
      setResult(published);
      setOpen(false);
      onPublished();
      await invalidateLegal(client);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby={`${ids}-titulo`} className="space-y-3 rounded-xl border bg-surface p-4">
      <h2 id={`${ids}-titulo`} className="text-base font-semibold">
        Publicar
      </h2>
      {canPublish && (
        <p className="text-sm text-muted-foreground">
          Publicada, a versão não muda mais e vira a vigente na hora: o site passa a mostrar este texto em{' '}
          <span className="font-mono">{config.sitePath}</span> (em até 5 minutos, pelo cache) e o checkout
          passa a exigir o aceite dela. Quem já é cliente continua com a versão que aceitou.
        </p>
      )}
      {canPublish && blockedReason !== undefined && <p className="text-sm font-medium">{blockedReason}</p>}
      {canPublish && !open && (
        <Button onClick={() => setOpen(true)} disabled={blockedReason !== undefined}>
          Publicar…
        </Button>
      )}
      {canPublish && open && (
        <div className="space-y-3 rounded-lg border border-border-strong p-3">
          <div className="flex max-w-sm flex-col gap-1">
            <label htmlFor={`${ids}-confirmar`} className="text-sm font-medium">
              Digite a versão <span className="font-mono">{record.version}</span> para confirmar
            </label>
            <input
              id={`${ids}-confirmar`}
              className="h-9 w-full rounded-md border border-border-strong bg-surface-raised px-3 font-mono text-sm"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(event) => setTyped(event.target.value.trim())}
              aria-describedby={`${ids}-dica`}
            />
            <p id={`${ids}-dica`} className="text-xs text-muted-foreground">
              {matches ? 'Confere.' : 'O botão libera quando o texto for igual à versão.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void publish()} disabled={busy || !matches || blockedReason !== undefined}>
              {busy ? 'Publicando…' : 'Confirmar a publicação'}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancelar
            </Button>
          </div>
        </div>
      )}
      {result !== undefined && (
        <p role="status" className="font-medium">
          Publicada: {result.version}, em {formatDateTime(result.publishedAt)}. É a vigente de{' '}
          {config.title.toLowerCase()}.
        </p>
      )}
      {error !== undefined && <ErrorState error={error} />}
    </section>
  );
}

function BackLink() {
  return (
    <p className="text-sm">
      <Link to={LEGAL_ROOT} className="text-primary underline-offset-2 hover:underline">
        Textos legais
      </Link>
    </p>
  );
}

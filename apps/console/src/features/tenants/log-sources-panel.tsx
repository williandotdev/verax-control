import {
  Archive,
  CircleCheck,
  CircleX,
  Clock,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { logSourcesApi } from '@/lib/api';
import type {
  LogSourceSpec,
  LogSourceStatus,
  LogSourceView,
  NodeSyncOverview,
  NodeSyncView,
  TenantDetail,
} from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { formatDateTime, formatDay, plural } from '@/lib/format';
import { ConfirmBySlug } from './confirm-by-slug';
import { AddSourceForm, CredentialForm, EditSourceForm, type WriteDone } from './log-source-forms';
import { SourceInstructions } from './log-source-instructions';
import {
  ACCOUNT_LABELS,
  BUCKET_LABELS,
  BUCKET_SOURCES,
  COLLECTION_ERROR_LABELS,
  CONNECTION_LABELS,
  CREDENTIAL_KIND_LABELS,
  logSourceErrorMessage,
  NODE_ERROR_MESSAGES,
  PLATFORM_LABELS,
  PROVIDER_CREDENTIAL_KINDS,
  PROVIDER_LABELS,
  SOURCE_CODE_MESSAGES,
  SOURCE_STATUS_LABELS,
} from './log-source-labels';
import { useClipboard } from './log-source-messages';
import { useInvalidateNodeSync, useNodeSync } from './queries';

/** A primeira versão do nó que sincroniza com a Verax. */
const SYNC_RELEASE = 'node-v1.2.0';

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/** A impressão digital curta (os 16 primeiros hexadecimais, de 4 em 4), como o painel do cliente mostra o começo. */
function shortFingerprint(fingerprint: string): string {
  return `${(fingerprint.slice(0, 16).match(/.{1,4}/g) ?? []).join(' ')}…`;
}

type Tone = 'waiting' | 'warning' | 'ok';

const TONE_ICONS: Readonly<Record<Tone, ReactNode>> = {
  waiting: <Clock aria-hidden className="size-4 text-subtle-foreground" />,
  warning: <TriangleAlert aria-hidden className="size-4 text-high" />,
  ok: <CircleCheck aria-hidden className="size-4 text-ok" />,
};

function syncSituation(overview: NodeSyncOverview): { tone: Tone; title: string; detail: ReactNode } {
  const node = overview.node;
  if (node === null) {
    return {
      tone: 'waiting',
      title: 'O servidor do cliente ainda não se comunicou com a Verax',
      detail: (
        <>
          A sincronização chega com a versão <span className="font-mono">{SYNC_RELEASE}</span> do servidor (ou
          mais nova).{' '}
          {overview.hosting === 'verax' ? (
            <>
              Promova a versão para este cliente em{' '}
              <Link to="/versoes" className="text-primary underline underline-offset-2">
                Versões
              </Link>
              .
            </>
          ) : (
            'Peça ao cliente para atualizar o servidor na VM dele.'
          )}{' '}
          Até lá, as fontes cadastradas aqui esperam a primeira sincronização, e a chave não pode ser enviada
          daqui (o cliente pode colá-la no painel dele).
        </>
      ),
    };
  }
  if (node.stale) {
    return {
      tone: 'warning',
      title: 'O servidor do cliente não se comunica há mais de 15 minutos',
      detail: `Última sincronização: ${formatDateTime(node.lastSeenAt)}. Ele sincroniza a cada 5 minutos: confira se o servidor está no ar. As mudanças daqui esperam a próxima sincronização.`,
    };
  }
  return {
    tone: 'ok',
    title: 'Servidor sincronizado',
    detail: `Última sincronização: ${formatDateTime(node.lastSeenAt)}. Ele sincroniza a cada 5 minutos.`,
  };
}

function NodeDetails({ node }: { node: NodeSyncView }) {
  const clip = useClipboard();
  return (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Meta label="Última sincronização">{formatDateTime(node.lastSeenAt)}</Meta>
        <Meta label="Plataforma">{PLATFORM_LABELS[node.platform]}</Meta>
        <Meta label="Versão (commit)">
          <span className="font-mono">{node.commit.slice(0, 7)}</span>
        </Meta>
        <Meta label="Cofre de credenciais">
          {node.vaultReady
            ? `Pronto${node.keyVersion === null ? '' : ` (chave ${node.keyVersion})`}`
            : 'Sem o cofre: a chave não pode ser enviada daqui'}
        </Meta>
      </dl>
      {node.fingerprint !== null && (
        <div className="space-y-1">
          <dl className="flex flex-wrap items-center gap-2">
            <dt className="text-xs text-muted-foreground">Impressão digital da chave do cofre</dt>
            <dd className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{shortFingerprint(node.fingerprint)}</span>
              {clip.available && (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label="Copiar: impressão digital completa"
                  onClick={() => void clip.copy('impressão digital', node.fingerprint ?? '')}
                >
                  Copiar
                </Button>
              )}
              <span role="status" className="text-xs text-muted-foreground">
                {clip.status}
              </span>
            </dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            O painel do cliente mostra a mesma: é a chave para a qual o console cifra as chaves coladas aqui.
          </p>
        </div>
      )}
      {node.platformMismatch && (
        <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          O servidor informou a plataforma {PLATFORM_LABELS[node.platform]}, que não é a do lugar deste
          cliente: nenhuma chave é enviada daqui até conferir a instalação.
        </div>
      )}
      {node.error !== null && (
        <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          {NODE_ERROR_MESSAGES[node.error]}
        </div>
      )}
    </div>
  );
}

function NodeSyncStatus({ overview }: { overview: NodeSyncOverview }) {
  const situation = syncSituation(overview);
  return (
    <div className="space-y-3">
      <div
        role="group"
        aria-label="Situação da sincronização"
        className={cn(
          'flex items-start gap-2 rounded-lg border p-3 text-sm',
          situation.tone === 'warning' && 'border-high/60 bg-high/10',
        )}
      >
        <span className="mt-0.5">{TONE_ICONS[situation.tone]}</span>
        <div className="space-y-0.5">
          <p className="font-medium">{situation.title}</p>
          <p className="text-muted-foreground">{situation.detail}</p>
        </div>
      </div>
      {overview.node !== null && <NodeDetails node={overview.node} />}
    </div>
  );
}

const STATUS_ICONS: Readonly<Record<LogSourceStatus, ReactNode>> = {
  pending: <Clock aria-hidden className="size-3.5" />,
  applied: <CircleCheck aria-hidden className="size-3.5 text-ok" />,
  failed: <CircleX aria-hidden className="size-3.5 text-critical" />,
  removing: <LoaderCircle aria-hidden className="size-3.5" />,
  removed: <Archive aria-hidden className="size-3.5 text-subtle-foreground" />,
};

/** A situação da fonte, sempre com ícone e texto (nunca só a cor). */
function SourceStatusBadge({ status }: { status: LogSourceStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        status === 'failed' && 'border-critical/50 bg-critical/5 text-critical-text',
      )}
    >
      {STATUS_ICONS[status]}
      {SOURCE_STATUS_LABELS[status]}
    </span>
  );
}

/** O que a fonte cobre, em poucas palavras. */
function scopeText(spec: LogSourceSpec): string {
  switch (spec.provider) {
    case 'aws': {
      const buckets = BUCKET_SOURCES.filter((source) => typeof spec.buckets?.[source] === 'string').length;
      return `${plural(spec.regions.length, 'região', 'regiões')}, ${buckets === 0 ? 'sem bucket' : plural(buckets, 'bucket', 'buckets')}`;
    }
    case 'cloudflare':
      return spec.zones === undefined || spec.zones.length === 0
        ? 'Nenhuma zona'
        : plural(spec.zones.length, 'zona', 'zonas');
    case 'gcp':
      return typeof spec.pubsubSubscription === 'string' ? 'Assinatura do Pub/Sub' : 'Sem assinatura';
  }
}

/** A situação, com o motivo da falha (curto, na tabela) ou o que espera. */
function statusNote(source: LogSourceView): string | undefined {
  if (source.status === 'failed' && source.code !== null) return SOURCE_CODE_MESSAGES[source.code].message;
  if (source.status === 'pending') return 'O servidor aplica na próxima sincronização.';
  if (source.status === 'removing') return 'O servidor desativa a conta na próxima sincronização.';
  return undefined;
}

/** A chave da fonte: a enviada daqui (metadados) e a que vale no servidor (a daqui ou a colada no painel). */
function credentialLines(source: LogSourceView, overview: NodeSyncOverview): string[] {
  const lines: string[] = [];
  const sent = source.credential;
  const reported = source.report?.credential ?? null;
  if (sent !== null) {
    lines.push(
      `${CREDENTIAL_KIND_LABELS[sent.kind]}, revisão ${sent.revision}, enviada em ${formatDateTime(sent.submittedAt)}`,
    );
  }
  if (reported !== null && reported.revision === null) {
    lines.push('Chave colada pelo cliente no painel');
  } else if (reported !== null && reported.outcome === 'applied') {
    lines.push(`Aplicada no servidor (revisão ${reported.revision ?? '—'})`);
  } else if (reported !== null && reported.code !== null) {
    lines.push(`Recusada no servidor: ${SOURCE_CODE_MESSAGES[reported.code].message}`);
  }
  if (reported?.keyIdSuffix !== null && reported?.keyIdSuffix !== undefined) {
    lines.push(`ID da chave terminando em …${reported.keyIdSuffix}`);
  }
  if (reported?.expiresAt !== null && reported?.expiresAt !== undefined) {
    lines.push(`Vence em ${formatDateTime(reported.expiresAt)}`);
  }
  if (lines.length > 0) return lines;
  const kind = PROVIDER_CREDENTIAL_KINDS[source.spec.provider];
  if (!overview.credentialKinds.includes(kind)) {
    return [
      source.spec.provider === 'cloudflare'
        ? 'Sem token: o cliente conecta no painel dele'
        : 'Sem chave (papel de leitura)',
    ];
  }
  return ['Nenhuma: o cliente cola no painel, ou envie daqui'];
}

/** A coleta como o servidor contou: a conexão, desde quando lê e o último evento. */
function collectionLines(source: LogSourceView): string[] {
  const account = source.report?.account ?? null;
  if (account === null) return ['—'];
  const lines = [
    `${CONNECTION_LABELS[account.connection]}${account.connectionError === null ? '' : ` (${account.connectionError})`}`,
  ];
  if (account.ingestFrom !== null) lines.push(`Lendo desde ${formatDay(account.ingestFrom)}`);
  lines.push(
    account.lastEventAt === null
      ? 'Nenhum evento ainda'
      : `Último evento: ${formatDateTime(account.lastEventAt)}`,
  );
  if (account.collectionError !== null) lines.push(COLLECTION_ERROR_LABELS[account.collectionError]);
  return lines;
}

function Lines({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="space-y-0.5">
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

function sourceTitle(source: LogSourceView): string {
  return `${PROVIDER_LABELS[source.spec.provider]} ${source.spec.accountId}`;
}

function SourcesTable({
  overview,
  selected,
  onSelect,
}: {
  overview: NodeSyncOverview;
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}) {
  if (overview.sources.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nenhuma fonte cadastrada pelo console. As contas que o cliente cadastra no painel dele não aparecem
        aqui.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Fontes de log cadastradas pelo console</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Provedor
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Conta
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              O que lê
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Situação
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Chave
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Coleta
            </th>
            <th scope="col" className="py-1 font-medium">
              <span className="sr-only">Detalhes</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {overview.sources.map((source) => {
            const note = statusNote(source);
            const open = selected === source.id;
            return (
              <tr key={source.id} className={cn('border-t align-top', open && 'bg-foreground/5')}>
                <th scope="row" className="py-2 pr-3 text-left font-medium">
                  {PROVIDER_LABELS[source.spec.provider]}
                </th>
                <td className="py-2 pr-3 font-mono text-xs break-all">{source.spec.accountId}</td>
                <td className="py-2 pr-3 text-xs">{scopeText(source.spec)}</td>
                <td className="py-2 pr-3 text-xs">
                  <div className="space-y-1">
                    <SourceStatusBadge status={source.status} />
                    {note !== undefined && <p className="text-muted-foreground">{note}</p>}
                  </div>
                </td>
                <td className="py-2 pr-3 text-xs">
                  <Lines lines={credentialLines(source, overview)} />
                </td>
                <td className="py-2 pr-3 text-xs">
                  <Lines lines={collectionLines(source)} />
                </td>
                <td className="py-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-expanded={open}
                    aria-controls={open ? `fonte-${source.id}` : undefined}
                    aria-label={`${open ? 'Fechar' : 'Abrir'} a fonte ${sourceTitle(source)}`}
                    onClick={() => onSelect(open ? undefined : source.id)}
                  >
                    {open ? 'Fechar' : 'Abrir'}
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type Mode = 'edit' | 'credential' | 'remove';

function SpecDetails({ spec }: { spec: LogSourceSpec }) {
  switch (spec.provider) {
    case 'aws':
      return (
        <>
          <Meta label="Regiões">
            <span className="font-mono text-xs">{spec.regions.join(', ')}</span>
          </Meta>
          {BUCKET_SOURCES.map((source) => (
            <Meta key={source} label={BUCKET_LABELS[source]}>
              <span className="font-mono text-xs">{spec.buckets?.[source] ?? '—'}</span>
            </Meta>
          ))}
        </>
      );
    case 'cloudflare':
      return (
        <Meta label="Zonas">
          <span className="font-mono text-xs">
            {spec.zones === undefined || spec.zones.length === 0 ? '—' : spec.zones.join(', ')}
          </span>
        </Meta>
      );
    case 'gcp':
      return (
        <Meta label="Assinatura do Pub/Sub">
          <span className="font-mono text-xs">{spec.pubsubSubscription ?? '—'}</span>
        </Meta>
      );
  }
}

/** Uma fonte aberta: a situação com o que fazer, o cadastro, as ações e o que mandar ao cliente. */
function SourceDetail({
  tenant,
  overview,
  source,
  writable,
  onDone,
}: {
  tenant: TenantDetail;
  overview: NodeSyncOverview;
  source: LogSourceView;
  writable: boolean;
  onDone: WriteDone;
}) {
  const [mode, setMode] = useState<Mode | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const active = source.state === 'active';
  const failure =
    source.status === 'failed' && source.code !== null ? SOURCE_CODE_MESSAGES[source.code] : undefined;
  const headingId = `fonte-${source.id}-titulo`;

  async function remove(confirmSlug: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await logSourcesApi.remove(tenant.id, source.id, confirmSlug);
      setMode(undefined);
      onDone(
        result,
        'Fonte removida. O servidor do cliente desativa a conta e para a coleta na próxima sincronização.',
      );
    } catch (caught) {
      setError(logSourceErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  function done(...args: Parameters<WriteDone>): void {
    setMode(undefined);
    onDone(...args);
  }

  return (
    <section
      id={`fonte-${source.id}`}
      aria-labelledby={headingId}
      className="space-y-4 rounded-xl border border-border-strong p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={headingId} className="text-base font-semibold">
          {sourceTitle(source)}
        </h3>
        <SourceStatusBadge status={source.status} />
      </div>
      {failure !== undefined && source.code !== null && (
        <div className="space-y-1 rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          <p className="font-medium">
            {failure.message} <span className="font-mono text-xs text-critical-text">{source.code}</span>
          </p>
          <p>{failure.action}</p>
        </div>
      )}
      {source.status === 'pending' && (
        <p className="text-sm text-muted-foreground">
          {overview.node === null
            ? 'Espera a primeira sincronização do servidor do cliente.'
            : 'O servidor do cliente ainda não processou a revisão atual (ou a chave nova): ele aplica na próxima sincronização.'}
        </p>
      )}
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Meta label={ACCOUNT_LABELS[source.spec.provider]}>
          <span className="font-mono text-xs">{source.spec.accountId}</span>
        </Meta>
        <SpecDetails spec={source.spec} />
        <Meta label="Revisão">{source.revision}</Meta>
        <Meta label="Cadastrada">
          {formatDateTime(source.createdAt)} por {source.createdBy.replace(/^owner:/, '')}
        </Meta>
        <Meta label="Alterada">
          {formatDateTime(source.updatedAt)} por {source.updatedBy.replace(/^owner:/, '')}
        </Meta>
        {source.report !== null && (
          <Meta label="Último relato do servidor">{formatDateTime(source.report.reportedAt)}</Meta>
        )}
        <Meta label="Chave">
          <Lines lines={credentialLines(source, overview)} />
        </Meta>
        <Meta label="Coleta">
          <Lines lines={collectionLines(source)} />
        </Meta>
      </dl>
      {active && writable && mode === undefined && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setMode('edit')}>
            <Pencil aria-hidden />
            Alterar…
          </Button>
          {overview.credentialKinds.includes(PROVIDER_CREDENTIAL_KINDS[source.spec.provider]) && (
            <Button variant="secondary" onClick={() => setMode('credential')}>
              <KeyRound aria-hidden />
              Enviar chave…
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => {
              setError(undefined);
              setMode('remove');
            }}
          >
            <Trash2 aria-hidden />
            Remover…
          </Button>
        </div>
      )}
      {mode === 'edit' && (
        <EditSourceForm tenant={tenant} source={source} onDone={done} onCancel={() => setMode(undefined)} />
      )}
      {mode === 'credential' && (
        <CredentialForm
          tenant={tenant}
          overview={overview}
          source={source}
          onDone={done}
          onCancel={() => setMode(undefined)}
        />
      )}
      {mode === 'remove' && (
        <ConfirmBySlug
          slug={tenant.slug}
          actionLabel="Confirmar: remover a fonte"
          busyLabel="Removendo…"
          busy={busy}
          onConfirm={(typed) => void remove(typed)}
          onCancel={() => {
            setMode(undefined);
            setError(undefined);
          }}
        >
          <p>
            <strong>
              O servidor do cliente desativa a conta {source.spec.accountId} e para a coleta desta fonte na
              próxima sincronização.
            </strong>
          </p>
          <p>
            Os eventos já recebidos ficam. Uma chave enviada daqui que o servidor ainda não leu é descartada.
            A mesma conta pode voltar depois, como fonte nova.
          </p>
        </ConfirmBySlug>
      )}
      {error !== undefined && (
        <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          {error}
        </div>
      )}
      <SourceInstructions source={source} />
    </section>
  );
}

/**
 * As fontes de log do cliente no detalhe dele: a situação da sincronização com o servidor do cliente (o nó chama a
 * Verax a cada 5 minutos, a partir da versão node-v1.2.0), as fontes cadastradas aqui com a situação que o nó contou,
 * o cadastro, a alteração, o envio da chave e a remoção (com o subdomínio digitado), e o que mandar ao cliente em cada
 * uma. Docs: `docs/runbooks/console-do-responsavel.md`, §7.2.
 */
export function LogSourcesPanel({ tenant }: { tenant: TenantDetail }) {
  const sync = useNodeSync(tenant.id);
  const invalidate = useInvalidateNodeSync();
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const writable = tenant.state !== 'canceled' && tenant.state !== 'deleted';
  const overview = sync.data;

  const done: WriteDone = (result, text) => {
    setAdding(false);
    setNotice(text);
    setSelected(result.source.id);
    void invalidate(tenant.id);
  };

  const open = overview?.sources.find((source) => source.id === selected);
  return (
    <section aria-labelledby="fontes-de-log" className="space-y-3 rounded-xl border bg-surface p-4">
      <h2 id="fontes-de-log" className="text-base font-semibold">
        Fontes de log
      </h2>
      <p className="text-sm">
        As contas de nuvem que o servidor do cliente lê. O que você cadastra aqui chega a ele na próxima
        sincronização, e ele conta de volta o que aplicou.
      </p>
      {overview === undefined ? (
        sync.isError ? (
          <ErrorState error={sync.error} onRetry={() => void sync.refetch()} />
        ) : (
          <LoadingState label="Lendo as fontes de log" />
        )
      ) : (
        <>
          <NodeSyncStatus overview={overview} />
          <p role="status" className={cn('text-sm font-medium', notice === undefined && 'sr-only')}>
            {notice}
          </p>
          <SourcesTable
            overview={overview}
            selected={open?.id}
            onSelect={(id) => {
              setSelected(id);
              setNotice(undefined);
            }}
          />
          {open !== undefined && (
            <SourceDetail
              key={open.id}
              tenant={tenant}
              overview={overview}
              source={open}
              writable={writable}
              onDone={done}
            />
          )}
          {!writable && (
            <p className="text-sm text-muted-foreground">
              O contrato terminou: as fontes ficam só para consulta.
            </p>
          )}
          {writable && !adding && (
            <Button
              variant="secondary"
              onClick={() => {
                setAdding(true);
                setNotice(undefined);
              }}
            >
              <Plus aria-hidden />
              Cadastrar fonte…
            </Button>
          )}
          {writable && adding && (
            <AddSourceForm
              tenant={tenant}
              overview={overview}
              onDone={done}
              onCancel={() => setAdding(false)}
            />
          )}
        </>
      )}
    </section>
  );
}

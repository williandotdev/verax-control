import {
  CircleCheck,
  CircleX,
  Clock,
  ExternalLink,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError, tenantsApi } from '@/lib/api';
import type { SizeId, TenantDetail, TenantInstallation } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { ConfirmBySlug } from './confirm-by-slug';
import { failureHint, STATE_LABELS, stepLabel, WORKER_FAILURE_MESSAGES } from './labels';
import { useInvalidateTenants, useTenantInstallation } from './queries';

/**
 * O mínimo da VM de cada porte, o mesmo que o instalador confere (`verax-install.sh`, `min_cpus`, `min_memory_mb` e
 * `min_disk_gb`, com folga para o que o sistema reserva) e o guia (`docs/runbooks/instalacao-no-cliente.md`).
 */
const VM_PROFILES: Readonly<Record<SizeId, { cpus: number; memoryGb: number; diskGb: number }>> = {
  P: { cpus: 2, memoryGb: 8, diskGb: 60 },
  M: { cpus: 4, memoryGb: 16, diskGb: 120 },
  G: { cpus: 8, memoryGb: 32, diskGb: 240 },
};

/** A saída que a VM precisa (o guia, "A rede: só saída"). Nenhuma porta de entrada. */
const EGRESS: readonly { hosts: string; ports: string; purpose: string }[] = [
  {
    hosts: '*.argotunnel.com, *.cftunnel.com',
    ports: '443 e 7844 (TCP e UDP)',
    purpose: 'O túnel da Verax no Cloudflare',
  },
  {
    hosts: 'conta.veraxsistemas.com.br',
    ports: '443',
    purpose: 'O registro da VM e a sincronização com a Verax',
  },
  { hosts: 'github.com, objects.githubusercontent.com', ports: '443', purpose: 'O instalador e o pacote' },
  { hosts: 'ghcr.io, pkg-containers.githubusercontent.com', ports: '443', purpose: 'As imagens do Verax' },
  {
    hosts: 'registry-1.docker.io, auth.docker.io, *.docker.com',
    ports: '443',
    purpose: 'O Docker e as imagens de terceiros',
  },
  { hosts: 'api.cloudflare.com e as APIs das nuvens monitoradas', ports: '443', purpose: 'A coleta' },
  { hosts: 'O servidor de e-mail dos nós', ports: '465 ou 587', purpose: 'Os e-mails do painel' },
  { hosts: 'Os espelhos do apt e o NTP', ports: '80/443 e 123 (UDP)', purpose: 'Pacotes e relógio' },
];

const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const HEX_ALPHABET = '0123456789abcdef';

/** Tamanho fixo e só caracteres do alfabeto (sem expressão regular sobre o que veio da API). */
function fixedToken(value: string, length: number, alphabet: string): boolean {
  return value.length === length && [...value].every((char) => alphabet.includes(char));
}

/** Só endereços `https` do GitHub (a API já confere; aqui, de novo, antes de virar link ou comando). */
function githubHref(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * O comando único que o cliente roda na VM: baixa o instalador da versão vigente, confere o SHA-256 dele (o do
 * manifesto assinado) e instala com o código. Fora do formato, nada: o console não monta um comando duvidoso.
 */
function installCommand(installer: { url: string; sha256: string }, code: string): string | undefined {
  const url = githubHref(installer.url);
  if (
    url === undefined ||
    !fixedToken(installer.sha256, 64, HEX_ALPHABET) ||
    !fixedToken(code, 43, CODE_ALPHABET)
  ) {
    return undefined;
  }
  return `curl -fsSLo verax-install.sh ${url} && echo "${installer.sha256}  verax-install.sh" | sha256sum -c - && sudo bash verax-install.sh --codigo ${code}`;
}

/** A mensagem de um erro da API: o que fazer quando o cp-worker não atendeu; senão, a da API. */
function apiErrorMessage(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code !== undefined &&
    Object.hasOwn(WORKER_FAILURE_MESSAGES, error.code)
  ) {
    return WORKER_FAILURE_MESSAGES[error.code] ?? errorMessage(error);
  }
  return errorMessage(error);
}

/** Os códigos que o instalador avisa (`node_error:<código>`) e que o cliente resolve sozinho. */
const INSTALLER_ERRORS: Readonly<Record<string, string>> = {
  host_below_size: 'A VM é menor que o porte do contrato: o cliente aumenta a VM.',
  tunnel_unreachable: 'A VM não alcançou o túnel: o cliente libera a saída para 443 e 7844 (TCP e UDP).',
};

function customerFailureHint(code: string): string {
  if (code === 'enrollment_timeout') return 'A VM não se registrou em 30 dias.';
  if (code.startsWith('node_error:')) {
    return (
      INSTALLER_ERRORS[code.slice('node_error:'.length)] ??
      'O instalador avisou um erro na VM: a tela da VM diz o que houve.'
    );
  }
  return failureHint(code) ?? 'O provisionamento parou.';
}

type Tone = 'waiting' | 'progress' | 'ok' | 'failed';

const TONE_ICONS: Readonly<Record<Tone, ReactNode>> = {
  waiting: <Clock aria-hidden className="size-4 text-subtle-foreground" />,
  progress: <LoaderCircle aria-hidden className="size-4 text-primary" />,
  ok: <CircleCheck aria-hidden className="size-4 text-ok" />,
  failed: <CircleX aria-hidden className="size-4 text-critical" />,
};

interface InstallStatusView {
  tone: Tone;
  title: string;
  detail: string;
  code?: string;
}

/** A situação da instalação, pelo estado do cliente e pelo passo `enrollment.wait` da execução reduzida. */
function installStatus(tenant: TenantDetail): InstallStatusView | undefined {
  switch (tenant.state) {
    case 'waiting_customer_install':
      return {
        tone: 'waiting',
        title: 'Aguardando o comando',
        detail: 'Gere o comando abaixo e envie ao cliente.',
      };
    case 'provisioning': {
      const wait = tenant.timeline.find((step) => step.name === 'enrollment.wait');
      if (wait?.status === 'done') {
        return {
          tone: 'progress',
          title: 'VM registrada',
          detail: `Conferindo o ambiente (${stepLabel(tenant.provisioning?.step)}).`,
        };
      }
      const since = wait?.waitingSince ?? wait?.startedAt;
      return {
        tone: 'progress',
        title: 'Esperando a VM do cliente',
        detail:
          since === undefined
            ? 'O cliente roda o comando e a VM se registra sozinha.'
            : `O cliente roda o comando e a VM se registra sozinha. Esperando desde ${formatDateTime(since)}.`,
      };
    }
    case 'provisioning_failed': {
      const code = tenant.provisioning?.lastError?.code;
      return {
        tone: 'failed',
        title: 'A instalação parou',
        detail: `${code === undefined ? 'O provisionamento parou.' : customerFailureHint(code)} Para recomeçar, gere um comando novo.`,
        ...(code === undefined ? {} : { code }),
      };
    }
    case 'waiting_customer_connection':
      return {
        tone: 'ok',
        title: 'Pronto',
        detail: 'A VM está no ar. Falta o primeiro acesso do administrador.',
      };
    case 'active':
      return { tone: 'ok', title: 'Pronto', detail: 'A VM está no ar e o cliente já entrou.' };
    default:
      return undefined;
  }
}

function InstallStatus({ tenant }: { tenant: TenantDetail }) {
  const status = installStatus(tenant);
  if (status === undefined) return null;
  return (
    <div
      role={status.tone === 'failed' ? 'alert' : 'group'}
      aria-label="Situação da instalação"
      className={cn(
        'flex items-start gap-2 rounded-lg border p-3 text-sm',
        status.tone === 'failed' && 'border-critical/40 bg-critical/5',
      )}
    >
      <span className="mt-0.5">{TONE_ICONS[status.tone]}</span>
      <div className="space-y-0.5">
        <p className="font-medium">
          {status.title}
          {status.code !== undefined && (
            <span className="ml-2 font-mono text-xs text-critical-text">{status.code}</span>
          )}
        </p>
        <p className="text-muted-foreground">{status.detail}</p>
      </div>
    </div>
  );
}

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-2 rounded-lg border p-3">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function VmProfile({ size }: { size: SizeId }) {
  const profile = VM_PROFILES[size];
  return (
    <Block id="instalacao-perfil" title="1. Perfil da VM">
      <p className="text-xs text-muted-foreground">O mínimo para o porte {size} do contrato.</p>
      <dl className="grid grid-cols-3 gap-3">
        <div>
          <dt className="text-xs text-muted-foreground">vCPU</dt>
          <dd className="text-lg font-semibold tabular-nums">{profile.cpus}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Memória</dt>
          <dd className="text-lg font-semibold tabular-nums">{profile.memoryGb} GB</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Disco</dt>
          <dd className="text-lg font-semibold tabular-nums">{profile.diskGb} GB</dd>
        </div>
      </dl>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        <li>Debian 12, Ubuntu 22.04 ou Ubuntu 24.04, x86_64, instalação limpa.</li>
        <li>Em qualquer nuvem ou no datacenter do cliente.</li>
        <li>Swap desligado ou cifrado.</li>
        <li>Um usuário com sudo. A Verax não recebe acesso à VM.</li>
      </ul>
    </Block>
  );
}

function Network() {
  return (
    <Block id="instalacao-rede" title="2. Rede">
      <p className="flex items-center gap-2 rounded-md bg-ok/10 p-2 text-sm font-semibold">
        <ShieldCheck aria-hidden className="size-4 text-ok" />
        Nenhuma porta de entrada.
      </p>
      <p className="text-sm">A VM só faz conexões de saída. Libere a saída para:</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">Destinos de saída da VM</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Destino
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                Porta
              </th>
              <th scope="col" className="py-1 font-medium">
                Para quê
              </th>
            </tr>
          </thead>
          <tbody>
            {EGRESS.map((row) => (
              <tr key={row.hosts} className="border-t align-top">
                <td className="py-1 pr-3 font-mono text-xs break-words">{row.hosts}</td>
                <td className="py-1 pr-3 text-xs">{row.ports}</td>
                <td className="py-1 text-xs">{row.purpose}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Block>
  );
}

/** O comando gerado: só no estado desta tela, nunca na URL, no armazenamento do navegador ou no log. */
interface Issued {
  command: string;
  expiresAt: string;
  reinstall: boolean;
}

function IssuedCommand({ issued, onHide }: { issued: Issued; onHide: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'failed' | undefined>();
  // O `navigator.clipboard` só existe em contexto seguro (https); sem ele, o botão nem aparece.
  const clipboard =
    typeof navigator === 'undefined' ? undefined : (navigator.clipboard as Clipboard | undefined);

  async function copy() {
    try {
      await clipboard?.writeText(issued.command);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Comando gerado. Ele aparece só agora: copie e envie ao cliente.</p>
      <pre
        aria-label="Comando de instalação gerado"
        tabIndex={0}
        className="rounded-md border bg-surface-raised p-3 font-mono text-xs break-all whitespace-pre-wrap"
      >
        {issued.command}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        {clipboard !== undefined && (
          <Button size="sm" onClick={() => void copy()}>
            Copiar o comando
          </Button>
        )}
        <Button variant="secondary" size="sm" onClick={onHide}>
          Ocultar
        </Button>
        <span role="status" className="text-xs text-muted-foreground">
          {copied === 'ok' && 'Comando copiado.'}
          {copied === 'failed' && 'Não deu para copiar: selecione e copie à mão.'}
        </span>
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        <li>
          O código é de uso único e vale até <strong>{formatDateTime(issued.expiresAt)}</strong>.
        </li>
        <li>Ele é uma credencial: envie por um canal seguro.</li>
        {issued.reinstall && <li>A VM anterior deixou de valer: o cliente reinstala com este comando.</li>}
      </ul>
    </div>
  );
}

function InstallCommand({
  tenant,
  installation,
}: {
  tenant: TenantDetail;
  installation: ReturnType<typeof useTenantInstallation>;
}) {
  const invalidate = useInvalidateTenants();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<Issued | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const data = installation.data;
  const installer = data?.installer;
  const allowed = tenant.actions.enrollmentCode;
  const installed = tenant.state === 'waiting_customer_connection' || tenant.state === 'active';

  async function generate(confirmSlug: string): Promise<void> {
    if (busy || installer === undefined) return;
    setBusy(true);
    setError(undefined);
    setIssued(undefined);
    try {
      const result = await tenantsApi.enrollmentCode(tenant.id, confirmSlug);
      // O instalador da versão que a execução do provisionamento escolheu agora (a instalação passa a ler a versão da
      // execução): se a versão vigente mudou desde que a tela abriu, o comando não leva o instalador antigo, que o
      // registro recusaria (`release_mismatch`).
      const fresh = await installation.refetch();
      const current = fresh.data?.installer;
      const command = current === undefined ? undefined : installCommand(current, result.code);
      if (command === undefined) {
        setError('A resposta veio fora do formato: não envie nada ao cliente e tente de novo.');
      } else {
        setIssued({ command, expiresAt: result.expiresAt, reinstall: result.reinstall });
      }
      setConfirming(false);
      await invalidate(tenant.id);
    } catch (caught) {
      setError(apiErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block id="instalacao-comando" title="3. Comando de instalação">
      <p className="text-sm">
        O cliente roda um único comando na VM, com um código de uso único. O comando baixa o instalador,
        confere o SHA-256 dele e instala.
      </p>
      {installation.isPending && <LoadingState label="Lendo a versão do nó" />}
      {installation.isError && (
        <div
          role="alert"
          className="flex flex-col items-start gap-2 rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert aria-hidden className="size-4 text-critical" />
            {apiErrorMessage(installation.error)}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void installation.refetch()}>
            Tentar de novo
          </Button>
        </div>
      )}
      {data !== undefined && installer === undefined && (
        <p role="note" className="rounded-lg border border-high/60 bg-high/10 p-3 text-sm">
          A versão atual do nó ({data.release}) ainda não tem o instalador. Publique uma versão nova do nó
          para gerar o comando.
        </p>
      )}
      {data !== undefined && !allowed && (
        <p className="text-sm text-muted-foreground">
          Com o cliente em “{STATE_LABELS[tenant.state]}”, não há comando a gerar.
        </p>
      )}
      {!confirming && issued === undefined && data !== undefined && (
        <Button onClick={() => setConfirming(true)} disabled={installer === undefined || !allowed}>
          Gerar comando…
        </Button>
      )}
      {confirming && (
        <ConfirmBySlug
          slug={tenant.slug}
          actionLabel="Confirmar: gerar comando"
          busyLabel="Gerando…"
          busy={busy}
          onConfirm={(typed) => void generate(typed)}
          onCancel={() => {
            setConfirming(false);
            setError(undefined);
          }}
        >
          <p>Um comando novo revoga o anterior: o código antigo deixa de valer.</p>
          {installed && (
            <p>
              <strong>O ambiente já está instalado.</strong> Com o código novo, a VM atual deixa de valer e o
              cliente precisa reinstalar.
            </p>
          )}
          {tenant.state === 'provisioning_failed' && <p>A instalação que parou recomeça.</p>}
        </ConfirmBySlug>
      )}
      {issued !== undefined && <IssuedCommand issued={issued} onHide={() => setIssued(undefined)} />}
      {error !== undefined && (
        <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          {error}
        </div>
      )}
    </Block>
  );
}

function TechnicalDetails({ data }: { data: TenantInstallation }) {
  const guide = githubHref(data.guideUrl);
  return (
    <details className="rounded-lg border">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Detalhes técnicos</summary>
      <div className="space-y-2 px-3 pb-3 text-sm">
        <p>
          Versão do nó: <span className="font-mono">{data.release}</span>
          {data.releasedAt !== undefined && `, publicada em ${formatDateTime(data.releasedAt)}`}.
        </p>
        {guide !== undefined && (
          <p>
            <a
              href={guide}
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline"
            >
              Guia de instalação na VM do cliente
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          </p>
        )}
      </div>
    </details>
  );
}

/**
 * A instalação no ambiente do cliente: o painel fica na Verax e só o backend roda numa VM Linux do cliente, que se
 * liga à Verax por um túnel de saída. A situação da instalação, os três blocos para mandar ao cliente (o perfil da VM,
 * a rede e o comando único com o código de uso único) e, fechados, os detalhes técnicos.
 */
export function InstallationPanel({ tenant }: { tenant: TenantDetail }) {
  const enabled = tenant.state !== 'deleted';
  const installation = useTenantInstallation(tenant.id, enabled);
  return (
    <section aria-labelledby="instalacao" className="space-y-3 rounded-xl border bg-surface p-4">
      <h2 id="instalacao" className="text-base font-semibold">
        Instalação na infraestrutura do cliente
      </h2>
      {enabled ? (
        <>
          <p className="text-sm">
            O painel fica na Verax. Só o backend roda numa VM Linux do cliente, que se liga à Verax por um
            túnel de saída. Envie ao cliente os três itens abaixo.
          </p>
          <InstallStatus tenant={tenant} />
          <VmProfile size={tenant.configuration.size} />
          <Network />
          <InstallCommand tenant={tenant} installation={installation} />
          {installation.data !== undefined && <TechnicalDetails data={installation.data} />}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">O contrato terminou: não há o que instalar.</p>
      )}
    </section>
  );
}

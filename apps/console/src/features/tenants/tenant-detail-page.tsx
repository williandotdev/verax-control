import { CircleCheck, CircleDashed, CircleX, LoaderCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { ErrorState, LoadingState } from '@/components/states';
import type { DirectTenantCreated, TimelineStep, TimelineStepStatus } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { configurationSummary, formatDateTime } from '@/lib/format';
import { formatCents, formatInteger } from '@/lib/numbers';
import {
  failureHint,
  STATE_LABELS,
  STEP_LABELS,
  STEP_STATUS_LABELS,
  stepLabel,
  SUSPENSION_LABELS,
  workerFailureMessage,
} from './labels';
import { useTenant } from './queries';
import { TenantActionButtons } from './tenant-actions';
import { BillingBadge, TenantStateBadge } from './tenant-badges';

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function Panel({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3 rounded-xl border bg-surface p-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** O CNPJ com a máscara (o formato alfanumérico também: 12 posições e 2 dígitos). */
function formatCnpj(cnpj: string): string {
  if (cnpj.length !== 14) return cnpj;
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
}

const STATUS_ICONS: Readonly<Record<TimelineStepStatus, ReactNode>> = {
  pending: <CircleDashed aria-hidden className="size-4 text-subtle-foreground" />,
  running: <LoaderCircle aria-hidden className="size-4 text-primary" />,
  waiting: <LoaderCircle aria-hidden className="size-4 text-primary" />,
  done: <CircleCheck aria-hidden className="size-4 text-ok" />,
  failed: <CircleX aria-hidden className="size-4 text-critical" />,
};

function TimelineItem({ step }: { step: TimelineStep }) {
  const when =
    step.finishedAt !== undefined
      ? `terminou ${formatDateTime(step.finishedAt)}`
      : step.startedAt !== undefined
        ? `desde ${formatDateTime(step.waitingSince ?? step.startedAt)}`
        : undefined;
  return (
    <li className={cn('flex gap-3 border-l-2 py-2 pl-3', step.status === 'failed' && 'border-critical')}>
      <span className="mt-0.5">{STATUS_ICONS[step.status]}</span>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">
          {STEP_LABELS[step.name]}{' '}
          <span className="font-mono text-xs text-muted-foreground">{step.name}</span>
        </p>
        <p className="text-xs text-muted-foreground">
          {STEP_STATUS_LABELS[step.status]}
          {step.attempts > 0 &&
            ` · ${formatInteger(step.attempts)} ${step.attempts === 1 ? 'entrega' : 'entregas'}`}
          {when !== undefined && ` · ${when}`}
        </p>
        {step.errorCode !== undefined && (
          <p
            className={cn('font-mono text-xs', step.status === 'failed' ? 'text-critical-text' : 'text-high')}
          >
            {step.errorCode}
          </p>
        )}
      </div>
    </li>
  );
}

/** A mensagem que o cadastro deixa ao abrir o cliente (a página veio do formulário). */
function createdNotice(
  created: DirectTenantCreated | undefined,
): { text: string; warning: boolean } | undefined {
  if (created === undefined) return undefined;
  if (created.provisioning.started) {
    return {
      text: created.replayed
        ? 'Este cadastro já tinha sido enviado: é o mesmo cliente, nada novo foi criado.'
        : 'Cliente criado. O provisionamento começou.',
      warning: false,
    };
  }
  return {
    text: `Cliente criado, mas o provisionamento não começou. ${workerFailureMessage(created.provisioning.failure)} Depois, use “Iniciar provisionamento”.`,
    warning: true,
  };
}

/**
 * Um cliente: quem é, como paga, o que contratou, a linha do tempo do provisionamento (cada passo, com o código
 * de quem parou), o acesso do administrador e o histórico de estados; e as operações do responsável, com o subdomínio
 * digitado como confirmação. Enquanto provisiona, a página se atualiza sozinha.
 */
export function TenantDetailPage() {
  const { id = '' } = useParams();
  const location = useLocation();
  const tenant = useTenant(id);
  const [notice] = useState(() =>
    createdNotice((location.state as { created?: DirectTenantCreated } | null)?.created),
  );

  if (tenant.isPending) return <LoadingState label="Carregando o cliente" />;
  if (tenant.isError) {
    return (
      <div className="space-y-3">
        <BackLink />
        <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} />
      </div>
    );
  }
  const data = tenant.data;
  const lastError = data.provisioning?.lastError;
  const hint = failureHint(lastError?.code);
  const contract = data.billingMode === 'contract';
  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <BackLink />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{data.company.legalName}</h1>
          <TenantStateBadge state={data.state} />
          <BillingBadge mode={data.billingMode} />
        </div>
        {notice !== undefined && (
          <p
            role="status"
            className={cn(
              'text-sm font-medium',
              notice.warning && 'rounded-lg border border-high/60 bg-high/10 p-3',
            )}
          >
            {notice.text}
          </p>
        )}
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Meta label="Subdomínio">
            <span className="font-mono">{data.slug}</span>
          </Meta>
          <Meta label="CNPJ">
            <span className="tabular-nums">{formatCnpj(data.company.cnpj)}</span>
          </Meta>
          <Meta label="Administrador">{data.adminEmail ?? '—'}</Meta>
          <Meta label="Criado">{formatDateTime(data.createdAt)}</Meta>
          <Meta label="Estado">
            {STATE_LABELS[data.state]} desde {formatDateTime(data.stateUpdatedAt)}
          </Meta>
          <Meta label="Painel">
            <span className="font-mono text-xs">{data.urls.panelUrl}</span>
          </Meta>
          <Meta label="API">
            <span className="font-mono text-xs">{data.urls.apiUrl}</span>
          </Meta>
          <Meta label="Id">
            <span className="font-mono text-xs">{data.id}</span>
          </Meta>
        </dl>
      </header>

      <Panel title="Contratado" id="contratado">
        <p className="text-sm">{configurationSummary(data.configuration)}</p>
        <p className="text-sm tabular-nums">
          {contract ? 'Preço de referência' : 'Preço cotado no checkout'} (tabela{' '}
          {data.pricing.priceTableVersion}): {formatCents(data.pricing.monthlyTotal)} por mês
          {data.pricing.setupTotal > 0 && `, implantação ${formatCents(data.pricing.setupTotal)}`}.
        </p>
        {contract && (
          <p className="text-xs text-muted-foreground">
            Contrato direto: sem assinatura nem cobrança pela Stripe. A cobrança e a nota fiscal seguem o
            contrato.
          </p>
        )}
      </Panel>

      <Panel title="Provisionamento" id="provisionamento">
        {data.run === undefined ? (
          <p className="text-sm text-muted-foreground">
            {data.state === 'pending'
              ? 'Ainda não começou.'
              : 'Nenhuma execução registrada (as execuções ficam 180 dias).'}
          </p>
        ) : (
          <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Meta label="Execução">
              <span className="font-mono text-xs">{data.run.runId}</span>
            </Meta>
            <Meta label="Tipo">{data.run.kind === 'resume' ? 'Retomada' : 'Primeira'}</Meta>
            <Meta label="Versão do nó">{data.run.release ?? data.provisioning?.nodeVersion ?? '—'}</Meta>
            <Meta label="Início">{formatDateTime(data.run.startedAt)}</Meta>
          </dl>
        )}
        {data.state === 'provisioning_failed' && lastError !== undefined && (
          <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
            <p className="font-medium">
              Parou em {stepLabel(data.provisioning?.step)} com{' '}
              <span className="font-mono">{lastError.code}</span> ({formatDateTime(lastError.at)}).
            </p>
            {hint !== undefined && <p>{hint}</p>}
            <p className="text-xs">
              O que fazer em cada código está no runbook “Provisionamento que parou”
              (docs/runbooks/provisionamento.md).
            </p>
          </div>
        )}
        <ol aria-label="Linha do tempo do provisionamento" className="space-y-1">
          {data.timeline.map((step) => (
            <TimelineItem key={step.name} step={step} />
          ))}
        </ol>
        <TenantActionButtons tenant={data} actions={['start', 'resume']} />
      </Panel>

      <Panel title="Acesso do administrador" id="acesso">
        <p className="text-sm">
          {contract
            ? 'Quando o ambiente fica pronto, o administrador recebe o e-mail “ambiente pronto” com um link de uso único (24 horas) para ver a senha temporária. A senha nunca passa por este console nem pelo e-mail.'
            : 'O cliente vê a senha temporária uma vez, na página de status do site; se não vir em 48 horas, recebe o e-mail com o link de uso único.'}
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <Meta label="E-mail de acesso enviado">
            {data.access.revealEmailSentAt === undefined
              ? 'Ainda não'
              : formatDateTime(data.access.revealEmailSentAt)}
          </Meta>
          <Meta label="Senha vista pelo cliente">
            {data.access.passwordRevealedAt === undefined
              ? 'Ainda não'
              : formatDateTime(data.access.passwordRevealedAt)}
          </Meta>
        </dl>
      </Panel>

      <Panel title="Ciclo de vida" id="ciclo-de-vida">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {data.lifecycle.suspendedReason !== undefined && (
            <Meta label="Suspenso">
              {SUSPENSION_LABELS[data.lifecycle.suspendedReason] ?? data.lifecycle.suspendedReason}
            </Meta>
          )}
          {data.lifecycle.cancelScheduledFor !== undefined && (
            <Meta label="Cancelamento marcado">{formatDateTime(data.lifecycle.cancelScheduledFor)}</Meta>
          )}
          {data.lifecycle.canceledAt !== undefined && (
            <Meta label="Cancelado">{formatDateTime(data.lifecycle.canceledAt)}</Meta>
          )}
          {data.lifecycle.exportUntil !== undefined && (
            <Meta label="Exportação até">{formatDateTime(data.lifecycle.exportUntil)}</Meta>
          )}
          {data.lifecycle.deleteAfter !== undefined && (
            <Meta label="Exclusão 1 (D+30)">
              {formatDateTime(data.lifecycle.deletedAt ?? data.lifecycle.deleteAfter)}
            </Meta>
          )}
          {data.lifecycle.cryptoDestroyAfter !== undefined && (
            <Meta label="Cripto-destruição (D+97)">
              {formatDateTime(data.lifecycle.cryptoDestroyedAt ?? data.lifecycle.cryptoDestroyAfter)}
            </Meta>
          )}
          {data.lifecycle.nodeStoppedAt !== undefined && (
            <Meta label="VM parada desde">{formatDateTime(data.lifecycle.nodeStoppedAt)}</Meta>
          )}
        </dl>
        {data.lifecycle.run?.lastError !== undefined && (
          <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
            A exclusão ({data.lifecycle.run.kind === 'delete' ? 'Exclusão 1' : 'Exclusão 2'}) parou em{' '}
            <span className="font-mono">{data.lifecycle.run.step}</span> com{' '}
            <span className="font-mono">{data.lifecycle.run.lastError.code}</span>. O que fazer está no
            runbook “Ciclo de vida” (docs/runbooks/ciclo-de-vida.md); depois, “Apagar agora” recomeça.
          </div>
        )}
        {!contract && (
          <p className="text-sm text-muted-foreground">
            Cliente da Stripe: cancelamento e suspensão seguem a assinatura (Portal do cliente ou Dashboard da
            Stripe). Apagar agora e exportar ficam disponíveis depois do cancelamento.
          </p>
        )}
        <TenantActionButtons
          tenant={data}
          actions={['suspend', 'reactivate', 'cancel', 'export', 'delete-now']}
          emptyText="Nenhuma operação do ciclo de vida neste estado."
        />
      </Panel>

      <Panel title="Histórico de estados" id="historico">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Mudanças de estado do cliente, da mais antiga para a mais nova
            </caption>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Quando
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  De
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  Para
                </th>
                <th scope="col" className="py-1 font-medium">
                  Motivo
                </th>
              </tr>
            </thead>
            <tbody>
              {data.transitions.map((transition, index) => (
                <tr key={`${transition.at}-${index}`} className="border-t">
                  <td className="py-1 pr-3 tabular-nums">{formatDateTime(transition.at)}</td>
                  <td className="py-1 pr-3">
                    {transition.from === null ? '—' : STATE_LABELS[transition.from]}
                  </td>
                  <td className="py-1 pr-3">{STATE_LABELS[transition.to]}</td>
                  <td className="py-1 font-mono text-xs">{transition.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function BackLink() {
  return (
    <p className="text-sm">
      <Link to="/clientes" className="text-primary underline-offset-2 hover:underline">
        Clientes
      </Link>
    </p>
  );
}

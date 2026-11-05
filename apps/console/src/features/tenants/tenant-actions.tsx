import { Ban, CirclePause, FileDown, Play, RotateCcw, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ApiError, tenantsApi } from '@/lib/api';
import type { TenantAction, TenantActionResult, TenantActions, TenantDetail } from '@/lib/api-types';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { ConfirmBySlug } from './confirm-by-slug';
import { WORKER_FAILURE_MESSAGES } from './labels';
import { useInvalidateTenants } from './queries';

interface ActionConfig {
  /** A bandeira de `TenantDetail.actions` que diz se a operação está disponível agora. */
  flag: keyof TenantActions;
  label: string;
  busy: string;
  icon: ReactNode;
  danger?: boolean;
  describe: (tenant: TenantDetail) => ReactNode;
}

const ACTIONS: Readonly<Record<TenantAction, ActionConfig>> = {
  start: {
    flag: 'start',
    label: 'Iniciar provisionamento',
    busy: 'Iniciando…',
    icon: <Play aria-hidden />,
    describe: (tenant) => (
      <p>
        O cp-worker põe o cliente em provisionamento e enfileira a conferência inicial. Os passos criam o nó{' '}
        <span className="font-mono">vx-{tenant.slug}</span> na GCP (tem custo).
      </p>
    ),
  },
  resume: {
    flag: 'resume',
    label: 'Retomar provisionamento',
    busy: 'Retomando…',
    icon: <RotateCcw aria-hidden />,
    describe: (tenant) => (
      <p>
        Uma execução nova recomeça pela conferência inicial; o que já existe (túnel, site, nó) é reconhecido e
        reaproveitado.
        {tenant.state === 'provisioning' &&
          ' O cliente ainda está em provisionamento: retome só se ele parou (um passo sem andar há muito tempo).'}
      </p>
    ),
  },
  cancel: {
    flag: 'cancel',
    label: 'Cancelar contrato',
    busy: 'Cancelando…',
    icon: <Ban aria-hidden />,
    danger: true,
    describe: () => (
      <p>
        Agora, ou numa data futura (o fim do contrato, até 2 anos), que o relógio do plano de controle aplica.
        Cancelado, a VM para, o cliente pode pedir a exportação por 30 dias e a exclusão vem em D+30 (a
        cripto-destruição, em D+97).
      </p>
    ),
  },
  suspend: {
    flag: 'suspend',
    label: 'Suspender',
    busy: 'Suspendendo…',
    icon: <CirclePause aria-hidden />,
    danger: true,
    describe: () => (
      <p>
        A VM do cliente para e o painel sai do ar até você reativar. Disco e backups ficam. Nada é cobrado nem
        estornado aqui: a cobrança do contrato direto é fora da Stripe.
      </p>
    ),
  },
  reactivate: {
    flag: 'reactivate',
    label: 'Reativar',
    busy: 'Reativando…',
    icon: <Play aria-hidden />,
    describe: () => <p>O cliente volta ao estado de antes da suspensão e a VM é ligada.</p>,
  },
  'delete-now': {
    flag: 'deleteNow',
    label: 'Apagar agora',
    busy: 'Pedindo a exclusão…',
    icon: <Trash2 aria-hidden />,
    danger: true,
    describe: () => (
      <p>
        A Exclusão 1 agora, sem esperar D+30: a VM, o disco e os snapshots, o túnel e os registros de DNS, o
        site do painel e os cofres saem. <strong>Não tem volta.</strong> A chave das credenciais e os backups
        ficam até a cripto-destruição (D+97). Numa exclusão que parou, recomeça de onde der.
      </p>
    ),
  },
  export: {
    flag: 'export',
    label: 'Exportar dados',
    busy: 'Gerando o link…',
    icon: <FileDown aria-hidden />,
    describe: (tenant) => (
      <p>
        Gera um link de 24 horas para baixar um backup do cliente (o banco). Para saber os nomes, liste com as
        suas permissões:{' '}
        <code className="font-mono text-xs break-all">
          gcloud storage ls gs://&lt;projeto-dos-nos&gt;-vx-{tenant.slug}-backups/postgres/
        </code>
        . O link é uma credencial: mande ao cliente por um canal seguro.
      </p>
    ),
  },
};

/** A mensagem de uma operação recusada: o que fazer quando o cp-worker não atendeu; senão, a da API. */
function actionError(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code !== undefined &&
    Object.hasOwn(WORKER_FAILURE_MESSAGES, error.code)
  ) {
    return WORKER_FAILURE_MESSAGES[error.code] ?? errorMessage(error);
  }
  return errorMessage(error);
}

function doneMessage(result: TenantActionResult): string {
  switch (result.action) {
    case 'start':
      return 'Provisionamento iniciado: o primeiro passo está na fila.';
    case 'resume':
      return 'Provisionamento retomado: uma execução nova começou pela conferência inicial.';
    case 'cancel':
      return result.result === 'scheduled'
        ? `Cancelamento marcado para ${formatDateTime(result.cancelAt)}.`
        : `Contrato cancelado. A exclusão automática fica para ${formatDateTime(result.deleteAfter)}.`;
    case 'suspend':
      return 'Cliente suspenso: a VM está sendo parada.';
    case 'reactivate':
      return 'Cliente reativado: a VM está sendo ligada.';
    case 'delete-now':
      if (result.deletion === 'in_progress') return 'A exclusão já está em andamento.';
      if (result.deletion === 'deleted')
        return 'A Exclusão 1 já terminou; a cripto-destruição segue o prazo.';
      if (result.deletion === 'purged') return 'O cliente já foi excluído por completo.';
      return result.deletion === 'restarted' ? 'A exclusão recomeçou.' : 'A exclusão começou.';
    case 'export':
      return `Link gerado para ${result.object}, válido até ${formatDateTime(result.expiresAt)}.`;
  }
}

/** A data (`<input type="date">`, no horário deste navegador) como ISO; vazio é "agora". */
function cancelAtOf(day: string): string | undefined {
  if (day === '') return undefined;
  const date = new Date(`${day}T00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Os botões das operações do responsável sobre um cliente (as de `actions` disponíveis agora), cada uma com a
 * confirmação pelo subdomínio na própria página. O cancelamento aceita a data do fim do contrato; a exportação, o
 * nome do backup. O link da exportação aparece uma vez, aqui, e não fica guardado em lugar nenhum do console.
 */
export function TenantActionButtons({
  tenant,
  actions,
  emptyText,
}: {
  tenant: TenantDetail;
  actions: readonly TenantAction[];
  emptyText?: string;
}) {
  const ids = useId();
  const invalidate = useInvalidateTenants();
  const [open, setOpen] = useState<TenantAction | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [cancelDay, setCancelDay] = useState('');
  const [object, setObject] = useState('');
  const [done, setDone] = useState<TenantActionResult | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);

  async function run(action: TenantAction, confirmSlug: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const at = action === 'cancel' ? cancelAtOf(cancelDay) : undefined;
      const result = await tenantsApi.act(tenant.id, action, {
        confirmSlug,
        ...(at === undefined ? {} : { at }),
        ...(action === 'export' ? { object: object.trim() } : {}),
      });
      setDone(result);
      setOpen(undefined);
      await invalidate(tenant.id);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  const available = actions.filter((action) => tenant.actions[ACTIONS[action].flag]);
  return (
    <div className="space-y-3">
      {open === undefined && available.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {available.map((action) => (
            <Button
              key={action}
              variant={ACTIONS[action].danger === true ? 'secondary' : 'primary'}
              onClick={() => {
                setOpen(action);
                setCancelDay('');
                setObject('');
                setDone(undefined);
                setError(undefined);
              }}
            >
              {ACTIONS[action].icon}
              {ACTIONS[action].label}…
            </Button>
          ))}
        </div>
      )}
      {open === undefined && available.length === 0 && emptyText !== undefined && (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      )}
      {open !== undefined && (
        <ConfirmBySlug
          slug={tenant.slug}
          actionLabel={`Confirmar: ${ACTIONS[open].label.toLowerCase()}`}
          busyLabel={ACTIONS[open].busy}
          busy={busy}
          onConfirm={(typed) => void run(open, typed)}
          onCancel={() => setOpen(undefined)}
        >
          {ACTIONS[open].describe(tenant)}
          {open === 'cancel' && (
            <div className="flex max-w-sm flex-col gap-1">
              <label htmlFor={`${ids}-cancelar-em`} className="text-sm font-medium">
                Cancelar em
              </label>
              <input
                id={`${ids}-cancelar-em`}
                type="date"
                className="h-9 rounded-md border border-border-strong bg-surface-raised px-3 text-sm"
                value={cancelDay}
                onChange={(event) => setCancelDay(event.target.value)}
                aria-describedby={`${ids}-cancelar-em-dica`}
              />
              <p id={`${ids}-cancelar-em-dica`} className="text-xs text-muted-foreground">
                Vazio: agora. Uma data marca o cancelamento para o começo daquele dia (horário deste
                navegador).
              </p>
            </div>
          )}
          {open === 'export' && (
            <div className="flex max-w-xl flex-col gap-1">
              <label htmlFor={`${ids}-backup`} className="text-sm font-medium">
                Backup
              </label>
              <input
                id={`${ids}-backup`}
                type="text"
                autoComplete="off"
                spellCheck={false}
                className="h-9 rounded-md border border-border-strong bg-surface-raised px-3 font-mono text-sm"
                placeholder="postgres/verax-AAAAMMDDTHHMMSSZ.dump"
                value={object}
                onChange={(event) => setObject(event.target.value)}
              />
            </div>
          )}
        </ConfirmBySlug>
      )}
      {done !== undefined && (
        <div role="status" className="space-y-2 text-sm">
          <p className="font-medium">{doneMessage(done)}</p>
          {done.action === 'export' && (
            <p className="break-all">
              <a
                href={done.url}
                rel="noopener noreferrer"
                className="font-mono text-xs text-primary underline"
              >
                {done.url}
              </a>
            </p>
          )}
        </div>
      )}
      {error !== undefined && (
        <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          {actionError(error)}
        </div>
      )}
    </div>
  );
}

import { type CloudAccount, cloudAccountCreateSchema } from '@verax/shared';
import { Copy, ExternalLink } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import { SEVERITY_STYLES } from '@/design/severity';
import {
  ADMIN_PAGE_SIZE,
  useCloudAccountList,
  useCreateCloudAccount,
  useUpdateCloudAccount,
} from '@/features/admin/admin-api';
import { AdminShell, FormError } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { CONNECTION_LABELS, CONNECTOR_GUIDE_URL, CONNECTOR_TEMPLATE_URL } from '@/features/admin/labels';
import { useMe } from '@/features/session/session';
import { cn } from '@/lib/cn';
import { formatRelative } from '@/lib/format';

const NEW = 'nova';

/** Contas cloud (T7.3): cadastrar, ver o ExternalId e o template do conector, e acompanhar a conexão. */
export function CloudAccountsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const canWrite = me?.permissions.includes('cloud_accounts:write') === true;
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const list = useCloudAccountList(page, scope !== null);
  const open = params.get('conta');
  const setOpen = (value: string | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set('conta', value);
      else next.delete('conta');
      return next;
    });
  const selected = list.data?.items.find((account) => account.id === open) ?? null;

  const columns: Column<CloudAccount>[] = [
    {
      key: 'conta',
      header: 'Conta AWS',
      cell: (row) => (
        <button type="button" className="font-mono text-sm hover:underline" onClick={() => setOpen(row.id)}>
          {row.accountId}
        </button>
      ),
    },
    { key: 'regioes', header: 'Regiões', cell: (row) => row.regions.join(', ') },
    { key: 'conexao', header: 'Conexão', cell: (row) => <ConnectionBadge account={row} /> },
    {
      key: 'evento',
      header: 'Último evento',
      className: 'whitespace-nowrap',
      cell: (row) =>
        row.lastEventAt ? (
          formatRelative(row.lastEventAt)
        ) : (
          <span className="text-muted-foreground">nenhum ainda</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) =>
        row.status === 'active' ? 'Ativa' : <span className="text-muted-foreground">Inativa</span>,
    },
  ];

  return (
    <AdminShell
      title="Contas cloud"
      description="Contas AWS monitoradas. O Verax Control lê cada uma por um papel somente leitura que o cliente cria com o conector."
      action={canWrite && <Button onClick={() => setOpen(NEW)}>Cadastrar conta</Button>}
    >
      <DataTable
        caption="Contas cloud do cliente"
        columns={columns}
        rows={list.data?.items}
        rowKey={(row) => row.id}
        page={page}
        pageSize={ADMIN_PAGE_SIZE}
        total={list.data?.total ?? 0}
        onPageChange={(next) => setParams({ pagina: String(next) })}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        emptyTitle="Nenhuma conta cadastrada"
        emptyDescription="Cadastre a primeira conta AWS do cliente para começar o monitoramento."
      />
      <Sheet
        open={open === NEW || selected !== null}
        onOpenChange={(value) => {
          if (!value) setOpen(null);
        }}
        title={open === NEW ? 'Cadastrar conta AWS' : `Conta ${selected?.accountId ?? ''}`}
      >
        {open === NEW ? (
          <CreateAccount />
        ) : (
          selected && <AccountDetail account={selected} canWrite={canWrite} />
        )}
      </Sheet>
    </AdminShell>
  );
}

function ConnectionBadge({ account }: { account: CloudAccount }) {
  const connection = account.connection ?? 'pending';
  const severity = connection === 'ok' ? 'ok' : connection === 'error' ? 'critical' : 'medium';
  const { icon: Icon, tone } = SEVERITY_STYLES[severity];
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-sm">
      <Icon aria-hidden className={cn('size-4', tone)} />
      {CONNECTION_LABELS[connection]}
    </span>
  );
}

function CreateAccount() {
  const [values, setValues] = useState({ accountId: '', regions: 'sa-east-1' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateCloudAccount();

  if (create.data) {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-md border border-ok/50 bg-ok/10 p-3 text-sm">
          Conta {create.data.accountId} cadastrada. Falta o cliente criar o conector nela.
        </p>
        <ConnectorSteps account={create.data} />
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = cloudAccountCreateSchema.safeParse({
      provider: 'aws',
      accountId: values.accountId.trim(),
      regions: values.regions
        .split(',')
        .map((region) => region.trim())
        .filter(Boolean),
    });
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    create.mutate(input.data);
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label="ID da conta AWS"
        hint="12 dígitos (canto superior direito do console da AWS)."
        inputMode="numeric"
        value={values.accountId}
        onChange={(event) => setValues({ ...values, accountId: event.target.value })}
        error={errors['accountId']}
      />
      <Field
        label="Regiões monitoradas"
        hint="Separadas por vírgula, por exemplo: sa-east-1, us-east-1."
        value={values.regions}
        onChange={(event) => setValues({ ...values, regions: event.target.value })}
        error={errors['regions'] ?? Object.entries(errors).find(([key]) => key.startsWith('regions.'))?.[1]}
      />
      <FormError error={create.error} />
      <Button type="submit" disabled={create.isPending}>
        Cadastrar e gerar o ExternalId
      </Button>
    </form>
  );
}

function AccountDetail({ account, canWrite }: { account: CloudAccount; canWrite: boolean }) {
  const update = useUpdateCloudAccount(account.id);
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Conexão</dt>
        <dd>
          <ConnectionBadge account={account} />
        </dd>
        <dt className="text-muted-foreground">Último evento</dt>
        <dd>{account.lastEventAt ? formatRelative(account.lastEventAt) : 'nenhum ainda'}</dd>
        <dt className="text-muted-foreground">Regiões</dt>
        <dd>{account.regions.join(', ')}</dd>
        <dt className="text-muted-foreground">Papel de leitura</dt>
        <dd className="break-all font-mono text-xs">{account.roleArn}</dd>
      </dl>
      {account.externalId ? (
        <ConnectorSteps account={account} />
      ) : (
        <p className="text-sm text-muted-foreground">
          O ExternalId só aparece para quem configura o conector.
        </p>
      )}
      {canWrite && (
        <div className="space-y-2">
          <Button
            variant="secondary"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: account.status === 'active' ? 'inactive' : 'active' })}
          >
            {account.status === 'active' ? 'Desativar monitoramento' : 'Reativar monitoramento'}
          </Button>
          <FormError error={update.error} />
        </div>
      )}
    </div>
  );
}

/** O que o cliente faz na conta dele: o template do conector com o ExternalId desta conta. */
function ConnectorSteps({ account }: { account: CloudAccount }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!account.externalId) return;
    void navigator.clipboard?.writeText(account.externalId).then(() => setCopied(true));
  };
  return (
    <section aria-labelledby="conector-passos" className="space-y-3 rounded-md border p-3">
      <h3 id="conector-passos" className="text-sm font-semibold">
        Conector na conta {account.accountId}
      </h3>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          Baixe o{' '}
          <a
            href={CONNECTOR_TEMPLATE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            template do conector
            <ExternalLink aria-hidden className="size-3.5" />
          </a>{' '}
          e siga o{' '}
          <a
            href={CONNECTOR_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 underline"
          >
            passo a passo
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
          .
        </li>
        <li>
          No CloudFormation da conta, crie a pilha com este ExternalId (é secreto: envie ao cliente por um
          canal seguro):
          <div className="mt-1 flex items-center gap-2">
            <code className="break-all rounded bg-foreground/5 px-2 py-1 font-mono text-xs">
              {account.externalId}
            </code>
            <Button type="button" variant="ghost" size="sm" onClick={copy} aria-label="Copiar o ExternalId">
              <Copy aria-hidden />
              {copied ? 'Copiado' : 'Copiar'}
            </Button>
          </div>
        </li>
        <li>A conexão muda para "Conectada" na primeira leitura bem-sucedida do papel.</li>
      </ol>
    </section>
  );
}

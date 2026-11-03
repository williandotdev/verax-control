import { type TenantSummary, tenantCreateSchema } from '@verax/shared';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import {
  ADMIN_PAGE_SIZE,
  useCreateTenant,
  useTenant,
  useTenantList,
  useUpdateTenant,
} from '@/features/admin/admin-api';
import { AdminShell, FormError } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { TENANT_STATUS_LABELS } from '@/features/admin/labels';

const NEW = 'novo';

/** Clientes (T7.1): listar, criar, editar e desativar. Só admin_verax (permissão `tenants:read`). */
export function TenantsPage() {
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const list = useTenantList(page, true);
  const open = params.get('cliente');
  const setOpen = (value: string | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set('cliente', value);
      else next.delete('cliente');
      return next;
    });

  const columns: Column<TenantSummary>[] = [
    {
      key: 'nome',
      header: 'Cliente',
      cell: (row) => (
        <button
          type="button"
          className="text-left font-medium hover:underline"
          onClick={() => setOpen(row.id)}
        >
          {row.name}
        </button>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <span className={row.status === 'inactive' ? 'text-muted-foreground' : undefined}>
          {TENANT_STATUS_LABELS[row.status]}
        </span>
      ),
    },
  ];

  return (
    <AdminShell
      title="Clientes"
      description="Empresas atendidas pela Verax. Desativar um cliente bloqueia o acesso dos usuários dele, sem apagar o histórico."
      needsTenant={false}
      action={<Button onClick={() => setOpen(NEW)}>Novo cliente</Button>}
    >
      <DataTable
        caption="Clientes"
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
        emptyTitle="Nenhum cliente cadastrado"
      />
      <Sheet
        open={open !== null}
        onOpenChange={(value) => {
          if (!value) setOpen(null);
        }}
        title={open === NEW ? 'Novo cliente' : 'Cliente'}
      >
        {open === NEW ? (
          <TenantForm onDone={() => setOpen(null)} />
        ) : (
          open && <ExistingTenant id={open} onDone={() => setOpen(null)} />
        )}
      </Sheet>
    </AdminShell>
  );
}

function ExistingTenant({ id, onDone }: { id: string; onDone: () => void }) {
  const tenant = useTenant(id);
  if (tenant.isError) return <ErrorState error={tenant.error} onRetry={() => void tenant.refetch()} />;
  if (!tenant.data) return <LoadingState rows={6} label="Carregando o cliente" />;
  return <TenantForm key={tenant.data.updatedAt} tenant={tenant.data} onDone={onDone} />;
}

interface TenantValues {
  name: string;
  cnpj: string;
  plan: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}

function TenantForm({
  tenant,
  onDone,
}: {
  tenant?: NonNullable<ReturnType<typeof useTenant>['data']>;
  onDone: () => void;
}) {
  const [values, setValues] = useState<TenantValues>({
    name: tenant?.name ?? '',
    cnpj: tenant?.cnpj ?? '',
    plan: tenant?.plan ?? '',
    contactName: tenant?.escalationContact?.name ?? '',
    contactEmail: tenant?.escalationContact?.email ?? '',
    contactPhone: tenant?.escalationContact?.phone ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateTenant();
  const update = useUpdateTenant(tenant?.id ?? '');
  const busy = create.isPending || update.isPending;
  const set = (key: keyof TenantValues) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = tenantCreateSchema.safeParse({
      name: values.name,
      cnpj: values.cnpj,
      plan: values.plan,
      escalationContact: {
        name: values.contactName,
        email: values.contactEmail,
        phone: values.contactPhone.trim() || null,
      },
    });
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    if (tenant) update.mutate(input.data, { onSuccess: onDone });
    else create.mutate(input.data, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Nome" value={values.name} onChange={set('name')} error={errors['name']} maxLength={120} />
      <Field
        label="CNPJ"
        hint="Com ou sem pontuação; aceita o CNPJ alfanumérico."
        value={values.cnpj}
        onChange={set('cnpj')}
        error={errors['cnpj']}
      />
      <Field label="Plano" value={values.plan} onChange={set('plan')} error={errors['plan']} maxLength={60} />
      <fieldset className="space-y-3 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Contato de escalonamento</legend>
        <p className="text-xs text-muted-foreground">Quem a Verax aciona num incidente grave.</p>
        <Field
          label="Nome do contato"
          value={values.contactName}
          onChange={set('contactName')}
          error={errors['escalationContact.name']}
        />
        <Field
          label="E-mail do contato"
          type="email"
          value={values.contactEmail}
          onChange={set('contactEmail')}
          error={errors['escalationContact.email']}
        />
        <Field
          label="Telefone do contato (opcional)"
          type="tel"
          value={values.contactPhone}
          onChange={set('contactPhone')}
          error={errors['escalationContact.phone']}
        />
      </fieldset>
      <FormError error={create.error ?? update.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {tenant ? 'Salvar' : 'Cadastrar cliente'}
        </Button>
        {tenant && (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() =>
              update.mutate(
                { status: tenant.status === 'active' ? 'inactive' : 'active' },
                { onSuccess: onDone },
              )
            }
          >
            {tenant.status === 'active' ? 'Desativar cliente' : 'Reativar cliente'}
          </Button>
        )}
      </div>
    </form>
  );
}

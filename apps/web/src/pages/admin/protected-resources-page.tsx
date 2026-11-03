import {
  PROTECTED_RESOURCE_TYPES,
  type ProtectedResource,
  protectedResourceCreateSchema,
  type ProtectedResourceType,
  protectedResourceUpdateSchema,
} from '@verax/shared';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import {
  ADMIN_PAGE_SIZE,
  useCreateProtected,
  useDeleteProtected,
  useProtectedList,
  useUpdateProtected,
} from '@/features/admin/admin-api';
import { AdminShell, ConfirmButton, FormError, SelectInput, TextAreaField } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { PROTECTED_TYPE_LABELS } from '@/features/admin/labels';
import { useMe } from '@/features/session/session';
import { formatRelative } from '@/lib/format';

const NEW = 'novo';
const TYPE_OPTIONS = PROTECTED_RESOURCE_TYPES.map((type) => ({
  value: type,
  label: PROTECTED_TYPE_LABELS[type],
}));

/** Lista de proteção (T7.4): itens críticos do cliente; alerta que os envolve sobe de prioridade. */
export function ProtectedResourcesPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const canWrite = me?.permissions.includes('protected_resources:write') === true;
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const list = useProtectedList(page, scope !== null);
  const open = params.get('item');
  const setOpen = (value: string | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set('item', value);
      else next.delete('item');
      return next;
    });
  const selected = list.data?.items.find((item) => item.id === open) ?? null;

  const columns: Column<ProtectedResource>[] = [
    { key: 'tipo', header: 'Tipo', cell: (row) => PROTECTED_TYPE_LABELS[row.type] },
    {
      key: 'item',
      header: 'Item',
      cell: (row) => (
        <button
          type="button"
          className="break-all text-left font-mono text-xs hover:underline"
          onClick={() => setOpen(row.id)}
        >
          {row.identifier}
        </button>
      ),
    },
    { key: 'motivo', header: 'Motivo', className: 'min-w-64', cell: (row) => row.reason },
    {
      key: 'quem',
      header: 'Incluído',
      className: 'whitespace-nowrap',
      cell: (row) => `${row.createdBy.name}, ${formatRelative(row.createdAt)}`,
    },
  ];

  return (
    <AdminShell
      title="Lista de proteção"
      description="Contas, identidades e recursos críticos do cliente. Um incidente que envolva um deles ganha +15 na nota de risco."
      action={canWrite && <Button onClick={() => setOpen(NEW)}>Incluir item</Button>}
    >
      <DataTable
        caption="Lista de proteção do cliente"
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
        emptyTitle="Lista vazia"
        emptyDescription="Inclua as contas, usuários e buckets que não podem ser tocados sem alguém saber."
      />
      <Sheet
        open={open === NEW || selected !== null}
        onOpenChange={(value) => {
          if (!value) setOpen(null);
        }}
        title={open === NEW ? 'Incluir na lista de proteção' : (selected?.identifier ?? 'Item')}
        description={selected ? PROTECTED_TYPE_LABELS[selected.type] : undefined}
      >
        {open === NEW ? (
          <CreateItem onDone={() => setOpen(null)} />
        ) : (
          selected && (
            <EditItem key={selected.id} item={selected} canWrite={canWrite} onDone={() => setOpen(null)} />
          )
        )}
      </Sheet>
    </AdminShell>
  );
}

function CreateItem({ onDone }: { onDone: () => void }) {
  const [values, setValues] = useState({
    type: 'aws_account' as ProtectedResourceType,
    identifier: '',
    reason: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateProtected();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = protectedResourceCreateSchema.safeParse(values);
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    create.mutate(input.data, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <SelectInput
        label="Tipo"
        value={values.type}
        onChange={(event) => setValues({ ...values, type: event.target.value as ProtectedResourceType })}
        options={TYPE_OPTIONS}
      />
      <Field
        label="Identificador"
        hint="O ID da conta, o nome ou ARN do usuário, o ID da chave, da instância ou do grupo, o nome do bucket ou o IP."
        value={values.identifier}
        onChange={(event) => setValues({ ...values, identifier: event.target.value })}
        error={errors['identifier']}
      />
      <TextAreaField
        label="Motivo (obrigatório)"
        value={values.reason}
        onChange={(event) => setValues({ ...values, reason: event.target.value })}
        error={errors['reason']}
        maxLength={500}
      />
      <FormError error={create.error} />
      <Button type="submit" disabled={create.isPending}>
        Incluir
      </Button>
    </form>
  );
}

function EditItem({
  item,
  canWrite,
  onDone,
}: {
  item: ProtectedResource;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [reason, setReason] = useState(item.reason);
  const [error, setError] = useState<string>();
  const update = useUpdateProtected(item.id);
  const remove = useDeleteProtected(item.id);

  if (!canWrite) return <p className="text-sm">{item.reason}</p>;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = protectedResourceUpdateSchema.safeParse({ reason });
    if (!input.success) {
      setError(fieldErrors(input.error)['reason']);
      return;
    }
    setError(undefined);
    update.mutate(input.data, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <TextAreaField
        label="Motivo"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={error}
        maxLength={500}
      />
      <FormError error={update.error ?? remove.error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={update.isPending}>
          Salvar motivo
        </Button>
        <ConfirmButton
          label="Remover da lista"
          confirmLabel="Confirmar remoção"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(undefined, { onSuccess: onDone })}
        />
      </div>
    </form>
  );
}

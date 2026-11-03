import {
  ALERT_EXCEPTION_FIELDS,
  type AlertException,
  alertExceptionCreateSchema,
  type AlertExceptionField,
  alertExceptionUpdateSchema,
} from '@verax/shared';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import {
  ADMIN_PAGE_SIZE,
  useCreateException,
  useDeleteException,
  useExceptionList,
  useUpdateException,
} from '@/features/admin/admin-api';
import { AdminShell, ConfirmButton, FormError, SelectInput, TextAreaField } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { EXCEPTION_FIELD_LABELS } from '@/features/admin/labels';
import { useMe } from '@/features/session/session';
import { formatRelative, plural } from '@/lib/format';

const NEW = 'nova';
const FIELD_OPTIONS = ALERT_EXCEPTION_FIELDS.map((field) => ({
  value: field,
  label: EXCEPTION_FIELD_LABELS[field],
}));
const dayFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short' });

/** Data do campo (AAAA-MM-DD) como o fim daquele dia, no fuso do navegador; vazio é sem validade. */
const endOfDay = (date: string): string | null => (date ? new Date(`${date}T23:59:59`).toISOString() : null);
const toDateInput = (iso: string | null): string => {
  if (!iso) return '';
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/** Exceções (T7.5): comportamentos esperados; os achados iguais entram como legítimos, sem pedir decisão. */
export function ExceptionsPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const canWrite = me?.permissions.includes('alert_exceptions:write') === true;
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const list = useExceptionList(page, scope !== null);
  const open = params.get('excecao');
  const setOpen = (value: string | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set('excecao', value);
      else next.delete('excecao');
      return next;
    });
  const selected = list.data?.items.find((item) => item.id === open) ?? null;

  const columns: Column<AlertException>[] = [
    {
      key: 'regra',
      header: 'Regra',
      cell: (row) => (
        <button type="button" className="font-mono text-sm hover:underline" onClick={() => setOpen(row.id)}>
          {row.ruleId}
        </button>
      ),
    },
    {
      key: 'quando',
      header: 'Quando',
      cell: (row) => (
        <span>
          {EXCEPTION_FIELD_LABELS[row.field]}:{' '}
          <span className="break-all font-mono text-xs">{row.value}</span>
        </span>
      ),
    },
    { key: 'motivo', header: 'Motivo', className: 'min-w-64', cell: (row) => row.reason },
    {
      key: 'marcou',
      header: 'Já marcou',
      className: 'whitespace-nowrap',
      cell: (row) => (
        <span>
          {plural(row.matchedCount, 'achado', 'achados')}
          {row.lastMatchedAt && (
            <span className="block text-xs text-muted-foreground">
              último {formatRelative(row.lastMatchedAt)}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'validade',
      header: 'Validade',
      className: 'whitespace-nowrap',
      cell: (row) =>
        !row.expiresAt ? (
          'Sem validade'
        ) : row.active ? (
          `até ${dayFormat.format(new Date(row.expiresAt))}`
        ) : (
          <span className="font-medium text-critical">
            Vencida em {dayFormat.format(new Date(row.expiresAt))}
          </span>
        ),
    },
  ];

  return (
    <AdminShell
      title="Exceções"
      description="Comportamentos esperados do cliente. Um alerta da regra com o mesmo usuário, IP ou recurso entra como legítimo, sem pedir decisão."
      action={canWrite && <Button onClick={() => setOpen(NEW)}>Nova exceção</Button>}
    >
      <DataTable
        caption="Exceções de alerta do cliente"
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
        emptyTitle="Nenhuma exceção"
        emptyDescription="Ao marcar um achado como legítimo, o painel oferece criar a exceção."
      />
      <Sheet
        open={open === NEW || selected !== null}
        onOpenChange={(value) => {
          if (!value) setOpen(null);
        }}
        title={open === NEW ? 'Nova exceção' : `Exceção da regra ${selected?.ruleId ?? ''}`}
        description={selected ? `${EXCEPTION_FIELD_LABELS[selected.field]}: ${selected.value}` : undefined}
      >
        {open === NEW ? (
          <CreateException onDone={() => setOpen(null)} />
        ) : (
          selected && (
            <EditException
              key={selected.id}
              exception={selected}
              canWrite={canWrite}
              onDone={() => setOpen(null)}
            />
          )
        )}
      </Sheet>
    </AdminShell>
  );
}

function CreateException({ onDone }: { onDone: () => void }) {
  const [values, setValues] = useState({
    ruleId: '',
    field: 'user' as AlertExceptionField,
    value: '',
    reason: '',
    expires: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateException();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = alertExceptionCreateSchema.safeParse({
      ruleId: values.ruleId.trim(),
      field: values.field,
      value: values.value,
      reason: values.reason,
      expiresAt: endOfDay(values.expires),
    });
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    create.mutate(input.data, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label="Regra"
        hint="O número da regra, que aparece no detalhe do achado (do Wazuh ou da auditoria da GCP)."
        inputMode="numeric"
        value={values.ruleId}
        onChange={(event) => setValues({ ...values, ruleId: event.target.value })}
        error={errors['ruleId']}
      />
      <SelectInput
        label="Comparar por"
        value={values.field}
        onChange={(event) => setValues({ ...values, field: event.target.value as AlertExceptionField })}
        options={FIELD_OPTIONS}
      />
      <Field
        label="Valor"
        hint={values.field === 'ip' ? 'Um IP ou uma faixa CIDR, como 203.0.113.0/24.' : undefined}
        value={values.value}
        onChange={(event) => setValues({ ...values, value: event.target.value })}
        error={errors['value']}
      />
      <TextAreaField
        label="Motivo (obrigatório)"
        value={values.reason}
        onChange={(event) => setValues({ ...values, reason: event.target.value })}
        error={errors['reason']}
        maxLength={500}
      />
      <Field
        label="Validade (opcional)"
        hint="Até um ano. Sem validade, a exceção vale até ser removida."
        type="date"
        value={values.expires}
        onChange={(event) => setValues({ ...values, expires: event.target.value })}
        error={errors['expiresAt']}
      />
      <FormError error={create.error} />
      <Button type="submit" disabled={create.isPending}>
        Criar exceção
      </Button>
    </form>
  );
}

function EditException({
  exception,
  canWrite,
  onDone,
}: {
  exception: AlertException;
  canWrite: boolean;
  onDone: () => void;
}) {
  const [reason, setReason] = useState(exception.reason);
  const [expires, setExpires] = useState(toDateInput(exception.expiresAt));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const update = useUpdateException(exception.id);
  const remove = useDeleteException(exception.id);
  const summary = `${plural(exception.matchedCount, 'achado marcado', 'achados marcados')} por esta exceção${
    exception.lastMatchedAt ? `, o último ${formatRelative(exception.lastMatchedAt)}` : ''
  }.`;

  if (!canWrite) {
    return (
      <div className="space-y-2 text-sm">
        <p>{exception.reason}</p>
        <p className="text-muted-foreground">{summary}</p>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Só manda a validade se ela mudou: reenviar a de antes bloquearia a exceção vencida (data no passado) e
    // estenderia até o fim do dia uma validade precisa definida pela API.
    const expiryChanged = expires !== toDateInput(exception.expiresAt);
    const input = alertExceptionUpdateSchema.safeParse({
      reason,
      ...(expiryChanged ? { expiresAt: endOfDay(expires) } : {}),
    });
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    update.mutate(input.data, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <p className="text-sm text-muted-foreground">{summary}</p>
      <TextAreaField
        label="Motivo"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        error={errors['reason']}
        maxLength={500}
      />
      <Field
        label="Validade"
        hint="Deixe em branco para valer até ser removida."
        type="date"
        value={expires}
        onChange={(event) => setExpires(event.target.value)}
        error={errors['expiresAt']}
      />
      <FormError error={update.error ?? remove.error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={update.isPending}>
          Salvar
        </Button>
        <ConfirmButton
          label="Remover exceção"
          confirmLabel="Confirmar remoção"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(undefined, { onSuccess: onDone })}
        />
      </div>
    </form>
  );
}

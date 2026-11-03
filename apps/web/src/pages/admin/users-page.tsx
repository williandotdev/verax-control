import { ROLE_LABELS, TENANT_ROLES, type TenantRole, type User, userInviteSchema } from '@verax/shared';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import {
  ADMIN_PAGE_SIZE,
  useInviteUser,
  useResendInvite,
  useUpdateUser,
  useUserList,
} from '@/features/admin/admin-api';
import { AdminShell, FormError, SelectInput } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { USER_STATUS_LABELS } from '@/features/admin/labels';
import { useMe } from '@/features/session/session';

const NEW = 'convite';
const ROLE_OPTIONS = TENANT_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

/** Usuários do cliente (T7.2): listar, convidar, alterar papel e desativar. */
export function UsersPage() {
  const { data: me } = useMe();
  const scope = me?.scopeTenantId ?? null;
  const canWrite = me?.permissions.includes('users:write') === true;
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number.parseInt(params.get('pagina') ?? '1', 10) || 1);
  const list = useUserList(page, scope !== null);
  const open = params.get('usuario');
  const setOpen = (value: string | null) =>
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set('usuario', value);
      else next.delete('usuario');
      return next;
    });
  const selected = list.data?.items.find((user) => user.id === open) ?? null;

  const columns: Column<User>[] = [
    {
      key: 'nome',
      header: 'Usuário',
      cell: (row) => (
        <button type="button" className="text-left hover:underline" onClick={() => setOpen(row.id)}>
          <span className="font-medium">{row.name}</span>
          <span className="block text-xs text-muted-foreground">{row.email}</span>
        </button>
      ),
    },
    { key: 'papel', header: 'Papel', cell: (row) => ROLE_LABELS[row.role] },
    { key: 'status', header: 'Status', cell: (row) => USER_STATUS_LABELS[row.status] },
    {
      key: 'mfa',
      header: 'MFA',
      cell: (row) =>
        row.mfaEnabled ? 'Cadastrado' : <span className="text-muted-foreground">Pendente</span>,
    },
  ];

  return (
    <AdminShell
      title="Usuários"
      description="Quem acessa o painel deste cliente. Todo usuário entra por convite e cadastra o MFA no primeiro acesso."
      action={canWrite && <Button onClick={() => setOpen(NEW)}>Convidar usuário</Button>}
    >
      <DataTable
        caption="Usuários do cliente"
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
        emptyTitle="Nenhum usuário ainda"
      />
      <Sheet
        open={open === NEW || selected !== null}
        onOpenChange={(value) => {
          if (!value) setOpen(null);
        }}
        title={open === NEW ? 'Convidar usuário' : (selected?.name ?? 'Usuário')}
        description={selected?.email}
      >
        {open === NEW ? (
          <InviteForm onDone={() => setOpen(null)} />
        ) : (
          selected && (
            <UserAccess
              key={selected.id}
              user={selected}
              isSelf={selected.id === me?.userId}
              canWrite={canWrite}
            />
          )
        )}
      </Sheet>
    </AdminShell>
  );
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const [values, setValues] = useState({ name: '', email: '', role: 'analista_cliente' as TenantRole });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const invite = useInviteUser();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = userInviteSchema.safeParse(values);
    if (!input.success) {
      setErrors(fieldErrors(input.error));
      return;
    }
    setErrors({});
    invite.mutate(input.data, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field
        label="Nome"
        value={values.name}
        onChange={(event) => setValues({ ...values, name: event.target.value })}
        error={errors['name']}
      />
      <Field
        label="E-mail"
        type="email"
        value={values.email}
        onChange={(event) => setValues({ ...values, email: event.target.value })}
        error={errors['email']}
      />
      <SelectInput
        label="Papel"
        value={values.role}
        onChange={(event) => setValues({ ...values, role: event.target.value as TenantRole })}
        options={ROLE_OPTIONS}
        error={errors['role']}
      />
      <p className="text-xs text-muted-foreground">
        O convite chega por e-mail, com um link de uso único que vale 60 minutos.
      </p>
      <FormError error={invite.error} />
      <Button type="submit" disabled={invite.isPending}>
        Enviar convite
      </Button>
    </form>
  );
}

function UserAccess({ user, isSelf, canWrite }: { user: User; isSelf: boolean; canWrite: boolean }) {
  const update = useUpdateUser(user.id);
  const resend = useResendInvite(user.id);
  if (isSelf) {
    return (
      <p className="text-sm text-muted-foreground">
        Ninguém altera o próprio acesso: peça a outro administrador.
      </p>
    );
  }
  if (!canWrite) {
    return (
      <p className="text-sm">
        {ROLE_LABELS[user.role]} · {USER_STATUS_LABELS[user.status]}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <SelectInput
        label="Papel"
        value={user.role}
        disabled={update.isPending}
        onChange={(event) => update.mutate({ role: event.target.value as TenantRole })}
        options={ROLE_OPTIONS}
      />
      <div className="flex flex-wrap gap-2">
        {user.status !== 'invited' && (
          <Button
            variant="secondary"
            disabled={update.isPending}
            onClick={() => update.mutate({ status: user.status === 'disabled' ? 'active' : 'disabled' })}
          >
            {user.status === 'disabled' ? 'Reativar acesso' : 'Desativar acesso'}
          </Button>
        )}
        {user.status === 'invited' && (
          <Button variant="secondary" disabled={resend.isPending} onClick={() => resend.mutate(undefined)}>
            Reenviar convite
          </Button>
        )}
      </div>
      {resend.isSuccess && (
        <p role="status" className="text-sm">
          Convite reenviado para {user.email}.
        </p>
      )}
      <FormError error={update.error ?? resend.error} />
    </div>
  );
}

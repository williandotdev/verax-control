import {
  ROLE_LABELS,
  TEMPORARY_PASSWORD_HOURS,
  TENANT_ROLES,
  type TenantRole,
  type User,
  userCreateSchema,
} from '@verax/shared';
import { type FormEvent, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type Column, DataTable } from '@/components/data-table';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Sheet } from '@/components/ui/sheet';
import {
  ADMIN_PAGE_SIZE,
  useCreateUser,
  useGenerateTemporaryPassword,
  useUpdateUser,
  useUserList,
} from '@/features/admin/admin-api';
import { AdminShell, ConfirmButton, FormError, SelectInput } from '@/features/admin/admin-ui';
import { fieldErrors } from '@/features/admin/forms';
import { USER_STATUS_LABELS } from '@/features/admin/labels';
import { TemporaryPasswordNotice } from '@/features/admin/temporary-password';
import { useMe } from '@/features/session/session';

const NEW = 'novo';
const ROLE_OPTIONS = TENANT_ROLES.map((role) => ({ value: role, label: ROLE_LABELS[role] }));

/** Ainda com a senha temporária: não entrou nem trocou. Conta desativada não entra, então não conta. */
const awaitingFirstAccess = (user: User) => user.mustChangePassword && user.status !== 'disabled';

/** Usuários do cliente (T7.2): listar, criar com senha temporária, alterar papel, desativar e gerar senha nova. */
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
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <>
          {USER_STATUS_LABELS[row.status]}
          {awaitingFirstAccess(row) && (
            <span className="block text-xs text-muted-foreground">Com senha temporária</span>
          )}
        </>
      ),
    },
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
      description="Quem acessa o painel deste cliente. Toda conta nasce com uma senha temporária: no primeiro acesso, a pessoa troca a senha e cadastra o MFA."
      action={canWrite && <Button onClick={() => setOpen(NEW)}>Criar usuário</Button>}
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
        title={open === NEW ? 'Criar usuário' : (selected?.name ?? 'Usuário')}
        description={selected?.email}
      >
        {open === NEW ? (
          <CreateUserForm onDone={() => setOpen(null)} />
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

function CreateUserForm({ onDone }: { onDone: () => void }) {
  const [values, setValues] = useState({ name: '', email: '', role: 'analista_cliente' as TenantRole });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateUser();

  // A senha temporária aparece uma vez, no lugar do formulário; ao concluir (ou fechar o painel), ela some.
  if (create.data) {
    const { user } = create.data;
    return (
      <TemporaryPasswordNotice
        title={`Senha temporária de ${user.name}`}
        summary={`Conta de ${user.name} (${user.email}) criada.`}
        password={create.data}
        hasMfa={false}
        onDone={onDone}
      />
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input = userCreateSchema.safeParse(values);
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
        A conta nasce com uma senha temporária, que aparece uma única vez depois de criar e vale por{' '}
        {TEMPORARY_PASSWORD_HOURS} horas. Nenhum e-mail é enviado: você manda a senha à pessoa.
      </p>
      <FormError error={create.error} />
      <Button type="submit" disabled={create.isPending}>
        Criar usuário
      </Button>
    </form>
  );
}

function UserAccess({ user, isSelf, canWrite }: { user: User; isSelf: boolean; canWrite: boolean }) {
  const update = useUpdateUser(user.id);
  const generate = useGenerateTemporaryPassword(user.id);
  if (isSelf) {
    return (
      <p className="text-sm text-muted-foreground">
        Ninguém altera o próprio acesso: peça a outro administrador.
      </p>
    );
  }
  const pending =
    user.status === 'invited'
      ? 'Conta do antigo convite por e-mail, ainda sem senha: o acesso começa com uma senha temporária.'
      : awaitingFirstAccess(user)
        ? 'Ainda com a senha temporária: não entrou nem trocou a senha.'
        : undefined;
  const firstAccess = pending && <p className="text-sm text-muted-foreground">{pending}</p>;
  if (!canWrite) {
    return (
      <div className="space-y-2">
        <p className="text-sm">
          {ROLE_LABELS[user.role]} · {USER_STATUS_LABELS[user.status]}
        </p>
        {firstAccess}
      </div>
    );
  }
  if (generate.data) {
    return (
      <TemporaryPasswordNotice
        title={`Senha temporária de ${user.name}`}
        summary="Senha temporária nova gerada. A anterior deixou de valer, e as sessões abertas foram encerradas."
        password={generate.data}
        hasMfa={user.mfaEnabled}
        onDone={() => generate.reset()}
      />
    );
  }
  return (
    <div className="space-y-4">
      {firstAccess}
      <SelectInput
        label="Papel"
        value={user.role}
        disabled={update.isPending}
        onChange={(event) => update.mutate({ role: event.target.value as TenantRole })}
        options={ROLE_OPTIONS}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={update.isPending}
          onClick={() => update.mutate({ status: user.status === 'disabled' ? 'active' : 'disabled' })}
        >
          {user.status === 'disabled' ? 'Reativar acesso' : 'Desativar acesso'}
        </Button>
      </div>
      <section aria-labelledby="senha-temporaria" className="space-y-2 rounded-md border p-3">
        <h3 id="senha-temporaria" className="text-sm font-semibold">
          Senha temporária
        </h3>
        {user.status === 'disabled' ? (
          <p className="text-sm text-muted-foreground">
            Conta desativada: reative o acesso para gerar uma senha temporária.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Para quem esqueceu a senha ou não entrou a tempo. A senha nova vale por{' '}
              {TEMPORARY_PASSWORD_HOURS} horas, e no próximo login a pessoa a troca por uma só dela.
            </p>
            <ConfirmButton
              label="Gerar senha temporária"
              confirmLabel="Gerar e encerrar as sessões"
              warning={`A senha atual de ${user.name} deixa de valer, e as sessões abertas da conta caem na hora.`}
              busy={generate.isPending}
              onConfirm={() => generate.mutate(undefined)}
            />
          </>
        )}
      </section>
      <FormError error={update.error ?? generate.error} />
    </div>
  );
}

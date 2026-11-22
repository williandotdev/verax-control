import { CircleCheck, CircleX, Clock, Hourglass } from 'lucide-react';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError, tenantsApi } from '@/lib/api';
import type { NodeUserCreated, NodeUserStatus, NodeUserView, TenantRole } from '@/lib/api-types';
import { cn } from '@/lib/cn';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  CUSTOMER_USER_STATUS_LABELS,
  NODE_USER_BLOCK_MESSAGES,
  NODE_USER_CODE_MESSAGES,
  NODE_USER_STATUS_LABELS,
  ROLE_LABELS,
  TENANT_ROLES,
} from './labels';
import { type AccessRow, OneTimeAccess } from './one-time-access';
import { useInvalidateNodeSync, useNodeSync } from './queries';

const INPUT =
  'h-9 w-full rounded-md border border-border-strong bg-surface-raised px-3 text-sm placeholder:text-subtle-foreground aria-invalid:border-critical';

/** O e-mail no formato que vale (a API confere de novo). */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A mensagem pronta para a pessoa do cliente, com o acesso e o que acontece no primeiro login. */
function newUserMessage(created: NodeUserCreated): string {
  return [
    'Olá! O seu acesso ao Verax Control foi criado.',
    '',
    `Painel: ${created.panelUrl}`,
    `Login: ${created.email}`,
    `Senha temporária: ${created.temporaryPassword}`,
    `Válida até: ${formatDateTime(created.notAfter)} (horário de Brasília)`,
    '',
    'No primeiro acesso, troque a senha e configure a verificação em duas etapas (MFA), com um aplicativo autenticador.',
  ].join('\n');
}

/** O usuário recém-pedido: só no estado desta tela, nunca na URL, no armazenamento do navegador, no cache ou no log. */
function CreatedUser({ created, onClose }: { created: NodeUserCreated; onClose: () => void }) {
  const rows: readonly AccessRow[] = [
    { target: 'panel', label: 'Painel', value: created.panelUrl, mono: true },
    { target: 'login', label: 'Login', value: created.email, mono: true },
    { target: 'password', label: 'Senha temporária', value: created.temporaryPassword, mono: true },
    { target: 'expiry', label: 'Válida até', value: formatDateTime(created.notAfter), mono: false },
  ];
  return (
    <OneTimeAccess
      label="Acesso do novo usuário para enviar ao cliente"
      rows={rows}
      message={newUserMessage(created)}
      onClose={onClose}
      footer={
        <>
          <p>
            O servidor do cliente cria a conta ({ROLE_LABELS[created.role]}) na próxima sincronização, em até
            uns 5 minutos: a senha só funciona depois que o pedido aparecer como “Criado” na lista abaixo.
          </p>
          <p>
            No primeiro acesso, o painel pede para a pessoa trocar a senha e configurar a verificação em duas
            etapas (MFA).
          </p>
        </>
      }
    />
  );
}

/** Os problemas de cada campo que a API devolveu (`details.issues`), pelo caminho. */
function issuesByField(error: unknown): Partial<Record<'name' | 'email' | 'role', string[]>> {
  if (!(error instanceof ApiError)) return {};
  const result: Partial<Record<'name' | 'email' | 'role', string[]>> = {};
  for (const issue of error.issues) {
    if (issue.path === 'name' || issue.path === 'email' || issue.path === 'role') {
      result[issue.path] = [...(result[issue.path] ?? []), issue.message];
    }
  }
  return result;
}

/** O formulário do pedido: nome, e-mail e papel. A chamada vai direto à API, sem o cache das mutações. */
function CreateUserForm({
  tenantId,
  onCreated,
  onCancel,
}: {
  tenantId: string;
  onCreated: (created: NodeUserCreated) => void;
  onCancel: () => void;
}) {
  const ids = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TenantRole>('analista_cliente');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [touched, setTouched] = useState(false);

  const local: Partial<Record<'name' | 'email', string>> = {};
  if (touched && name.trim() === '') local.name = 'Informe o nome.';
  if (touched && !EMAIL.test(email.trim())) local.email = 'Informe um e-mail válido.';
  const remote = issuesByField(error);
  const fieldErrors = (field: 'name' | 'email' | 'role'): string[] => [
    ...(field !== 'role' && local[field] !== undefined ? [local[field]] : []),
    ...(remote[field] ?? []),
  ];

  async function submit(event: FormEvent) {
    event.preventDefault();
    setTouched(true);
    if (busy || name.trim() === '' || !EMAIL.test(email.trim())) return;
    setBusy(true);
    setError(undefined);
    try {
      onCreated(await tenantsApi.createUser(tenantId, { name: name.trim(), email: email.trim(), role }));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  function field(
    key: 'name' | 'email' | 'role',
    label: string,
    control: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode,
    hint?: string,
  ) {
    const id = `${ids}-${key}`;
    const errors = fieldErrors(key);
    const describedBy =
      [hint === undefined ? undefined : `${id}-dica`, errors.length === 0 ? undefined : `${id}-erro`]
        .filter(Boolean)
        .join(' ') || undefined;
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {control({ id, describedBy, invalid: errors.length > 0 })}
        {hint !== undefined && (
          <p id={`${id}-dica`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
        {errors.length > 0 && (
          <p id={`${id}-erro`} className="text-xs text-critical-text">
            {errors.join(' · ')}
          </p>
        )}
      </div>
    );
  }

  const generalError =
    error !== undefined && !(error instanceof ApiError && error.code === 'invalid_request')
      ? errorMessage(error)
      : undefined;

  return (
    <form
      noValidate
      aria-label="Criar usuário do cliente"
      onSubmit={(event) => void submit(event)}
      className="space-y-3 rounded-lg border border-border-strong p-3"
    >
      <div className="grid gap-3 sm:grid-cols-3">
        {field('name', 'Nome', ({ id, describedBy, invalid }) => (
          <input
            id={id}
            className={INPUT}
            type="text"
            autoComplete="off"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          />
        ))}
        {field(
          'email',
          'E-mail (o login)',
          ({ id, describedBy, invalid }) => (
            <input
              id={id}
              className={cn(INPUT, 'font-mono')}
              type="email"
              autoComplete="off"
              spellCheck={false}
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          ),
          'Nenhum e-mail sai da Verax: você manda o acesso à pessoa.',
        )}
        {field('role', 'Papel', ({ id, describedBy, invalid }) => (
          <select
            id={id}
            className="h-9 rounded-md border border-border-strong bg-surface-raised px-2 text-sm"
            value={role}
            onChange={(event) => setRole(event.target.value as TenantRole)}
            aria-describedby={describedBy}
            aria-invalid={invalid || undefined}
          >
            {TENANT_ROLES.map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]}
              </option>
            ))}
          </select>
        ))}
      </div>
      {generalError !== undefined && (
        <div role="alert" className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-sm">
          {generalError}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? 'Criando…' : 'Criar usuário'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>
          Voltar
        </Button>
      </div>
    </form>
  );
}

const STATUS_ICONS: Readonly<Record<NodeUserStatus, ReactNode>> = {
  pending: <Hourglass aria-hidden className="size-3.5" />,
  created: <CircleCheck aria-hidden className="size-3.5 text-ok" />,
  failed: <CircleX aria-hidden className="size-3.5 text-critical" />,
  expired: <Clock aria-hidden className="size-3.5 text-subtle-foreground" />,
};

/** A situação do pedido, sempre com ícone e texto (nunca só a cor). */
function NodeUserStatusBadge({ status }: { status: NodeUserStatus }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        status === 'failed' && 'border-critical/50 bg-critical/5 text-critical-text',
      )}
    >
      {STATUS_ICONS[status]}
      {NODE_USER_STATUS_LABELS[status]}
    </span>
  );
}

/** O detalhe da situação: o prazo, a conta criada, o motivo da recusa. */
function statusDetail(user: NodeUserView): string {
  switch (user.status) {
    case 'pending':
      return `O servidor do cliente cria na próxima sincronização. A senha vale até ${formatDateTime(user.notAfter)}.`;
    case 'created': {
      const account = user.user;
      if (account === undefined) return 'Conta criada no painel do cliente.';
      return [
        `Conta ${CUSTOMER_USER_STATUS_LABELS[account.status].toLowerCase()}`,
        account.mustChangePassword ? 'ainda com a senha temporária' : 'senha trocada',
        account.mfaEnabled ? 'MFA configurado' : 'MFA ainda não configurado',
      ].join(' · ');
    }
    case 'failed':
      return user.code === undefined
        ? NODE_USER_CODE_MESSAGES.internal_error
        : NODE_USER_CODE_MESSAGES[user.code];
    case 'expired':
      return user.code === undefined
        ? 'O pedido perdeu a validade sem o servidor do cliente criar a conta (o prazo passou, ou o servidor foi reinstalado): peça de novo.'
        : NODE_USER_CODE_MESSAGES[user.code];
  }
}

function UsersTable({ users }: { users: readonly NodeUserView[] }) {
  if (users.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum usuário pedido pela Verax ainda.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <caption className="sr-only">Usuários pedidos pela Verax, do mais novo ao mais antigo</caption>
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="py-1 pr-3 font-medium">
              Pessoa
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Papel
            </th>
            <th scope="col" className="py-1 pr-3 font-medium">
              Situação
            </th>
            <th scope="col" className="py-1 font-medium">
              Pedido
            </th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.requestId} className="border-t align-top">
              <td className="py-2 pr-3">
                <p>{user.name}</p>
                <p className="font-mono text-xs break-all text-muted-foreground">{user.email}</p>
              </td>
              <td className="py-2 pr-3">{ROLE_LABELS[user.role]}</td>
              <td className="py-2 pr-3">
                <NodeUserStatusBadge status={user.status} />
                <p className="mt-1 text-xs text-muted-foreground">{statusDetail(user)}</p>
              </td>
              <td className="py-2 text-xs text-muted-foreground">
                <p className="tabular-nums">{formatDateTime(user.createdAt)}</p>
                <p className="break-all">{user.createdBy.replace(/^owner:/, '')}</p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Os usuários do cliente que a Verax cria pelo console: o pedido (nome, e-mail e papel), a senha temporária mostrada uma
 * única vez com os botões de copiar e a mensagem pronta, e a lista com o que o servidor do cliente contou de cada
 * pedido. O botão fica desligado, com o motivo, enquanto o servidor do cliente não pode receber usuários. A senha fica
 * só no estado deste componente: a chamada não passa pelo cache das consultas (nem pelo das mutações), e some ao fechar
 * ou ao sair da página. Na v1 não há alteração nem remoção: o administrador do cliente cuida das contas no painel.
 */
export function NodeUsers({ tenantId }: { tenantId: string }) {
  const sync = useNodeSync(tenantId);
  const invalidate = useInvalidateNodeSync();
  const ids = useId();
  const [formOpen, setFormOpen] = useState(false);
  const [created, setCreated] = useState<NodeUserCreated | undefined>(undefined);

  async function onCreated(value: NodeUserCreated) {
    setCreated(value);
    setFormOpen(false);
    // A lista lida de novo traz o pedido (sem a senha, que nunca passa pela leitura).
    await invalidate(tenantId);
  }

  const data = sync.data;
  const blocked = data?.usersBlockedBy ?? null;
  return (
    <div className="space-y-3">
      <p className="text-sm">
        A Verax cria a conta no painel do cliente pela sincronização do servidor dele. A senha temporária
        aparece aqui uma única vez; no primeiro acesso, a pessoa troca a senha e configura a verificação em
        duas etapas (MFA). O cliente vê a criação na auditoria do painel, como “Verax (administrativo)”.
      </p>
      {/* O acesso recém-criado fica de pé mesmo se a releitura da lista falhar. */}
      {created !== undefined && <CreatedUser created={created} onClose={() => setCreated(undefined)} />}
      {data === undefined ? (
        sync.isError ? (
          <ErrorState error={sync.error} onRetry={() => void sync.refetch()} />
        ) : (
          <LoadingState label="Carregando os usuários do cliente" />
        )
      ) : (
        <>
          {formOpen && blocked === null ? (
            <CreateUserForm
              tenantId={tenantId}
              onCreated={(value) => void onCreated(value)}
              onCancel={() => setFormOpen(false)}
            />
          ) : (
            <div className="space-y-1">
              <Button
                variant="secondary"
                disabled={blocked !== null}
                aria-describedby={blocked === null ? undefined : `${ids}-bloqueio`}
                onClick={() => setFormOpen(true)}
              >
                Criar usuário…
              </Button>
              {blocked !== null && (
                <p id={`${ids}-bloqueio`} className="text-sm text-muted-foreground">
                  {NODE_USER_BLOCK_MESSAGES[blocked]}
                </p>
              )}
            </div>
          )}
          <UsersTable users={data.users} />
        </>
      )}
    </div>
  );
}

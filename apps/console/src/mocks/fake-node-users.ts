import type {
  NodeSyncOverview,
  NodeUserBlock,
  NodeUserView,
  TenantDetail,
  TenantRole,
  ValidationIssue,
} from '@/lib/api-types';
import type { FakeNodeSync, FakeResponse } from './fake-log-sources';

/**
 * Os usuários do cliente na API simulada do console, sobre o mesmo estado do nó das fontes de log
 * (`fake-log-sources.ts`): a parte `users` do `GET .../node-sync` e o `POST .../users`. Imita
 * `apps/control-plane/src/admin/admin-node-users.*`: as recusas (`node_not_synced`, `node_outdated`, `vault_disabled`,
 * `user_pending`, o contrato terminado), a senha temporária devolvida uma vez e o pedido que o "servidor do cliente"
 * cria (ou recusa) na sincronização seguinte. Pessoas e e-mails FICTÍCIOS; a senha é sorteada a cada pedido, nenhuma
 * fica no código.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** A validade da senha temporária (72 horas, como no painel). */
const VALIDITY = 72 * HOUR;
/** O "servidor do cliente" sincroniza a cada 5 minutos; aqui, 2 minutos depois do pedido ele já contou o resultado. */
const SYNC_DELAY = 2 * MINUTE;
const OWNER = 'owner:responsavel@verax.example';
const ROLES: readonly TenantRole[] = ['admin_cliente', 'analista_cliente', 'leitura'];
/** Um e-mail que já existe no painel do cliente de exemplo: o "nó" recusa com `email_taken`. */
const TAKEN_EMAIL_PREFIX = 'ja-existe@';

/**
 * Uma senha temporária de exemplo no formato da geradora (quatro grupos de cinco), com os caracteres hexadecimais de um
 * UUID aleatório: é só o mock (a senha de verdade sai do cp-admin), então não precisa do alfabeto da geradora.
 */
function fakeUserPassword(): string {
  const hex = crypto.randomUUID().replaceAll('-', '');
  return [0, 5, 10, 15].map((start) => hex.slice(start, start + 5)).join('-');
}

/** Um ULID de exemplo (só o formato: o tempo e a parte aleatória). */
function fakeUlid(at: Date): string {
  const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = at.getTime();
  let text = '';
  for (let i = 0; i < 10; i += 1) {
    text = crockford.charAt(time % 32) + text;
    time = Math.floor(time / 32);
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  return text + [...random].map((byte) => crockford.charAt(byte % 32)).join('');
}

/** Os pedidos de exemplo do cliente ativo: um criado, um recusado (`email_taken`) e um vencido. */
export function fakeNodeUsers(now: Date): NodeUserView[] {
  const at = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE).toISOString();
  const until = (minutes: number): string =>
    new Date(now.getTime() - minutes * MINUTE + VALIDITY).toISOString();
  return [
    {
      requestId: '01JC0000000000000000000U03',
      name: 'Pessoa Demo Três',
      email: 'pessoa.tres@cliente-demo-z.example',
      role: 'leitura',
      notAfter: until(60 * 80),
      createdAt: at(60 * 80),
      createdBy: OWNER,
      status: 'expired',
    },
    {
      requestId: '01JC0000000000000000000U02',
      name: 'Pessoa Demo Dois',
      email: 'ja-existe@cliente-demo-z.example',
      role: 'analista_cliente',
      notAfter: until(60 * 24),
      createdAt: at(60 * 24),
      createdBy: OWNER,
      status: 'failed',
      code: 'email_taken',
      reportedAt: at(60 * 24 - 5),
    },
    {
      requestId: '01JC0000000000000000000U01',
      name: 'Pessoa Demo Um',
      email: 'pessoa.um@cliente-demo-z.example',
      role: 'admin_cliente',
      notAfter: until(60 * 48),
      createdAt: at(60 * 48),
      createdBy: OWNER,
      status: 'created',
      user: { status: 'active', mfaEnabled: true, mustChangePassword: false },
      reportedAt: at(60 * 48 - 5),
    },
  ];
}

function error(status: number, message: string, code: string, details?: Record<string, unknown>) {
  return {
    status,
    body: { statusCode: status, message, code, ...(details === undefined ? {} : { details }) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** O que o "servidor do cliente" já contou: o pedido pendente há mais de 2 minutos vira criado (ou recusado). */
function advance(sync: FakeNodeSync, now: Date): void {
  sync.users = (sync.users ?? []).map((user) => {
    if (user.status !== 'pending') return user;
    if (Date.parse(user.notAfter) <= now.getTime()) return { ...user, status: 'expired' };
    if (Date.parse(user.createdAt) + SYNC_DELAY > now.getTime()) return user;
    const reportedAt = new Date(Date.parse(user.createdAt) + SYNC_DELAY).toISOString();
    if (user.email.startsWith(TAKEN_EMAIL_PREFIX)) {
      return { ...user, status: 'failed', code: 'email_taken', reportedAt };
    }
    return {
      ...user,
      status: 'created',
      user: { status: 'active', mfaEnabled: false, mustChangePassword: true },
      reportedAt,
    };
  });
}

function usersSupportedBy(sync: FakeNodeSync): boolean {
  return sync.node?.capabilities.includes('users') ?? false;
}

/** Por que o console não pode pedir usuário agora, como `nodeUserBlockOf` do cp-admin. */
function blockOf(tenant: TenantDetail, sync: FakeNodeSync): NodeUserBlock | null {
  if (tenant.state === 'canceled' || tenant.state === 'deleted') return 'not_allowed';
  if (sync.node === null || sync.node.nodeTenantId === null) return 'node_not_synced';
  if (!usersSupportedBy(sync)) return 'node_outdated';
  if (!sync.node.vaultReady) return 'vault_disabled';
  return null;
}

/** A parte dos usuários no `GET .../node-sync`. */
export function nodeUsersOverview(
  tenant: TenantDetail,
  sync: FakeNodeSync,
  now: Date,
): Pick<NodeSyncOverview, 'users' | 'usersSupported' | 'usersBlockedBy'> {
  advance(sync, now);
  return {
    users: [...(sync.users ?? [])],
    usersSupported: usersSupportedBy(sync),
    usersBlockedBy: blockOf(tenant, sync),
  };
}

const BLOCK_MESSAGES: Readonly<Record<NodeUserBlock, string>> = {
  not_allowed: 'O contrato deste cliente já terminou (cancelado ou excluído): não há usuário para criar.',
  placement_unsupported: 'Cliente da célula compartilhada: os usuários ainda não são criados pelo console.',
  node_not_synced:
    'O servidor do cliente ainda não sincronizou com o plano de controle: não há para quem mandar o usuário.',
  node_outdated: 'O servidor do cliente precisa da versão nova para receber usuários.',
  platform_mismatch:
    'O nó informou outra plataforma que a do lugar deste cliente: nada foi cifrado. Confira a instalação.',
  vault_disabled:
    'O nó deste cliente está sem o cofre de credenciais (ou não consegue lê-lo): não há para quem cifrar a senha.',
  vault_key_invalid:
    'A chave do cofre que o nó informou não confere (formato ou impressão digital): nada foi cifrado.',
};

/** Uma amostra da validação do `userCreateSchema` (a de verdade é o zod da API). */
function issuesOf(body: Record<string, unknown>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(body)) {
    if (!['name', 'email', 'role'].includes(key)) issues.push({ path: key, message: 'Campo desconhecido.' });
  }
  const name = typeof body['name'] === 'string' ? body['name'].trim() : '';
  if (name.length < 1 || name.length > 120) issues.push({ path: 'name', message: 'Informe o nome.' });
  const email = typeof body['email'] === 'string' ? body['email'] : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    issues.push({ path: 'email', message: 'E-mail inválido.' });
  }
  if (!ROLES.includes(body['role'] as TenantRole)) issues.push({ path: 'role', message: 'Papel inválido.' });
  return issues;
}

/** `POST .../users`: o pedido ao "servidor do cliente", com a senha temporária devolvida uma vez. */
export function createNodeUser(
  tenant: TenantDetail,
  sync: FakeNodeSync,
  now: Date,
  body: unknown,
): FakeResponse {
  advance(sync, now);
  const input = isRecord(body) ? body : {};
  const issues = issuesOf(input);
  if (issues.length > 0) return error(400, 'Dados inválidos.', 'invalid_request', { issues });
  const block = blockOf(tenant, sync);
  if (block !== null) return error(409, BLOCK_MESSAGES[block], block);
  const email = (input['email'] as string).toLowerCase();
  if ((sync.users ?? []).some((user) => user.status === 'pending' && user.email === email)) {
    return error(
      409,
      'Já há um pedido para este e-mail esperando o servidor do cliente: aguarde o resultado ou o prazo dele.',
      'user_pending',
      { issues: [{ path: 'email', message: 'Pedido pendente para este e-mail.' }] },
    );
  }
  const requestId = fakeUlid(now);
  const notAfter = new Date(now.getTime() + VALIDITY).toISOString();
  const role = input['role'] as TenantRole;
  sync.generation += 1;
  sync.users = [
    {
      requestId,
      name: (input['name'] as string).trim(),
      email,
      role,
      notAfter,
      createdAt: now.toISOString(),
      createdBy: OWNER,
      status: 'pending',
    },
    ...(sync.users ?? []),
  ];
  return {
    status: 201,
    body: {
      requestId,
      panelUrl: `https://${tenant.slug}.control.veraxsistemas.com.br`,
      email,
      role,
      temporaryPassword: fakeUserPassword(),
      notAfter,
    },
  };
}

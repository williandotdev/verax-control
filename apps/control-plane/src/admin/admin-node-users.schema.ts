import { type NodeSyncUserCode, type TenantRole, userCreateSchema, type UserStatus } from '@verax/shared';

/**
 * As formas da API dos usuários do cliente no console do responsável (`POST /v1/admin/tenants/:id/users` e a parte
 * `users` do `GET .../node-sync`, só no cp-admin): o usuário que a Verax pede ao nó do cliente, com a senha temporária
 * gerada aqui, mostrada uma única vez na resposta da criação e mandada ao nó só no envelope cifrado para o cofre dele.
 * A leitura nunca traz a senha nem o envelope: só o pedido e o que o nó contou.
 */

/** `POST .../users`: o nome, o e-mail e o papel, com as regras da criação de usuário do painel (`userCreateSchema`). */
export const nodeUserCreateRequestSchema = userCreateSchema;

/**
 * A situação do pedido para o console:
 * - `pending`: o envelope espera o nó (ainda sem relato e no prazo);
 * - `created`: o nó criou a conta (a situação dela em `user`);
 * - `failed`: o nó recusou (o código em `code`);
 * - `expired`: o prazo (`notAfter`) passou sem o nó criar a conta, ou o envelope foi descartado antes (o nó foi
 *   reinstalado, com outra chave do cofre): peça de novo.
 */
export const NODE_USER_STATUSES = ['pending', 'created', 'failed', 'expired'] as const;
export type NodeUserStatus = (typeof NODE_USER_STATUSES)[number];

/** Um usuário pedido ao nó, com o último relato dele. Nunca a senha nem o envelope. */
export interface NodeUserView {
  requestId: string;
  name: string;
  email: string;
  role: TenantRole;
  /** Até quando a senha temporária vale (e o nó aceita criar a conta). */
  notAfter: Date;
  createdAt: Date;
  createdBy: string;
  status: NodeUserStatus;
  /** O código do nó, quando ele recusou (ou contou o prazo vencido). */
  code?: NodeSyncUserCode;
  /** A conta no painel do cliente, quando o nó a criou. */
  user?: { status: UserStatus; mfaEnabled: boolean; mustChangePassword: boolean };
  /** Quando chegou o último relato do nó sobre o pedido. */
  reportedAt?: Date;
}

/**
 * Por que o console não pode pedir usuário agora (a mesma conferência da criação, sem gastar o limite): o contrato
 * terminou, cliente da célula, o nó nunca sincronizou, é de versão sem a criação de usuários, é de outra plataforma,
 * está sem o cofre ou com a chave que não confere.
 */
export type NodeUserBlock =
  | 'not_allowed'
  | 'placement_unsupported'
  | 'node_not_synced'
  | 'node_outdated'
  | 'platform_mismatch'
  | 'vault_disabled'
  | 'vault_key_invalid';

/**
 * A resposta da criação (201), uma única vez: o painel do cliente, o login, o papel, a senha temporária e até quando
 * ela vale. A senha não fica em lugar nenhum do plano de controle (só o envelope, até o nó consumir).
 */
export interface NodeUserCreated {
  requestId: string;
  panelUrl: string;
  email: string;
  role: TenantRole;
  temporaryPassword: string;
  notAfter: string;
}

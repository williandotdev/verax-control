import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { NODE_SYNC_MAX_USERS, type NodeSyncUserCode, TEMPORARY_PASSWORD_HOURS } from '@verax/shared';
import { generateTemporaryPassword, sealUserPassword } from '@verax/vault-envelope';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { tenantUrls } from '../access/tenant-urls.js';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { isUlid, newUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  type DocumentTransaction,
  parseDocument,
} from '../firestore/document-store.js';
import {
  NODE_SYNC_DESIRED_DOC,
  NODE_SYNC_STATE_DOC,
  NODE_USER_SECRET_GRACE_MS,
  nodeSyncDesiredSchema,
  type NodeSyncState,
  nodeSyncStateSchema,
  type NodeUser,
  type NodeUserReport,
  nodeUserReportSchema,
  nodeUserSchema,
  nodeUserSecretSchema,
} from '../node-sync/node-sync.schema.js';
import type { OwnerContext } from '../pricing/pricing-store.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { hostingOf, type TenantRecord } from '../tenants/tenant.schema.js';
import { type NodeVault, nodeVaultOf, platformOf, readCollection } from './admin-node-sync-common.js';
import {
  type NodeUserBlock,
  type NodeUserCreated,
  nodeUserCreateRequestSchema,
  type NodeUserStatus,
  type NodeUserView,
} from './admin-node-users.schema.js';
import { ADMIN_TENANT_LIMITS, type AdminTenantLimits } from './admin-tenants.service.js';
import { type FieldIssue, invalidRequest } from './validation.js';

/** A operação, como vai à auditoria (`details.operation`). */
const OPERATION = 'node_user.create';

/** A validade da senha temporária e do pedido: a mesma do painel (72 horas). */
export const NODE_USER_VALIDITY_MS = TEMPORARY_PASSWORD_HOURS * 60 * 60_000;

/** Por que a criação foi recusada (o código da resposta e da auditoria). */
export type NodeUserRefusalCode = NodeUserBlock | 'user_pending' | 'user_limit' | 'rate_limited';

const REFUSALS: Readonly<
  Record<NodeUserRefusalCode, { status: HttpStatus; message: string; issue?: FieldIssue }>
> = {
  not_allowed: {
    status: HttpStatus.CONFLICT,
    message: 'O contrato deste cliente já terminou (cancelado ou excluído): não há usuário para criar.',
  },
  placement_unsupported: {
    status: HttpStatus.CONFLICT,
    message: 'Cliente da célula compartilhada: os usuários ainda não são criados pelo console.',
  },
  node_not_synced: {
    status: HttpStatus.CONFLICT,
    message:
      'O servidor do cliente ainda não sincronizou com o plano de controle: não há para quem mandar o usuário.',
  },
  node_outdated: {
    status: HttpStatus.CONFLICT,
    message: 'O servidor do cliente precisa da versão nova para receber usuários.',
  },
  platform_mismatch: {
    status: HttpStatus.CONFLICT,
    message:
      'O nó informou outra plataforma que a do lugar deste cliente: nada foi cifrado. Confira a instalação.',
  },
  vault_disabled: {
    status: HttpStatus.CONFLICT,
    message:
      'O nó deste cliente está sem o cofre de credenciais (ou não consegue lê-lo): não há para quem cifrar a senha.',
  },
  vault_key_invalid: {
    status: HttpStatus.CONFLICT,
    message:
      'A chave do cofre que o nó informou não confere (formato ou impressão digital): nada foi cifrado.',
  },
  user_pending: {
    status: HttpStatus.CONFLICT,
    message:
      'Já há um pedido para este e-mail esperando o servidor do cliente: aguarde o resultado ou o prazo dele.',
    issue: { path: 'email', message: 'Pedido pendente para este e-mail.' },
  },
  user_limit: {
    status: HttpStatus.CONFLICT,
    message: `Já há ${NODE_SYNC_MAX_USERS} pedidos de usuário esperando o servidor do cliente, o máximo da sincronização.`,
  },
  rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Muitas operações em pouco tempo. Tente novamente mais tarde.',
  },
};

class NodeUserRefusal extends Error {
  constructor(readonly code: NodeUserRefusalCode) {
    super(`usuário recusado: ${code}`);
    this.name = 'NodeUserRefusal';
  }
}

function refusalError(code: NodeUserRefusalCode): ApiError {
  const entry = REFUSALS[code];
  return new ApiError(
    entry.status,
    entry.message,
    code,
    entry.issue === undefined ? undefined : { issues: [entry.issue] },
  );
}

/** O que a leitura dos usuários de um cliente traz (o mesmo dentro e fora da transação). */
export interface NodeUsersSnapshot {
  state: NodeSyncState | undefined;
  generation: number;
  users: Map<string, NodeUser>;
  reports: Map<string, NodeUserReport>;
  /** Os pedidos com o envelope ainda no Firestore (só os ids: o envelope nunca sai daqui). */
  stored: Set<string>;
}

export async function readNodeUsers(reader: DocumentReader, tenantId: string): Promise<NodeUsersSnapshot> {
  const collection = COLLECTIONS.nodeSync(tenantId);
  const stateData = await reader.get(collection, NODE_SYNC_STATE_DOC);
  const desiredData = await reader.get(collection, NODE_SYNC_DESIRED_DOC);
  const users = await readCollection(reader, COLLECTIONS.nodeUsers(tenantId), nodeUserSchema);
  const reports = await readCollection(reader, COLLECTIONS.nodeUserReports(tenantId), nodeUserReportSchema);
  const secrets = await reader.query(COLLECTIONS.nodeUserSecrets(tenantId));
  return {
    state:
      stateData === undefined
        ? undefined
        : parseDocument(nodeSyncStateSchema, collection, NODE_SYNC_STATE_DOC, stateData),
    generation:
      desiredData === undefined
        ? 0
        : parseDocument(nodeSyncDesiredSchema, collection, NODE_SYNC_DESIRED_DOC, desiredData).generation,
    users,
    reports,
    stored: new Set(secrets.map((doc) => doc.id)),
  };
}

/** A situação do pedido pelo relato do nó, pelo prazo e pelo envelope que ainda espera (ou não) o nó. */
export function nodeUserStatusOf(
  user: Pick<NodeUser, 'notAfter'>,
  report: NodeUserReport | undefined,
  envelopeStored: boolean,
  now: Date,
): { status: NodeUserStatus; code?: NodeSyncUserCode } {
  if (report !== undefined) {
    if (report.report.outcome === 'created') return { status: 'created' };
    const code = report.report.code ?? 'internal_error';
    return { status: code === 'expired' ? 'expired' : 'failed', code };
  }
  if (user.notAfter.getTime() <= now.getTime() || !envelopeStored) return { status: 'expired' };
  return { status: 'pending' };
}

/** Os pedidos do cliente para o console, do mais novo ao mais antigo. */
export function nodeUserViewsOf(snapshot: NodeUsersSnapshot, now: Date): NodeUserView[] {
  return [...snapshot.users]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([requestId, user]) => {
      const stored = snapshot.reports.get(requestId);
      const { status, code } = nodeUserStatusOf(user, stored, snapshot.stored.has(requestId), now);
      const created = stored?.report.user;
      return {
        requestId,
        name: user.name,
        email: user.email,
        role: user.role,
        notAfter: user.notAfter,
        createdAt: user.createdAt,
        createdBy: user.createdBy,
        status,
        ...(code === undefined ? {} : { code }),
        ...(created === null || created === undefined ? {} : { user: { ...created } }),
        ...(stored === undefined ? {} : { reportedAt: stored.reportedAt }),
      };
    });
}

/** O nó anunciou a criação de usuários na última sincronização (versão com a capacidade `users`). */
export function usersSupportedBy(state: NodeSyncState | undefined): boolean {
  return state?.capabilities.includes('users') ?? false;
}

/** Por que o console não pode pedir usuário agora (null: pode), com a chave do cofre quando pode. */
export function nodeUserBlockOf(
  tenant: TenantRecord,
  state: NodeSyncState | undefined,
): { ok: true; vault: NodeVault } | { ok: false; code: NodeUserBlock } {
  if (tenant.placement !== undefined) return { ok: false, code: 'placement_unsupported' };
  if (tenant.state === 'canceled' || tenant.state === 'deleted') return { ok: false, code: 'not_allowed' };
  if (state === undefined || state.nodeTenantId === null) return { ok: false, code: 'node_not_synced' };
  if (!usersSupportedBy(state)) return { ok: false, code: 'node_outdated' };
  return nodeVaultOf(state, platformOf(hostingOf(tenant)));
}

/**
 * Os usuários do cliente que a Verax cria pelo console (só no cp-admin; docs/ARQUITETURA.md, "Sincronização com o
 * plano de controle", "Usuários do cliente"). A senha temporária é gerada aqui (a mesma geradora do painel do nó), entra
 * na máscara do logger antes de qualquer `await`, é cifrada com a chave pública do cofre do nó (conferida pela
 * impressão digital), amarrada ao id do cliente no banco do nó, ao id do pedido e ao e-mail, e volta uma única vez na
 * resposta. O Firestore guarda o pedido (`nodeUsers`) e só o envelope (`nodeUserSecrets`), numa transação com a geração
 * do estado desejado e a auditoria; o cp-worker entrega ao nó que anuncia `users` e apaga o envelope quando o nó conta o
 * resultado. A senha nunca vai à auditoria, ao log nem ao Firestore.
 *
 * Na v1, o console não altera nem remove os usuários: a pessoa do cliente cuida da conta no painel dele.
 */
@Injectable()
export class AdminNodeUsersService {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    private readonly tenants: TenantStore,
    private readonly audit: AuditService,
    @Inject(ADMIN_TENANT_LIMITS) private readonly limits: AdminTenantLimits,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(AdminNodeUsersService.name) private readonly logger: PinoLogger,
  ) {}

  /** `POST .../users`: o pedido ao nó, com a senha temporária devolvida uma única vez. */
  async create(tenantId: string, body: unknown, owner: OwnerContext): Promise<NodeUserCreated> {
    const parsed = nodeUserCreateRequestSchema.safeParse(body ?? {});
    if (!parsed.success) throw invalidRequest(parsed.error);
    const { name, role } = parsed.data;
    const email = parsed.data.email.toLowerCase();
    const tenant = await this.tenant(tenantId);
    try {
      // A conferência fora da transação, sem gerar nem cifrar nada: o limite só gasta com um pedido que pode dar certo.
      this.plan(tenant, await readNodeUsers(this.store, tenant.id), email, this.clock.now());
      this.take(owner);
    } catch (error) {
      return this.refused(tenant, owner, error);
    }
    const temporaryPassword = generateTemporaryPassword();
    registerLiveSecret(temporaryPassword);
    try {
      const requestId = newUlid(this.clock.now().getTime());
      const actor = `owner:${owner.email}`;
      const result = await this.store.runTransaction(async (tx) => {
        const snapshot = await readNodeUsers(tx, tenant.id);
        const now = this.clock.now();
        const vault = this.plan(tenant, snapshot, email, now);
        const notAfter = new Date(now.getTime() + NODE_USER_VALIDITY_MS);
        const envelope = sealUserPassword(
          vault.publicKey,
          { nodeTenantId: vault.nodeTenantId, requestId, email },
          temporaryPassword,
        );
        tx.set(
          COLLECTIONS.nodeUsers(tenant.id),
          requestId,
          nodeUserSchema.parse({ name, email, role, notAfter, createdAt: now, createdBy: actor }),
        );
        tx.set(
          COLLECTIONS.nodeUserSecrets(tenant.id),
          requestId,
          nodeUserSecretSchema.parse({
            envelope,
            fingerprint: vault.fingerprint,
            nodeTenantId: vault.nodeTenantId,
            createdAt: now,
            expiresAt: new Date(notAfter.getTime() + NODE_USER_SECRET_GRACE_MS),
          }),
        );
        const generation = this.bump(tx, tenant.id, snapshot.generation, now);
        this.audit.record(tx, {
          actor,
          action: 'tenant.console_request',
          tenantId: tenant.id,
          // Nunca a senha nem o envelope: o pedido, o papel, o prazo e a chave do cofre que cifrou.
          details: {
            operation: OPERATION,
            outcome: 'ok',
            userRequestId: requestId,
            email,
            role,
            notAfter: notAfter.toISOString(),
            keyVersion: vault.keyVersion,
            fingerprint: vault.fingerprint,
            generation,
          },
          requestId: owner.requestId,
        });
        return { notAfter, generation };
      });
      this.logger.info(
        {
          event: 'admin_node_user',
          tenantId: tenant.id,
          operation: OPERATION,
          userRequestId: requestId,
          role,
          generation: result.generation,
        },
        'usuário do cliente gravado no estado desejado',
      );
      return {
        requestId,
        panelUrl: tenantUrls(tenant.slug, this.config).panelUrl,
        email,
        role,
        temporaryPassword,
        notAfter: result.notAfter.toISOString(),
      };
    } catch (error) {
      // Sem resposta, ninguém vai esquecer a senha no fim dela (o controlador só esquece a que devolveu).
      forgetLiveSecret(temporaryPassword);
      return this.refused(tenant, owner, error);
    }
  }

  private async tenant(tenantId: string): Promise<TenantRecord> {
    const tenant = isUlid(tenantId) ? await this.tenants.get(tenantId) : undefined;
    if (tenant === undefined) {
      throw new ApiError(HttpStatus.NOT_FOUND, 'Cliente não encontrado.', 'tenant_not_found');
    }
    return tenant;
  }

  /** As regras da criação sobre a leitura (fora ou dentro da transação): a chave do cofre pronta, ou a recusa. */
  private plan(tenant: TenantRecord, snapshot: NodeUsersSnapshot, email: string, now: Date): NodeVault {
    const block = nodeUserBlockOf(tenant, snapshot.state);
    if (!block.ok) {
      if (block.code === 'vault_key_invalid') {
        this.logger.error(
          {
            event: 'admin_node_user_vault_key_invalid',
            tenantId: tenant.id,
            keyVersion: snapshot.state?.vaultKey?.version,
          },
          'a chave do cofre informada pelo nó não confere',
        );
      }
      throw new NodeUserRefusal(block.code);
    }
    let pending = 0;
    for (const [requestId, user] of snapshot.users) {
      const { status } = nodeUserStatusOf(
        user,
        snapshot.reports.get(requestId),
        snapshot.stored.has(requestId),
        now,
      );
      if (status !== 'pending') continue;
      if (user.email === email) throw new NodeUserRefusal('user_pending');
      pending += 1;
    }
    if (pending >= NODE_SYNC_MAX_USERS) throw new NodeUserRefusal('user_limit');
    return block.vault;
  }

  private take(owner: OwnerContext): void {
    if (!this.limits.operations.take(owner.email).allowed) throw new NodeUserRefusal('rate_limited');
  }

  /** A geração do estado desejado, um passo acima, na mesma transação do pedido. */
  private bump(tx: DocumentTransaction, tenantId: string, current: number, now: Date): number {
    const generation = current + 1;
    tx.set(
      COLLECTIONS.nodeSync(tenantId),
      NODE_SYNC_DESIRED_DOC,
      nodeSyncDesiredSchema.parse({ generation, updatedAt: now }),
    );
    return generation;
  }

  /** A recusa vai à auditoria antes da resposta (com o código); outro erro segue como veio. */
  private async refused(tenant: TenantRecord, owner: OwnerContext, error: unknown): Promise<never> {
    if (!(error instanceof NodeUserRefusal)) throw error;
    await this.audit.write({
      actor: `owner:${owner.email}`,
      action: 'tenant.console_request_refused',
      tenantId: tenant.id,
      details: { operation: OPERATION, code: error.code, state: tenant.state },
      requestId: owner.requestId,
    });
    this.logger.info(
      { event: 'admin_node_user_refused', tenantId: tenant.id, operation: OPERATION, code: error.code },
      'pedido de usuário do cliente recusado',
    );
    throw refusalError(error.code);
  }
}

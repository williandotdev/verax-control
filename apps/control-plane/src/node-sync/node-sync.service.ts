import { Inject, Injectable } from '@nestjs/common';
import {
  NODE_SYNC_INTERVAL_SECONDS,
  NODE_SYNC_MAX_CLOCK_SKEW_MS,
  NODE_SYNC_MAX_SOURCES,
  NODE_SYNC_MAX_USERS,
  NODE_SYNC_POLL_MIN_SECONDS,
  NODE_SYNC_PROTOCOL,
  NODE_SYNC_RESPONSE_MAX_BYTES,
  type NodeSyncCredentialReport,
  type NodeSyncDesiredSource,
  type NodeSyncDesiredUser,
  nodeSyncDesiredSourceSchema,
  nodeSyncDesiredUserSchema,
  type NodeSyncRequest,
  type NodeSyncResponse,
  nodeSyncResponseSchema,
  type NodeSyncSourceCode,
  type NodeSyncSourceReport,
  type NodeSyncUserReport,
  respondsTo,
} from '@verax/shared';
import type { z } from 'zod';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { enrollmentHash, nodeKeyValid, sameHash } from '../enrollment/enrollment.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  type DocumentTransaction,
  equalValues,
  parseDocument,
} from '../firestore/document-store.js';
import { TenantStore } from '../tenants/tenant-store.js';
import { hostingOf, type TenantRecord, type TenantState } from '../tenants/tenant.schema.js';
import type { NodeSyncCredential } from './node-identity.js';
import { NodeIdentityVerifier } from './node-identity.js';
import {
  type LogSource,
  logSourceReportSchema,
  logSourceSchema,
  type LogSourceSecret,
  logSourceSecretSchema,
  NODE_SYNC_DESIRED_DOC,
  NODE_SYNC_STATE_DOC,
  nodeSyncDesiredSchema,
  type NodeSyncState,
  nodeSyncStateSchema,
  type NodeUser,
  nodeUserReportSchema,
  nodeUserSchema,
  type NodeUserSecret,
  nodeUserSecretSchema,
} from './node-sync.schema.js';

/** O que a sincronização recusa, cada um com o seu status (`internal-node-sync.controller.ts`). */
export type NodeSyncRefusal =
  'invalid_request' | 'clock_skew' | 'unauthenticated' | 'not_found' | 'stale_sequence';

export type NodeSyncOutcome =
  | { ok: true; response: NodeSyncResponse }
  | { ok: false; reason: NodeSyncRefusal }
  | { ok: false; reason: 'too_soon'; retryAfterSeconds: number };

/**
 * Estados em que o nó gerenciado sincroniza: com a VM no ar (o provisionamento, a espera da conexão, o ambiente pronto
 * e a carência da cobrança). Suspenso, cancelado ou excluído: 404 (a VM do suspenso está parada). Na VM do cliente,
 * valem os estados do registro (`nodeKeyValid`, sem `past_due`: o contrato direto não tem cobrança pela Stripe).
 */
export const NODE_SYNC_ACTIVE_STATES: ReadonlySet<TenantState> = new Set([
  'provisioning',
  'waiting_customer_connection',
  'active',
  'past_due',
]);

/** Uma chamada aceita por cliente a cada 20 s (`nodeSync/state.lastSeenAt`): mais que isso é 429 com `Retry-After`. */
export const NODE_SYNC_MIN_INTERVAL_MS = 20_000;

/**
 * Os códigos da credencial que o nó não vai mudar tentando de novo a mesma revisão: o envelope consumido sai do
 * Firestore (o console mostra "reenviar"). `source_unavailable` e `internal_error` ficam: o nó tenta de novo.
 */
export const TERMINAL_CREDENTIAL_CODES: ReadonlySet<NodeSyncSourceCode> = new Set([
  'credential_unreadable',
  'credential_rejected_invalid',
  'credential_rejected_inactive',
  'credential_rejected_expired',
  'credential_rejected_not_yet_valid',
  'credential_rejected_no_account_access',
  'credential_rejected_wrong_identity',
  'credential_kind_not_allowed',
  'vault_disabled',
]);

/**
 * Quanto dos envelopes cabe numa resposta (o nó lê até 1 MB, `NODE_SYNC_RESPONSE_MAX_BYTES`). O que passar fica para a
 * próxima chamada, que vem logo (`pollAfterSeconds` no mínimo): o nó faz uma segunda volta depois de aplicar.
 */
const ENVELOPE_BUDGET_BYTES = 512 * 1024;

/** A credencial da fonte, conferida contra o relato do nó, saiu do Firestore? */
function credentialConsumed(
  report: NodeSyncCredentialReport | null | undefined,
  secret: LogSourceSecret,
): boolean {
  if (report === null || report === undefined || report.revision === null) return false;
  if (report.revision < secret.revision) return false;
  return report.outcome === 'applied' || (report.code !== null && TERMINAL_CREDENTIAL_CODES.has(report.code));
}

/** A última revisão da credencial do console que o nó disse ter aplicado (0: nenhuma). */
function appliedCredentialRevision(report: NodeSyncSourceReport | undefined): number {
  const credential = report?.credential;
  if (credential === null || credential === undefined || credential.revision === null) return 0;
  return credential.outcome === 'applied' ? credential.revision : 0;
}

function retryAfterSeconds(elapsedMs: number): number {
  const waitMs = NODE_SYNC_MIN_INTERVAL_MS - Math.max(0, elapsedMs);
  return Math.min(NODE_SYNC_MIN_INTERVAL_MS / 1000, Math.max(1, Math.ceil(waitMs / 1000)));
}

async function readCollection<T extends z.ZodType>(
  reader: DocumentReader,
  collection: string,
  schema: T,
): Promise<Map<string, z.infer<T>>> {
  const docs = await reader.query(collection);
  const result = new Map<string, z.infer<T>>();
  for (const doc of [...docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    result.set(doc.id, parseDocument(schema, collection, doc.id, doc.data));
  }
  return result;
}

/** O que a transação contou, para a linha de log (nunca um envelope, uma chave ou um e-mail). */
interface SyncCounts {
  unknownSources: number;
  unknownUsers: number;
  reportsWritten: number;
  consumedEnvelopes: number;
  sentEnvelopes: number;
  deferredEnvelopes: number;
  invalidItems: number;
  identityChanged: boolean;
  firstSeen: boolean;
}

type ApplyResult =
  | { ok: true; response: NodeSyncResponse; counts: SyncCounts }
  | { ok: false; reason: 'stale_sequence' }
  | { ok: false; reason: 'too_soon'; retryAfterSeconds: number };

type Resolution = { ok: true; tenant: TenantRecord } | { ok: false; reason: 'unauthenticated' | 'not_found' };

/**
 * A sincronização do nó dedicado no cp-worker (o cp-public só repassa; docs/ARQUITETURA.md, "Sincronização com o plano
 * de controle"):
 *
 * 1. a credencial é conferida de novo aqui, independente do cp-public, e o cliente sai **só** dela: o token do nó
 *    gerenciado (assinatura, `aud`, `sub` → `resources.serviceAccountUniqueId`, o projeto e o nome da VM) ou a chave do
 *    nó da VM do cliente (o hash, como no `report` do registro). Credencial de uma plataforma com o corpo da outra:
 *    401. Cliente fora dos estados com nó, da célula (`placement`) ou de outra hospedagem: 404;
 * 2. o `sentAt` dentro de ±10 min do relógio do plano de controle e, na transação, a `sequence` maior que a última
 *    aceita (409 `stale_sequence`) e no máximo uma chamada a cada 20 s (429);
 * 3. grava `nodeSync/state`; com outro cliente no banco do nó ou outra chave do cofre (reinstalação), audita
 *    `node_sync.identity_changed` e descarta os envelopes pendentes, que não abririam mais;
 * 4. grava os relatos só dos itens que existem sob este cliente (os outros são ignorados e contados no log) e apaga os
 *    envelopes consumidos;
 * 5. responde o estado desejado das capacidades que o nó anunciou, conferido com os schemas estritos do protocolo.
 */
@Injectable()
export class NodeSyncService {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    private readonly tenants: TenantStore,
    private readonly audit: AuditService,
    private readonly verifier: NodeIdentityVerifier,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(NodeSyncService.name) private readonly logger: PinoLogger,
  ) {}

  async sync(
    credential: NodeSyncCredential,
    request: NodeSyncRequest,
    requestId?: string,
  ): Promise<NodeSyncOutcome> {
    const resolved = await this.resolve(credential, request, requestId);
    if (!resolved.ok) return resolved;
    const tenant = resolved.tenant;
    const now = this.clock.now();
    if (Math.abs(Date.parse(request.sentAt) - now.getTime()) > NODE_SYNC_MAX_CLOCK_SKEW_MS) {
      this.logger.info(
        { event: 'node_sync_refused', tenantId: tenant.id, reason: 'clock_skew', requestId },
        'sincronização do nó recusada',
      );
      return { ok: false, reason: 'clock_skew' };
    }
    const result = await this.store.runTransaction((tx) =>
      this.apply(tx, tenant.id, credential.kind, request, now, requestId),
    );
    if (!result.ok) {
      this.logger.info(
        { event: 'node_sync_refused', tenantId: tenant.id, reason: result.reason, requestId },
        'sincronização do nó recusada',
      );
      return result;
    }
    const size = Buffer.byteLength(JSON.stringify(result.response), 'utf8');
    if (size > NODE_SYNC_RESPONSE_MAX_BYTES) {
      // Nada a fazer pelo nó: o estado desejado passou do que ele lê. O relato e o estado já foram gravados.
      this.logger.error(
        { event: 'node_sync_response_too_large', tenantId: tenant.id, bytes: size, requestId },
        'resposta da sincronização maior que o nó lê',
      );
      throw new Error('node_sync_response_too_large');
    }
    const { counts } = result;
    if (counts.invalidItems > 0) {
      this.logger.error(
        { event: 'node_sync_invalid_desired', tenantId: tenant.id, items: counts.invalidItems, requestId },
        'item desejado fora do protocolo ficou fora da resposta',
      );
    }
    this.logger.info(
      {
        event: 'node_sync',
        tenantId: tenant.id,
        authKind: credential.kind,
        sequence: request.sequence,
        generation: result.response.generation,
        sources: request.sources.length,
        users: request.users.length,
        ...counts,
        requestId,
      },
      'sincronização do nó',
    );
    return { ok: true, response: result.response };
  }

  /** O cliente da credencial, conferida aqui; nada do corpo escolhe o cliente (só a plataforma é cruzada). */
  private async resolve(
    credential: NodeSyncCredential,
    request: NodeSyncRequest,
    requestId: string | undefined,
  ): Promise<Resolution> {
    const refuse = (
      reason: 'unauthenticated' | 'not_found',
      detail: string,
      tenantId?: string,
    ): Resolution => {
      this.logger.warn(
        { event: 'node_sync_refused', reason: detail, authKind: credential.kind, tenantId, requestId },
        'sincronização do nó recusada',
      );
      return { ok: false, reason };
    };
    if (credential.kind === 'gcp_identity') {
      const verification = await this.verifier.verify(credential.token);
      if (!verification.ok) return refuse('unauthenticated', `token_${verification.reason}`);
      const identity = verification.identity;
      if (request.node.platform !== 'gcp') return refuse('unauthenticated', 'platform_mismatch');
      if (request.node.serviceAccountId !== identity.serviceAccountId) {
        return refuse('unauthenticated', 'service_account_mismatch');
      }
      const candidates = await this.tenants.findByServiceAccountUniqueId(identity.serviceAccountId);
      if (candidates.length > 1) {
        // A conta de serviço é de um nó só: dois clientes com ela é um erro de dados, nunca um a escolher.
        this.logger.error(
          {
            event: 'node_sync_identity_ambiguous',
            tenantIds: candidates.map((candidate) => candidate.id),
            requestId,
          },
          'dois clientes com a mesma conta de serviço do nó',
        );
        return { ok: false, reason: 'not_found' };
      }
      const tenant = candidates[0];
      if (tenant === undefined) return refuse('not_found', 'unknown_service_account');
      if (hostingOf(tenant) !== 'verax') return refuse('unauthenticated', 'hosting_mismatch', tenant.id);
      if (
        tenant.resources?.nodesProject !== identity.projectId ||
        tenant.resources.instanceName !== identity.instanceName
      ) {
        return refuse('unauthenticated', 'instance_mismatch', tenant.id);
      }
      if (tenant.placement !== undefined || !NODE_SYNC_ACTIVE_STATES.has(tenant.state)) {
        return refuse('not_found', 'tenant_not_eligible', tenant.id);
      }
      return { ok: true, tenant };
    }
    const nodeKeyHash = enrollmentHash(credential.nodeKey);
    const tenant = await this.tenants.findByNodeKeyHash(nodeKeyHash);
    if (tenant === undefined || !sameHash(tenant.enrollment?.nodeKeyHash, nodeKeyHash)) {
      return refuse('unauthenticated', 'unknown_node_key');
    }
    if (hostingOf(tenant) !== 'customer') return refuse('unauthenticated', 'hosting_mismatch', tenant.id);
    if (request.node.platform !== 'vm') return refuse('unauthenticated', 'platform_mismatch', tenant.id);
    if (tenant.placement !== undefined || !nodeKeyValid(tenant, nodeKeyHash)) {
      return refuse('not_found', 'tenant_not_eligible', tenant.id);
    }
    return { ok: true, tenant };
  }

  /** A transação: lê tudo do cliente, confere a sequência e o intervalo, grava e monta a resposta. */
  private async apply(
    tx: DocumentTransaction,
    tenantId: string,
    authKind: NodeSyncCredential['kind'],
    request: NodeSyncRequest,
    now: Date,
    requestId: string | undefined,
  ): Promise<ApplyResult> {
    const stateCollection = COLLECTIONS.nodeSync(tenantId);
    const stateData = await tx.get(stateCollection, NODE_SYNC_STATE_DOC);
    const state =
      stateData === undefined
        ? undefined
        : parseDocument(nodeSyncStateSchema, stateCollection, NODE_SYNC_STATE_DOC, stateData);
    if (state !== undefined && request.sequence <= state.sequence)
      return { ok: false, reason: 'stale_sequence' };
    if (state !== undefined) {
      const elapsed = now.getTime() - state.lastSeenAt.getTime();
      if (elapsed < NODE_SYNC_MIN_INTERVAL_MS) {
        return { ok: false, reason: 'too_soon', retryAfterSeconds: retryAfterSeconds(elapsed) };
      }
    }
    const desiredData = await tx.get(stateCollection, NODE_SYNC_DESIRED_DOC);
    const desired =
      desiredData === undefined
        ? undefined
        : parseDocument(nodeSyncDesiredSchema, stateCollection, NODE_SYNC_DESIRED_DOC, desiredData);
    const sources = await readCollection(tx, COLLECTIONS.logSources(tenantId), logSourceSchema);
    const sourceSecrets = await readCollection(
      tx,
      COLLECTIONS.logSourceSecrets(tenantId),
      logSourceSecretSchema,
    );
    const sourceReports = await readCollection(
      tx,
      COLLECTIONS.logSourceReports(tenantId),
      logSourceReportSchema,
    );
    const users = await readCollection(tx, COLLECTIONS.nodeUsers(tenantId), nodeUserSchema);
    const userSecrets = await readCollection(tx, COLLECTIONS.nodeUserSecrets(tenantId), nodeUserSecretSchema);
    const userReports = await readCollection(tx, COLLECTIONS.nodeUserReports(tenantId), nodeUserReportSchema);

    const counts: SyncCounts = {
      unknownSources: 0,
      unknownUsers: 0,
      reportsWritten: 0,
      consumedEnvelopes: 0,
      sentEnvelopes: 0,
      deferredEnvelopes: 0,
      invalidItems: 0,
      identityChanged: false,
      firstSeen: state === undefined,
    };
    const node = request.node;
    const previousFingerprint = state?.vaultKey?.fingerprint ?? null;
    const fingerprint = node.vaultKey?.fingerprint ?? null;
    counts.identityChanged =
      state !== undefined && (state.nodeTenantId !== node.tenantId || previousFingerprint !== fingerprint);

    // --- os relatos, só dos itens deste cliente --------------------------------------------------------------------
    const sourceReportsById = new Map<string, NodeSyncSourceReport>();
    for (const report of request.sources) {
      if (!sources.has(report.id)) {
        counts.unknownSources += 1;
        continue;
      }
      sourceReportsById.set(report.id, report);
      const previous = sourceReports.get(report.id);
      if (previous === undefined || !equalValues(previous.report, report)) {
        tx.set(
          COLLECTIONS.logSourceReports(tenantId),
          report.id,
          logSourceReportSchema.parse({ report, reportedAt: now }),
        );
        counts.reportsWritten += 1;
      }
    }
    const userReportsById = new Map<string, NodeSyncUserReport>();
    for (const report of request.users) {
      if (!users.has(report.requestId)) {
        counts.unknownUsers += 1;
        continue;
      }
      userReportsById.set(report.requestId, report);
      const previous = userReports.get(report.requestId);
      if (previous === undefined || !equalValues(previous.report, report)) {
        tx.set(
          COLLECTIONS.nodeUserReports(tenantId),
          report.requestId,
          nodeUserReportSchema.parse({ report, reportedAt: now }),
        );
        counts.reportsWritten += 1;
      }
    }

    // --- os envelopes consumidos -----------------------------------------------------------------------------------
    const consumedSources = new Set<string>();
    for (const [id, secret] of sourceSecrets) {
      const source = sources.get(id);
      const consumed =
        counts.identityChanged ||
        source === undefined ||
        source.state === 'removed' ||
        credentialConsumed(sourceReportsById.get(id)?.credential, secret);
      if (consumed) consumedSources.add(id);
    }
    const consumedUsers = new Set<string>();
    for (const [id] of userSecrets) {
      const user = users.get(id);
      const consumed =
        counts.identityChanged ||
        user === undefined ||
        userReportsById.has(id) ||
        user.notAfter.getTime() <= now.getTime();
      if (consumed) consumedUsers.add(id);
    }
    for (const id of consumedSources) tx.delete(COLLECTIONS.logSourceSecrets(tenantId), id);
    for (const id of consumedUsers) tx.delete(COLLECTIONS.nodeUserSecrets(tenantId), id);
    counts.consumedEnvelopes = consumedSources.size + consumedUsers.size;

    // --- o estado do nó --------------------------------------------------------------------------------------------
    const vaultKey =
      node.vaultKey === null
        ? null
        : {
            ...node.vaultKey,
            since: state?.vaultKey?.fingerprint === node.vaultKey.fingerprint ? state.vaultKey.since : now,
          };
    const nextState: NodeSyncState = nodeSyncStateSchema.parse({
      lastSeenAt: now,
      sequence: request.sequence,
      authKind,
      platform: node.platform,
      commit: node.commit,
      capabilities: request.capabilities,
      nodeTenantId: node.tenantId,
      vaultKey,
      serviceAccountId: node.serviceAccountId,
      egressIps: node.egressIps,
      audience: node.audience,
      error: node.error,
    });
    tx.set(stateCollection, NODE_SYNC_STATE_DOC, nextState);
    if (counts.identityChanged) {
      this.audit.record(tx, {
        actor: 'system',
        action: 'node_sync.identity_changed',
        tenantId,
        details: {
          previousNodeTenantId: state?.nodeTenantId ?? null,
          nodeTenantId: node.tenantId,
          previousFingerprint,
          fingerprint,
          previousKeyVersion: state?.vaultKey?.version ?? null,
          keyVersion: node.vaultKey?.version ?? null,
          discardedEnvelopes: counts.consumedEnvelopes,
        },
        requestId,
      });
    }

    // --- a resposta ------------------------------------------------------------------------------------------------
    const usable = (secret: LogSourceSecret | NodeUserSecret): boolean =>
      node.vaultKey !== null &&
      secret.fingerprint === node.vaultKey.fingerprint &&
      secret.nodeTenantId === node.tenantId;
    let budget = ENVELOPE_BUDGET_BYTES;
    const take = (envelope: string): boolean => {
      if (envelope.length > budget) {
        counts.deferredEnvelopes += 1;
        return false;
      }
      budget -= envelope.length;
      counts.sentEnvelopes += 1;
      return true;
    };
    const response: NodeSyncResponse = {
      protocol: NODE_SYNC_PROTOCOL,
      generation: desired?.generation ?? 0,
      pollAfterSeconds: NODE_SYNC_INTERVAL_SECONDS,
    };
    if (respondsTo(request.capabilities, 'log_sources')) {
      response.sources = this.desiredSources(sources, sourceSecrets, consumedSources, sourceReportsById, {
        usable,
        take,
        counts,
      });
    }
    if (respondsTo(request.capabilities, 'users')) {
      response.users = this.desiredUsers(users, userSecrets, consumedUsers, userReports, {
        usable,
        take,
        counts,
        now,
      });
    }
    if (counts.deferredEnvelopes > 0) response.pollAfterSeconds = NODE_SYNC_POLL_MIN_SECONDS;
    // O que sai é o que o protocolo aceita: um erro aqui é do plano de controle (503), nunca uma resposta torta.
    return { ok: true, response: nodeSyncResponseSchema.parse(response), counts };
  }

  /** As fontes desejadas, com a credencial pendente quando a revisão dela é mais nova que a última aplicada. */
  private desiredSources(
    sources: ReadonlyMap<string, LogSource>,
    secrets: ReadonlyMap<string, LogSourceSecret>,
    consumed: ReadonlySet<string>,
    reports: ReadonlyMap<string, NodeSyncSourceReport>,
    context: {
      usable: (secret: LogSourceSecret) => boolean;
      take: (envelope: string) => boolean;
      counts: SyncCounts;
    },
  ): NodeSyncDesiredSource[] {
    const result: NodeSyncDesiredSource[] = [];
    for (const [id, source] of sources) {
      if (result.length >= NODE_SYNC_MAX_SOURCES) {
        context.counts.invalidItems += 1;
        continue;
      }
      const secret = secrets.get(id);
      const pending =
        source.state === 'active' &&
        secret !== undefined &&
        !consumed.has(id) &&
        context.usable(secret) &&
        secret.revision > appliedCredentialRevision(reports.get(id));
      const credential =
        pending && context.take(secret.envelope)
          ? { revision: secret.revision, kind: secret.kind, envelope: secret.envelope }
          : null;
      const parsed = nodeSyncDesiredSourceSchema.safeParse({
        id,
        revision: source.revision,
        state: source.state,
        spec: source.spec,
        credential,
      });
      if (!parsed.success) {
        context.counts.invalidItems += 1;
        continue;
      }
      result.push(parsed.data);
    }
    return result;
  }

  /** Os usuários pedidos ainda sem resultado, no prazo e com o envelope para a chave atual do nó. */
  private desiredUsers(
    users: ReadonlyMap<string, NodeUser>,
    secrets: ReadonlyMap<string, NodeUserSecret>,
    consumed: ReadonlySet<string>,
    stored: ReadonlyMap<string, { report: NodeSyncUserReport }>,
    context: {
      usable: (secret: NodeUserSecret) => boolean;
      take: (envelope: string) => boolean;
      counts: SyncCounts;
      now: Date;
    },
  ): NodeSyncDesiredUser[] {
    const result: NodeSyncDesiredUser[] = [];
    for (const [id, user] of users) {
      const secret = secrets.get(id);
      if (secret === undefined || consumed.has(id) || !context.usable(secret)) continue;
      if (stored.get(id)?.report.outcome === 'created') continue;
      if (user.notAfter.getTime() <= context.now.getTime()) continue;
      if (result.length >= NODE_SYNC_MAX_USERS) {
        context.counts.invalidItems += 1;
        continue;
      }
      if (!context.take(secret.envelope)) continue;
      const parsed = nodeSyncDesiredUserSchema.safeParse({
        requestId: id,
        name: user.name,
        email: user.email,
        role: user.role,
        envelope: secret.envelope,
        notAfter: user.notAfter.toISOString(),
      });
      if (!parsed.success) {
        context.counts.invalidItems += 1;
        continue;
      }
      result.push(parsed.data);
    }
    return result;
  }
}

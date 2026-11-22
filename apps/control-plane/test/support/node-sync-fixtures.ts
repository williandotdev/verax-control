import { randomBytes, randomUUID } from 'node:crypto';
import type { NodeSyncRequest, NodeSyncSourceReport, NodeSyncUserReport } from '@verax/shared';
import { newUlid } from '../../src/common/ulid.js';

/**
 * Dados fictícios da sincronização do nó (`node-sync/`): ids gerados no teste, contas de exemplo, IPs da faixa de
 * documentação (RFC 5737) e envelopes de mentira no formato do cofre (`v<versão>:<base64>`), que nada abre.
 */

/** Um id de fonte novo (UUID em minúsculas, como o console escolhe). */
export function sourceId(): string {
  return randomUUID();
}

/** Um id de pedido de usuário novo (ULID). */
export function userRequestId(at = Date.now()): string {
  return newUlid(at);
}

/** Um envelope de mentira, aleatório (nenhum valor fixo que pareça segredo no repositório). */
export function fakeEnvelope(bytes = 384): string {
  return `v1:${randomBytes(bytes).toString('base64')}`;
}

/** Uma impressão digital de chave do cofre (64 hexadecimais). */
export function fakeFingerprint(): string {
  return randomBytes(32).toString('hex');
}

export interface FakeNodeIdentity {
  tenantId: string;
  fingerprint: string;
  keyVersion: number;
}

export function fakeNodeIdentity(): FakeNodeIdentity {
  return { tenantId: randomUUID(), fingerprint: fakeFingerprint(), keyVersion: 1 };
}

/** O corpo do `POST /v1/node-sync` de um nó, com o que o teste quiser trocar. */
export function nodeSyncRequest(options: {
  sequence: number;
  sentAt: Date;
  platform?: 'gcp' | 'vm';
  serviceAccountId?: string | null;
  identity?: FakeNodeIdentity | null;
  capabilities?: NodeSyncRequest['capabilities'];
  sources?: NodeSyncSourceReport[];
  users?: NodeSyncUserReport[];
}): NodeSyncRequest {
  const identity = options.identity === undefined ? fakeNodeIdentity() : options.identity;
  const platform = options.platform ?? 'gcp';
  return {
    protocol: 1,
    sequence: options.sequence,
    sentAt: options.sentAt.toISOString(),
    capabilities: options.capabilities ?? ['log_sources', 'users'],
    node: {
      commit: 'a'.repeat(40),
      platform,
      mode: 'dedicated',
      tenantId: identity?.tenantId ?? null,
      vaultKey:
        identity === null
          ? null
          : {
              version: identity.keyVersion,
              publicKey: Buffer.from(`chave-publica-${identity.fingerprint}`).toString('base64'),
              fingerprint: identity.fingerprint,
            },
      serviceAccountId:
        options.serviceAccountId === undefined
          ? platform === 'gcp'
            ? '100000000000000000001'
            : null
          : options.serviceAccountId,
      egressIps: ['203.0.113.10/32'],
      audience: 'https://conta.example.com/aws-reader',
      error: null,
    },
    sources: options.sources ?? [],
    users: options.users ?? [],
  };
}

/** O relato de uma fonte aplicada, com a credencial do console (`revision`) aplicada ou falhada. */
export function sourceReport(
  id: string,
  revision: number,
  credential?: {
    revision: number | null;
    outcome: 'applied' | 'failed';
    code?: NodeSyncSourceReport['code'];
  },
): NodeSyncSourceReport {
  return {
    id,
    revision,
    outcome: 'applied',
    code: null,
    credential:
      credential === undefined
        ? null
        : {
            revision: credential.revision,
            outcome: credential.outcome,
            code: credential.code ?? null,
            kind: 'cloudflare_api_token',
            keyIdSuffix: 'ab_9',
            expiresAt: null,
            verifiedAt: credential.outcome === 'applied' ? '2026-11-20T11:59:00.000Z' : null,
          },
    account: {
      status: 'active',
      connection: 'connected',
      connectionError: null,
      collectionError: null,
      ingestFrom: null,
      lastEventAt: null,
      lastCollectedAt: null,
      checkRequestedAt: null,
    },
  };
}

export function userCreated(requestId: string): NodeSyncUserReport {
  return {
    requestId,
    outcome: 'created',
    code: null,
    user: { status: 'active', mfaEnabled: false, mustChangePassword: true },
  };
}

export function userFailed(
  requestId: string,
  code: NonNullable<NodeSyncUserReport['code']>,
): NodeSyncUserReport {
  return { requestId, outcome: 'failed', code, user: null };
}

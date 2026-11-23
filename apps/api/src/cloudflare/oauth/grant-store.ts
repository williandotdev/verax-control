import { randomUUID } from 'node:crypto';
import { type CloudflareOauthTokens as GrantTokens, sealCloudflareOauthTokens } from '@verax/vault-envelope';
import { scopeToTenant } from '../../common/prisma/tenant-scope.js';
import type { VaultPublicKey } from '../../credentials/credential-keys.js';
import { lockGrant } from '../../credentials/credential-rekey.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * As escritas da concessão do Cloudflare (OAuth) que mais de um lugar faz: criar, soltar de uma conta e mandar revogar.
 *
 * Ordem dos locks, a mesma em todo caminho: as vagas do plano, o lock da credencial de cada conta (`lockCredential`) e só
 * depois o da concessão (`lockGrant`); com mais de uma concessão, em ordem de ID. Os itens da sincronização com o plano
 * de controle vêm depois de todos.
 */

type Tx = Prisma.TransactionClient;

/** Uma concessão a gravar: os tokens já cifrados para ela. */
export interface SealedGrant {
  id: string;
  tenantId: string;
  clientId: string;
  scopes: string[];
  ciphertext: string;
  keyVersion: number;
  accessExpiresAt: Date;
  consentedAt: Date;
  consentedBy: string;
}

/** Cifra os tokens para uma concessão nova. Lança `CredentialVaultError` se não couberem no envelope. */
export function sealGrant(
  publicKey: VaultPublicKey,
  grant: Omit<SealedGrant, 'id' | 'ciphertext' | 'keyVersion' | 'accessExpiresAt'>,
  tokens: GrantTokens,
): SealedGrant {
  const id = randomUUID();
  return {
    ...grant,
    id,
    ciphertext: sealCloudflareOauthTokens(publicKey, { tenantId: grant.tenantId, subjectId: id }, tokens),
    keyVersion: publicKey.version,
    accessExpiresAt: tokens.accessExpiresAt,
  };
}

/** Grava a concessão: em uso ou, quando os tokens não servem, já esperando a revogação no Cloudflare. */
export async function createGrant(
  tx: Tx,
  grant: SealedGrant,
  status: 'active' | 'revoking',
  now: Date,
): Promise<void> {
  await scopeToTenant(tx, grant.tenantId).cloudflareGrant.create({
    data: { ...grant, status, revokeRequestedAt: status === 'revoking' ? now : null },
    select: { id: true },
  });
}

/**
 * Manda revogar a concessão que nenhuma conta usa mais, sob o lock dela. Falso se uma conta ainda a usa ou se ela já
 * espera a revogação. Quem chama confere que nenhuma tentativa aberta ainda vai usá-la.
 */
export async function releaseGrantIfUnused(
  tx: Tx,
  tenantId: string,
  grantId: string,
  now: Date,
): Promise<boolean> {
  await lockGrant(tx, grantId);
  const { count } = await scopeToTenant(tx, tenantId).cloudflareGrant.updateMany({
    where: { id: grantId, status: { in: ['active', 'reconnect'] }, cloudAccounts: { none: {} } },
    data: { status: 'revoking', revokeRequestedAt: now, refreshStartedAt: null },
  });
  return count === 1;
}

/** O que aconteceu com a concessão ao soltar a conta dela. */
export interface DetachedGrant {
  grantId: string;
  /** Era a última conta: a concessão espera a revogação no Cloudflare. */
  released: boolean;
}

/**
 * Solta a conta da concessão (desativação, exclusão, token colado no lugar). Quem chama já tem o lock da credencial da
 * conta (`lockCredential`). Null na conta que não é lida por OAuth.
 */
export async function detachAccount(
  tx: Tx,
  account: { id: string; tenantId: string },
  now: Date,
): Promise<DetachedGrant | null> {
  const db = scopeToTenant(tx, account.tenantId);
  const row = await db.cloudAccount.findUnique({
    where: { id: account.id },
    select: { cloudflareGrantId: true },
  });
  const grantId = row?.cloudflareGrantId ?? null;
  if (grantId === null) return null;
  await lockGrant(tx, grantId);
  await db.cloudAccount.update({
    where: { id: account.id },
    data: { cloudflareGrantId: null },
    select: { id: true },
  });
  return { grantId, released: await releaseGrantIfUnused(tx, account.tenantId, grantId, now) };
}

import type { NodePlatform } from '@verax/shared';
import {
  CredentialVaultError,
  type EnvelopePublicKey,
  publicKeyFingerprint,
  vaultPublicKeyFromPem,
} from '@verax/vault-envelope';
import type { z } from 'zod';
import { type DocumentReader, parseDocument } from '../firestore/document-store.js';
import type { NodeSyncState } from '../node-sync/node-sync.schema.js';
import type { Hosting } from '../tenants/tenant.schema.js';

/**
 * O que as escritas do console para o nó do cliente têm em comum (as fontes de log, `admin-log-sources.service.ts`, e
 * os usuários do cliente, `admin-node-users.service.ts`): a plataforma do nó pelo lugar do cliente, a leitura de uma
 * subcoleção inteira e a chave pública do cofre do nó, conferida de novo antes de cifrar qualquer coisa para ele.
 */

/** A plataforma do nó pelo lugar do cliente: o gerenciado roda na GCP; o do cliente, na VM dele. */
export function platformOf(hosting: Hosting): NodePlatform {
  return hosting === 'verax' ? 'gcp' : 'vm';
}

/** Uma subcoleção inteira, conferida documento a documento, na ordem do id. */
export async function readCollection<T extends z.ZodType>(
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

/** Por que não há para quem cifrar: o nó não sincronizou, é de outra plataforma, está sem cofre ou a chave não confere. */
export type NodeVaultRefusal =
  'node_not_synced' | 'platform_mismatch' | 'vault_disabled' | 'vault_key_invalid';

/** A chave do cofre do nó pronta para cifrar, com o id do cliente no banco do nó (o do rótulo dos envelopes). */
export interface NodeVault {
  publicKey: EnvelopePublicKey;
  keyVersion: number;
  fingerprint: string;
  nodeTenantId: string;
}

/**
 * A chave pública do cofre que o nó informou na última sincronização (`nodeSync/state`), conferida de novo aqui: o nó
 * sincronizado (com o id do cliente no banco dele), da plataforma do lugar do cliente, com o cofre legível, a chave
 * no formato do cofre e a impressão digital igual à gravada. Qualquer divergência é recusa: nada é cifrado.
 */
export function nodeVaultOf(
  state: NodeSyncState | undefined,
  platform: NodePlatform,
): { ok: true; vault: NodeVault } | { ok: false; code: NodeVaultRefusal } {
  if (state?.nodeTenantId === null || state?.nodeTenantId === undefined) {
    return { ok: false, code: 'node_not_synced' };
  }
  if (state.platform !== platform) return { ok: false, code: 'platform_mismatch' };
  const vaultKey = state.vaultKey;
  if (vaultKey === null || state.error === 'vault_unreadable') return { ok: false, code: 'vault_disabled' };
  const pem = Buffer.from(vaultKey.publicKey, 'base64').toString('utf8');
  try {
    const publicKey = vaultPublicKeyFromPem(pem, vaultKey.version);
    if (publicKeyFingerprint(pem) !== vaultKey.fingerprint)
      throw new CredentialVaultError('public_key_invalid');
    return {
      ok: true,
      vault: {
        publicKey,
        keyVersion: vaultKey.version,
        fingerprint: vaultKey.fingerprint,
        nodeTenantId: state.nodeTenantId,
      },
    };
  } catch (error) {
    if (!(error instanceof CredentialVaultError)) throw error;
    return { ok: false, code: 'vault_key_invalid' };
  }
}

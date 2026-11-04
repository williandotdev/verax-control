import { AuditService } from '../common/audit/audit.service.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { VaultKeyring } from './credential-keys.js';
import {
  CredentialVaultError,
  type CredentialVaultErrorCode,
  credentialBinding,
  reseal,
} from './credential-vault.js';

/** Uma vez por dia (e na partida do worker, como toda tarefa do agendador). */
export const CREDENTIAL_REKEY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Linhas por execução; as que sobrarem ficam para a execução seguinte. */
export const CREDENTIAL_REKEY_BATCH = 500;

/**
 * Lock transacional por conta cloud: a recifragem e a troca da credencial pelo painel (PR-V3) nunca gravam a mesma
 * linha ao mesmo tempo. Só vale dentro de uma transação.
 */
export async function lockCredential(tx: Prisma.TransactionClient, cloudAccountId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:cloud-credential:${cloudAccountId}`}))`;
}

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente). */
export interface CredentialRekeyReport {
  /** Linhas encontradas com uma versão da chave mais antiga que a corrente. */
  stale: number;
  rekeyed: number;
  /** Mudaram entre a busca e a gravação (troca pelo painel, outra réplica): ficam como estão. */
  skipped: number;
  /** Não abriram: ficam como estão, e o motivo vai por código (`key_version_missing`, `decrypt_failed`...). */
  failed: number;
  failures?: Partial<Record<CredentialVaultErrorCode, number>>;
}

type Outcome = 'rekeyed' | 'skipped';

/**
 * Tarefa `credential-rekey` do worker (fase 2, PR-V1): recifra com a versão corrente da chave do nó as credenciais
 * guardadas com uma versão mais antiga. Depois dela, a versão antiga pode ser desativada no Secret Manager sem
 * perder nenhuma credencial (as linhas que falharam continuam na versão de antes e aparecem no relatório).
 *
 * Cada linha é recifrada numa transação própria, sob o lock da conta, pelo escopo do próprio cliente, com auditoria
 * (`cloud_credential.rekey`, só o tipo e as versões) na trilha dele. O texto claro só existe na memória do worker.
 */
export class CredentialRekey {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    private readonly audit: AuditService = new AuditService(),
  ) {}

  async runOnce(signal?: AbortSignal): Promise<CredentialRekeyReport> {
    // Busca de sistema, entre todos os clientes: só as chaves das linhas. A leitura do conteúdo é pelo escopo.
    const stale = await this.prisma.cloudCredential.findMany({
      where: { keyVersion: { lt: this.keyring.current } },
      select: { cloudAccountId: true, tenantId: true },
      orderBy: { cloudAccountId: 'asc' },
      take: CREDENTIAL_REKEY_BATCH,
    });
    const report: CredentialRekeyReport = { stale: stale.length, rekeyed: 0, skipped: 0, failed: 0 };
    for (const row of stale) {
      signal?.throwIfAborted();
      try {
        report[await this.rekey(row.tenantId, row.cloudAccountId)] += 1;
      } catch (error) {
        if (!(error instanceof CredentialVaultError)) throw error;
        report.failed += 1;
        report.failures = { ...report.failures, [error.code]: (report.failures?.[error.code] ?? 0) + 1 };
      }
    }
    return report;
  }

  private rekey(tenantId: string, cloudAccountId: string): Promise<Outcome> {
    return this.prisma.$transaction(async (tx) => {
      await lockCredential(tx, cloudAccountId);
      const db = scopeToTenant(tx, tenantId);
      const credential = await db.cloudCredential.findUnique({
        where: { cloudAccountId },
        select: { kind: true, ciphertext: true, keyVersion: true },
      });
      const account = await db.cloudAccount.findUnique({
        where: { id: cloudAccountId },
        select: { id: true, tenantId: true, provider: true, accountId: true },
      });
      if (credential === null || account === null || credential.keyVersion >= this.keyring.current) {
        return 'skipped';
      }
      const binding = credentialBinding(account, credential.kind);
      const sealed = reseal(this.keyring, binding, credential.ciphertext);
      if (sealed === null) return 'skipped';
      const { count } = await db.cloudCredential.updateMany({
        where: { cloudAccountId, keyVersion: credential.keyVersion, ciphertext: credential.ciphertext },
        data: { ciphertext: sealed.ciphertext, keyVersion: sealed.keyVersion },
      });
      if (count === 0) return 'skipped';
      await this.audit.write(tx, {
        actor: { type: 'system', tenantId },
        action: 'cloud_credential.rekey',
        outcome: 'success',
        resourceType: 'cloud_credential',
        resourceId: cloudAccountId,
        before: { kind: credential.kind, keyVersion: credential.keyVersion },
        after: { kind: credential.kind, keyVersion: sealed.keyVersion },
      });
      return 'rekeyed';
    });
  }
}

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
/** Linhas por página da busca. A execução percorre todas as páginas (cursor pelo ID da conta), até a última linha. */
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
  /** Linhas encontradas com uma versão da chave mais antiga que a corrente, somadas todas as páginas. */
  stale: number;
  rekeyed: number;
  /** Mudaram entre a busca e a gravação (troca pelo painel, outra réplica): ficam como estão. */
  skipped: number;
  /**
   * Não abriram: ficam como estão, com o motivo por código (`key_version_missing`, `decrypt_failed`...), e são tentadas
   * de novo na execução seguinte.
   */
  failed: number;
  failures?: Partial<Record<CredentialVaultErrorCode, number>>;
}

/** O que a construção aceita além do banco e do chaveiro. */
export interface CredentialRekeyOptions {
  audit?: AuditService;
  /** Linhas por página da busca (menor nos testes, para percorrer várias páginas com poucas linhas). */
  batch?: number;
}

type Outcome = 'rekeyed' | 'skipped';

/** O que a busca de sistema lê de cada linha pendente: só as chaves (o conteúdo é lido depois, pelo escopo). */
interface StaleRow {
  cloudAccountId: string;
  tenantId: string;
}

/**
 * Tarefa `credential-rekey` do worker (fase 2, PR-V1): recifra com a versão corrente da chave do nó as credenciais
 * guardadas com uma versão mais antiga. Depois dela, a versão antiga pode ser desativada no Secret Manager sem
 * perder nenhuma credencial (as linhas que falharam continuam na versão de antes e aparecem no relatório).
 *
 * Cada linha é recifrada numa transação própria, sob o lock da conta, pelo escopo do próprio cliente, com auditoria
 * (`cloud_credential.rekey`, só o tipo e as versões) na trilha dele. O texto claro só existe na memória do worker.
 *
 * A execução percorre todas as linhas pendentes, em páginas pelo ID da conta. Uma linha que não abre (versão da chave
 * desativada, texto adulterado) continua pendente, mas o cursor passa por ela e a execução segue até a última linha:
 * ela não segura as seguintes, e é tentada de novo na execução seguinte. O sinal do agendador (orçamento de tempo,
 * parada do worker) é conferido a cada página e a cada linha.
 */
export class CredentialRekey {
  private readonly audit: AuditService;
  private readonly batch: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    { audit = new AuditService(), batch = CREDENTIAL_REKEY_BATCH }: CredentialRekeyOptions = {},
  ) {
    if (!Number.isInteger(batch) || batch < 1)
      throw new Error('a página da recifragem precisa ser um inteiro positivo');
    this.audit = audit;
    this.batch = batch;
  }

  async runOnce(signal?: AbortSignal): Promise<CredentialRekeyReport> {
    const report: CredentialRekeyReport = { stale: 0, rekeyed: 0, skipped: 0, failed: 0 };
    // Busca de sistema, entre todos os clientes: só as chaves das linhas. A leitura do conteúdo é pelo escopo.
    // O cursor é o último ID lido (`cloudAccountId > último`), não um deslocamento (a linha recifrada sai da busca e
    // deslocaria as seguintes) nem o `cursor` do Prisma (que para se a linha do cursor sumir entre duas páginas).
    let after: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const page: StaleRow[] = await this.prisma.cloudCredential.findMany({
        where: {
          keyVersion: { lt: this.keyring.current },
          ...(after !== null && { cloudAccountId: { gt: after } }),
        },
        select: { cloudAccountId: true, tenantId: true },
        orderBy: { cloudAccountId: 'asc' },
        take: this.batch,
      });
      report.stale += page.length;
      for (const row of page) {
        signal?.throwIfAborted();
        try {
          report[await this.rekey(row.tenantId, row.cloudAccountId)] += 1;
        } catch (error) {
          if (!(error instanceof CredentialVaultError)) throw error;
          report.failed += 1;
          report.failures = { ...report.failures, [error.code]: (report.failures?.[error.code] ?? 0) + 1 };
        }
      }
      const last = page.at(-1);
      if (last === undefined || page.length < this.batch) return report;
      after = last.cloudAccountId;
    }
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

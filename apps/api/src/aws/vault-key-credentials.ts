import { forgetLiveSecret } from '../common/logger/sanitize.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { VaultKeyring } from '../credentials/credential-keys.js';
import {
  AwsAccessKey,
  CredentialVaultError,
  credentialBinding,
  open,
} from '../credentials/credential-vault.js';
import { type AwsCredentialIdentity, TemporaryCredentials } from '../inventory/read-only-session.js';
import {
  type AwsCredentialProvider,
  AwsConnectionError,
  type AwsLogger,
  type AwsReaderCredentials,
  type ReaderSession,
  STS_FALLBACK_REGION,
} from './web-identity.js';

/**
 * As credenciais da AWS na VM própria do cliente (`NODE_PLATFORM=vm`; `docs/ARQUITETURA.md`, "Cofre de credenciais"):
 * lá não há token do Google para entrar no papel sem chave, e o worker lê a conta com a chave do usuário IAM de leitura
 * que o admin colou no painel (`aws_access_key`, no cofre do nó). O resto da conferência (`web-identity-checker.ts`) e
 * o inventário (`inventory/inventory-job.ts`) não mudam: pedem a sessão da conta pelo mesmo contrato do papel
 * (`AwsReaderCredentials`).
 *
 * - A chave sai do cofre só aqui, no worker, amarrada à conta ativa do cadastro (o ID da conta AWS é único no nó), e
 *   fica num objeto que não vira JSON nem log, com o segredo registrado no logger enquanto vale.
 * - Guardada por conta enquanto o texto cifrado for o mesmo: trocar a chave no painel troca o texto, e a próxima
 *   sessão já sai com a nova; remover a chave (ou desativar a conta) faz a próxima falhar com `key_missing`.
 * - O STS é sempre o de us-east-1 (que não pode ser desligado): o `GetCallerIdentity` da conferência não depende da
 *   região da conta.
 */
export class VaultKeyCredentials implements AwsReaderCredentials {
  readonly #cache = new Map<string, { ciphertext: string; session: ReaderSession }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    private readonly logger: AwsLogger = { warn: () => undefined },
  ) {}

  async session(accountId: string, _region: string, signal?: AbortSignal): Promise<ReaderSession> {
    signal?.throwIfAborted();
    const account = await this.prisma.cloudAccount.findFirst({
      where: { provider: 'aws', accountId, status: 'active' },
      select: {
        id: true,
        tenantId: true,
        accountId: true,
        credential: { select: { kind: true, ciphertext: true } },
      },
    });
    const credential = account?.credential;
    if (account === null || credential == null || credential.kind !== 'aws_access_key') {
      this.forget(accountId);
      throw new AwsConnectionError('key_missing', false);
    }
    const cached = this.#cache.get(accountId);
    if (cached !== undefined && cached.ciphertext === credential.ciphertext) return cached.session;
    // A chave trocada (ou colada de novo): a anterior sai antes de a nova ser registrada no logger.
    this.forget(accountId);
    let key: AwsAccessKey;
    try {
      const opened = open(
        this.keyring,
        credentialBinding({ ...account, provider: 'aws' }, credential.kind),
        credential.ciphertext,
      );
      if (!(opened instanceof AwsAccessKey)) throw new CredentialVaultError('payload_invalid');
      key = opened;
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      // Só o código do cofre; a conta aparece como sem chave legível, e o admin cola de novo.
      this.logger.warn({ vaultError: error.code }, 'a chave da AWS guardada no cofre não abriu');
      this.forget(accountId);
      throw new AwsConnectionError('key_missing', false);
    }
    const identity: AwsCredentialIdentity = { accessKeyId: key.accessKeyId, secretAccessKey: key.secret() };
    const session: ReaderSession = {
      credentials: new TemporaryCredentials(identity),
      stsRegion: STS_FALLBACK_REGION,
      regionFallback: false,
      principal: 'iam_user',
    };
    this.#cache.set(accountId, { ciphertext: credential.ciphertext, session });
    return session;
  }

  credentialsFor(accountId: string, region: string): AwsCredentialProvider {
    return async () => (await this.session(accountId, region)).credentials.identity();
  }

  /** Descarta a chave guardada da conta, e o logger deixa de guardar o segredo dela. */
  forget(accountId: string): void {
    const cached = this.#cache.get(accountId);
    if (cached !== undefined) forgetLiveSecret(cached.session.credentials.identity().secretAccessKey);
    this.#cache.delete(accountId);
  }
}

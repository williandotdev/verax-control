import type { PrismaService } from '../common/prisma/prisma.service.js';
import type { VaultKeyring } from '../credentials/credential-keys.js';
import {
  CredentialVaultError,
  credentialBinding,
  GcpServiceAccountKey,
  open,
} from '../credentials/credential-vault.js';
import { type PubsubMessage, type PubsubReader, PubsubRestReader } from './pubsub.client.js';
import { ServiceAccountTokenProvider, type ServiceAccountTokenOptions } from './service-account-token.js';

/**
 * A assinatura não tem chave legível no cofre (nenhuma conta ativa com ela tem a chave da conta de serviço, ou a chave
 * não abriu). Vira o erro de conexão das contas que usam a assinatura (o nome é o código que vai para a conta).
 */
export class GcpKeyMissingError extends Error {
  override name = 'gcp_key_missing';

  constructor() {
    super('assinatura do Pub/Sub sem a chave da conta de serviço no cofre');
  }
}

/** Uma assinatura lida com a chave de uma conta: o leitor e o texto cifrado de onde a chave saiu. */
interface KeyedReader {
  ciphertext: string;
  tokens: ServiceAccountTokenProvider;
  reader: PubsubRestReader;
}

export interface VaultPubsubReaderOptions {
  /** Só para os testes: os servidores falsos do token e do Pub/Sub, em 127.0.0.1. */
  token?: Pick<ServiceAccountTokenOptions, 'url'>;
  pubsubBaseUrl?: string;
}

/**
 * A leitura do Pub/Sub na VM própria do cliente (`NODE_PLATFORM=vm`; `docs/ARQUITETURA.md`, "Cofre de credenciais"):
 * sem a conta de serviço da VM, cada assinatura é lida com a chave da conta de serviço de leitura que o admin colou na
 * conta GCP dela (`gcp_service_account_key`, no cofre). O sync (`gcp-audit-sync.ts`) não muda: ele pede cada
 * assinatura pelo nome, e este leitor escolhe a chave.
 *
 * - A chave é a da conta ativa mais antiga que cadastrou a assinatura e tem a chave (a assinatura é de um cliente só, e
 *   o sync já trata a cadastrada em dois como ambígua). Ela sai do cofre só aqui, amarrada à conta do cadastro.
 * - O token de 1 hora de cada chave fica guardado enquanto o texto cifrado for o mesmo: trocar a chave no painel troca
 *   o texto, e a leitura seguinte já usa a nova. Sem chave legível, `gcp_key_missing` (o erro de conexão das contas).
 */
export class VaultPubsubReader implements PubsubReader {
  readonly #readers = new Map<string, KeyedReader>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    private readonly options: VaultPubsubReaderOptions = {},
  ) {}

  async pull(subscription: string, maxMessages: number): Promise<PubsubMessage[]> {
    return (await this.#readerFor(subscription)).pull(subscription, maxMessages);
  }

  async acknowledge(subscription: string, ackIds: readonly string[]): Promise<void> {
    if (ackIds.length === 0) return;
    await (await this.#readerFor(subscription)).acknowledge(subscription, ackIds);
  }

  async #readerFor(subscription: string): Promise<PubsubRestReader> {
    const account = await this.prisma.cloudAccount.findFirst({
      where: {
        provider: 'gcp',
        status: 'active',
        pubsubSubscription: subscription,
        credential: { kind: 'gcp_service_account_key' },
      },
      select: {
        id: true,
        tenantId: true,
        accountId: true,
        credential: { select: { kind: true, ciphertext: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const credential = account?.credential;
    if (account == null || credential == null) {
      this.#forget(subscription);
      throw new GcpKeyMissingError();
    }
    const cached = this.#readers.get(subscription);
    if (cached !== undefined && cached.ciphertext === credential.ciphertext) return cached.reader;
    this.#forget(subscription);
    let key: GcpServiceAccountKey;
    try {
      const opened = open(
        this.keyring,
        credentialBinding({ ...account, provider: 'gcp' }, credential.kind),
        credential.ciphertext,
      );
      if (!(opened instanceof GcpServiceAccountKey)) throw new CredentialVaultError('payload_invalid');
      key = opened;
    } catch (error) {
      if (error instanceof CredentialVaultError) throw new GcpKeyMissingError();
      throw error;
    }
    const tokens = new ServiceAccountTokenProvider(key, this.options.token ?? {});
    const reader = new PubsubRestReader(tokens, this.options.pubsubBaseUrl);
    this.#readers.set(subscription, { ciphertext: credential.ciphertext, tokens, reader });
    return reader;
  }

  #forget(subscription: string): void {
    this.#readers.get(subscription)?.tokens.release();
    this.#readers.delete(subscription);
  }
}

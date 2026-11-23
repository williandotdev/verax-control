import { CLOUDFLARE_OAUTH_RECONNECT_ERROR } from '@verax/shared';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { CheckedCredential } from '../credentials/credential-check.js';
import type { VaultKeyring } from '../credentials/credential-keys.js';
import { lockCredential } from '../credentials/credential-rekey.js';
import {
  CloudflareToken,
  CredentialVaultError,
  credentialBinding,
  open,
} from '../credentials/credential-vault.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CloudflareGrants, GrantBearer } from './oauth/cloudflare-grants.js';

/** O que identifica a conta para abrir a credencial dela. */
export interface CredentialAccount {
  id: string;
  tenantId: string;
  accountId: string;
  /** A concessão por OAuth que lê a conta; null na conta com token colado. */
  cloudflareGrantId: string | null;
}

/**
 * A versão da credencial aberta: o que tem de continuar igual para a leitura mexer na conexão da conta.
 * - token colado: o próprio texto cifrado (uma troca no painel o muda);
 * - concessão por OAuth: a concessão e o consentimento. O envelope dela muda a cada renovação, que não troca a credencial
 *   de ninguém; uma reconexão muda.
 */
export type CredentialVersion =
  { kind: 'token'; ciphertext: string } | { kind: 'oauth'; grantId: string; consentedAt: Date };

/** A leitura da conta em curso: a conta, a versão da credencial e o que autentica os pedidos. */
export type CloudflareSession<A extends CredentialAccount = CredentialAccount> =
  | { account: A; version: Extract<CredentialVersion, { kind: 'token' }>; token: CloudflareToken }
  | { account: A; version: Extract<CredentialVersion, { kind: 'oauth' }>; token: GrantBearer };

export type OpenedCloudflare<A extends CredentialAccount> =
  | { kind: 'ready'; session: CloudflareSession<A> }
  /** Sem credencial do Cloudflare (ou a concessão sumiu): nada a ler nem a registrar. */
  | { kind: 'none' }
  /** A coleta para até o cliente agir: nenhuma chamada. */
  | { kind: 'blocked'; version: CredentialVersion; code: string }
  /** O texto guardado não abre neste worker. */
  | { kind: 'unreadable'; version: CredentialVersion; code: string }
  /** Só na concessão: o acesso venceu e a renovação espera. */
  | { kind: 'waiting'; version: CredentialVersion; code: string; retryAt: Date };

/**
 * De onde vem a credencial de uma conta do Cloudflare (CF-3): o token colado, do cofre do nó, ou a concessão por OAuth.
 * O coletor não sabe a diferença, fora o que muda de verdade: a conferência de hora em hora (o `tokens/verify` é só do
 * token colado), o limite de requisições (o da concessão vale para todas as contas dela) e a versão que protege a escrita
 * da conexão.
 */
export class CloudflareCredentials {
  constructor(
    private readonly prisma: PrismaService,
    private readonly keyring: VaultKeyring,
    private readonly grants: CloudflareGrants,
  ) {}

  async open<A extends CredentialAccount>(
    account: A,
    now: Date,
    clock: () => Date,
  ): Promise<OpenedCloudflare<A>> {
    return account.cloudflareGrantId === null
      ? this.openToken(account, now)
      : this.openGrant(account, account.cloudflareGrantId, clock);
  }

  private async openToken<A extends CredentialAccount>(account: A, now: Date): Promise<OpenedCloudflare<A>> {
    const credential = await this.prisma.forTenant(account.tenantId).cloudCredential.findUnique({
      where: { cloudAccountId: account.id },
      select: { kind: true, ciphertext: true, expiresAt: true },
    });
    if (credential?.kind !== 'cloudflare_api_token') return { kind: 'none' };
    const { ciphertext } = credential;
    const version = { kind: 'token', ciphertext } as const;
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now.getTime()) {
      return { kind: 'blocked', version, code: 'credential_expired' };
    }
    try {
      const { id, tenantId, accountId } = account;
      const binding = credentialBinding({ id, tenantId, accountId, provider: 'cloudflare' }, credential.kind);
      const token = open(this.keyring, binding, ciphertext);
      if (!(token instanceof CloudflareToken)) throw new CredentialVaultError('payload_invalid');
      return { kind: 'ready', session: { account, version, token } };
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      return { kind: 'unreadable', version, code: 'credential_unreadable' };
    }
  }

  private async openGrant<A extends CredentialAccount>(
    account: A,
    grantId: string,
    clock: () => Date,
  ): Promise<OpenedCloudflare<A>> {
    const outcome = await this.grants.open({ tenantId: account.tenantId, grantId }, clock);
    if (outcome.kind === 'gone') return { kind: 'none' };
    const version = { kind: 'oauth', grantId, consentedAt: outcome.consentedAt } as const;
    switch (outcome.kind) {
      case 'ready':
        return { kind: 'ready', session: { account, version, token: outcome.bearer } };
      case 'reconnect':
        return { kind: 'blocked', version, code: CLOUDFLARE_OAUTH_RECONNECT_ERROR };
      case 'unreadable':
        return { kind: 'unreadable', version, code: 'oauth_unreadable' };
      case 'waiting':
        return { kind: 'waiting', version, code: outcome.code, retryAt: outcome.retryAt };
    }
  }

  /**
   * O código da conexão para uma recusa que para a coleta. No acesso por OAuth, o 401 que sobreviveu à renovação quer
   * dizer que a autorização acabou: a concessão espera o cliente conectar de novo. Os demais códigos são os de sempre.
   */
  async blockingCode(session: CloudflareSession, code: string): Promise<string> {
    if (session.version.kind !== 'oauth' || code !== 'credential_rejected') return code;
    const ref = { tenantId: session.account.tenantId, grantId: session.version.grantId };
    await this.grants.reject(ref, (session.token as GrantBearer).generation, code);
    return CLOUDFLARE_OAUTH_RECONNECT_ERROR;
  }

  /**
   * A credencial da conta ainda é a da leitura? Chamada dentro da transação que grava a conexão, com o lock da credencial
   * (`lockCredential`) já pego: um token trocado, uma reconexão ou a passagem do token para o OAuth no meio da leitura
   * nunca herdam o resultado da credencial anterior.
   */
  async isCurrent(
    tx: Prisma.TransactionClient,
    account: CredentialAccount,
    version: CredentialVersion,
  ): Promise<boolean> {
    const db = scopeToTenant(tx, account.tenantId);
    if (version.kind === 'token') {
      const current = await db.cloudCredential.findUnique({
        where: { cloudAccountId: account.id },
        select: { ciphertext: true },
      });
      return current?.ciphertext === version.ciphertext;
    }
    const current = await db.cloudAccount.findUnique({
      where: { id: account.id },
      select: { cloudflareGrantId: true },
    });
    if (current?.cloudflareGrantId !== version.grantId) return false;
    const grant = await db.cloudflareGrant.findUnique({
      where: { id: version.grantId },
      select: { consentedAt: true },
    });
    return grant?.consentedAt.getTime() === version.consentedAt.getTime();
  }

  /** A última conferência e a validade do token colado vindas do Cloudflare, só se o guardado ainda é o conferido. */
  async checked(
    account: CredentialAccount,
    version: Extract<CredentialVersion, { kind: 'token' }>,
    checked: CheckedCredential,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockCredential(tx, account.id);
      await scopeToTenant(tx, account.tenantId).cloudCredential.updateMany({
        where: { cloudAccountId: account.id, ciphertext: version.ciphertext },
        data: { verifiedAt: now, expiresAt: checked.expiresAt },
      });
    });
  }
}

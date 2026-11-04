import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  type AcceptedCredentialKind,
  type CloudAccount,
  type CloudCredentialInput,
  CREDENTIAL_KIND_PROVIDERS,
} from '@verax/shared';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CloudAccountsService, RESET_CONNECTION } from '../cloud-accounts/cloud-accounts.service.js';
import { CloudflareTokenCheck } from '../cloudflare/cloudflare-token-check.js';
import { AuditContext } from '../common/audit/audit-context.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { ApiError } from '../common/http/api-error.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { VaultPublicKey } from './credential-keys.js';
import {
  type CheckedCredential,
  CredentialRejected,
  type CredentialRejectionReason,
  CredentialSourceUnavailable,
} from './credential-check.js';
import { lockCredential } from './credential-rekey.js';
import {
  CloudflareToken,
  CredentialVaultError,
  credentialBinding,
  releaseSecret,
  seal,
  type VaultSecret,
} from './credential-vault.js';

/** Ações da trilha: a primeira credencial da conta, a troca e a remoção pelo painel. */
export const CREDENTIAL_ACTIONS = {
  set: 'cloud_credential.set',
  rotate: 'cloud_credential.rotate',
  remove: 'cloud_credential.remove',
} as const;
const RESOURCE_TYPE = 'cloud_credential';

/**
 * Limite de tentativas recusadas (R19 do plano revisado), contadas na própria trilha de auditoria: a cada hora, 5
 * por conta e 20 por cliente. Conta só o que a API recusou com 400 depois de achar a conta (recusa da origem, tipo de
 * outro provedor, conta inativa): é o que faria do endpoint um verificador de tokens. Formato inválido (o schema
 * recusa antes, sem chamar a origem), indisponibilidade (503) e o próprio 429 não contam.
 */
export const CREDENTIAL_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;
export const CREDENTIAL_ATTEMPTS_PER_ACCOUNT = 5;
export const CREDENTIAL_ATTEMPTS_PER_TENANT = 20;

/** O que a trilha guarda da credencial: só metadados. */
const SUMMARY_SELECT = {
  kind: true,
  keyIdSuffix: true,
  expiresAt: true,
} as const satisfies Prisma.CloudCredentialSelect;
type CredentialSummaryRow = Prisma.CloudCredentialGetPayload<{ select: typeof SUMMARY_SELECT }>;

function summary(row: CredentialSummaryRow) {
  return { kind: row.kind, keyIdSuffix: row.keyIdSuffix, expiresAt: row.expiresAt?.toISOString() ?? null };
}

/** Mensagens da recusa: dizem o que conferir, sem repetir nada da resposta da origem. */
const REJECTION_MESSAGES: Readonly<Record<CredentialRejectionReason, string>> = {
  invalid:
    'O Cloudflare não aceitou o token. Confira se ele foi copiado inteiro e se foi criado para esta conta.',
  inactive: 'O token está desativado no Cloudflare.',
  expired: 'O token venceu no Cloudflare. Crie outro ou estenda a validade dele.',
  not_yet_valid: 'O token ainda não começou a valer: confira a data de início definida no Cloudflare.',
  no_account_access:
    'O token não lê a auditoria desta conta do Cloudflare. Confira a conta escolhida ao criar o token, a permissão Account Settings: Read e o filtro de IP.',
};

const NOT_FOUND = 'Conta não encontrada';

/** Uma credencial aceita: como montar o invólucro do valor colado e como conferi-lo na origem. */
interface KindHandler {
  wrap(input: CloudCredentialInput): VaultSecret;
  check(secret: VaultSecret, accountId: string): Promise<CheckedCredential>;
}

/**
 * Recebimento da credencial colada no painel (fase 2; a rota genérica que o PR-V3 descrevia, hoje só com o token do
 * Cloudflare, PR-11'): `PUT` e `DELETE /v1/cloud-accounts/:id/credential`, na transação do `AuditInterceptor`.
 *
 * No `PUT`, nesta ordem:
 * 1. o cofre precisa estar ligado no nó (a API tem a chave pública);
 * 2. lock da conta (o mesmo da recifragem do worker) e a conta pelo escopo do cliente: de outro cliente, 404 sem
 *    chamar a origem; de outro provedor ou inativa, 400;
 * 3. limite de tentativas recusadas (429);
 * 4. a conferência na origem, na memória da API (recusa: 400; origem fora: 503);
 * 5. cifra com a chave pública (a API não decifra), grava a linha e volta a conexão para "aguardando";
 * 6. auditoria `cloud_credential.set` ou `.rotate`, só com tipo, `keyIdSuffix` e validade.
 *
 * O texto claro nunca vai para o banco, o log, a auditoria nem a resposta, e o logger o esquece no fim
 * (`releaseSecret`).
 */
@Injectable()
export class CredentialIntakeService {
  private readonly publicKey: VaultPublicKey | null;
  private readonly handlers: Readonly<Record<AcceptedCredentialKind, KindHandler>>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditContext,
    private readonly accounts: CloudAccountsService,
    cloudflare: CloudflareTokenCheck,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'credentialsPublicKey'>,
    @InjectPinoLogger(CredentialIntakeService.name) private readonly logger: PinoLogger,
  ) {
    this.publicKey = config.credentialsPublicKey;
    this.handlers = {
      cloudflare_api_token: {
        wrap: (input) => new CloudflareToken(input.token),
        check: (secret, accountId) => {
          if (!(secret instanceof CloudflareToken)) throw new CredentialVaultError('binding_invalid');
          return cloudflare.check(secret, accountId);
        },
      },
    };
  }

  async put(auth: RequestAuth, id: string, input: CloudCredentialInput): Promise<CloudAccount> {
    // Descrita antes de tudo: a tentativa recusada entra na trilha com esta ação (é o que o limite conta).
    this.audit.describe({ action: CREDENTIAL_ACTIONS.set, resourceType: RESOURCE_TYPE, resourceId: id });
    const publicKey = this.publicKey;
    if (publicKey === null) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'O cofre de credenciais não está ligado neste nó.',
        'CREDENTIAL_VAULT_DISABLED',
      );
    }
    await lockCredential(this.prisma.db(), id);
    const db = this.prisma.scoped();
    const account = await db.cloudAccount.findUnique({
      where: { id },
      select: { id: true, tenantId: true, provider: true, accountId: true, status: true },
    });
    if (!account) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    const current = await db.cloudCredential.findUnique({
      where: { cloudAccountId: id },
      select: SUMMARY_SELECT,
    });
    const action = current ? CREDENTIAL_ACTIONS.rotate : CREDENTIAL_ACTIONS.set;
    this.audit.describe({ action });
    if (CREDENTIAL_KIND_PROVIDERS[input.kind] !== account.provider) {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Este tipo de credencial não vale para esta conta.');
    }
    if (account.status !== 'active') {
      throw new ApiError(HttpStatus.BAD_REQUEST, 'Reative a conta antes de guardar a credencial.');
    }
    await this.assertAttemptsLeft(db, id);

    const handler = this.handlers[input.kind];
    const secret = handler.wrap(input);
    try {
      const checked = await this.checkAtSource(input.kind, account.id, () =>
        handler.check(secret, account.accountId),
      );
      const sealed = seal(publicKey, credentialBinding(account, input.kind), secret);
      const data = {
        kind: input.kind,
        ciphertext: sealed.ciphertext,
        keyVersion: sealed.keyVersion,
        keyIdSuffix: checked.keyIdSuffix,
        issuedAt: checked.issuedAt,
        expiresAt: checked.expiresAt,
        verifiedAt: new Date(),
        rotationNoticeAt: null,
      } satisfies Prisma.CloudCredentialUpdateInput;
      const saved = await db.cloudCredential.upsert({
        where: { cloudAccountId: id },
        create: { cloudAccountId: id, tenantId: account.tenantId, ...data },
        update: data,
        select: SUMMARY_SELECT,
      });
      // Credencial nova é leitura nova: a conexão espera a próxima coleta confirmar.
      await db.cloudAccount.update({ where: { id }, data: RESET_CONNECTION, select: { id: true } });
      this.audit.describe({ action, before: current ? summary(current) : null, after: summary(saved) });
    } finally {
      releaseSecret(secret);
    }
    return this.accounts.get(auth, id);
  }

  async remove(id: string): Promise<void> {
    this.audit.describe({ action: CREDENTIAL_ACTIONS.remove, resourceType: RESOURCE_TYPE, resourceId: id });
    await lockCredential(this.prisma.db(), id);
    const db = this.prisma.scoped();
    const account = await db.cloudAccount.findUnique({ where: { id }, select: { id: true } });
    if (!account) throw new ApiError(HttpStatus.NOT_FOUND, NOT_FOUND);
    const current = await db.cloudCredential.findUnique({
      where: { cloudAccountId: id },
      select: SUMMARY_SELECT,
    });
    if (!current) throw new ApiError(HttpStatus.NOT_FOUND, 'Esta conta não tem credencial guardada.');
    await db.cloudCredential.delete({ where: { cloudAccountId: id }, select: { cloudAccountId: true } });
    await db.cloudAccount.update({ where: { id }, data: RESET_CONNECTION, select: { id: true } });
    this.audit.describe({ before: summary(current), after: null });
  }

  /** Tentativas recusadas na última hora, na trilha do cliente do escopo: por conta e no cliente inteiro. */
  private async assertAttemptsLeft(db: Prisma.TransactionClient, id: string): Promise<void> {
    const refused = {
      action: { in: [CREDENTIAL_ACTIONS.set, CREDENTIAL_ACTIONS.rotate] },
      outcome: 'failure',
      statusCode: HttpStatus.BAD_REQUEST,
      occurredAt: { gte: new Date(Date.now() - CREDENTIAL_ATTEMPT_WINDOW_MS) },
    } satisfies Prisma.AuditLogWhereInput;
    const onAccount = await db.auditLog.count({
      where: { ...refused, resourceType: RESOURCE_TYPE, resourceId: id },
    });
    const onTenant = await db.auditLog.count({ where: refused });
    if (onAccount >= CREDENTIAL_ATTEMPTS_PER_ACCOUNT || onTenant >= CREDENTIAL_ATTEMPTS_PER_TENANT) {
      throw new ApiError(
        HttpStatus.TOO_MANY_REQUESTS,
        'Muitas tentativas recusadas. Confira o token no Cloudflare e tente de novo em até uma hora.',
        'CREDENTIAL_ATTEMPTS_EXCEEDED',
      );
    }
  }

  /**
   * A conferência na origem, com a recusa e a indisponibilidade traduzidas. No log, só o tipo, a conta e os códigos:
   * nada do valor colado nem da resposta da origem.
   */
  private async checkAtSource(
    kind: AcceptedCredentialKind,
    cloudAccountId: string,
    check: () => Promise<CheckedCredential>,
  ): Promise<CheckedCredential> {
    try {
      return await check();
    } catch (error) {
      if (error instanceof CredentialRejected) {
        this.logger.warn(
          { cloudAccountId, kind, reason: error.reason, sourceStatus: error.sourceStatus },
          'credencial recusada na origem',
        );
        throw new ApiError(HttpStatus.BAD_REQUEST, REJECTION_MESSAGES[error.reason], 'CREDENTIAL_REJECTED');
      }
      if (error instanceof CredentialSourceUnavailable) {
        this.logger.warn(
          { cloudAccountId, kind, sourceError: error.code },
          'origem da credencial indisponível',
        );
        throw new ApiError(
          HttpStatus.SERVICE_UNAVAILABLE,
          'A origem da credencial não respondeu.',
          'SOURCE_UNAVAILABLE',
        );
      }
      throw error;
    }
  }
}

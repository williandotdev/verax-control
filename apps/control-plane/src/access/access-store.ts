import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { isUlid } from '../common/ulid.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  parseDocument,
} from '../firestore/document-store.js';
import { type Tenant, type TenantRecord, tenantSchema } from '../tenants/tenant.schema.js';
import {
  newStatusTokenValue,
  STATUS_TOKEN_TTL_MS,
  type StatusTokenDocument,
  statusTokenDocumentSchema,
  statusTokenId,
  type StatusTokenKind,
  statusTokenValueSchema,
} from './status-token.js';

/** O único estado em que a senha inicial pode ser revelada (plano §4g). */
export const REVEAL_STATE = 'waiting_customer_connection';

/**
 * Credencial desconhecida, vencida, do tipo errado, link já usado, ou cliente inexistente ou excluído: para quem chama
 * de fora é tudo o mesmo 404 genérico (plano §4g), sem dizer qual.
 */
export class StatusAccessNotFoundError extends Error {
  constructor() {
    super('credencial da página de status inválida');
    this.name = 'StatusAccessNotFoundError';
  }
}

/** A senha deste cliente já foi revelada (a segunda revelação é 409). */
export class AlreadyRevealedError extends Error {
  constructor(readonly tenantId: string) {
    super(`a senha inicial do cliente ${tenantId} já foi revelada`);
    this.name = 'AlreadyRevealedError';
  }
}

/** O cliente não está esperando a conexão (ainda provisionando, suspenso, cancelado...): nada a revelar agora. */
export class RevealNotAvailableError extends Error {
  constructor(readonly tenantId: string) {
    super(`o cliente ${tenantId} não está em ${REVEAL_STATE}`);
    this.name = 'RevealNotAvailableError';
  }
}

export interface MintedStatusToken {
  /** O valor que vai ao cliente (cookie ou link); nunca é gravado. */
  value: string;
  expiresAt: Date;
}

export interface ResolvedStatusToken extends StatusTokenDocument {
  id: string;
}

/** A revelação marcada (o ponto sem volta): o cliente como ficou e o carimbo, para desfazer se a leitura falhar. */
export interface RevealClaim {
  tenant: TenantRecord;
  revealedAt: Date;
  tokenId: string;
  kind: StatusTokenKind;
}

export interface AccessAuditContext {
  requestId?: string;
}

const HOUR_MS = 60 * 60_000;
/** Plano B (plano §4c, passo 9): o e-mail sai 48 h depois de o cliente entrar em espera sem revelar a senha. */
export const REVEAL_EMAIL_AFTER_MS = 48 * HOUR_MS;
/** Depois de 72 h a senha temporária já venceu (plano §4c, passo 10): o e-mail não serve mais. */
export const REVEAL_EMAIL_UNTIL_MS = 72 * HOUR_MS;
/** Teto de clientes por rodada do `tick`: são poucos por dia; o resto fica para a hora seguinte. */
const REVEAL_EMAIL_BATCH = 200;

function customerActor(tenantId: string): string {
  return `customer:${tenantId}`;
}

/**
 * Repositório do acesso do cliente (plano §3): `statusTokens/{sha256}` e o bloco `access` de `tenants/{id}`. A
 * revelação é uma transação que confere a credencial e o cliente e marca `access.passwordRevealedAt` antes de qualquer
 * leitura do segredo (plano §4c, passo 10): duas revelações ao mesmo tempo terminam com uma marcada e a outra em
 * `AlreadyRevealedError`. Toda escrita leva a auditoria na mesma transação; nenhuma leva o valor de credencial nem
 * e-mail.
 */
@Injectable()
export class AccessStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Cria uma credencial para o cliente; o valor volta só daqui, e o Firestore guarda o hash. */
  async mint(
    tenantId: string,
    kind: StatusTokenKind,
    actor: string,
    context: AccessAuditContext = {},
  ): Promise<MintedStatusToken> {
    if (!isUlid(tenantId)) throw new TypeError('id de cliente inválido');
    const value = newStatusTokenValue();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + STATUS_TOKEN_TTL_MS[kind]);
    const document = statusTokenDocumentSchema.parse({ tenantId, kind, createdAt: now, expiresAt });
    await this.store.runTransaction((tx) => {
      tx.create(COLLECTIONS.statusTokens, statusTokenId(value), document);
      this.audit.record(tx, {
        actor,
        action: kind === 'cookie' ? 'access.status_claimed' : 'access.reveal_link_created',
        tenantId,
        details: { kind, expiresAt },
        requestId: context.requestId,
      });
      return Promise.resolve();
    });
    return { value, expiresAt };
  }

  /** A credencial válida agora (existe, do tipo pedido, no prazo e, se for link, sem uso), ou `undefined`. */
  async resolve(value: string, kind: StatusTokenKind): Promise<ResolvedStatusToken | undefined> {
    if (!statusTokenValueSchema.safeParse(value).success) return undefined;
    const id = statusTokenId(value);
    const credential = await this.readToken(this.store, id);
    if (credential === undefined || !this.usable(credential, kind, this.clock.now())) return undefined;
    return { id, ...credential };
  }

  /**
   * Marca a revelação, numa transação: credencial válida do tipo pedido, cliente existente e não excluído, ainda sem
   * revelação (`AlreadyRevealedError`) e esperando a conexão (`RevealNotAvailableError`). Grava
   * `access.passwordRevealedAt`, o uso do link do e-mail e a auditoria `access.revealed`.
   */
  async claimReveal(
    value: string,
    kind: StatusTokenKind,
    context: AccessAuditContext = {},
  ): Promise<RevealClaim> {
    if (!statusTokenValueSchema.safeParse(value).success) throw new StatusAccessNotFoundError();
    const id = statusTokenId(value);
    return this.store.runTransaction(async (tx) => {
      const credential = await this.readToken(tx, id);
      const now = this.clock.now();
      if (credential === undefined || !this.usable(credential, kind, now))
        throw new StatusAccessNotFoundError();
      const tenant = await this.readTenant(tx, credential.tenantId);
      if (tenant === undefined || tenant.state === 'deleted') throw new StatusAccessNotFoundError();
      if (tenant.access?.passwordRevealedAt !== undefined)
        throw new AlreadyRevealedError(credential.tenantId);
      if (tenant.state !== REVEAL_STATE) throw new RevealNotAvailableError(credential.tenantId);
      const updated = tenantSchema.parse({
        ...tenant,
        access: { ...tenant.access, passwordRevealedAt: now },
        updatedAt: now,
      });
      tx.set(COLLECTIONS.tenants, credential.tenantId, updated);
      if (kind === 'email_reveal') {
        tx.set(COLLECTIONS.statusTokens, id, statusTokenDocumentSchema.parse({ ...credential, usedAt: now }));
      }
      this.audit.record(tx, {
        actor: customerActor(credential.tenantId),
        action: 'access.revealed',
        tenantId: credential.tenantId,
        details: { via: kind },
        requestId: context.requestId,
      });
      return { tenant: { id: credential.tenantId, ...updated }, revealedAt: now, tokenId: id, kind };
    });
  }

  /**
   * Desfaz a marcação quando nada foi mostrado (o segredo não pôde ser lido, a senha venceu, a destruição não entrou
   * na fila): o cliente pode tentar de novo, com o mesmo link se veio do e-mail. Só desfaz a marcação desta revelação
   * (mesmo carimbo); devolve `false` se ela não estiver mais lá.
   */
  async revertReveal(claim: RevealClaim, reason: string, context: AccessAuditContext = {}): Promise<boolean> {
    const tenantId = claim.tenant.id;
    return this.store.runTransaction(async (tx) => {
      const tenant = await this.readTenant(tx, tenantId);
      const credential = claim.kind === 'email_reveal' ? await this.readToken(tx, claim.tokenId) : undefined;
      const marked = tenant?.access?.passwordRevealedAt;
      if (tenant === undefined || marked?.getTime() !== claim.revealedAt.getTime()) return false;
      const now = this.clock.now();
      const { passwordRevealedAt: _undone, ...access } = tenant.access ?? {};
      tx.set(COLLECTIONS.tenants, tenantId, tenantSchema.parse({ ...tenant, access, updatedAt: now }));
      if (credential?.usedAt?.getTime() === claim.revealedAt.getTime()) {
        const { usedAt: _unused, ...rest } = credential;
        tx.set(COLLECTIONS.statusTokens, claim.tokenId, statusTokenDocumentSchema.parse(rest));
      }
      this.audit.record(tx, {
        actor: 'system',
        action: 'access.reveal_reverted',
        tenantId,
        details: { reason, via: claim.kind },
        requestId: context.requestId,
      });
      return true;
    });
  }

  /** Registra o envio do e-mail do plano B (`access.revealEmailSentAt`), para o `tick` não mandar de novo. */
  async markRevealEmailSent(tenantId: string, context: AccessAuditContext = {}): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      const tenant = await this.readTenant(tx, tenantId);
      if (tenant === undefined) return;
      const now = this.clock.now();
      tx.set(
        COLLECTIONS.tenants,
        tenantId,
        tenantSchema.parse({
          ...tenant,
          access: { ...tenant.access, revealEmailSentAt: now },
          updatedAt: now,
        }),
      );
      this.audit.record(tx, {
        actor: 'system',
        action: 'access.reveal_email_sent',
        tenantId,
        details: { state: tenant.state },
        requestId: context.requestId,
      });
    });
  }

  /**
   * Clientes para o e-mail do plano B: em espera da conexão há 48 h a 72 h (`stateUpdatedAt`), sem a senha revelada e
   * sem o e-mail enviado. A consulta (estado e prazo) usa o índice composto (`state`, `stateUpdatedAt`).
   */
  async findDueForRevealEmail(now: Date): Promise<TenantRecord[]> {
    const docs = await this.store.query(COLLECTIONS.tenants, {
      where: [
        { field: 'state', op: '==', value: REVEAL_STATE },
        { field: 'stateUpdatedAt', op: '>', value: new Date(now.getTime() - REVEAL_EMAIL_UNTIL_MS) },
        { field: 'stateUpdatedAt', op: '<=', value: new Date(now.getTime() - REVEAL_EMAIL_AFTER_MS) },
      ],
      orderBy: { field: 'stateUpdatedAt' },
      limit: REVEAL_EMAIL_BATCH,
    });
    return docs
      .map(({ id, data }) => ({ id, ...parseDocument(tenantSchema, COLLECTIONS.tenants, id, data) }))
      .filter(
        (tenant) =>
          tenant.access?.passwordRevealedAt === undefined && tenant.access?.revealEmailSentAt === undefined,
      );
  }

  private usable(credential: StatusTokenDocument, kind: StatusTokenKind, now: Date): boolean {
    return (
      credential.kind === kind &&
      credential.expiresAt.getTime() > now.getTime() &&
      (kind === 'cookie' || credential.usedAt === undefined)
    );
  }

  private async readToken(reader: DocumentReader, id: string): Promise<StatusTokenDocument | undefined> {
    const data = await reader.get(COLLECTIONS.statusTokens, id);
    if (data === undefined) return undefined;
    return parseDocument(statusTokenDocumentSchema, COLLECTIONS.statusTokens, id, data);
  }

  private async readTenant(reader: DocumentReader, tenantId: string): Promise<Tenant | undefined> {
    const data = await reader.get(COLLECTIONS.tenants, tenantId);
    if (data === undefined) return undefined;
    return parseDocument(tenantSchema, COLLECTIONS.tenants, tenantId, data);
  }
}

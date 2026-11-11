import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  parseDocument,
} from '../firestore/document-store.js';
import type { OwnerContext } from '../pricing/pricing-store.js';
import {
  type CurrentLegalVersions,
  legalContentSchema,
  type LegalKind,
  type LegalTextDocument,
  legalTextDocumentSchema,
  type LegalTextRecord,
  legalVersionSchema,
  type LegalVersionSummary,
} from './legal.schema.js';

export class LegalVersionNotFoundError extends Error {
  constructor(
    readonly kind: LegalKind,
    readonly version: string,
  ) {
    super(`versão inexistente: ${kind}/${version}`);
    this.name = 'LegalVersionNotFoundError';
  }
}

export class LegalVersionExistsError extends Error {
  constructor(
    readonly kind: LegalKind,
    readonly version: string,
  ) {
    super(`versão já existe: ${kind}/${version}`);
    this.name = 'LegalVersionExistsError';
  }
}

/** Só o rascunho muda: a publicada é imutável (mudar uma vírgula é criar outra versão). */
export class LegalVersionImmutableError extends Error {
  constructor(
    readonly kind: LegalKind,
    readonly version: string,
  ) {
    super(`versão ${kind}/${version} está publicada: só o rascunho pode mudar`);
    this.name = 'LegalVersionImmutableError';
  }
}

/** O rascunho mudou depois de quem edita ou publica tê-lo lido (outra aba, outra pessoa): nada é gravado. */
export class LegalDraftChangedError extends Error {
  constructor(
    readonly kind: LegalKind,
    readonly version: string,
  ) {
    super(`o rascunho ${kind}/${version} mudou desde a última leitura`);
    this.name = 'LegalDraftChangedError';
  }
}

/** Um texto em branco não se publica: o cliente aceitaria nada. */
export class LegalTextEmptyError extends Error {
  constructor(
    readonly kind: LegalKind,
    readonly version: string,
  ) {
    super(`o rascunho ${kind}/${version} está em branco`);
    this.name = 'LegalTextEmptyError';
  }
}

/** A revisão do rascunho que quem escreve leu (o `updatedAt` dele). */
export interface LegalDraftRevision {
  expectedUpdatedAt: Date;
}

export function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function bytesOf(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/** Prefixo das ações de auditoria de um texto (`legal.terms.`): a trilha do console filtra por ele. */
export function legalAuditPrefix(kind: LegalKind): string {
  return `legal.${kind}.`;
}

export function summaryOf(record: LegalTextRecord, current: boolean): LegalVersionSummary {
  return {
    kind: record.kind,
    version: record.version,
    status: record.status,
    current,
    ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }),
    ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    ...(record.publishedBy === undefined ? {} : { publishedBy: record.publishedBy }),
    ...(record.contentSha256 === undefined ? {} : { contentSha256: record.contentSha256 }),
    bytes: bytesOf(record.content),
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

/**
 * Repositório dos textos legais (`legalTexts/{tipo}/versions/{versão}`), no mesmo molde das tabelas de preço
 * (`pricing/pricing-store.ts`): toda escrita é uma transação que relê o documento, valida com zod e grava a auditoria
 * junto (ator `owner:<e-mail>`): `legal.<tipo>.draft.created`, `legal.<tipo>.draft.updated` (com o tamanho e o hash, nunca
 * o texto) e `legal.<tipo>.published` (com o hash do texto publicado). A vigente de cada texto é a publicada mais
 * recente (maior `publishedAt`). Não há exclusão nem aposentadoria: quem aceitou uma versão antiga ainda a lê.
 */
@Injectable()
export class LegalTextStore {
  constructor(
    @Inject(DOCUMENT_STORE) private readonly store: DocumentStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async get(kind: LegalKind, version: string): Promise<LegalTextRecord | undefined> {
    return this.read(this.store, kind, version);
  }

  async require(kind: LegalKind, version: string): Promise<LegalTextRecord> {
    const record = await this.get(kind, version);
    if (record === undefined) throw new LegalVersionNotFoundError(kind, version);
    return record;
  }

  /** As versões de um texto, da mais nova para a mais antiga (por criação), sem o texto, com a vigente marcada. */
  async list(kind: LegalKind): Promise<LegalVersionSummary[]> {
    const collection = COLLECTIONS.legalVersions(kind);
    const current = await this.current(kind);
    const docs = await this.store.query(collection);
    return docs
      .map(({ id, data }) => this.toRecord(kind, id, data))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.version < b.version ? 1 : -1))
      .map((record) => summaryOf(record, record.version === current?.version));
  }

  /**
   * A vigente: a publicada de maior `publishedAt`. Rascunhos não têm o campo e ficam fora da consulta (um campo só,
   * desigualdade nenhuma: sem índice composto).
   */
  async current(kind: LegalKind): Promise<LegalTextRecord | undefined> {
    const [latest] = await this.store.query(COLLECTIONS.legalVersions(kind), {
      orderBy: { field: 'publishedAt', direction: 'desc' },
      limit: 1,
    });
    return latest === undefined ? undefined : this.toRecord(kind, latest.id, latest.data);
  }

  /** As vigentes dos três textos, para o checkout e a rota pública. */
  async currentAll(): Promise<Record<LegalKind, LegalTextRecord | undefined>> {
    const [terms, privacy, dpa] = await Promise.all([
      this.current('terms'),
      this.current('privacy'),
      this.current('dpa'),
    ]);
    return { terms, privacy, dpa };
  }

  async currentVersions(): Promise<CurrentLegalVersions> {
    const current = await this.currentAll();
    return {
      terms: current.terms?.version,
      privacy: current.privacy?.version,
      dpa: current.dpa?.version,
    };
  }

  /** Um rascunho novo: em branco ou cópia do texto de outra versão do mesmo tipo (rascunho ou publicada). */
  async createDraft(
    kind: LegalKind,
    version: string,
    options: { from?: string },
    owner: OwnerContext,
  ): Promise<LegalTextRecord> {
    const id = legalVersionSchema.parse(version);
    const collection = COLLECTIONS.legalVersions(kind);
    return this.store.runTransaction(async (tx) => {
      const existing = await tx.get(collection, id);
      const source = options.from === undefined ? undefined : await this.read(tx, kind, options.from);
      if (existing !== undefined) throw new LegalVersionExistsError(kind, id);
      if (options.from !== undefined && source === undefined) {
        throw new LegalVersionNotFoundError(kind, options.from);
      }
      const now = this.clock.now();
      const document = legalTextDocumentSchema.parse({
        status: 'draft',
        content: source?.content ?? '',
        ...(source === undefined ? {} : { basedOn: source.version }),
        createdAt: now,
        createdBy: owner.email,
        updatedAt: now,
        updatedBy: owner.email,
      });
      tx.create(collection, id, { ...document });
      this.audit.record(tx, {
        actor: `owner:${owner.email}`,
        action: `${legalAuditPrefix(kind)}draft.created`,
        details: {
          version: id,
          ...(source === undefined ? {} : { basedOn: source.version }),
          bytes: bytesOf(document.content),
        },
        requestId: owner.requestId,
      });
      return { kind, version: id, ...document };
    });
  }

  /**
   * Grava o texto do rascunho. `expectedUpdatedAt` é o `updatedAt` que o console leu: se o rascunho mudou desde então,
   * `LegalDraftChangedError` e nada é gravado (a edição de uma aba não apaga a de outra). Texto igual não grava nada.
   */
  async updateDraft(
    kind: LegalKind,
    version: string,
    content: unknown,
    revision: LegalDraftRevision,
    owner: OwnerContext,
  ): Promise<LegalTextRecord> {
    const parsed = legalContentSchema.parse(content);
    const collection = COLLECTIONS.legalVersions(kind);
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, kind, version);
      if (current === undefined) throw new LegalVersionNotFoundError(kind, version);
      if (current.status !== 'draft') throw new LegalVersionImmutableError(kind, version);
      if (current.updatedAt.getTime() !== revision.expectedUpdatedAt.getTime()) {
        throw new LegalDraftChangedError(kind, version);
      }
      if (current.content === parsed) return current;
      const now = this.clock.now();
      const next = legalTextDocumentSchema.parse({
        ...this.documentOf(current),
        content: parsed,
        updatedAt: now,
        updatedBy: owner.email,
      });
      tx.set(collection, version, { ...next });
      this.audit.record(tx, {
        actor: `owner:${owner.email}`,
        action: `${legalAuditPrefix(kind)}draft.updated`,
        details: {
          version,
          bytesBefore: bytesOf(current.content),
          bytes: bytesOf(next.content),
          contentSha256: sha256Hex(next.content),
        },
        requestId: owner.requestId,
      });
      return { kind, version, ...next };
    });
  }

  /**
   * Publica o rascunho na revisão que quem publica conferiu: `published`, imutável, com `publishedAt`, `publishedBy` e
   * o SHA-256 do texto. Passa a ser a vigente na hora. O `publishedAt` fica sempre depois do da última publicada (no
   * mesmo milissegundo, um a mais), para a vigente nunca empatar.
   */
  async publish(
    kind: LegalKind,
    version: string,
    revision: LegalDraftRevision,
    owner: OwnerContext,
  ): Promise<LegalTextRecord> {
    const collection = COLLECTIONS.legalVersions(kind);
    return this.store.runTransaction(async (tx) => {
      const draft = await this.read(tx, kind, version);
      const [latest] = await tx.query(collection, {
        orderBy: { field: 'publishedAt', direction: 'desc' },
        limit: 1,
      });
      if (draft === undefined) throw new LegalVersionNotFoundError(kind, version);
      if (draft.status !== 'draft') throw new LegalVersionImmutableError(kind, version);
      if (draft.updatedAt.getTime() !== revision.expectedUpdatedAt.getTime()) {
        throw new LegalDraftChangedError(kind, version);
      }
      if (draft.content.trim() === '') throw new LegalTextEmptyError(kind, version);

      const now = this.clock.now();
      const latestAt = latest?.data['publishedAt'];
      const publishedAt =
        latestAt instanceof Date && latestAt.getTime() >= now.getTime()
          ? new Date(latestAt.getTime() + 1)
          : now;
      const contentSha256 = sha256Hex(draft.content);
      const next = legalTextDocumentSchema.parse({
        ...this.documentOf(draft),
        status: 'published',
        publishedAt,
        publishedBy: owner.email,
        contentSha256,
        updatedAt: now,
        updatedBy: owner.email,
      });
      tx.set(collection, version, { ...next });
      this.audit.record(tx, {
        actor: `owner:${owner.email}`,
        action: `${legalAuditPrefix(kind)}published`,
        details: {
          version,
          publishedAt,
          contentSha256,
          bytes: bytesOf(next.content),
          ...(latest === undefined ? {} : { previous: latest.id }),
        },
        requestId: owner.requestId,
      });
      return { kind, version, ...next };
    });
  }

  private documentOf(record: LegalTextRecord): LegalTextDocument {
    const { kind: _kind, version: _version, ...document } = record;
    return document;
  }

  private toRecord(kind: LegalKind, version: string, data: Record<string, unknown>): LegalTextRecord {
    const collection = COLLECTIONS.legalVersions(kind);
    return { kind, version, ...parseDocument(legalTextDocumentSchema, collection, version, data) };
  }

  private async read(
    reader: DocumentReader,
    kind: LegalKind,
    version: string,
  ): Promise<LegalTextRecord | undefined> {
    if (!legalVersionSchema.safeParse(version).success) return undefined;
    const data = await reader.get(COLLECTIONS.legalVersions(kind), version);
    return data === undefined ? undefined : this.toRecord(kind, version, data);
  }
}

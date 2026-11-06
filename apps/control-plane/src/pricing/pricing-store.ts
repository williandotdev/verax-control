import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { COLLECTIONS } from '../firestore/collections.js';
import {
  DOCUMENT_STORE,
  type DocumentReader,
  type DocumentStore,
  equalValues,
  parseDocument,
} from '../firestore/document-store.js';
import {
  type CostModel,
  costModelSchema,
  type PriceTable,
  priceTableSchema,
  versionIdSchema,
} from './pricing.schema.js';

/**
 * Estados de uma versão (tabela de preços ou modelo de custos):
 * - `draft`: em edição, a única que muda;
 * - `published`: imutável, vigente a partir de `effectiveFrom`;
 * - `retired`: substituída por uma versão publicada depois; `retiredAt` é quando ela deixa (ou deixou) de valer. Com
 *   a publicação agendada, uma versão `retired` continua vigente até o `effectiveFrom` da sucessora.
 * A versão vigente num instante é a de maior `effectiveFrom` até ele (`current`). Uma versão nova nunca muda
 * assinaturas existentes: elas apontam para os preços da Stripe, que são imutáveis.
 */
export const VERSION_STATUSES = ['draft', 'published', 'retired'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];

/** Resumo da checagem guardado na versão publicada (o relatório inteiro vai na resposta e na auditoria). */
export const publishCheckSchema = z.strictObject({
  priceTableVersion: versionIdSchema,
  costModelVersion: versionIdSchema,
  ok: z.boolean(),
  checkedConfigurations: z.number().int().min(0),
  belowMinimum: z.number().int().min(0),
  belowAlert: z.number().int().min(0),
  worstMargin: z.number().nullable(),
  minimumMargin: z.number(),
  alertMargin: z.number(),
  at: z.date(),
});
export type PublishCheck = z.infer<typeof publishCheckSchema>;

const principal = z.string().min(1).max(254);

function versionedDocumentSchema<T extends z.ZodType>(content: T) {
  return z.strictObject({
    status: z.enum(VERSION_STATUSES),
    content,
    effectiveFrom: z.date().optional(),
    publishedAt: z.date().optional(),
    publishedBy: principal.optional(),
    retiredAt: z.date().optional(),
    supersededBy: versionIdSchema.optional(),
    publishCheck: publishCheckSchema.optional(),
    createdAt: z.date(),
    createdBy: principal,
    updatedAt: z.date(),
    updatedBy: principal,
  });
}

export const priceTableDocumentSchema = versionedDocumentSchema(priceTableSchema);
export const costModelDocumentSchema = versionedDocumentSchema(costModelSchema);

export interface VersionedDocument<C> {
  status: VersionStatus;
  content: C;
  effectiveFrom?: Date;
  publishedAt?: Date;
  publishedBy?: string;
  retiredAt?: Date;
  supersededBy?: string;
  publishCheck?: PublishCheck;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface VersionedRecord<C> extends VersionedDocument<C> {
  version: string;
}

/** Quem age no console: o e-mail conferido no token do IAP (a auditoria leva `owner:<e-mail>`). */
export interface OwnerContext {
  email: string;
  requestId?: string;
}

export class VersionNotFoundError extends Error {
  constructor(readonly version: string) {
    super(`versão inexistente: ${version}`);
    this.name = 'VersionNotFoundError';
  }
}

export class VersionExistsError extends Error {
  constructor(readonly version: string) {
    super(`versão já existe: ${version}`);
    this.name = 'VersionExistsError';
  }
}

/** Só o rascunho muda: publicada e aposentada são imutáveis (mudar um valor é criar outra versão). */
export class VersionImmutableError extends Error {
  constructor(
    readonly version: string,
    readonly status: VersionStatus,
  ) {
    super(`versão ${version} está ${status}: só o rascunho pode mudar`);
    this.name = 'VersionImmutableError';
  }
}

/** O rascunho mudou entre a checagem e a publicação: a checagem não vale para o conteúdo novo. */
export class DraftChangedError extends Error {
  constructor(readonly version: string) {
    super(`o rascunho ${version} mudou durante a publicação`);
    this.name = 'DraftChangedError';
  }
}

/** A vigência precisa ser agora ou depois, e depois da última versão publicada (a ordem das versões é a do tempo). */
export class EffectiveFromError extends Error {
  constructor(readonly reason: 'in_past' | 'not_after_latest') {
    super(`vigência inválida: ${reason}`);
    this.name = 'EffectiveFromError';
  }
}

/** O resumo de uma versão na lista do console: estado, vigência e quem publicou e editou por último (o e-mail do IAP). */
export interface VersionSummary {
  version: string;
  status: VersionStatus;
  current: boolean;
  effectiveFrom?: Date;
  publishedAt?: Date;
  publishedBy?: string;
  retiredAt?: Date;
  supersededBy?: string;
  updatedAt: Date;
  updatedBy: string;
}

/** Teto de diferenças guardadas na auditoria de uma edição (o resto vira só a contagem). */
const MAX_AUDITED_CHANGES = 40;

type Leaf = string | number | boolean | null;

/** Diferença folha a folha entre dois conteúdos: caminho, valor anterior e novo. */
export function contentChanges(
  before: unknown,
  after: unknown,
  path = '',
): { path: string; before: Leaf | undefined; after: Leaf | undefined }[] {
  const isContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
    typeof value === 'object' && value !== null && !(value instanceof Date);
  if (!isContainer(before) || !isContainer(after) || Array.isArray(before) !== Array.isArray(after)) {
    if (equalValues(before, after)) return [];
    const leaf = (value: unknown): Leaf | undefined =>
      value === undefined || isContainer(value) ? undefined : value instanceof Date ? null : (value as Leaf);
    return [{ path: path || '(raiz)', before: leaf(before), after: leaf(after) }];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((key) =>
    contentChanges(
      (before as Record<string, unknown>)[key],
      (after as Record<string, unknown>)[key],
      path === '' ? key : `${path}.${key}`,
    ),
  );
}

interface VersionedKind<C> {
  collection: string;
  /** Prefixo das ações de auditoria: `pricing.*` ou `costs.*`. */
  auditPrefix: 'pricing' | 'costs';
  schema: z.ZodType<VersionedDocument<C>>;
  contentSchema: z.ZodType<C>;
}

/**
 * Repositório das versões de um documento comercial (`pricingTables/{versão}` ou `costModels/{versão}`). Toda escrita é
 * uma transação que relê o documento, valida com zod e grava a auditoria junto (ator `owner:<e-mail>`):
 * `<prefixo>.draft.created`, `<prefixo>.draft.updated` (com a diferença), `<prefixo>.published` (com o resumo da
 * checagem) e `<prefixo>.retired`. Não há exclusão.
 */
export class VersionedStore<C> {
  constructor(
    private readonly kind: VersionedKind<C>,
    private readonly store: DocumentStore,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  async get(version: string): Promise<VersionedRecord<C> | undefined> {
    return this.read(this.store, version);
  }

  async require(version: string): Promise<VersionedRecord<C>> {
    const record = await this.get(version);
    if (record === undefined) throw new VersionNotFoundError(version);
    return record;
  }

  /** Todas as versões, da mais nova para a mais antiga (por criação), sem o conteúdo, com a vigente marcada. */
  async list(): Promise<VersionSummary[]> {
    const current = await this.current();
    const docs = await this.store.query(this.kind.collection);
    return docs
      .map(({ id, data }) => ({
        version: id,
        ...parseDocument(this.kind.schema, this.kind.collection, id, data),
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.version < b.version ? 1 : -1))
      .map((record) => ({
        version: record.version,
        status: record.status,
        current: record.version === current?.version,
        ...(record.effectiveFrom === undefined ? {} : { effectiveFrom: record.effectiveFrom }),
        ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
        ...(record.publishedBy === undefined ? {} : { publishedBy: record.publishedBy }),
        ...(record.retiredAt === undefined ? {} : { retiredAt: record.retiredAt }),
        ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
        updatedAt: record.updatedAt,
        updatedBy: record.updatedBy,
      }));
  }

  /**
   * A versão vigente em `at` (agora, por padrão): a de maior `effectiveFrom` até esse instante. Rascunhos não têm
   * `effectiveFrom` e nunca entram. Consulta de um campo só (desigualdade e ordenação nele): sem índice composto.
   */
  async current(at: Date = this.clock.now()): Promise<VersionedRecord<C> | undefined> {
    const [latest] = await this.store.query(this.kind.collection, {
      where: [{ field: 'effectiveFrom', op: '<=', value: at }],
      orderBy: { field: 'effectiveFrom', direction: 'desc' },
      limit: 1,
    });
    if (latest === undefined) return undefined;
    return {
      version: latest.id,
      ...parseDocument(this.kind.schema, this.kind.collection, latest.id, latest.data),
    };
  }

  async createDraft(version: string, content: unknown, owner: OwnerContext): Promise<VersionedRecord<C>> {
    const id = versionIdSchema.parse(version);
    const now = this.clock.now();
    const document = this.kind.schema.parse({
      status: 'draft',
      content: this.kind.contentSchema.parse(content),
      createdAt: now,
      createdBy: owner.email,
      updatedAt: now,
      updatedBy: owner.email,
    });
    await this.store.runTransaction(async (tx) => {
      if ((await tx.get(this.kind.collection, id)) !== undefined) throw new VersionExistsError(id);
      tx.create(this.kind.collection, id, { ...document });
      this.audit.record(tx, {
        actor: `owner:${owner.email}`,
        action: `${this.kind.auditPrefix}.draft.created`,
        details: { version: id },
        requestId: owner.requestId,
      });
    });
    return { version: id, ...document };
  }

  async updateDraft(version: string, content: unknown, owner: OwnerContext): Promise<VersionedRecord<C>> {
    const parsed = this.kind.contentSchema.parse(content);
    return this.store.runTransaction(async (tx) => {
      const current = await this.read(tx, version);
      if (current === undefined) throw new VersionNotFoundError(version);
      if (current.status !== 'draft') throw new VersionImmutableError(version, current.status);
      const changes = contentChanges(current.content, parsed);
      if (changes.length === 0) return current;
      const now = this.clock.now();
      const { version: _version, ...stored } = current;
      const next = this.kind.schema.parse({
        ...stored,
        content: parsed,
        updatedAt: now,
        updatedBy: owner.email,
      });
      tx.set(this.kind.collection, version, { ...next });
      this.audit.record(tx, {
        actor: `owner:${owner.email}`,
        action: `${this.kind.auditPrefix}.draft.updated`,
        details: {
          version,
          changes: changes.slice(0, MAX_AUDITED_CHANGES),
          ...(changes.length > MAX_AUDITED_CHANGES
            ? { moreChanges: changes.length - MAX_AUDITED_CHANGES }
            : {}),
        },
        requestId: owner.requestId,
      });
      return { version, ...next };
    });
  }

  /**
   * Publica o rascunho: `published`, vigente a partir de `effectiveFrom` (agora, por padrão), com o resumo da
   * checagem. A vigência não pode estar no passado nem antes da última versão publicada; toda versão ainda
   * `published` passa a `retired`, com `retiredAt` = a vigência da nova. `expectedUpdatedAt` é o `updatedAt` do
   * rascunho que a checagem viu: se ele mudou desde então, `DraftChangedError` e nada é gravado.
   */
  async publish(
    version: string,
    options: { effectiveFrom?: Date; expectedUpdatedAt: Date; publishCheck?: PublishCheck },
    owner: OwnerContext,
  ): Promise<VersionedRecord<C>> {
    return this.store.runTransaction(async (tx) => {
      const now = this.clock.now();
      const effectiveFrom = options.effectiveFrom ?? now;
      const draft = await this.read(tx, version);
      const [latest] = await tx.query(this.kind.collection, {
        orderBy: { field: 'effectiveFrom', direction: 'desc' },
        limit: 1,
      });
      const published = await tx.query(this.kind.collection, {
        where: [{ field: 'status', op: '==', value: 'published' }],
      });
      if (draft === undefined) throw new VersionNotFoundError(version);
      if (draft.status !== 'draft') throw new VersionImmutableError(version, draft.status);
      if (draft.updatedAt.getTime() !== options.expectedUpdatedAt.getTime())
        throw new DraftChangedError(version);
      if (effectiveFrom.getTime() < now.getTime()) throw new EffectiveFromError('in_past');
      const latestFrom = latest === undefined ? undefined : latest.data['effectiveFrom'];
      if (latestFrom instanceof Date && effectiveFrom.getTime() <= latestFrom.getTime()) {
        throw new EffectiveFromError('not_after_latest');
      }

      const { version: _version, ...stored } = draft;
      const next = this.kind.schema.parse({
        ...stored,
        status: 'published',
        effectiveFrom,
        publishedAt: now,
        publishedBy: owner.email,
        ...(options.publishCheck === undefined ? {} : { publishCheck: options.publishCheck }),
        updatedAt: now,
        updatedBy: owner.email,
      });
      tx.set(this.kind.collection, version, { ...next });
      this.audit.record(tx, {
        actor: `owner:${owner.email}`,
        action: `${this.kind.auditPrefix}.published`,
        details: {
          version,
          effectiveFrom,
          ...(options.publishCheck === undefined ? {} : { check: options.publishCheck }),
        },
        requestId: owner.requestId,
      });
      for (const previous of published) {
        const record = parseDocument(this.kind.schema, this.kind.collection, previous.id, previous.data);
        tx.set(this.kind.collection, previous.id, {
          ...this.kind.schema.parse({
            ...record,
            status: 'retired',
            retiredAt: effectiveFrom,
            supersededBy: version,
            updatedAt: now,
            updatedBy: owner.email,
          }),
        });
        this.audit.record(tx, {
          actor: `owner:${owner.email}`,
          action: `${this.kind.auditPrefix}.retired`,
          details: { version: previous.id, retiredAt: effectiveFrom, supersededBy: version },
          requestId: owner.requestId,
        });
      }
      return { version, ...next };
    });
  }

  private async read(reader: DocumentReader, version: string): Promise<VersionedRecord<C> | undefined> {
    if (!versionIdSchema.safeParse(version).success) return undefined;
    const data = await reader.get(this.kind.collection, version);
    if (data === undefined) return undefined;
    return { version, ...parseDocument(this.kind.schema, this.kind.collection, version, data) };
  }
}

/** As tabelas de preços (`pricingTables/{versão}`). */
@Injectable()
export class PricingTableStore extends VersionedStore<PriceTable> {
  constructor(
    @Inject(DOCUMENT_STORE) store: DocumentStore,
    @Inject(CLOCK) clock: Clock,
    audit: AuditService,
  ) {
    super(
      {
        collection: COLLECTIONS.pricingTables,
        auditPrefix: 'pricing',
        schema: priceTableDocumentSchema,
        contentSchema: priceTableSchema,
      },
      store,
      clock,
      audit,
    );
  }
}

/** Os modelos de custo (`costModels/{versão}`): publicados na hora (custo não muda o preço de ninguém). */
@Injectable()
export class CostModelStore extends VersionedStore<CostModel> {
  constructor(
    @Inject(DOCUMENT_STORE) store: DocumentStore,
    @Inject(CLOCK) clock: Clock,
    audit: AuditService,
  ) {
    super(
      {
        collection: COLLECTIONS.costModels,
        auditPrefix: 'costs',
        schema: costModelDocumentSchema,
        contentSchema: costModelSchema,
      },
      store,
      clock,
      audit,
    );
  }
}

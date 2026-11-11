import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z, ZodError } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/http/api-error.js';
import {
  legalAuditPrefix,
  LegalDraftChangedError,
  LegalTextEmptyError,
  LegalTextStore,
  LegalVersionExistsError,
  LegalVersionImmutableError,
  LegalVersionNotFoundError,
  summaryOf,
} from '../legal/legal-store.js';
import {
  isLegalKind,
  legalContentSchema,
  type LegalKind,
  type LegalTextRecord,
  legalVersionSchema,
  type LegalVersionSummary,
} from '../legal/legal.schema.js';
import type { OwnerContext } from '../pricing/pricing-store.js';
import { invalidFields, invalidRequest, parseBody } from './validation.js';

const revisionSchema = z.iso.datetime({ offset: true });

export const legalCreateBodySchema = z.strictObject({
  version: legalVersionSchema,
  /** A versão de onde copiar o texto; sem ela, o rascunho começa em branco. */
  from: legalVersionSchema.optional(),
});
export const legalUpdateBodySchema = z.strictObject({
  content: legalContentSchema,
  expectedUpdatedAt: revisionSchema,
});
/** A versão digitada de novo confirma a publicação (como o subdomínio nas operações de um cliente). */
export const legalPublishBodySchema = z.strictObject({
  expectedUpdatedAt: revisionSchema,
  confirmVersion: z.string(),
});

/** Quantos registros da trilha o console mostra por texto. */
export const LEGAL_AUDIT_LIMIT = 100;

/** `GET /v1/admin/legal`: as versões de cada texto, da mais nova para a mais antiga. */
export type LegalOverview = Record<LegalKind, LegalVersionSummary[]>;

/** Um registro da trilha de um texto, só com o que o console mostra (nunca o texto). */
export interface LegalAuditEntry {
  id: string;
  at: Date;
  actor: string;
  event: 'draft.created' | 'draft.updated' | 'published';
  version: string;
  basedOn?: string;
  bytes?: number;
  contentSha256?: string;
}

const auditDetailsSchema = z.object({
  version: z.string(),
  basedOn: z.string().optional(),
  bytes: z.number().optional(),
  contentSha256: z.string().optional(),
});
const LEGAL_EVENTS = ['draft.created', 'draft.updated', 'published'] as const;

function requireKind(kind: string): LegalKind {
  if (!isLegalKind(kind))
    throw new ApiError(HttpStatus.NOT_FOUND, 'Texto inexistente.', 'legal_kind_not_found');
  return kind;
}

function requireVersion(version: string): string {
  const result = legalVersionSchema.safeParse(version);
  if (!result.success) throw new ApiError(HttpStatus.NOT_FOUND, 'Versão inexistente.', 'version_not_found');
  return result.data;
}

/** Erros do repositório no código e na mensagem que o console trata (os mesmos códigos das tabelas de preço). */
function storeError(error: unknown): unknown {
  if (error instanceof ZodError) return invalidRequest(error);
  if (error instanceof LegalVersionNotFoundError) {
    return new ApiError(HttpStatus.NOT_FOUND, 'Versão inexistente.', 'version_not_found');
  }
  if (error instanceof LegalVersionExistsError) {
    return new ApiError(HttpStatus.CONFLICT, 'Esta versão já existe.', 'version_exists');
  }
  if (error instanceof LegalVersionImmutableError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'Só o rascunho muda: para alterar um texto publicado, crie outra versão.',
      'version_immutable',
    );
  }
  if (error instanceof LegalDraftChangedError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'O rascunho mudou depois que você o abriu (outra aba ou outra pessoa). Recarregue e confira.',
      'draft_changed',
    );
  }
  if (error instanceof LegalTextEmptyError) {
    return new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, 'O texto está em branco.', 'legal_text_empty');
  }
  return error;
}

/**
 * Os textos legais no console do responsável (só no `cp-admin`): a lista, o rascunho (em branco ou copiado de outra
 * versão), a edição com a guarda de revisão, a publicação com a versão digitada de novo e a trilha de auditoria de
 * cada texto. Toda escrita passa pelo `LegalTextStore` (auditado com `owner:<e-mail>`). Os logs levam só o tipo, a
 * versão e o desfecho: nem o e-mail, nem o texto.
 */
@Injectable()
export class AdminLegalService {
  constructor(
    private readonly texts: LegalTextStore,
    private readonly audit: AuditService,
    @InjectPinoLogger(AdminLegalService.name) private readonly logger: PinoLogger,
  ) {}

  async overview(): Promise<LegalOverview> {
    const [terms, privacy, dpa] = await Promise.all([
      this.texts.list('terms'),
      this.texts.list('privacy'),
      this.texts.list('dpa'),
    ]);
    return { terms, privacy, dpa };
  }

  get(kind: string, version: string): Promise<LegalTextRecord> {
    const legalKind = requireKind(kind);
    const id = requireVersion(version);
    return this.guarded(() => this.texts.require(legalKind, id));
  }

  async create(kind: string, body: unknown, owner: OwnerContext): Promise<LegalTextRecord> {
    const legalKind = requireKind(kind);
    const { version, from } = parseBody(legalCreateBodySchema, body);
    const record = await this.guarded(() =>
      this.texts.createDraft(legalKind, version, from === undefined ? {} : { from }, owner),
    );
    this.logger.info(
      { event: 'legal_draft_created', kind: legalKind, version },
      'rascunho de texto legal criado',
    );
    return record;
  }

  async update(kind: string, version: string, body: unknown, owner: OwnerContext): Promise<LegalTextRecord> {
    const legalKind = requireKind(kind);
    const id = requireVersion(version);
    const { content, expectedUpdatedAt } = parseBody(legalUpdateBodySchema, body);
    const record = await this.guarded(() =>
      this.texts.updateDraft(
        legalKind,
        id,
        content,
        { expectedUpdatedAt: new Date(expectedUpdatedAt) },
        owner,
      ),
    );
    this.logger.info(
      { event: 'legal_draft_updated', kind: legalKind, version: id },
      'rascunho de texto legal atualizado',
    );
    return record;
  }

  /**
   * Publica o rascunho na revisão que o responsável conferiu, com a versão digitada de novo. Vale na hora: o site passa
   * a mostrar o texto novo (com os minutos de cache do CDN) e o checkout passa a exigir o aceite dele.
   */
  async publish(
    kind: string,
    version: string,
    body: unknown,
    owner: OwnerContext,
  ): Promise<LegalVersionSummary> {
    const legalKind = requireKind(kind);
    const id = requireVersion(version);
    const { expectedUpdatedAt, confirmVersion } = parseBody(legalPublishBodySchema, body);
    if (confirmVersion !== id) {
      throw invalidFields([
        { path: 'confirmVersion', message: 'Digite a versão exatamente como está para confirmar.' },
      ]);
    }
    const published = await this.guarded(() =>
      this.texts.publish(legalKind, id, { expectedUpdatedAt: new Date(expectedUpdatedAt) }, owner),
    );
    this.logger.info(
      { event: 'legal_text_published', kind: legalKind, version: id },
      'texto legal publicado',
    );
    return summaryOf(published, true);
  }

  /** A trilha de um texto, da mais nova para a mais antiga (até `LEGAL_AUDIT_LIMIT`). */
  async auditTrail(kind: string): Promise<LegalAuditEntry[]> {
    const legalKind = requireKind(kind);
    const prefix = legalAuditPrefix(legalKind);
    const records = await this.audit.listByActionPrefix(prefix, LEGAL_AUDIT_LIMIT);
    return records.flatMap((record): LegalAuditEntry[] => {
      const event = record.action.slice(prefix.length);
      const details = auditDetailsSchema.safeParse(record.details ?? {});
      if (!(LEGAL_EVENTS as readonly string[]).includes(event) || !details.success) return [];
      const { version, basedOn, bytes, contentSha256 } = details.data;
      return [
        {
          id: record.id,
          at: record.at,
          actor: record.actor,
          event: event as LegalAuditEntry['event'],
          version,
          ...(basedOn === undefined ? {} : { basedOn }),
          ...(bytes === undefined ? {} : { bytes }),
          ...(contentSha256 === undefined ? {} : { contentSha256 }),
        },
      ];
    });
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw storeError(error);
    }
  }
}

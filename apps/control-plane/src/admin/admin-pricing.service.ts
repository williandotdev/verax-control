import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z, ZodError } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { CostModelMismatchError, costModelProblems, dre, type DreResult } from '../pricing/dre.js';
import {
  CostModelStore,
  DraftChangedError,
  EffectiveFromError,
  type OwnerContext,
  PricingTableStore,
  type PublishCheck,
  VersionExistsError,
  VersionImmutableError,
  VersionNotFoundError,
  type VersionedRecord,
  type VersionedStore,
  type VersionSummary,
} from '../pricing/pricing-store.js';
import {
  configurationInputSchema,
  type CostModel,
  paymentMethodSchema,
  type PriceTable,
  versionIdSchema,
} from '../pricing/pricing.schema.js';
import { type GuardReport, runPublishGuard } from '../pricing/publish-guard.js';
import type { ContactReason } from '../pricing/quote.js';
import { invalidRequest, parseBody } from './validation.js';

const createBodySchema = z.strictObject({ version: versionIdSchema, content: z.unknown() });
const updateBodySchema = z.strictObject({ content: z.unknown() });
const checkBodySchema = z.strictObject({ costModelVersion: versionIdSchema.optional() });
const publishTableBodySchema = z.strictObject({ effectiveFrom: z.iso.datetime({ offset: true }).optional() });
const publishCostBodySchema = z.strictObject({});
const simulateBodySchema = z.strictObject({
  configuration: configurationInputSchema,
  paymentMethod: paymentMethodSchema,
  priceTableVersion: versionIdSchema.optional(),
  costModelVersion: versionIdSchema.optional(),
  taxRateId: z
    .string()
    .regex(/^[a-z0-9_]{1,32}$/)
    .optional(),
  discountRate: z.number().min(0).max(1).optional(),
  allocationCustomers: z.number().int().min(1).max(100_000).optional(),
});

/** A versão publicada (o resumo, como na lista) e o relatório da checagem que a acompanhou. */
export type PublishResult = Omit<VersionSummary, 'current'> & { report: GuardReport | null };

/**
 * A DRE simulada. Junto com ela vão as metas de margem e a alíquota do modelo de custos usado, para o console marcar
 * o que fica abaixo da mínima ou do alerta e nomear o imposto sem ler o modelo de novo (só no console, nunca em log).
 */
export type SimulationResult =
  | { contactUs: true; reason: ContactReason; priceTableVersion: string; costModelVersion: string }
  | {
      contactUs: false;
      priceTableVersion: string;
      costModelVersion: string;
      dre: DreResult;
      margins: { minimum: number; alert: number };
      taxRate: { id: string; label: string; rate: number };
    };

const invalid = invalidRequest;
const parse = parseBody;

function requireVersion(version: string): string {
  const result = versionIdSchema.safeParse(version);
  if (!result.success) throw new ApiError(HttpStatus.NOT_FOUND, 'Versão inexistente.', 'version_not_found');
  return result.data;
}

/** Erros do repositório no código e na mensagem que o console trata. */
function storeError(error: unknown): unknown {
  if (error instanceof ZodError) return invalid(error);
  if (error instanceof VersionNotFoundError) {
    return new ApiError(HttpStatus.NOT_FOUND, 'Versão inexistente.', 'version_not_found');
  }
  if (error instanceof VersionExistsError) {
    return new ApiError(HttpStatus.CONFLICT, 'Esta versão já existe.', 'version_exists');
  }
  if (error instanceof VersionImmutableError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'Só o rascunho muda: para alterar uma versão publicada, crie outra.',
      'version_immutable',
    );
  }
  if (error instanceof DraftChangedError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'O rascunho mudou durante a publicação. Confira e publique de novo.',
      'draft_changed',
    );
  }
  if (error instanceof EffectiveFromError) {
    return new ApiError(
      HttpStatus.CONFLICT,
      'A vigência precisa ser agora ou depois, e depois da última versão publicada.',
      'effective_from_invalid',
    );
  }
  return error;
}

function summaryOf(record: VersionedRecord<unknown>): Omit<VersionSummary, 'current'> {
  return {
    version: record.version,
    status: record.status,
    ...(record.effectiveFrom === undefined ? {} : { effectiveFrom: record.effectiveFrom }),
    ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    ...(record.publishedBy === undefined ? {} : { publishedBy: record.publishedBy }),
    ...(record.retiredAt === undefined ? {} : { retiredAt: record.retiredAt }),
    ...(record.supersededBy === undefined ? {} : { supersededBy: record.supersededBy }),
    updatedAt: record.updatedAt,
    updatedBy: record.updatedBy,
  };
}

/**
 * O console do responsável (só no `cp-admin`): rascunhos, publicação e simulação. Toda escrita passa pelos repositórios
 * versionados (auditados com `owner:<e-mail>`); a publicação de uma tabela de preços roda a checagem da grade com o
 * modelo de custos vigente e é recusada (422, com o relatório) se alguma configuração ficar abaixo da margem mínima. Os
 * logs levam só a versão e o desfecho: nem o e-mail do responsável, nem valores, custos ou margens.
 */
@Injectable()
export class AdminPricingService {
  constructor(
    private readonly tables: PricingTableStore,
    private readonly costs: CostModelStore,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(AdminPricingService.name) private readonly logger: PinoLogger,
  ) {}

  listTables(): Promise<VersionSummary[]> {
    return this.tables.list();
  }

  listCostModels(): Promise<VersionSummary[]> {
    return this.costs.list();
  }

  getTable(version: string): Promise<VersionedRecord<PriceTable>> {
    return this.guarded(() => this.tables.require(requireVersion(version)));
  }

  getCostModel(version: string): Promise<VersionedRecord<CostModel>> {
    return this.guarded(() => this.costs.require(requireVersion(version)));
  }

  createTable(body: unknown, owner: OwnerContext): Promise<VersionedRecord<PriceTable>> {
    return this.create(this.tables, body, owner, 'pricing_table');
  }

  createCostModel(body: unknown, owner: OwnerContext): Promise<VersionedRecord<CostModel>> {
    return this.create(this.costs, body, owner, 'cost_model');
  }

  updateTable(version: string, body: unknown, owner: OwnerContext): Promise<VersionedRecord<PriceTable>> {
    return this.update(this.tables, version, body, owner, 'pricing_table');
  }

  updateCostModel(version: string, body: unknown, owner: OwnerContext): Promise<VersionedRecord<CostModel>> {
    return this.update(this.costs, version, body, owner, 'cost_model');
  }

  /** A checagem de publicação sem publicar: com o modelo de custos pedido ou o vigente. */
  async checkTable(
    version: string,
    body: unknown,
  ): Promise<{ costModelVersion: string; report: GuardReport }> {
    const { costModelVersion } = parse(checkBodySchema, body);
    const table = await this.guarded(() => this.tables.require(requireVersion(version)));
    const model = await this.costModel(costModelVersion);
    return { costModelVersion: model.version, report: runPublishGuard(table.content, model.content) };
  }

  /**
   * Publica a tabela de preços: rascunho, modelo de custos vigente, checagem da grade inteira e, só se ela passar, a
   * publicação (a versão anterior vira `retired` na vigência da nova). Recusada, 422 `publish_guard_failed` com o
   * relatório (as piores configurações, as abaixo da mínima e o motivo), e a recusa fica na auditoria.
   */
  async publishTable(version: string, body: unknown, owner: OwnerContext): Promise<PublishResult> {
    const { effectiveFrom } = parse(publishTableBodySchema, body);
    const id = requireVersion(version);
    const table = await this.guarded(() => this.tables.require(id));
    if (table.status !== 'draft') throw storeError(new VersionImmutableError(id, table.status));
    const model = await this.costModel(undefined);
    const report = runPublishGuard(table.content, model.content);
    const check = this.checkSummary(id, model.version, report);
    if (!report.ok) {
      await this.audit.write({
        actor: `owner:${owner.email}`,
        action: 'pricing.publish_refused',
        details: { version: id, check },
        requestId: owner.requestId,
      });
      this.logger.warn(
        { event: 'pricing_publish_refused', version: id, costModelVersion: model.version },
        'publicação da tabela de preços recusada pela checagem',
      );
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'A tabela não passou na checagem de publicação.',
        'publish_guard_failed',
        { costModelVersion: model.version, report },
      );
    }
    const published = await this.guarded(() =>
      this.tables.publish(
        id,
        {
          ...(effectiveFrom === undefined ? {} : { effectiveFrom: new Date(effectiveFrom) }),
          expectedUpdatedAt: table.updatedAt,
          publishCheck: check,
        },
        owner,
      ),
    );
    this.logger.info(
      { event: 'pricing_table_published', version: id, costModelVersion: model.version },
      'tabela de preços publicada',
    );
    return { ...summaryOf(published), report };
  }

  /**
   * Publica o modelo de custos, vigente na hora (custo não muda o preço de ninguém). Não é bloqueada: a checagem da
   * tabela de preços vigente com o modelo novo vai na resposta e, se ela falhar, um alerta vai ao log (só as versões).
   */
  async publishCostModel(version: string, body: unknown, owner: OwnerContext): Promise<PublishResult> {
    parse(publishCostBodySchema, body);
    const id = requireVersion(version);
    const model = await this.guarded(() => this.costs.require(id));
    if (model.status !== 'draft') throw storeError(new VersionImmutableError(id, model.status));
    const table = await this.tables.current();
    const report = table === undefined ? null : runPublishGuard(table.content, model.content);
    const published = await this.guarded(() =>
      this.costs.publish(
        id,
        {
          expectedUpdatedAt: model.updatedAt,
          ...(table === undefined || report === null
            ? {}
            : { publishCheck: this.checkSummary(table.version, id, report) }),
        },
        owner,
      ),
    );
    if (table !== undefined && report !== null && !report.ok) {
      this.logger.warn(
        { event: 'pricing_margin_alert', priceTableVersion: table.version, costModelVersion: id },
        'com o modelo de custos novo, a tabela de preços vigente não passa na checagem de publicação',
      );
    }
    this.logger.info({ event: 'cost_model_published', version: id }, 'modelo de custos publicado');
    return { ...summaryOf(published), report };
  }

  /** A DRE de uma configuração: com a tabela e o modelo pedidos (rascunho também) ou os vigentes. */
  async simulate(body: unknown): Promise<SimulationResult> {
    const request = parse(simulateBodySchema, body);
    const table =
      request.priceTableVersion === undefined
        ? await this.tables.current()
        : await this.guarded(() => this.tables.require(request.priceTableVersion ?? ''));
    if (table === undefined) {
      throw new ApiError(HttpStatus.CONFLICT, 'Nenhuma tabela de preços vigente.', 'pricing_table_missing');
    }
    const model = await this.costModel(request.costModelVersion);
    const problems = costModelProblems(table.content, model.content);
    if (
      request.taxRateId !== undefined &&
      !model.content.taxes.rates.some((tax) => tax.id === request.taxRateId)
    ) {
      problems.push(`taxes.rates.${request.taxRateId}`);
    }
    if (problems.length > 0) {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'O modelo de custos não cobre esta tabela de preços.',
        'cost_model_incomplete',
        { problems },
      );
    }
    let outcome;
    try {
      outcome = dre(request.configuration, table.content, model.content, request.paymentMethod, {
        ...(request.taxRateId === undefined ? {} : { taxRateId: request.taxRateId }),
        ...(request.discountRate === undefined ? {} : { discountRate: request.discountRate }),
        ...(request.allocationCustomers === undefined
          ? {}
          : { allocationCustomers: request.allocationCustomers }),
      });
    } catch (error) {
      if (error instanceof CostModelMismatchError) {
        throw new ApiError(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'O modelo de custos não cobre esta tabela de preços.',
          'cost_model_incomplete',
          { problems: [...error.problems] },
        );
      }
      throw error;
    }
    const versions = { priceTableVersion: table.version, costModelVersion: model.version };
    if (outcome.kind === 'contact_us') return { contactUs: true, reason: outcome.reason, ...versions };
    const { taxRateId } = outcome.dre;
    const tax = model.content.taxes.rates.find((candidate) => candidate.id === taxRateId);
    // A DRE só sai com uma alíquota do modelo (`dre` confere); sem ela, o modelo é inconsistente.
    if (tax === undefined) throw new TypeError(`alíquota ausente do modelo: ${taxRateId}`);
    return {
      contactUs: false,
      ...versions,
      dre: outcome.dre,
      margins: { minimum: model.content.margins.minimum, alert: model.content.margins.alert },
      taxRate: { id: tax.id, label: tax.label, rate: tax.rate },
    };
  }

  private async create<C>(
    store: VersionedStore<C>,
    body: unknown,
    owner: OwnerContext,
    kind: string,
  ): Promise<VersionedRecord<C>> {
    const { version, content } = parse(createBodySchema, body);
    const record = await this.guarded(() => store.createDraft(version, content, owner));
    this.logger.info({ event: 'admin_draft_created', kind, version }, 'rascunho criado');
    return record;
  }

  private async update<C>(
    store: VersionedStore<C>,
    version: string,
    body: unknown,
    owner: OwnerContext,
    kind: string,
  ): Promise<VersionedRecord<C>> {
    const { content } = parse(updateBodySchema, body);
    const id = requireVersion(version);
    const record = await this.guarded(() => store.updateDraft(id, content, owner));
    this.logger.info({ event: 'admin_draft_updated', kind, version: id }, 'rascunho atualizado');
    return record;
  }

  private async costModel(version: string | undefined): Promise<VersionedRecord<CostModel>> {
    if (version !== undefined) return this.guarded(() => this.costs.require(version));
    const current = await this.costs.current();
    if (current === undefined) {
      throw new ApiError(
        HttpStatus.CONFLICT,
        'Nenhum modelo de custos publicado: publique um antes da tabela de preços.',
        'cost_model_missing',
      );
    }
    return current;
  }

  private checkSummary(
    priceTableVersion: string,
    costModelVersion: string,
    report: GuardReport,
  ): PublishCheck {
    return {
      priceTableVersion,
      costModelVersion,
      ok: report.ok,
      checkedConfigurations: report.checkedConfigurations,
      belowMinimum: report.belowMinimum.count,
      belowAlert: report.belowAlert.count,
      worstMargin: report.worst[0]?.contributionMarginRatio ?? null,
      minimumMargin: report.minimumMargin,
      alertMargin: report.alertMargin,
      at: this.clock.now(),
    };
  }

  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw storeError(error);
    }
  }
}

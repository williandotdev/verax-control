import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { PricingTableStore, type VersionedRecord } from './pricing-store.js';
import {
  type Configuration,
  configurationInputSchema,
  type NodeLimits,
  type PriceTable,
  type SizeId,
} from './pricing.schema.js';
import {
  describeLineItem,
  isSoldOnline,
  modeNotSoldOnline,
  type PublicPricing,
  publicPricing,
} from './public-pricing.js';
import { QuoteDailyLimitReachedError, QuoteStore } from './quote-store.js';
import { type ContactReason, quote } from './quote.js';

/** Configuração que o site não vende na hora: o motivo, para o site levar ao contato com os campos preenchidos. */
export interface ContactUsResponse {
  contactUs: true;
  reason: ContactReason;
  priceTableVersion: string;
}

export interface PublicQuoteLine {
  component: string;
  description: string;
  quantity: number;
  unitAmount: number;
  amount: number;
  recurring: boolean;
}

/** A cotação devolvida ao site: valores em centavos, nenhum custo, nenhum `lookup_key`. */
export interface QuoteResponse {
  contactUs: false;
  quoteId: string;
  priceTableVersion: string;
  expiresAt: string;
  currency: 'brl';
  configuration: Configuration;
  size: SizeId;
  sizeDescription: string;
  lineItems: PublicQuoteLine[];
  monthlyTotal: number;
  setupTotal: number;
  firstInvoiceTotal: number;
  included: { cloudAccounts: number; monthlyGib: number; historyDays: number; users: number };
  limits: NodeLimits;
}

const QUOTE_FIELDS: ReadonlySet<string> = new Set(Object.keys(configurationInputSchema.shape));

/** 429 do teto diário das cotações, com quanto falta para o dia (UTC) virar. */
export class QuoteDailyLimitApiError extends ApiError {
  constructor(readonly retryAfterSeconds: number) {
    super(
      HttpStatus.TOO_MANY_REQUESTS,
      'Não foi possível calcular o preço agora. Tente novamente mais tarde.',
      'quote_daily_limit',
    );
  }
}

/**
 * A calculadora pública: a tabela vigente sem custos (`GET /v1/public/pricing`) e a cotação (`POST /v1/public/quote`),
 * que nunca recebe preço do cliente: só as seis respostas. A cotação é gravada por 24 h e é o que o checkout aceita.
 * Só o ambiente na infraestrutura da Verax é vendido aqui: o da infraestrutura do cliente é 422 `mode_not_sold_online`
 * antes de qualquer leitura da tabela (`public-pricing.ts`), sem gravar nada.
 * As linhas do funil (`quote_issued`, `quote_contact_us`) saem pelo logger raiz, sem o `req` da requisição (que leva o
 * IP): só o id da cotação, a versão, o modo, o porte e as faixas, e o `requestId` para correlação. Nada de valores.
 */
@Injectable()
export class PublicPricingService {
  constructor(
    private readonly tables: PricingTableStore,
    private readonly quotes: QuoteStore,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(PublicPricingService.name) private readonly logger: PinoLogger,
  ) {}

  async catalog(): Promise<PublicPricing> {
    const table = await this.requireCurrent();
    return publicPricing(table.version, table.content);
  }

  async createQuote(body: unknown, requestId?: string): Promise<QuoteResponse | ContactUsResponse> {
    const parsed = configurationInputSchema.safeParse(body);
    if (!parsed.success) {
      const fields = [
        ...new Set(
          parsed.error.issues
            .map((issue) => issue.path[0])
            .filter((field): field is string => typeof field === 'string' && QUOTE_FIELDS.has(field)),
        ),
      ];
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        fields.length === 0 ? 'Configuração inválida.' : `Configuração inválida: ${fields.join(', ')}.`,
        'invalid_request',
      );
    }
    const input = parsed.data;
    if (!isSoldOnline(input.mode)) {
      // Só o modo vai ao log (a procura pelo ambiente no cliente, para o responsável): nenhum outro campo, nem o IP.
      PinoLogger.root.info(
        { event: 'quote_mode_refused', mode: input.mode, requestId, context: PublicPricingService.name },
        'modo que o site não vende: contrato direto',
      );
      throw modeNotSoldOnline();
    }
    const table = await this.requireCurrent();
    const outcome = quote(input, table.content);
    if (outcome.kind === 'contact_us') return this.contactUs(table, outcome.reason, input.mode, requestId);

    let stored;
    try {
      stored = await this.quotes.create(table.version, outcome.quote);
    } catch (error) {
      if (error instanceof QuoteDailyLimitReachedError) {
        PinoLogger.root.warn(
          {
            event: 'quote_daily_limit_reached',
            limit: error.limit,
            day: error.day,
            requestId,
            context: PublicPricingService.name,
          },
          'teto diário de cotações atingido; novas cotações recusadas até o fim do dia (UTC)',
        );
        throw new QuoteDailyLimitApiError(
          Math.max(1, Math.ceil((error.resetsAt.getTime() - this.clock.now().getTime()) / 1000)),
        );
      }
      throw error;
    }
    const { configuration } = stored;
    PinoLogger.root.info(
      {
        event: 'quote_issued',
        quoteId: stored.quoteId,
        priceTableVersion: table.version,
        mode: configuration.mode,
        size: configuration.size,
        cloudAccounts: configuration.cloudAccounts,
        monthlyGib: configuration.monthlyGib,
        agents: configuration.agents,
        historyDays: configuration.historyDays,
        support: configuration.support,
        requestId,
        context: PublicPricingService.name,
      },
      'cotação emitida',
    );
    return {
      contactUs: false,
      quoteId: stored.quoteId,
      priceTableVersion: table.version,
      expiresAt: stored.expiresAt.toISOString(),
      currency: 'brl',
      configuration,
      size: configuration.size,
      sizeDescription: stored.sizeDescription,
      lineItems: stored.lineItems.map((item) => ({
        component: item.component,
        description: describeLineItem(item, configuration.mode, configuration.size),
        quantity: item.quantity,
        unitAmount: item.unitAmount,
        amount: item.amount,
        recurring: item.recurring,
      })),
      monthlyTotal: stored.monthlyTotal,
      setupTotal: stored.setupTotal,
      firstInvoiceTotal: stored.monthlyTotal + stored.setupTotal,
      included: outcome.quote.included,
      limits: stored.limits,
    };
  }

  private contactUs(
    table: VersionedRecord<PriceTable>,
    reason: ContactReason,
    mode: string,
    requestId: string | undefined,
  ): ContactUsResponse {
    PinoLogger.root.info(
      {
        event: 'quote_contact_us',
        priceTableVersion: table.version,
        mode,
        reason,
        requestId,
        context: PublicPricingService.name,
      },
      'configuração sob consulta',
    );
    return { contactUs: true, reason, priceTableVersion: table.version };
  }

  /** Sem tabela publicada vigente, a calculadora e o checkout ficam indisponíveis (503), nunca com preço inventado. */
  private async requireCurrent(): Promise<VersionedRecord<PriceTable>> {
    const table = await this.tables.current();
    if (table === undefined) {
      this.logger.error({ event: 'pricing_table_missing' }, 'nenhuma tabela de preços publicada vigente');
      throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Preços indisponíveis', 'pricing_unavailable');
    }
    return table;
  }
}

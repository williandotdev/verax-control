import { Controller, Get, HttpStatus, Inject, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CLOCK, type Clock } from '../common/clock.js';
import { ApiError } from '../common/http/api-error.js';
import { enforceRateLimit, type RateLimitRule, TokenBucketLimiter } from '../common/http/rate-limiter.js';
import { LegalTextStore } from './legal-store.js';
import {
  isLegalKind,
  LEGAL_KINDS,
  LEGAL_TITLES,
  type LegalKind,
  type LegalTextRecord,
  legalVersionSchema,
} from './legal.schema.js';

/** Limite por IP em memória, como o da tabela pública de preços: o site lê os textos a cada visita das páginas. */
export const LEGAL_PER_IP: RateLimitRule = { capacity: 30, windowMs: 60_000 };

export const LEGAL_RATE_LIMIT = Symbol('LEGAL_RATE_LIMIT');

export const LEGAL_RATE_LIMIT_PROVIDER = {
  provide: LEGAL_RATE_LIMIT,
  useFactory: (clock: Clock) => new TokenBucketLimiter(LEGAL_PER_IP, clock),
  inject: [CLOCK],
};

/** A vigente pode mudar a qualquer publicação: 5 min no CDN do Hosting e no navegador, como a tabela de preços. */
const CURRENT_CACHE = 'public, max-age=300';
/** Uma versão publicada nunca muda: 1 h. */
const VERSION_CACHE = 'public, max-age=3600';

/** A versão vigente de um texto, sem o texto (o que o formulário de compra manda no aceite). */
export interface PublicLegalVersion {
  version: string;
  publishedAt: Date;
}

/** `GET /v1/public/legal`: a vigente de cada texto; `null` no que nunca foi publicado (o checkout fica indisponível). */
export type PublicLegalIndex = Record<LegalKind, PublicLegalVersion | null>;

/** `GET /v1/public/legal/{tipo}[/{versão}]`: o texto publicado, em Markdown. Nunca quem publicou. */
export interface PublicLegalText {
  kind: LegalKind;
  title: string;
  version: string;
  publishedAt: Date;
  /** Se esta é a vigente (numa versão antiga, o site avisa que há outra). */
  current: boolean;
  content: string;
}

function notFound(): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, 'Texto não encontrado.', 'legal_text_not_found');
}

function publicVersion(record: LegalTextRecord | undefined): PublicLegalVersion | null {
  if (record?.publishedAt === undefined) return null;
  return { version: record.version, publishedAt: record.publishedAt };
}

function publicText(record: LegalTextRecord, current: boolean): PublicLegalText {
  if (record.status !== 'published' || record.publishedAt === undefined) throw notFound();
  return {
    kind: record.kind,
    title: LEGAL_TITLES[record.kind],
    version: record.version,
    publishedAt: record.publishedAt,
    current,
    content: record.content,
  };
}

/**
 * Os textos legais para o site (só no `cp-public`, com o CORS das origens do site): as versões vigentes, o texto
 * vigente de cada um e uma versão publicada antiga pelo nome (quem aceitou a anterior ainda a lê). Rascunho nunca sai
 * daqui. O cabeçalho de cache é trocado só depois do sucesso: um 404 ou 429 continua `private, no-store`.
 */
@Controller('public/legal')
export class LegalController {
  constructor(
    private readonly store: LegalTextStore,
    @Inject(LEGAL_RATE_LIMIT) private readonly limiter: TokenBucketLimiter,
  ) {}

  @Get()
  async index(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<PublicLegalIndex> {
    enforceRateLimit(this.limiter, req, res);
    const current = await this.store.currentAll();
    const index = Object.fromEntries(
      LEGAL_KINDS.map((kind) => [kind, publicVersion(current[kind])]),
    ) as PublicLegalIndex;
    res.setHeader('Cache-Control', CURRENT_CACHE);
    return index;
  }

  @Get(':kind')
  async current(
    @Param('kind') kind: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicLegalText> {
    enforceRateLimit(this.limiter, req, res);
    if (!isLegalKind(kind)) throw notFound();
    const record = await this.store.current(kind);
    if (record === undefined) throw notFound();
    const text = publicText(record, true);
    res.setHeader('Cache-Control', CURRENT_CACHE);
    return text;
  }

  @Get(':kind/:version')
  async version(
    @Param('kind') kind: string,
    @Param('version') version: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicLegalText> {
    enforceRateLimit(this.limiter, req, res);
    if (!isLegalKind(kind) || !legalVersionSchema.safeParse(version).success) throw notFound();
    const [record, current] = await Promise.all([this.store.get(kind, version), this.store.current(kind)]);
    if (record === undefined) throw notFound();
    const text = publicText(record, record.version === current?.version);
    // A versão é imutável, mas "vigente" não: o cache longo só vale para a que já foi substituída.
    res.setHeader('Cache-Control', text.current ? CURRENT_CACHE : VERSION_CACHE);
    return text;
  }
}

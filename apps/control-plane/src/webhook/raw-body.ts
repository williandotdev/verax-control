import { HttpStatus } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../common/http/api-error.js';

/** A rota do webhook da Stripe (plano §2.1), com o prefixo da API: o único caminho que recebe corpo bruto. */
export const WEBHOOK_PATH = '/v1/stripe/webhook';

/** Teto do corpo do webhook (plano §2.3): 1 MB. Um evento da Stripe tem alguns KB. */
export const WEBHOOK_BODY_LIMIT_BYTES = 1024 * 1024;

/**
 * Lê o corpo inteiro como `Buffer`, sem interpretar (a assinatura da Stripe é calculada sobre os bytes exatos), até
 * `limitBytes`. Acima disso responde 413 depois de esvaziar a requisição, sem guardar o excesso. Registrado antes do
 * parser de JSON e só no caminho do webhook (`app.setup.ts`): o parser de JSON vê a requisição já lida e não a toca.
 * Não depende do `Content-Type`.
 */
export function rawBodyParser(limitBytes: number = WEBHOOK_BODY_LIMIT_BYTES) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.method !== 'POST') {
      next();
      return;
    }
    const declared = Number(req.headers['content-length']);
    let tooLarge = Number.isFinite(declared) && declared > limitBytes;
    let size = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) {
        next(error);
        return;
      }
      (req as Request & { body: unknown }).body = Buffer.concat(chunks, size);
      next();
    };
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limitBytes) {
        tooLarge = true;
        chunks.length = 0;
        size = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      finish(
        tooLarge
          ? new ApiError(HttpStatus.PAYLOAD_TOO_LARGE, 'Requisição muito grande', 'payload_too_large')
          : undefined,
      );
    });
    req.on('error', () => {
      finish(new ApiError(HttpStatus.BAD_REQUEST, 'Requisição inválida', 'invalid_body'));
    });
  };
}

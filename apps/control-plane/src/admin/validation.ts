import { HttpStatus } from '@nestjs/common';
import type { z, ZodError } from 'zod';
import { ApiError } from '../common/http/api-error.js';

/** Um problema que o console mostra ao lado do campo (`path`, o mesmo caminho do formulário) e no resumo do alto. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** 400 com o caminho e a mensagem de cada problema (o console mostra ao lado do campo). Nunca o valor recebido. */
export function invalidRequest(error: ZodError): ApiError {
  return invalidFields(
    error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.map(String).join('.') || '(raiz)',
      message: issue.message,
    })),
  );
}

/** 400 `invalid_request` com os problemas dados. */
export function invalidFields(issues: readonly FieldIssue[]): ApiError {
  return new ApiError(HttpStatus.BAD_REQUEST, 'Dados inválidos.', 'invalid_request', { issues: [...issues] });
}

/** O corpo validado pelo schema, ou o 400 com os problemas de cada campo. */
export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw invalidRequest(result.error);
  return result.data;
}

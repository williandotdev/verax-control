import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Query string de paginação, usada por toda listagem da API. Os valores chegam como texto e são
 * convertidos; qualquer parâmetro desconhecido é rejeitado.
 */
export const paginationQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Resposta paginada. O front valida com `paginatedSchema(itemSchema)`. */
export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function paginatedSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE),
    total: z.number().int().min(0),
  });
}

/**
 * Amplia um schema de query de listagem com os filtros próprios da rota, mantendo-o estrito.
 * Ex.: `withPagination({ status: z.enum(['open', 'closed']).optional() })`.
 */
export function withPagination<T extends z.ZodRawShape>(filters: T) {
  return paginationQuerySchema.extend(filters);
}

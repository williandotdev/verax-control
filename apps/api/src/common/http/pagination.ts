import type { Paginated, PaginationQuery } from '@verax/shared';

/** Converte a query de paginação para `skip`/`take` do Prisma. */
export function toPrismaPage(query: PaginationQuery): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.pageSize, take: query.pageSize };
}

/** Monta a resposta paginada padrão da API. */
export function toPaginated<T>(items: T[], total: number, query: PaginationQuery): Paginated<T> {
  return { items, page: query.page, pageSize: query.pageSize, total };
}

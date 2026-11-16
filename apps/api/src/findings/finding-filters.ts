import { filterWindow, type FindingListQuery } from '@verax/shared';
import type { Prisma } from '../generated/prisma/client.js';

/** Os filtros de achados, sem a paginação: os da lista de achados e os da tela Detecções. */
export type FindingFilters = Omit<FindingListQuery, 'page' | 'pageSize'>;

/**
 * Os filtros de conteúdo no banco (conta, fonte, tática, técnica e busca), com a mesma regra de `findingContentMatches`
 * do `@verax/shared`. A busca é um `contains` sem diferenciar maiúsculas (`ILIKE` parametrizado pelo Prisma) em cada
 * campo de texto da lista; nada vira SQL montado à mão. No incidente, vale por pelo menos um achado dele.
 */
export function findingContentWhere(filters: FindingFilters): Prisma.FindingWhereInput {
  return {
    ...(filters.accountId !== undefined && { accountId: filters.accountId }),
    ...(filters.source !== undefined && { logSource: filters.source }),
    ...(filters.tactic !== undefined && { mitreTactics: { has: filters.tactic } }),
    ...(filters.technique !== undefined && { mitreTechniques: { has: filters.technique } }),
    ...(filters.q !== undefined && { OR: textSearch(filters.q) }),
  };
}

/**
 * O Prisma passa o texto do `contains` como parâmetro, mas não escapa os curingas do `LIKE`: sem isto, `%` e `_` na
 * busca casariam com qualquer coisa. A barra invertida é o escape padrão do `LIKE` no Postgres.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function textSearch(q: string): Prisma.FindingWhereInput[] {
  const contains = { contains: escapeLike(q), mode: 'insensitive' } as const;
  return [
    { title: contains },
    { eventName: contains },
    { resource: contains },
    { actorUser: contains },
    { sourceIp: contains },
    { accessKeyId: contains },
    { accountId: contains },
  ];
}

/**
 * Todos os filtros do achado no banco, com a regra de `findingMatchesFilters`: severidade, status, a janela de tempo
 * (o período até agora ou o intervalo personalizado, pela data do evento) e os de conteúdo.
 */
export function findingWhere(filters: FindingFilters, now: Date): Prisma.FindingWhereInput {
  const window = filterWindow(filters, now);
  return {
    ...(filters.severity !== undefined && { severity: filters.severity }),
    ...(filters.status !== undefined && { status: filters.status }),
    ...((window.from !== null || window.to !== null) && {
      occurredAt: {
        ...(window.from !== null && { gte: window.from }),
        ...(window.to !== null && { lte: window.to }),
      },
    }),
    ...findingContentWhere(filters),
  };
}

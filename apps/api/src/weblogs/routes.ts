import { z } from 'zod';
import { every, isDigit, isLower } from './ascii.js';
import { normalizePath } from './path.js';

/**
 * Rotas declaradas pelo cliente: host (exato ou qualquer), método, caminho literal com `*` no lugar de um segmento inteiro
 * (nenhuma regex), o tipo, os códigos de falha e de sucesso e o multiplicador dos limites. Aqui, entrada pura: o cadastro é
 * da PR-2 e a tela, da PR-8.
 *
 * `ignore` só diz que a rota **não é de login**. Não cala sonda, enumeração nem o 990403.
 */
export const WEB_ROUTE_KINDS = ['login', 'mfa', 'reset', 'signup', 'api_token', 'ignore'] as const;
export type WebRouteKind = (typeof WEB_ROUTE_KINDS)[number];

export const MAX_ROUTES = 50;
const MAX_ROUTE_SEGMENTS = 8;

const isLiteralChar = (code: number): boolean =>
  isLower(code) || isDigit(code) || code === 45 || code === 46 || code === 95 || code === 126;

function isRoutePath(path: string): boolean {
  if (!path.startsWith('/') || path === '/') return path === '/';
  const segments = path.slice(1).split('/');
  return (
    segments.length <= MAX_ROUTE_SEGMENTS &&
    segments.every((segment) => segment === '*' || every(segment, isLiteralChar))
  );
}

const statusCodes = z.array(z.int().min(100).max(599)).max(20);

export const webRouteSchema = z.strictObject({
  id: z.string().min(1).max(64),
  /** null: qualquer host. */
  host: z
    .string()
    .min(1)
    .max(253)
    .refine((value) => every(value, isLiteralChar), { error: 'host inválido' })
    .nullable(),
  method: z.enum(['ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().max(256).refine(isRoutePath, {
    error: 'caminho inválido: minúsculas, até 8 segmentos, `*` só no lugar de um segmento inteiro',
  }),
  kind: z.enum(WEB_ROUTE_KINDS),
  failureCodes: statusCodes,
  successCodes: statusCodes,
  multiplier: z.number().min(0.5).max(10),
});
export type WebRoute = z.infer<typeof webRouteSchema>;

export const webRoutesSchema = z
  .array(webRouteSchema)
  .max(MAX_ROUTES)
  .refine((routes) => new Set(routes.map((route) => route.id)).size === routes.length, {
    error: 'rota repetida',
  });

export interface CompiledRoute {
  route: WebRoute;
  segments: readonly string[];
  failures: ReadonlySet<number>;
  successes: ReadonlySet<number>;
  /** Mais literal primeiro: host exato, menos `*`, e a ordem do cadastro. */
  rank: number;
}

export class RouteTable {
  private readonly byLength = new Map<number, CompiledRoute[]>();

  constructor(routes: readonly WebRoute[]) {
    const compiled = webRoutesSchema.parse(routes).map((route): CompiledRoute => {
      const segments =
        route.path === '/'
          ? []
          : route.path
              .slice(1)
              .split('/')
              .map((segment) =>
                segment === '*' ? segment : (normalizePath(segment).segments[0] ?? segment),
              );
      const wild = segments.filter((segment) => segment === '*').length;
      return {
        route,
        segments,
        failures: new Set(route.failureCodes),
        successes: new Set(route.successCodes),
        rank: (route.host === null ? 100 : 0) + wild,
      };
    });
    compiled.sort((a, b) => a.rank - b.rank);
    for (const entry of compiled) {
      const list = this.byLength.get(entry.segments.length);
      if (list === undefined) this.byLength.set(entry.segments.length, [entry]);
      else list.push(entry);
    }
  }

  get empty(): boolean {
    return this.byLength.size === 0;
  }

  /** A rota mais específica que casa, ou null. Os segmentos vêm normalizados (`path.ts`). */
  match(host: string | null, method: string, segments: readonly string[]): CompiledRoute | null {
    for (const entry of this.byLength.get(segments.length) ?? []) {
      const { route } = entry;
      if (route.host !== null && route.host !== host) continue;
      if (route.method !== 'ANY' && route.method !== method) continue;
      if (entry.segments.every((segment, i) => segment === '*' || segment === segments[i])) return entry;
    }
    return null;
  }
}

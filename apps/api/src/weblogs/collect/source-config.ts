import { createHash } from 'node:crypto';
import { WEB_OBSERVE_MS } from '@verax/shared';
import type { PrismaService } from '../../common/prisma/prisma.service.js';
import { MAX_ROUTES, type WebRoute, webRouteSchema } from '../routes.js';
import { MAX_TRUSTED, type WebTrustedSource } from '../trusted-sources.js';

/**
 * A configuração de um balanceador, como o motor a recebe. Lida do banco a cada passagem (a validade das fontes confiáveis só
 * é olhada no motor quando a configuração chega nele): a mudança pelo painel vale na passagem seguinte.
 */
export interface SourceConfig {
  mode: 'observe' | 'alert';
  multiplier: number;
  /** O começo da observação, que identifica a contagem dela. */
  observedSince: string;
  trusted: WebTrustedSource[];
  routes: WebRoute[];
}

export async function loadSourceConfig(
  prisma: PrismaService,
  source: { tenantId: string; sourceId: string; authorizedAt: Date },
): Promise<SourceConfig> {
  const { tenantId, sourceId } = source;
  const db = prisma.forTenant(tenantId);
  const order = [{ createdAt: 'asc' }, { id: 'asc' }] as const;
  const [settings, trusted, routes] = await Promise.all([
    db.webSourceSettings.findFirst({
      where: { sourceId },
      select: { mode: true, observeUntil: true, thresholdMultiplier: true },
    }),
    db.webTrustedSource.findMany({
      // As de todos os balanceadores do cliente e as deste.
      where: { OR: [{ sourceId: null }, { sourceId }] },
      orderBy: [...order],
      take: MAX_TRUSTED,
      select: { id: true, cidr: true, kind: true, reason: true, expiresAt: true },
    }),
    db.webRoute.findMany({
      where: { sourceId },
      orderBy: [...order],
      take: MAX_ROUTES,
      select: {
        id: true,
        host: true,
        method: true,
        path: true,
        kind: true,
        failureCodes: true,
        successCodes: true,
        multiplier: true,
      },
    }),
  ]);
  const since =
    settings?.observeUntil == null
      ? source.authorizedAt
      : new Date(settings.observeUntil.getTime() - WEB_OBSERVE_MS);
  return {
    // Sem a linha da configuração (que a autorização cria), só observa.
    mode: settings?.mode === 'alert' ? 'alert' : 'observe',
    multiplier: settings?.thresholdMultiplier ?? 1,
    observedSince: since.toISOString(),
    trusted: trusted.map((row) => ({
      ...row,
      kind: row.kind as WebTrustedSource['kind'],
      expiresAt: row.expiresAt.toISOString(),
    })),
    // A rota fora do formato (que o cadastro e o banco recusam) fica de fora, em vez de parar a fonte.
    routes: routes.flatMap((row) => {
      const parsed = webRouteSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }),
  };
}

/** O fluxo do cursor de um balanceador: o nome dele entra pelo resumo. */
export function webLogsStream(resourceId: string): string {
  return `aws_web_${createHash('sha256').update(resourceId).digest('hex').slice(0, 10)}`;
}

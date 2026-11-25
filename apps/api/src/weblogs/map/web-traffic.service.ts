import { Injectable } from '@nestjs/common';
import {
  AWS_SOURCE_ACTIVE_STATES,
  WEB_TRAFFIC_WINDOWS,
  type WebTraffic,
  type WebTrafficQuery,
  type WebTrafficWindow,
} from '@verax/shared';
import { TenantCache } from '../../common/cache/tenant-cache.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { webLogsStream } from '../collect/source-config.js';
import { WebTrafficStore } from '../store/web-traffic-store.js';
import { buildTraffic, recentRange, type TrafficSource, viewSources, windowRange } from './traffic-view.js';

/**
 * Por quanto tempo o mapa vale para o mesmo cliente: todo painel aberto o pede a cada 60 s. Nas janelas por hora, os números
 * mudam pouco e a leitura custa mais.
 */
export const WEB_TRAFFIC_TTL_MS: Readonly<Record<WebTrafficWindow, number>> = {
  '24h': 30_000,
  '7d': 120_000,
  '30d': 120_000,
};
/** Clientes guardados por processo e janela. */
export const WEB_TRAFFIC_TENANTS = 500;

/**
 * O mapa de origens do cliente da sessão (`traffic-view.ts`): as contagens por país de todos os balanceadores dele, e o
 * estado da leitura. Só leitura, sempre pelo cliente da sessão, com uma memória curta por cliente e janela.
 */
@Injectable()
export class WebTrafficService {
  private readonly store: WebTrafficStore;
  private readonly byWindow: ReadonlyMap<WebTrafficWindow, TenantCache<WebTraffic>>;

  constructor(private readonly prisma: PrismaService) {
    this.store = new WebTrafficStore(prisma);
    this.byWindow = new Map(
      WEB_TRAFFIC_WINDOWS.map((window) => [
        window,
        new TenantCache<WebTraffic>({ ttlMs: WEB_TRAFFIC_TTL_MS[window], maxTenants: WEB_TRAFFIC_TENANTS }),
      ]),
    );
  }

  /** A chave da memória é o cliente da sessão, o mesmo de onde a leitura sai. */
  async traffic({ window }: WebTrafficQuery): Promise<WebTraffic> {
    const cache = this.byWindow.get(window) as TenantCache<WebTraffic>;
    return cache.get(this.prisma.scopeTenantId(), () => this.load(window, new Date()));
  }

  private async load(window: WebTrafficWindow, now: Date): Promise<WebTraffic> {
    const view = viewSources(await this.sources(), now);
    if (view.counts.authorized === 0) return buildTraffic({ window, now, view, total: [], recent: [] });
    const tenantId = this.prisma.scopeTenantId();
    // O recente antes do total: o que entra entre as duas leituras só pode estar a mais no total.
    const last = recentRange(view);
    const recent = last === null ? [] : await this.store.byCountry(tenantId, last.from, last.to);
    const { from, to } = windowRange(window, now);
    const total = await this.store.byCountry(tenantId, from, to);
    return buildTraffic({ window, now, view, total, recent });
  }

  /** Os balanceadores com a leitura autorizada, de contas ativas (até 20 por conta). */
  private async sources(): Promise<TrafficSource[]> {
    const db = this.prisma.scoped();
    const rows = await db.awsSource.findMany({
      where: {
        kind: 'elb_logs',
        origin: 'discovered',
        authorizedAt: { not: null },
        revokedAt: null,
        state: { in: [...AWS_SOURCE_ACTIVE_STATES] },
        cloudAccount: { status: 'active' },
      },
      select: {
        id: true,
        cloudAccountId: true,
        region: true,
        resourceId: true,
        state: true,
        authorizedAt: true,
        lastEventAt: true,
        lastIngestedAt: true,
      },
    });
    if (rows.length === 0) return [];
    const [accounts, alerting] = await Promise.all([
      // O cursor é dado de sistema, sem cliente: só se chega nele pela conta do cliente.
      db.cloudAccount.findMany({
        where: { id: { in: [...new Set(rows.map((row) => row.cloudAccountId))] } },
        select: {
          id: true,
          cursors: {
            where: { stream: { in: [...new Set(rows.map((row) => webLogsStream(row.resourceId)))] } },
            select: { stream: true, region: true, cursorAt: true },
          },
        },
      }),
      db.webSourceSettings.findMany({
        where: { sourceId: { in: rows.map((row) => row.id) }, mode: 'alert' },
        select: { sourceId: true },
      }),
    ]);
    const positions = new Map(
      accounts.flatMap(({ id, cursors }) =>
        cursors.map(({ stream, region, cursorAt }) => [`${id}|${stream}|${region}`, cursorAt] as const),
      ),
    );
    const alertingIds = new Set(alerting.map((row) => row.sourceId));
    return rows.flatMap(({ id, authorizedAt, ...row }): TrafficSource[] =>
      authorizedAt === null
        ? []
        : [
            {
              state: row.state,
              authorizedAt,
              lastEventAt: row.lastEventAt,
              lastIngestedAt: row.lastIngestedAt,
              position:
                positions.get(`${row.cloudAccountId}|${webLogsStream(row.resourceId)}|${row.region}`) ?? null,
              alerting: alertingIds.has(id),
            },
          ],
    );
  }
}

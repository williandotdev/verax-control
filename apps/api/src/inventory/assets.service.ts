import { Injectable } from '@nestjs/common';
import {
  ASSET_KINDS,
  type AssetKind,
  type AssetListQuery,
  assetSchemas,
  inventorySummarySchema,
  type InventorySummary,
  type Paginated,
} from '@verax/shared';
import type { z } from 'zod';
import { toPaginated } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';

const RISK_ORDER = ['critical', 'high', 'medium', 'low', 'none'] as const;
const rootSchema = inventorySummarySchema.shape.accounts.element.shape.root;

type Asset = z.infer<(typeof assetSchemas)[AssetKind]>;

/** Os itens de um tipo num retrato, conferidos pelo contrato: item fora do formato não vai para a tela. */
function itemsOf(snapshotItems: unknown, kind: AssetKind): Asset[] {
  const raw = (snapshotItems as Record<string, unknown> | null)?.[kind];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const parsed = assetSchemas[kind].safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Nome que ordena os itens de mesmo risco. */
function labelOf(asset: Asset): string {
  if ('userName' in asset && 'arn' in asset) return asset.userName;
  if ('id' in asset) return asset.id;
  if ('instanceId' in asset) return asset.instanceId;
  if ('groupId' in asset) return asset.groupId;
  return 'name' in asset && typeof asset.name === 'string' ? asset.name : '';
}

/**
 * Ativos e identidades do cliente da sessão (T5.9), a partir do retrato mais recente de cada conta AWS ativa,
 * gravado pelo job de inventário. Conta sem retrato aparece sem dados.
 */
@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  private async latestSnapshots() {
    const db = this.prisma.scoped();
    const accounts = await db.cloudAccount.findMany({
      where: { status: 'active', provider: 'aws' },
      select: { accountId: true },
      orderBy: { accountId: 'asc' },
    });
    return Promise.all(
      accounts.map(async ({ accountId }) => ({
        accountId,
        snapshot: await db.inventorySnapshot.findFirst({
          where: { accountId },
          select: { collectedAt: true, root: true, items: true },
          orderBy: [{ collectedAt: 'desc' }, { id: 'desc' }],
        }),
      })),
    );
  }

  async summary(): Promise<InventorySummary> {
    const snapshots = await this.latestSnapshots();
    const counts = Object.fromEntries(ASSET_KINDS.map((kind) => [kind, { total: 0, atRisk: 0 }])) as Record<
      AssetKind,
      { total: number; atRisk: number }
    >;
    for (const { snapshot } of snapshots) {
      for (const kind of ASSET_KINDS) {
        const items = itemsOf(snapshot?.items ?? null, kind);
        counts[kind].total += items.length;
        counts[kind].atRisk += items.filter((item) => item.risk !== 'none').length;
      }
    }
    return {
      accounts: snapshots.map(({ accountId, snapshot }) => {
        const root = rootSchema.safeParse(snapshot?.root ?? null);
        return {
          accountId,
          collectedAt: snapshot?.collectedAt.toISOString() ?? null,
          root: root.success ? root.data : null,
        };
      }),
      counts,
    };
  }

  async list(kind: AssetKind, query: AssetListQuery): Promise<Paginated<Asset>> {
    const snapshots = await this.latestSnapshots();
    const items = snapshots
      .filter(({ accountId }) => !query.accountId || accountId === query.accountId)
      .flatMap(({ snapshot }) => itemsOf(snapshot?.items ?? null, kind))
      .filter((item) => !query.atRisk || item.risk !== 'none')
      .sort(
        (a, b) =>
          RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk) || labelOf(a).localeCompare(labelOf(b)),
      );
    const start = (query.page - 1) * query.pageSize;
    return toPaginated(items.slice(start, start + query.pageSize), items.length, query);
  }
}

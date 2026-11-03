import { Injectable } from '@nestjs/common';
import type {
  Paginated,
  UnownedAccounts,
  UnownedAccountsQuery,
  UnownedAlert,
  UnownedAlertListQuery,
  UnownedPeriod,
} from '@verax/shared';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';

const PERIOD_HOURS: Readonly<Record<UnownedPeriod, number>> = {
  '24h': 24,
  '7d': 168,
  '30d': 720,
  '90d': 2160,
};

/** Quantas contas o resumo da fila mostra. */
const TOP_ACCOUNTS = 50;

const alertSelect = {
  id: true,
  source: true,
  reason: true,
  accounts: true,
  occurredAt: true,
  ruleId: true,
  ruleLevel: true,
  title: true,
  createdAt: true,
} as const satisfies Prisma.UnownedAlertSelect;

type AlertRow = Prisma.UnownedAlertGetPayload<{ select: typeof alertSelect }>;

function toAlert(row: AlertRow): UnownedAlert {
  return {
    ...row,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

const since = (period: UnownedPeriod, now: Date) =>
  new Date(now.getTime() - PERIOD_HOURS[period] * 3_600_000);

/**
 * Fila de alertas sem dono (T5.2), só para a equipe da Verax. Os alertas não pertencem a cliente nenhum, então a
 * leitura não passa pelo escopo de cliente: quem protege a rota é a permissão `unowned_alerts:read`.
 */
@Injectable()
export class UnownedAlertsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: UnownedAlertListQuery, now = new Date()): Promise<Paginated<UnownedAlert>> {
    const where: Prisma.UnownedAlertWhereInput = {
      ...(query.reason && { reason: query.reason }),
      ...(query.account && { accounts: { has: query.account } }),
      ...(query.period && { createdAt: { gte: since(query.period, now) } }),
    };
    const db = this.prisma.db();
    const [rows, total] = await Promise.all([
      db.unownedAlert.findMany({
        where,
        select: alertSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...toPrismaPage(query),
      }),
      db.unownedAlert.count({ where }),
    ]);
    return toPaginated(rows.map(toAlert), total, query);
  }

  /**
   * As contas que mais aparecem na fila no período, e onde cada uma está cadastrada hoje. Uma conta cadastrada aqui
   * explica alertas de antes do cadastro; uma não cadastrada é, quase sempre, a que falta cadastrar.
   */
  async accounts(query: UnownedAccountsQuery, now = new Date()): Promise<UnownedAccounts> {
    const from = since(query.period, now);
    const db = this.prisma.db();
    const rows = await db.$queryRaw<{ account: string; alerts: number; lastSeenAt: Date }[]>`
      SELECT account, count(DISTINCT u."id")::int AS alerts, max(u."createdAt") AS "lastSeenAt"
      FROM "UnownedAlert" u, unnest(u."accounts") AS account
      WHERE u."createdAt" >= ${from}
      GROUP BY account
      ORDER BY alerts DESC, account ASC
      LIMIT ${TOP_ACCOUNTS}
    `;
    const registered = await db.cloudAccount.findMany({
      where: { accountId: { in: rows.map((row) => row.account) } },
      select: { accountId: true, status: true, tenant: { select: { id: true, name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const byAccount = new Map<string, (typeof registered)[number]>();
    for (const account of registered) {
      if (!byAccount.has(account.accountId)) byAccount.set(account.accountId, account);
    }
    return {
      period: query.period,
      from: from.toISOString(),
      items: rows.map((row) => {
        const found = byAccount.get(row.account);
        return {
          account: row.account,
          alerts: row.alerts,
          lastSeenAt: row.lastSeenAt.toISOString(),
          registeredIn: found
            ? { tenantId: found.tenant.id, tenantName: found.tenant.name, active: found.status === 'active' }
            : null,
        };
      }),
    };
  }
}

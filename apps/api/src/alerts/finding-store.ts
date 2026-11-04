import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { CloudProvider, UnownedReason as DbUnownedReason } from '../generated/prisma/client.js';
import { type IncidentGrouping, protectedItemsOf } from '../incidents/incident-grouping.js';
import type { ActiveException } from './exception-match.js';
import type { FindingDraft } from './finding-draft.js';

/**
 * Gravação comum aos syncs de alertas (Wazuh e GCP): o achado, o uso da exceção, o incidente, a fila sem dono, o
 * último evento de cada conta e a concessão que deixa um worker por vez. Cada sync só decide de onde vêm os eventos e
 * como cada um vira achado.
 */

export type PersistOutcome = 'duplicate' | 'excepted' | 'opened' | 'joined' | 'none';

export function findingRow(draft: FindingDraft, exception: ActiveException | null) {
  return {
    tenantId: draft.tenantId,
    accountId: draft.accountId,
    source: draft.source,
    sourceEventId: draft.sourceEventId,
    logSource: draft.logSource,
    occurredAt: new Date(draft.occurredAt),
    severity: draft.severity,
    // A exceção marca o achado como esperado já na chegada: ele não entra na fila de triagem.
    status: exception ? ('legitimate' as const) : ('new' as const),
    ruleId: draft.ruleId,
    ruleLevel: draft.ruleLevel,
    title: draft.title.slice(0, 500),
    eventName: draft.eventName?.slice(0, 256) ?? null,
    region: draft.region?.slice(0, 64) ?? null,
    resource: draft.resource?.slice(0, 2048) ?? null,
    actorUser: draft.actorUser?.slice(0, 512) ?? null,
    actorType: draft.actorType?.slice(0, 64) ?? null,
    accessKeyId: draft.accessKeyId?.slice(0, 128) ?? null,
    sourceIp: draft.sourceIp,
    mitreTactics: draft.mitreTactics,
    mitreTechniques: draft.mitreTechniques,
    exceptionId: exception?.id ?? null,
  };
}

export interface UnownedRecord {
  source: string;
  sourceEventId: string;
  reason: DbUnownedReason;
  accounts: string[];
  occurredAt: Date | null;
  ruleId: string | null;
  ruleLevel: number | null;
  title: string | null;
}

/**
 * Último evento visto de cada conta numa execução, para a cobertura (conta silenciosa) da Torre.
 *
 * O evento recebido também conecta a conta: na AWS (lida pelo Wazuh) e na GCP (Pub/Sub), as fontes entregam por
 * evento, e só o evento prova que os logs chegam. A conta que recebeu evento passa de `waiting` para `connected`.
 * Nunca sai de `error` por aqui: quem tira a conta do erro é o sync da fonte, numa leitura que deu certo.
 */
export class LastEvents {
  private readonly events = new Map<string, { tenantId: string; accountId: string; at: Date }>();

  see(tenantId: string, accountId: string, at: Date): void {
    const key = `${tenantId}:${accountId}`;
    const known = this.events.get(key);
    if (!known || at > known.at) this.events.set(key, { tenantId, accountId, at });
  }

  async save(prisma: PrismaService, provider: CloudProvider): Promise<void> {
    for (const { tenantId, accountId, at } of this.events.values()) {
      const accounts = prisma.forTenant(tenantId).cloudAccount;
      await accounts.updateMany({
        where: { provider, accountId, OR: [{ lastEventAt: null }, { lastEventAt: { lt: at } }] },
        data: { lastEventAt: at },
      });
      // Conta desativada no meio da execução fica como a desativação deixou.
      await accounts.updateMany({
        where: { provider, accountId, status: 'active', connection: 'waiting' },
        data: { connection: 'connected', connectionError: null },
      });
    }
  }
}

export class FindingStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly grouping: IncidentGrouping,
  ) {}

  /**
   * Achado, uso da exceção e incidente na mesma transação: se algo falhar no meio, nada fica gravado, e a releitura
   * grava tudo de novo. Sem isso, o achado ficaria e voltaria como duplicado, sem nunca entrar no incidente.
   *
   * Os coletores rodam ao mesmo tempo (agendador do worker): os achados de um mesmo cliente entram um por vez, sob um
   * lock transacional por cliente. Sem ele, dois achados com a mesma chave, gravados juntos por coletores diferentes,
   * não se veriam e abririam dois incidentes. Clientes diferentes não esperam um pelo outro.
   */
  async persist(
    draft: FindingDraft,
    exception: ActiveException | null,
    protectedItems: ReadonlySet<string>,
    now: Date,
  ): Promise<PersistOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:findings:${draft.tenantId}`}))`;
      const db = scopeToTenant(tx, draft.tenantId);
      const { count } = await db.finding.createMany({
        data: [findingRow(draft, exception)],
        skipDuplicates: true,
      });
      if (count === 0) return 'duplicate' as const;
      if (exception) {
        await db.alertException.update({
          where: { id: exception.id },
          data: { matchedCount: { increment: 1 }, lastMatchedAt: now },
        });
        // Esperado por exceção: não abre nem alimenta incidente.
        return 'excepted' as const;
      }
      const { id } = await db.finding.findUniqueOrThrow({
        where: { source_sourceEventId: { source: draft.source, sourceEventId: draft.sourceEventId } },
        select: { id: true },
      });
      return this.grouping.place(db, id, protectedItems);
    });
  }

  /** Na dúvida, o evento não é de ninguém (T5.2): a fila guarda o motivo e o mínimo para a triagem. */
  async recordUnowned(record: UnownedRecord): Promise<void> {
    await this.prisma.unownedAlert.createMany({
      data: [{ ...record, title: record.title?.slice(0, 500) ?? null }],
      skipDuplicates: true,
    });
  }

  /** Lista de proteção de cada cliente, para a nota de risco dos incidentes (+15). */
  async protectedItems(): Promise<Map<string, Set<string>>> {
    const rows = await this.prisma.protectedResource.findMany({
      select: { tenantId: true, type: true, identifier: true },
    });
    const byTenant = new Map<string, { type: string; identifier: string }[]>();
    for (const { tenantId, ...item } of rows)
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), item]);
    return new Map([...byTenant].map(([tenantId, items]) => [tenantId, protectedItemsOf(items)]));
  }

  /** Exceções em vigor, por cliente, na ordem de criação. */
  async activeExceptions(now: Date): Promise<Map<string, ActiveException[]>> {
    const rows = await this.prisma.alertException.findMany({
      where: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      select: { id: true, tenantId: true, ruleId: true, field: true, value: true, expiresAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const byTenant = new Map<string, ActiveException[]>();
    for (const { tenantId, ...exception } of rows) {
      byTenant.set(tenantId, [...(byTenant.get(tenantId) ?? []), exception]);
    }
    return byTenant;
  }
}

/** Concessão no banco: um worker por vez em cada sync. Vence sozinha se o worker morrer no meio. */
export class SyncLease {
  constructor(
    private readonly prisma: PrismaService,
    private readonly name: string,
    private readonly owner: string,
    private readonly leaseMs: number,
  ) {}

  async acquire(now: Date): Promise<boolean> {
    await this.prisma.syncState.createMany({ data: [{ name: this.name }], skipDuplicates: true });
    const { count } = await this.prisma.syncState.updateMany({
      where: {
        name: this.name,
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }, { leaseOwner: this.owner }],
      },
      data: { leaseOwner: this.owner, leaseUntil: new Date(now.getTime() + this.leaseMs) },
    });
    return count === 1;
  }

  async renew(): Promise<void> {
    await this.prisma.syncState.updateMany({
      where: { name: this.name, leaseOwner: this.owner },
      data: { leaseUntil: new Date(Date.now() + this.leaseMs) },
    });
  }

  async release(): Promise<void> {
    await this.prisma.syncState.updateMany({
      where: { name: this.name, leaseOwner: this.owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}

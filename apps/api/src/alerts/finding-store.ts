import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type {
  CloudProvider,
  FindingStatus,
  Prisma,
  UnownedReason as DbUnownedReason,
} from '../generated/prisma/client.js';
import { type IncidentGrouping, protectedItemsOf } from '../incidents/incident-grouping.js';
import { enqueueNotices, findingNotices } from '../notifications/finding-notices.js';
import type { ActiveException } from './exception-match.js';
import type { FindingDraft } from './finding-draft.js';

/**
 * Gravação comum aos syncs de alertas (Wazuh e GCP): o achado, o uso da exceção, o incidente, os avisos por e-mail, a
 * fila sem dono, o último evento de cada conta e a concessão que deixa um worker por vez. Cada sync só decide de onde vêm os eventos e
 * como cada um vira achado.
 */

export type PersistOutcome = 'duplicate' | 'excepted' | 'opened' | 'joined' | 'none';

/** Cliente do banco já no escopo de um cliente, dentro da transação que grava o achado. */
type ScopedDb = Prisma.TransactionClient;

/**
 * Lock transacional dos achados de um cliente: a gravação dos coletores (`persist`) e o expurgo diário
 * (`retention/retention-job.ts`) nunca mexem nos achados e incidentes do mesmo cliente ao mesmo tempo. Só vale dentro
 * de uma transação.
 */
export async function lockTenantFindings(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:findings:${tenantId}`}))`;
}

/**
 * Triado é todo status fora do inicial (`new`): investigando, legítimo e resolvido. É a mesma régua da triagem pela
 * API (`findings.service.ts`), que marca `triagedAt` na primeira saída de "novo"; o achado que já nasce legítimo pela
 * exceção também conta como triado, e a atividade nova dele vira outro achado esperado (a exceção conta o uso).
 */
const isTriaged = (status: FindingStatus): boolean => status !== 'new';

export function findingRow(draft: FindingDraft, exception: ActiveException | null) {
  return {
    tenantId: draft.tenantId,
    accountId: draft.accountId,
    source: draft.source,
    sourceEventId: draft.sourceEventId,
    rawEventId: draft.rawEventId ?? null,
    logSource: draft.logSource,
    occurredAt: new Date(draft.occurredAt),
    lastSeenAt: draft.recurrence ? new Date(draft.recurrence.lastSeenAt) : null,
    chainKey: draft.recurrence?.chainKey ?? null,
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
      await lockTenantFindings(tx, draft.tenantId);
      const db = scopeToTenant(tx, draft.tenantId);
      const { count } = await db.finding.createMany({
        data: [findingRow(draft, exception)],
        skipDuplicates: true,
      });
      if (count === 1) return this.settle(db, draft, draft.sourceEventId, exception, protectedItems, now);
      // A chave já existe. Só o GuardDuty traz a versão do achado, que diz se é a mesma ou uma nova.
      return draft.recurrence
        ? this.recur(db, draft, draft.recurrence, exception, protectedItems, now)
        : ('duplicate' as const);
    });
  }

  /**
   * Depois de gravar o achado: o uso da exceção, ou o incidente e os avisos por e-mail que ele gera (incidente alto ou
   * crítico aberto, incidente que sobe para alto ou crítico, achado crítico fora de incidente), na mesma transação.
   */
  private async settle(
    db: ScopedDb,
    draft: Pick<FindingDraft, 'tenantId' | 'source' | 'severity'>,
    sourceEventId: string,
    exception: ActiveException | null,
    protectedItems: ReadonlySet<string>,
    now: Date,
  ): Promise<PersistOutcome> {
    if (exception) {
      await db.alertException.update({
        where: { id: exception.id },
        data: { matchedCount: { increment: 1 }, lastMatchedAt: now },
      });
      // Esperado por exceção: não abre nem alimenta incidente.
      return 'excepted' as const;
    }
    const { id } = await db.finding.findUniqueOrThrow({
      where: { source_sourceEventId: { source: draft.source, sourceEventId } },
      select: { id: true },
    });
    const placement = await this.grouping.place(db, id, protectedItems);
    await enqueueNotices(
      db,
      findingNotices({ tenantId: draft.tenantId, id, severity: draft.severity }, placement),
    );
    return placement.outcome;
  }

  /**
   * A chave já existe e o alerta traz a versão do achado: o GuardDuty soma a atividade nova ao mesmo achado (mesmo
   * `id`, `service.count` maior) e grava outra versão (`updatedAt` mais novo). Decisão de 2026-11-04:
   * - achado sem versão conhecida (gravado antes da coluna, ou com o `updatedAt` fora do formato na primeira versão):
   *   esta versão vira a base de comparação, seja qual for o status, e nada mais muda. Sem isso, reler a mesma versão
   *   de um achado triado viraria recorrência;
   * - versão igual ou mais antiga que a última conhecida: duplicada, nada muda;
   * - achado ainda não triado: ele absorve a versão nova, e só a versão conhecida avança. Assim a mesma versão,
   *   relida na sobreposição depois da triagem, não vira achado;
   * - achado já triado (investigando, legítimo ou resolvido) e versão estritamente mais nova: a versão vira um
   *   achado novo, com a chave do achado inteiro mais o horário (reler essa versão cai como duplicada), ligado ao
   *   original por `recurrenceOfId`. O original não muda: nem o status, nem os campos, nem o evento bruto.
   * Quem decide é o achado mais recente da cadeia (`chainKey`: o original, as recorrências e, na sondagem de porta,
   * o achado de cada IP): a versão que chega com uma recorrência ainda aberta entra nela, e não abre outra.
   * Na sondagem de porta, o wodle entrega a versão em vários alertas (um por IP), todos na mesma cadeia: a
   * recorrência é uma só por versão (os outros alertas caem como duplicados), e o alerta com exceção não a cria,
   * porque a exceção é do IP dele, e a recorrência fala pela versão inteira. Se todos os IPs têm exceção, a versão
   * não vira nada; o IP que aparece pela primeira vez é outro achado por IP, como sempre.
   * A chave é única no banco inteiro; se for de um achado de outro cliente (conta recadastrada), o escopo não o vê, e
   * nada é tocado.
   */
  private async recur(
    db: ScopedDb,
    draft: FindingDraft,
    recurrence: NonNullable<FindingDraft['recurrence']>,
    exception: ActiveException | null,
    protectedItems: ReadonlySet<string>,
    now: Date,
  ): Promise<PersistOutcome> {
    const original = await db.finding.findUnique({
      where: { source_sourceEventId: { source: draft.source, sourceEventId: draft.sourceEventId } },
      select: { id: true },
    });
    if (!original) return 'duplicate' as const;
    // O original entra pelo id também: gravado sem a chave da cadeia (antes da coluna), ele ainda decide.
    const latest = await db.finding.findFirstOrThrow({
      where: { OR: [{ id: original.id }, { chainKey: recurrence.chainKey }] },
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, lastSeenAt: true },
    });
    const seenAt = new Date(recurrence.lastSeenAt);
    if (latest.lastSeenAt === null) {
      await db.finding.update({
        where: { id: latest.id },
        data: { lastSeenAt: seenAt, chainKey: recurrence.chainKey },
        select: { id: true },
      });
      return 'duplicate' as const;
    }
    if (seenAt <= latest.lastSeenAt) return 'duplicate' as const;
    if (!isTriaged(latest.status)) {
      await db.finding.update({
        where: { id: latest.id },
        data: { lastSeenAt: seenAt },
        select: { id: true },
      });
      return 'duplicate' as const;
    }
    // Alerta de um item só da versão (a chave base leva o IP; a da cadeia, não) com exceção: não fala pela versão.
    if (exception && draft.sourceEventId !== recurrence.chainKey) return 'duplicate' as const;
    const { count } = await db.finding.createMany({
      data: [
        {
          ...findingRow(draft, exception),
          sourceEventId: recurrence.sourceEventId,
          recurrenceOfId: original.id,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return 'duplicate' as const;
    return this.settle(db, draft, recurrence.sourceEventId, exception, protectedItems, now);
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

  /** Renova a concessão. False se ela não é mais deste worker (venceu e outra réplica a tomou). */
  async renew(): Promise<boolean> {
    return this.holdIn(this.prisma);
  }

  /**
   * Confere e renova a concessão no cliente dado. Numa transação, a linha fica presa até o fim dela: outra réplica não
   * toma a concessão entre a conferência e a gravação que vem depois (o inventário da AWS, PR-14'). False se ela não é
   * mais deste worker.
   */
  async holdIn(db: Pick<Prisma.TransactionClient, 'syncState'>): Promise<boolean> {
    const { count } = await db.syncState.updateMany({
      where: { name: this.name, leaseOwner: this.owner },
      data: { leaseUntil: new Date(Date.now() + this.leaseMs) },
    });
    return count === 1;
  }

  async release(): Promise<void> {
    await this.prisma.syncState.updateMany({
      where: { name: this.name, leaseOwner: this.owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
  }
}

import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type {
  CloudProvider,
  FindingStatus,
  Prisma,
  UnownedReason as DbUnownedReason,
} from '../generated/prisma/client.js';
import { AlertNotices } from '../notifications/finding-notices.js';
import type { ActiveException } from './exception-match.js';
import type { FindingDraft } from './finding-draft.js';
import { type EvidenceOutcome, saveFindingEvidence } from './finding-evidence.js';

/**
 * Gravação comum aos syncs de alertas (Wazuh e GCP): o achado (o alerta a validar), o uso da exceção, o aviso por e-mail,
 * a fila sem dono, o último evento de cada conta e a concessão que deixa um worker por vez. Cada sync só decide de onde vêm os eventos e
 * como cada um vira achado.
 */

/**
 * `created`: alerta novo, na fila de validação. Incidente só nasce quando uma pessoa confirma (decisão de 17/11/2026):
 * o sync nunca abre nem alimenta incidente.
 */
export type PersistOutcome = 'duplicate' | 'excepted' | 'created';

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

/** A ordem das severidades, para saber se a de um achado atualizado na origem subiu. */
const SEVERITY_RANK: Readonly<Record<FindingDraft['severity'], number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function findingRow(draft: FindingDraft, exception: ActiveException | null) {
  return {
    tenantId: draft.tenantId,
    accountId: draft.accountId,
    source: draft.source,
    sourceEventId: draft.sourceEventId,
    rawEventId: draft.rawEventId ?? null,
    logSource: draft.logSource,
    occurredAt: new Date(draft.occurredAt),
    lastSeenAt: draft.recurrence
      ? new Date(draft.recurrence.lastSeenAt)
      : draft.revision
        ? new Date(draft.revision.lastSeenAt)
        : null,
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

export interface FindingStoreOptions {
  /** A evidência foi recusada (schema ou tamanho): o achado foi gravado sem ela. Recebe só o id da regra. */
  onEvidenceRefused?: (ruleId: string) => void;
}

export class FindingStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notices: AlertNotices = new AlertNotices(),
    private readonly options: FindingStoreOptions = {},
  ) {}

  /**
   * Achado, uso da exceção e aviso por e-mail na mesma transação: se algo falhar no meio, nada fica gravado, e a
   * releitura grava tudo de novo. Sem isso, o achado ficaria e voltaria como duplicado, sem nunca avisar.
   *
   * Os coletores rodam ao mesmo tempo (agendador do worker): os achados de um mesmo cliente entram um por vez, sob um
   * lock transacional por cliente, o mesmo que o expurgo e as mudanças de incidente pela API tomam (promover, anexar e
   * remover alertas). Clientes diferentes não esperam um pelo outro.
   *
   * O achado que traz a própria evidência (`draft.evidence`, só os ataques web pelos logs do ALB) a grava na mesma
   * transação. Sem ela, nenhuma consulta a mais.
   */
  async persist(draft: FindingDraft, exception: ActiveException | null, now: Date): Promise<PersistOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await lockTenantFindings(tx, draft.tenantId);
      const db = scopeToTenant(tx, draft.tenantId);
      const { count } = await db.finding.createMany({
        data: [findingRow(draft, exception)],
        skipDuplicates: true,
      });
      if (count === 1) return this.settle(tx, db, draft, draft.sourceEventId, exception, now);
      // A chave já existe. Só o GuardDuty traz a versão do achado, que diz se é a mesma ou uma nova.
      if (draft.recurrence) return this.recur(tx, db, draft, draft.recurrence, exception, now);
      // Os achados de estado da API da AWS trazem a versão também, e ela só atualiza o que já existe.
      if (draft.revision) return this.revise(tx, db, draft, draft.revision);
      return 'duplicate' as const;
    });
  }

  /** A evidência do achado, se o draft a traz. O `findingId` é de um achado lido no escopo do cliente. */
  private async saveEvidence(
    tx: Prisma.TransactionClient,
    draft: FindingDraft,
    findingId: string,
  ): Promise<EvidenceOutcome | null> {
    if (draft.evidence === undefined) return null;
    const outcome = await saveFindingEvidence(tx, { tenantId: draft.tenantId, findingId }, draft.evidence);
    if (outcome === 'refused') this.options.onEvidenceRefused?.(draft.ruleId);
    return outcome;
  }

  /**
   * A chave já existe e o achado é de estado (Security Hub, Inspector, Access Analyzer): a origem o atualiza a cada
   * reavaliação, e a versão nova nunca vira outro achado. Versão igual ou mais antiga que a conhecida: nada muda. Mais
   * nova: o `lastSeenAt` avança e, se mudaram na origem, a severidade (com o nível), a regra e o título acompanham (o
   * acesso externo que virou público, a vulnerabilidade que o fornecedor reclassificou). O status, os
   * comentários e o incidente não mudam: quem fecha o achado é sempre uma pessoa. Se a severidade subiu para alta ou
   * crítica, o aviso por e-mail sai agora, uma vez só por achado (a chave do aviso é a do achado); o achado marcado
   * como legítimo (por uma pessoa ou por exceção) não avisa. A chave de um achado de outro cliente não é vista pelo
   * escopo, e nada é tocado.
   *
   * Com evidência (o resumo do dia dos ataques web), ela e o `eventName`, que traz as contagens, acompanham a versão; na
   * mesma versão, só se a evidência cresceu (o arquivo de outro nó do balanceador que chegou depois).
   */
  private async revise(
    tx: Prisma.TransactionClient,
    db: ScopedDb,
    draft: FindingDraft,
    revision: NonNullable<FindingDraft['revision']>,
  ): Promise<PersistOutcome> {
    const current = await db.finding.findUnique({
      where: { source_sourceEventId: { source: draft.source, sourceEventId: draft.sourceEventId } },
      select: { id: true, lastSeenAt: true, severity: true, ruleId: true, title: true, status: true },
    });
    if (!current) return 'duplicate' as const;
    const seenAt = new Date(revision.lastSeenAt);
    const eventName = draft.evidence && { eventName: draft.eventName?.slice(0, 256) ?? null };
    if (current.lastSeenAt !== null && seenAt <= current.lastSeenAt) {
      if (eventName === undefined || seenAt < current.lastSeenAt) return 'duplicate' as const;
      if ((await this.saveEvidence(tx, draft, current.id)) === 'stored') {
        await db.finding.update({ where: { id: current.id }, data: eventName, select: { id: true } });
      }
      return 'duplicate' as const;
    }
    const title = draft.title.slice(0, 500);
    const severityChanged = current.severity !== draft.severity;
    await db.finding.update({
      where: { id: current.id },
      data: {
        lastSeenAt: seenAt,
        ...(severityChanged && { severity: draft.severity, ruleLevel: draft.ruleLevel }),
        ...(current.ruleId !== draft.ruleId && { ruleId: draft.ruleId }),
        ...(current.title !== title && { title }),
        ...eventName,
      },
      select: { id: true },
    });
    await this.saveEvidence(tx, draft, current.id);
    const rose = SEVERITY_RANK[draft.severity] > SEVERITY_RANK[current.severity];
    if (rose && current.status !== 'legitimate') {
      await this.notices.enqueue(db, { tenantId: draft.tenantId, id: current.id, severity: draft.severity });
    }
    return 'duplicate' as const;
  }

  /**
   * Depois de gravar o achado: o uso da exceção, ou o aviso por e-mail do alerta alto ou crítico, e a evidência, se o draft
   * a traz, na mesma transação.
   */
  private async settle(
    tx: Prisma.TransactionClient,
    db: ScopedDb,
    draft: FindingDraft,
    sourceEventId: string,
    exception: ActiveException | null,
    now: Date,
  ): Promise<PersistOutcome> {
    if (exception) {
      await db.alertException.update({
        where: { id: exception.id },
        data: { matchedCount: { increment: 1 }, lastMatchedAt: now },
      });
      // Esperado por exceção: já nasce legítimo, fora da fila de validação, e não avisa.
      if (draft.evidence !== undefined) {
        await this.saveEvidence(tx, draft, await this.findingId(db, draft.source, sourceEventId));
      }
      return 'excepted' as const;
    }
    const id = await this.findingId(db, draft.source, sourceEventId);
    await this.notices.enqueue(db, { tenantId: draft.tenantId, id, severity: draft.severity });
    await this.saveEvidence(tx, draft, id);
    return 'created' as const;
  }

  private async findingId(db: ScopedDb, source: string, sourceEventId: string): Promise<string> {
    const { id } = await db.finding.findUniqueOrThrow({
      where: { source_sourceEventId: { source, sourceEventId } },
      select: { id: true },
    });
    return id;
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
   *
   * Com evidência (os ataques web), a do achado ainda não triado acompanha a atividade, também dentro da mesma versão (a
   * hora cheia). A do triado não muda: é o que a pessoa viu ao decidir, e a atividade nova ganha achado e evidência
   * próprios.
   */
  private async recur(
    tx: Prisma.TransactionClient,
    db: ScopedDb,
    draft: FindingDraft,
    recurrence: NonNullable<FindingDraft['recurrence']>,
    exception: ActiveException | null,
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
      if (!isTriaged(latest.status)) await this.saveEvidence(tx, draft, latest.id);
      return 'duplicate' as const;
    }
    if (seenAt <= latest.lastSeenAt) {
      const sameVersion = seenAt.getTime() === latest.lastSeenAt.getTime();
      if (sameVersion && !isTriaged(latest.status)) await this.saveEvidence(tx, draft, latest.id);
      return 'duplicate' as const;
    }
    if (!isTriaged(latest.status)) {
      await db.finding.update({
        where: { id: latest.id },
        data: { lastSeenAt: seenAt },
        select: { id: true },
      });
      await this.saveEvidence(tx, draft, latest.id);
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
    return this.settle(tx, db, draft, recurrence.sourceEventId, exception, now);
  }

  /** Na dúvida, o evento não é de ninguém (T5.2): a fila guarda o motivo e o mínimo para a triagem. */
  async recordUnowned(record: UnownedRecord): Promise<void> {
    await this.prisma.unownedAlert.createMany({
      data: [{ ...record, title: record.title?.slice(0, 500) ?? null }],
      skipDuplicates: true,
    });
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

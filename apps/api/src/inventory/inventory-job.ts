import { randomUUID } from 'node:crypto';
import { AWS_BUCKET_ERROR_CODES, type AwsConnectionErrorCode, parseAwsConnectionError } from '@verax/shared';
import { SyncLease } from '../alerts/finding-store.js';
import { AwsConnectionError, STS_FALLBACK_REGION, type WebIdentityCredentials } from '../aws/web-identity.js';
import { type Backoff, CollectorCursors, type CursorKey } from '../collectors/collector-cursor.js';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  collectInventory,
  type InventoryClientFactory,
  InventoryRunClients,
  InventoryUnavailable,
  inventoryRegions,
} from './inventory.js';
import { type InventorySnapshotData, toSnapshot } from './snapshot-mapper.js';

/** Nome da concessão em `SyncState`: um worker por vez na tarefa, mesmo com mais de uma réplica. */
export const AWS_INVENTORY_SYNC = 'aws-inventory';
/** O fluxo do cursor de cada conta (`CollectorCursor`): a próxima coleta, a última bem-sucedida e as falhas. */
export const AWS_INVENTORY_STREAM = 'aws_inventory';
/** A tarefa olha as contas a cada 5 min: uma conta recém-verificada entra na volta seguinte. */
export const AWS_INVENTORY_TICK_MS = 5 * 60 * 1000;
/** Orçamento de uma execução (algumas contas, uma de cada vez). */
export const AWS_INVENTORY_BUDGET_MS = 30 * 60 * 1000;
/**
 * Validade da concessão. Ela é renovada durante a coleta, a cada terço da validade (e depois de cada conta), e conferida
 * de novo na transação que grava o retrato: uma coleta mais longa que a validade não deixa outra réplica coletar a
 * mesma conta ao mesmo tempo.
 */
export const AWS_INVENTORY_LEASE_MS = 15 * 60 * 1000;
/** Uma coleta por conta a cada 24 h... */
export const AWS_INVENTORY_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** ...mais um sorteio de até 1 h, para as contas não coletarem todas na mesma hora todo dia. */
export const AWS_INVENTORY_JITTER_MS = 60 * 60 * 1000;
/** Contas coletadas por execução, as mais atrasadas primeiro; as outras ficam para a volta seguinte. */
export const AWS_INVENTORY_BATCH = 5;
/**
 * Recuo depois de uma coleta que não terminou (a entrada no papel recusada, a AWS fora, tudo recusado): 30 min,
 * dobrando, até 6 h. Cada tentativa é uma entrada no papel (se a sessão não estiver guardada) e dezenas de leituras no
 * CloudTrail do cliente.
 */
export const AWS_INVENTORY_BACKOFF: Readonly<Backoff> = { baseMs: 30 * 60 * 1000, maxMs: 6 * 60 * 60 * 1000 };

/**
 * Os erros de uma conta com erro de conexão que não impedem a entrada no papel: um bucket de log com problema e o token
 * do host sem renovar (o do Wazuh, não o do worker). Com qualquer outro (a confiança recusada, o token do nó, a AWS
 * fora), a coleta espera a conferência da conexão voltar a "conectada", sem chamar a AWS.
 */
const COLLECTABLE_ERRORS: ReadonlySet<AwsConnectionErrorCode> = new Set<AwsConnectionErrorCode>([
  ...AWS_BUCKET_ERROR_CODES,
  'aws_token_stale',
]);

/** O que a tarefa usa do provedor de sessões (o do worker, `WebIdentityCredentials`; um falso nos testes). */
export type InventoryCredentials = Pick<WebIdentityCredentials, 'session' | 'credentialsFor' | 'forget'>;

/** Contagens de uma execução (vão para o log do agendador; nenhum dado de cliente nem da AWS). */
export interface AwsInventoryReport {
  /**
   * `locked`: outra réplica tem a concessão; `lease_lost`: a concessão venceu durante a execução e outra réplica a
   * tomou, e a execução parou sem gravar o retrato em curso (o estado da tarefa fica para a outra).
   */
  status: 'done' | 'locked' | 'lease_lost';
  /** Contas AWS ativas e já verificadas, conectadas ou com erro. */
  accounts: number;
  /** Com um erro de conexão que impede a entrada no papel: esperam a conferência da conexão. */
  waiting: number;
  /** Ainda não estavam na hora (ou ficaram para a volta seguinte, pelo lote). */
  notDue: number;
  /** Retratos gravados. */
  collected: number;
  /** Dos gravados, quantos são parciais (uma parte recusada, itens fora do formato ou o teto de itens). */
  partial: number;
  /** O retrato daquele início de coleta já existia (nada gravado de novo). */
  duplicates: number;
  /** A conta mudou durante a coleta (desativada, removida, de outro provedor): o retrato foi descartado. */
  stale: number;
  /** Coletas que não terminaram: nada gravado, com recuo. */
  failed: number;
  /** Itens recusados pelo contrato nos retratos gravados. */
  droppedItems: number;
  /** Os códigos das coletas que não terminaram. */
  failures?: Record<string, number>;
}

export interface AwsInventoryOptions {
  /** Nome da concessão em `SyncState` (os testes usam um por caso). */
  name?: string;
  owner?: string;
  leaseMs?: number;
  now?: () => Date;
  /** O sorteio do horário, de 0 a 1 (os testes fixam). */
  random?: () => number;
  batch?: number;
  intervalMs?: number;
  jitterMs?: number;
  backoff?: Backoff;
  /** Só os testes, que dividem o banco: restringe a execução às contas destes clientes. */
  tenantIds?: readonly string[];
}

const ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  regions: true,
  connection: true,
  connectionError: true,
} as const satisfies Prisma.CloudAccountSelect;
type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** A concessão não é mais deste worker: a execução para, e o retrato em curso não é gravado. */
class InventoryLeaseLost extends Error {
  constructor() {
    super('inventário da AWS: concessão perdida');
    this.name = 'InventoryLeaseLost';
  }
}

/** Uma coleta que não terminou, guardada no cursor só pelo código (o nome do erro). */
class InventoryRunError extends Error {
  constructor(code: string) {
    super(`inventário da AWS: ${code}`);
    this.name = code;
  }
}

/** A conta pode entrar no papel: conectada, ou com erro só num bucket (ou no token do host). */
function entersRole(row: AccountRow): boolean {
  if (row.connection === 'connected') return true;
  if (row.connection !== 'error' || row.connectionError === null) return false;
  const parsed = parseAwsConnectionError(row.connectionError);
  return parsed !== null && COLLECTABLE_ERRORS.has(parsed.code);
}

/** O código de uma coleta que não terminou: o da conexão, o da coleta, ou o tipo do erro (banco, gravação). */
function failureCode(error: unknown): string {
  if (error instanceof AwsConnectionError) return error.code;
  if (error instanceof InventoryUnavailable) return error.code;
  return errorKind(error);
}

/**
 * Tarefa `aws-inventory` do worker (fase 2, PR-14'): o inventário nativo da AWS (a tela Ativos), pelo papel de leitura
 * sem chave, com a mesma sessão da conferência da conexão (`WebIdentityCredentials`, uma entrada no papel por hora por
 * conta).
 *
 * - **Quem entra:** as contas AWS ativas já verificadas ao menos uma vez (`ingestFrom`), conectadas ou com erro só num
 *   bucket de log. Nunca as em "aguardando" (reativada, com outra lista de buckets ou com "Verificar" pendente), nem as
 *   com erro na entrada do papel: essas esperam a conferência da conexão (`aws-check`), que já tenta de 15 em 15 min.
 * - **Quando:** a conta que nunca coletou entra na volta seguinte (no máximo 5 min depois da primeira verificação); a
 *   que coletou, quando a última coleta bem-sucedida tem mais de 24 h, mais um sorteio de até 1 h. O cursor da conta
 *   (`CollectorCursor`, fluxo `aws_inventory`) guarda isso no banco: uma partida nova do worker não coleta tudo de novo.
 *   Uma coleta que não terminou recua (30 min, dobrando, até 6 h).
 * - **A coleta** (`collectInventory`): as regiões monitoradas, no máximo 2 chamadas do IAM ao mesmo tempo, só leitura.
 *   Uma parte recusada entra no retrato como coleta parcial; uma falha passageira, a sessão perdida no meio ou tudo
 *   recusado param a coleta, sem gravar nada, e o retrato anterior continua na tela. Tudo recusado também descarta a
 *   sessão guardada (uma sessão revogada no console não fica em uso até vencer).
 * - **A gravação:** o retrato (`toSnapshot`, cada item conferido pelo contrato) entra numa transação pelo escopo do
 *   cliente da conta, só se a conta ainda é a mesma (ativa, AWS, do mesmo cliente) e se a concessão ainda é deste
 *   worker (conferida e renovada na própria transação, que prende a linha dela); a chave única com o início da coleta
 *   torna a gravação idempotente. A conexão da conta não muda aqui: ela é da conferência.
 * - **A concessão** é renovada durante a coleta, a cada terço da validade. Perdida (venceu e outra réplica a tomou), o
 *   sinal da execução é abortado: as chamadas param, nada é gravado e o cursor fica como estava.
 *
 * Nada da conta vai para o log: o relatório só tem contagens e códigos. As credenciais ficam no provedor.
 */
export class AwsInventorySync {
  private readonly lease: SyncLease;
  private readonly cursors: CollectorCursors;
  private readonly name: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly batch: number;
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly backoff: Backoff;
  private readonly tenantFilter: Prisma.CloudAccountWhereInput;
  /** De quanto em quanto tempo a concessão é renovada durante a execução: um terço da validade. */
  private readonly renewEveryMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: InventoryCredentials,
    private readonly clients: InventoryClientFactory,
    {
      name = AWS_INVENTORY_SYNC,
      owner = `worker-${randomUUID()}`,
      leaseMs = AWS_INVENTORY_LEASE_MS,
      now = () => new Date(),
      random = Math.random,
      batch = AWS_INVENTORY_BATCH,
      intervalMs = AWS_INVENTORY_INTERVAL_MS,
      jitterMs = AWS_INVENTORY_JITTER_MS,
      backoff = AWS_INVENTORY_BACKOFF,
      tenantIds,
    }: AwsInventoryOptions = {},
  ) {
    if (!Number.isInteger(batch) || batch < 1)
      throw new Error('o lote do aws-inventory precisa ser um inteiro positivo');
    this.name = name;
    this.lease = new SyncLease(prisma, name, owner, leaseMs);
    this.renewEveryMs = Math.max(250, Math.floor(leaseMs / 3));
    this.cursors = new CollectorCursors(prisma);
    this.now = now;
    this.random = random;
    this.batch = batch;
    this.intervalMs = intervalMs;
    this.jitterMs = jitterMs;
    this.backoff = backoff;
    this.tenantFilter = tenantIds === undefined ? {} : { tenantId: { in: [...tenantIds] } };
  }

  /** A próxima coleta depois de uma bem-sucedida: 24 h depois do início dela, mais o sorteio. */
  nextRunAfter(startedAt: Date): Date {
    const jitter = Math.floor(Math.min(Math.max(this.random(), 0), 1) * this.jitterMs);
    return new Date(startedAt.getTime() + this.intervalMs + jitter);
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<AwsInventoryReport> {
    const report: AwsInventoryReport = {
      status: 'done',
      accounts: 0,
      waiting: 0,
      notDue: 0,
      collected: 0,
      partial: 0,
      duplicates: 0,
      stale: 0,
      failed: 0,
      droppedItems: 0,
    };
    const startedAt = this.now();
    if (!(await this.lease.acquire(startedAt))) return { ...report, status: 'locked' };
    // A concessão perdida aborta este sinal, junto com o do agendador: as chamadas à AWS e a gravação param.
    const ownership = new AbortController();
    const active = AbortSignal.any([signal, ownership.signal]);
    const keeper = setInterval(() => void this.keepLease(ownership), this.renewEveryMs);
    let firstError: string | null = null;
    try {
      const rows = await this.prisma.cloudAccount.findMany({
        where: {
          provider: 'aws',
          status: 'active',
          ingestFrom: { not: null },
          connection: { in: ['connected', 'error'] },
          ...this.tenantFilter,
        },
        select: ACCOUNT_SELECT,
        orderBy: { id: 'asc' },
      });
      report.accounts = rows.length;
      const due: { row: AccountRow; nextRunAt: number }[] = [];
      for (const row of rows) {
        if (!entersRole(row)) {
          report.waiting += 1;
          continue;
        }
        // Sem cursor (nunca coletou), ele nasce com a coleta para já.
        const cursor = await this.cursors.read(this.keyOf(row), startedAt);
        if (cursor.nextRunAt.getTime() > startedAt.getTime()) report.notDue += 1;
        else due.push({ row, nextRunAt: cursor.nextRunAt.getTime() });
      }
      due.sort((a, b) => a.nextRunAt - b.nextRunAt);
      report.notDue += Math.max(0, due.length - this.batch);
      for (const { row } of due.slice(0, this.batch)) {
        active.throwIfAborted();
        const failed = await this.collectOne(row, report, active, ownership);
        firstError ??= failed;
        await this.keepLease(ownership);
      }
      active.throwIfAborted();
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: {
          lastRunAt: startedAt,
          ...(firstError === null && { lastSuccessAt: this.now() }),
          lastError: firstError,
        },
      });
      return report;
    } catch (error) {
      // Outra réplica tomou a concessão: a execução para aqui, e o estado da tarefa é dela agora.
      if (ownership.signal.aborted && !signal.aborted) return { ...report, status: 'lease_lost' };
      // Só o tipo do erro: a mensagem de um erro do banco pode carregar dado.
      await this.prisma.syncState.update({
        where: { name: this.name },
        data: { lastRunAt: startedAt, lastError: errorKind(error) },
      });
      throw error;
    } finally {
      clearInterval(keeper);
      // Só solta se ainda for deste worker (a de outra réplica fica).
      await this.lease.release();
    }
  }

  /**
   * Renova a concessão. Perdida (venceu e outra réplica a tomou), aborta a execução. Uma falha do banco fica para a
   * renovação seguinte: a gravação confere a concessão de novo, na transação.
   */
  private async keepLease(ownership: AbortController): Promise<void> {
    if (ownership.signal.aborted) return;
    try {
      if (!(await this.lease.renew())) ownership.abort(new InventoryLeaseLost());
    } catch {
      // O banco fora agora: a próxima renovação, ou a gravação, decide.
    }
  }

  private keyOf(row: AccountRow): CursorKey {
    return { cloudAccountId: row.id, stream: AWS_INVENTORY_STREAM };
  }

  /**
   * A coleta de uma conta. Devolve o código da falha (ou null), para o estado da tarefa. O sinal é o da execução (o do
   * agendador e o da concessão); abortado, a coleta para sem gravar e sem mexer no cursor.
   */
  private async collectOne(
    row: AccountRow,
    report: AwsInventoryReport,
    signal: AbortSignal,
    ownership: AbortController,
  ): Promise<string | null> {
    const startedAt = this.now();
    const regions = inventoryRegions(row.regions);
    const home = regions[0] ?? STS_FALLBACK_REGION;
    let clients: InventoryRunClients | null = null;
    try {
      // A entrada no papel primeiro: recusada, nenhuma outra chamada.
      await this.credentials.session(row.accountId, home, signal);
      clients = new InventoryRunClients(
        this.clients(this.credentials.credentialsFor(row.accountId, home), home),
        home,
        signal,
      );
      const inventory = await collectInventory({ accountId: row.accountId, regions }, clients, {
        now: startedAt,
        signal,
      });
      const snapshot = toSnapshot(inventory);
      const result = await this.persist(row, snapshot);
      if (result === 'lost') {
        ownership.abort(new InventoryLeaseLost());
        signal.throwIfAborted();
      }
      if (result === 'stale') {
        report.stale += 1;
        return null;
      }
      if (result === 'duplicate') report.duplicates += 1;
      else {
        report.collected += 1;
        if (snapshot.errors.length > 0 || snapshot.truncated) report.partial += 1;
        report.droppedItems += Object.values(snapshot.dropped).reduce((sum, count) => sum + count, 0);
      }
      await this.cursors.advance(
        this.keyOf(row),
        { continuation: null, nextRunAt: this.nextRunAfter(startedAt) },
        this.now(),
      );
      return null;
    } catch (error) {
      // Parada do worker ou estouro do orçamento: a conta é coletada de novo na volta seguinte (o cursor não mudou).
      signal.throwIfAborted();
      const code = failureCode(error);
      if (error instanceof InventoryUnavailable && error.code === 'inventory_refused') {
        this.credentials.forget(row.accountId);
      }
      report.failed += 1;
      report.failures = { ...report.failures, [code]: (report.failures?.[code] ?? 0) + 1 };
      await this.cursors.fail(this.keyOf(row), new InventoryRunError(code), this.now(), {
        backoff: this.backoff,
      });
      return code;
    } finally {
      clients?.destroy();
    }
  }

  /**
   * Grava o retrato pelo escopo do cliente da conta, se a concessão ainda é deste worker (conferida e renovada na própria
   * transação: a linha dela fica presa até o fim, e outra réplica não a toma no meio) e se a conta ainda é a que foi
   * lida (ativa, AWS, do mesmo cliente). A chave única (cliente, conta e início da coleta) torna a gravação idempotente.
   */
  private persist(
    row: AccountRow,
    snapshot: InventorySnapshotData,
  ): Promise<'recorded' | 'duplicate' | 'stale' | 'lost'> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await this.lease.holdIn(tx))) return 'lost';
      const db = scopeToTenant(tx, row.tenantId);
      const current = await db.cloudAccount.count({
        where: { id: row.id, provider: 'aws', status: 'active', accountId: row.accountId },
      });
      if (current === 0) return 'stale';
      const { count } = await db.inventorySnapshot.createMany({
        data: [
          {
            tenantId: row.tenantId,
            accountId: snapshot.accountId,
            collectedAt: snapshot.collectedAt,
            ...(snapshot.root !== null && { root: snapshot.root }),
            items: snapshot.items as Prisma.InputJsonObject,
            errors: snapshot.errors,
            truncated: snapshot.truncated,
          },
        ],
        skipDuplicates: true,
      });
      return count === 1 ? 'recorded' : 'duplicate';
    });
  }
}

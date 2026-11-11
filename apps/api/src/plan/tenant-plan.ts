import { HttpStatus } from '@nestjs/common';
import {
  PLAN_LIMIT_BOUNDS,
  PLAN_LIMIT_KEYS,
  parseTenantPlan,
  type ResolvedPlan,
  resolvedPlanOf,
  type TenantPlan,
  tenantPlanFromResolved,
} from '@verax/shared';
import type { NodeMode } from '../common/config/env.schema.js';
import { ApiError } from '../common/http/api-error.js';
import { Prisma, type TenantPlanSource } from '../generated/prisma/client.js';

/** Código da recusa quando o cliente ainda não tem plano na célula. */
export const TENANT_PLAN_MISSING_CODE = 'TENANT_PLAN_MISSING';

/**
 * Cliente da célula sem plano gravado (o comando do plano de controle ainda não chegou): nenhuma vaga é dada e o uso
 * não é mostrado. 409, como o `TENANT_REQUIRED`: o estado do cliente não permite a operação agora, e passa sozinho
 * quando o comando chega (um 5xx sairia com a mensagem genérica, sem o código). A mensagem não cita outro cliente nem
 * valores.
 */
export class TenantPlanMissing extends ApiError {
  constructor() {
    super(
      HttpStatus.CONFLICT,
      'O plano deste cliente ainda não está configurado. Tente de novo em alguns minutos ou fale com a Verax.',
      TENANT_PLAN_MISSING_CODE,
    );
  }
}

/**
 * De onde vem o plano de cada cliente (CE-02). No nó, o `TenantPlanResolver`; nos testes do expurgo e dos avisos, um
 * plano fixo (`fixedTenantPlans`). `null` é o cliente sem plano: só na célula, antes do comando do plano de controle.
 */
export interface TenantPlans {
  planOf(tenantId: string, db?: Prisma.TransactionClient): Promise<ResolvedPlan | null>;
}

/** O mesmo plano para todo cliente (os testes do expurgo e dos avisos, que não dependem do banco para o plano). */
export function fixedTenantPlans(plan: ResolvedPlan | null): TenantPlans {
  return { planOf: () => Promise.resolve(plan) };
}

const TENANT_PLAN_SELECT = {
  planId: true,
  maxCloudAccounts: true,
  maxUsers: true,
  monthlyGib: true,
  historyDays: true,
  franchiseGbPerDay: true,
  source: true,
} as const satisfies Prisma.TenantPlanSelect;

type TenantPlanRow = Prisma.TenantPlanGetPayload<{ select: typeof TENANT_PLAN_SELECT }>;

/** O plano gravado, conferido de novo (uma linha que o CHECK do banco aceitou também passa aqui). */
export function tenantPlanOfRow(row: TenantPlanRow): TenantPlan {
  return parseTenantPlan({
    planId: row.planId,
    limits: {
      maxCloudAccounts: row.maxCloudAccounts,
      maxUsers: row.maxUsers,
      monthlyGib: row.monthlyGib,
      historyDays: row.historyDays,
    },
    franchiseGbPerDay: row.franchiseGbPerDay,
  });
}

function sameAs(row: TenantPlanRow, plan: TenantPlan): boolean {
  return (
    row.planId === plan.planId &&
    row.franchiseGbPerDay === plan.franchiseGbPerDay &&
    PLAN_LIMIT_KEYS.every((key) => row[key] === plan.limits[key])
  );
}

/**
 * Grava o plano de um cliente (CE-02). É a única escrita de `TenantPlan` da aplicação (o meta-teste confere): o
 * `node.conf` do nó dedicado, pelo `TenantPlanResolver`, e, na célula, o comando do plano de controle (CE-05). `db` é
 * o cliente base ou uma transação, nunca o escopo de um cliente (que recusa a gravação). O plano é conferido antes: um
 * plano que não vale não chega ao banco (e o CHECK dele repete a regra).
 */
export async function writeTenantPlan(
  db: Prisma.TransactionClient,
  tenantId: string,
  plan: TenantPlan,
  source: TenantPlanSource,
): Promise<void> {
  const valid = parseTenantPlan(plan);
  const data = {
    planId: valid.planId,
    ...valid.limits,
    franchiseGbPerDay: valid.franchiseGbPerDay,
    source,
  };
  await db.tenantPlan.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
}

/** Lê o plano gravado de um cliente (null sem linha). */
export async function readTenantPlan(
  db: Prisma.TransactionClient,
  tenantId: string,
): Promise<TenantPlan | null> {
  const row = await db.tenantPlan.findUnique({ where: { tenantId }, select: TENANT_PLAN_SELECT });
  return row === null ? null : tenantPlanOfRow(row);
}

function isMissingTenant(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

/** O cliente base do Prisma conecta e desconecta; a transação, não (`$connect` fica fora do `TransactionClient`). */
function isBaseClient(db: Prisma.TransactionClient): boolean {
  return typeof (db as { $connect?: unknown }).$connect === 'function';
}

/**
 * O plano de cada cliente (CE-02), lido pelas vagas, pelo histórico das telas, pelo expurgo e pelos avisos de volume.
 *
 * - **Nó dedicado** (`NODE_MODE=dedicated`, o padrão): o `node.conf` continua sendo a fonte. Na primeira leitura de
 *   cada cliente no processo, a linha `TenantPlan` dele é semeada do ambiente (gravada se falta ou se difere, com
 *   `source = env`), e a leitura devolve o plano do ambiente: trocar o `node.conf` e reiniciar continua trocando o
 *   plano, como antes. A semeadura não entra na auditoria: o que muda o plano é o `node.conf`, não o nó.
 * - **Célula** (`NODE_MODE=cell`): vale a linha gravada pelo plano de controle; sem ela, `null` (cliente sem plano), e
 *   quem lê decide o lado seguro (nenhuma vaga, o menor histórico, nenhum expurgo, nenhum aviso).
 *
 * `db` é a transação da requisição de escrita, quando houver (a semeadura entra nela e enxerga um cliente criado na
 * mesma transação); sem ela, o cliente base. A memória de "já semeado" só vale para o cliente base, porque uma
 * transação pode ser desfeita.
 */
export class TenantPlanResolver implements TenantPlans {
  private readonly seeded = new Set<string>();

  constructor(
    private readonly base: Prisma.TransactionClient,
    readonly mode: NodeMode,
    /** O plano do ambiente (`nodePlan(config)`): o de todo cliente no nó dedicado; na célula, não é usado. */
    private readonly envPlan: ResolvedPlan,
  ) {}

  async planOf(tenantId: string, db: Prisma.TransactionClient = this.base): Promise<ResolvedPlan | null> {
    if (this.mode === 'dedicated') {
      if (!this.seeded.has(tenantId)) {
        await this.seed(db, tenantId);
        if (isBaseClient(db)) this.seeded.add(tenantId);
      }
      return this.envPlan;
    }
    const plan = await readTenantPlan(db, tenantId);
    return plan === null ? null : resolvedPlanOf(plan);
  }

  /**
   * O histórico que vale sem cliente escolhido (a equipe da Verax sem cliente na sessão): no nó dedicado, o do
   * ambiente; na célula, o menor entre os planos gravados (a visão de todos não promete mais do que o cliente que
   * guarda menos), e o piso dos planos se nenhum tiver linha ainda. `null` é sem limite.
   */
  async historyDaysWithoutTenant(db: Prisma.TransactionClient = this.base): Promise<number | null> {
    if (this.mode === 'dedicated') return this.envPlan.limits.historyDays;
    const rows = await db.tenantPlan.findMany({ select: { historyDays: true } });
    if (rows.length === 0) return PLAN_LIMIT_BOUNDS.historyDays.min;
    const limited = rows.flatMap((row) => (row.historyDays === null ? [] : [row.historyDays]));
    return limited.length === 0 ? null : Math.min(...limited);
  }

  /** Semeia a linha do cliente com o plano do ambiente, se ela falta ou difere (nó dedicado). */
  private async seed(db: Prisma.TransactionClient, tenantId: string): Promise<void> {
    const want = tenantPlanFromResolved(this.envPlan);
    const row = await db.tenantPlan.findUnique({ where: { tenantId }, select: TENANT_PLAN_SELECT });
    if (row !== null && row.source === 'env' && sameAs(row, want)) return;
    try {
      await writeTenantPlan(db, tenantId, want, 'env');
    } catch (error) {
      // O cliente não existe (ou saiu no meio): não há o que semear, e o plano do ambiente vale do mesmo jeito. Numa
      // transação, o erro a deixaria abortada: ali ele sobe (e lá o cliente sempre existe, na mesma transação).
      if (!isMissingTenant(error) || !isBaseClient(db)) throw error;
    }
  }
}

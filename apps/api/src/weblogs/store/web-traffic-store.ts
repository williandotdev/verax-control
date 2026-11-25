import type { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { MINUTE_MS, SLOT_MS } from '../limits.js';
import { TRAFFIC_COUNTERS, type TrafficClass, type TrafficCounter, type TrafficDelta } from '../traffic.js';

export {
  TRAFFIC_CLASSES,
  TRAFFIC_COUNTERS,
  type TrafficClass,
  trafficClassOf,
  type TrafficCounter,
  type TrafficDelta,
  UNKNOWN_COUNTRY,
} from '../traffic.js';

/**
 * O tráfego por país de cada balanceador (o mapa): contagens por intervalo de 5 minutos (`WebTrafficSlot`, 48 h) e por hora
 * (`WebTrafficHour`, até 35 dias). Nunca IP, caminho nem host: só o país, a classe do cliente e os números.
 *
 * **Cada requisição conta uma vez.** A soma de um objeto (`add`) é feita na transação que grava a linha dele no registro
 * (`web-object-ledger.ts`): o objeto relido acha a linha e não soma, e a transação desfeita desfaz as duas.
 *
 * **Cada contagem está num lugar só.** A passagem para as horas (`rollup`) apaga as linhas de 5 minutos e soma na hora na
 * mesma instrução: parar no meio não perde nem dobra, e rodar de novo não acha o que já passou. O objeto que chega depois
 * de a hora dele ter passado cria linhas novas de 5 minutos, que passam na vez seguinte. Por isso a leitura (`byCountry`)
 * soma as duas tabelas numa instrução só, sem marca d'água nem relógio: o total não muda durante a passagem.
 *
 * Quem chama escolhe o cliente: o worker, o da fonte; a API, o da sessão. Nenhum método aceita um id vindo do request.
 * Quem soma e passa para as horas é a tarefa `web-logs` (`collect/web-logs-job.ts`); quem lê é a rota do mapa (`map/`).
 */

/** Quanto ficam os intervalos de 5 minutos, antes de passarem para as horas. */
export const TRAFFIC_SLOT_RETENTION_MS = 48 * 60 * MINUTE_MS;
export const TRAFFIC_HOUR_RETENTION_DAYS = 35;

const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Linhas por comando. */
const CHUNK = 1_000;

export interface CountryTraffic extends Record<TrafficCounter, bigint> {
  country: string;
  clientClass: TrafficClass;
}

const isCountry = (text: string): boolean =>
  text.length === 2 && [text.charCodeAt(0), text.charCodeAt(1)].every((code) => code >= 65 && code <= 90);

function assertDelta(delta: TrafficDelta): void {
  // A data inválida (NaN) também não dá zero.
  if (delta.slotStart.getTime() % SLOT_MS !== 0) {
    throw new RangeError('o intervalo do tráfego precisa estar alinhado em 5 minutos');
  }
  if (!isCountry(delta.country)) throw new RangeError('país fora do formato de duas letras');
  for (const counter of TRAFFIC_COUNTERS) {
    const value = delta[counter];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError('a contagem do tráfego deve ser um inteiro não negativo');
    }
  }
}

/** Uma linha por chave (o comando não pode tocar a mesma duas vezes), na ordem da chave (dois comandos não se travam). */
function merge(deltas: readonly TrafficDelta[]): TrafficDelta[] {
  const rows = new Map<string, TrafficDelta>();
  for (const delta of deltas) {
    assertDelta(delta);
    if (TRAFFIC_COUNTERS.every((counter) => delta[counter] === 0)) continue;
    const { tenantId, sourceId, slotStart, country, clientClass } = delta;
    const key = [tenantId, sourceId, slotStart.toISOString(), country, clientClass].join('|');
    const held = rows.get(key);
    if (held === undefined) {
      rows.set(key, { ...delta });
      continue;
    }
    for (const counter of TRAFFIC_COUNTERS) held[counter] += delta[counter];
  }
  return [...rows].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row);
}

const floorTo = (at: Date, step: number): Date => new Date(Math.floor(at.getTime() / step) * step);
const ceilTo = (at: Date, step: number): Date => new Date(Math.ceil(at.getTime() / step) * step);

/** Os intervalos antes disto passam para as horas: só horas inteiras com mais de 48 h. */
export function trafficSlotCutoff(now: Date): Date {
  return floorTo(new Date(now.getTime() - TRAFFIC_SLOT_RETENTION_MS), HOUR_MS);
}

/** As horas antes disto saem (o próprio corte fica). */
export function trafficHourCutoff(now: Date): Date {
  return new Date(now.getTime() - TRAFFIC_HOUR_RETENTION_DAYS * DAY_MS);
}

export class WebTrafficStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Soma as contagens, na transação do chamador: a que gravou a linha do objeto no registro, e só se ela é nova
   * (`settleWebLogObject`). Chamado fora dela, o objeto relido somaria de novo.
   */
  async add(tx: Prisma.TransactionClient, deltas: readonly TrafficDelta[]): Promise<void> {
    const rows = merge(deltas);
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const counts = (counter: TrafficCounter): string[] => chunk.map((row) => String(row[counter]));
      await tx.$executeRaw`
        INSERT INTO "WebTrafficSlot" AS held (
          "tenantId", "sourceId", "slotStart", "country", "clientClass",
          "requests", "blocked", "clientErrors", "serverErrors", "flagged"
        )
        SELECT * FROM unnest(
          ${chunk.map((row) => row.tenantId)}::uuid[],
          ${chunk.map((row) => row.sourceId)}::uuid[],
          ${chunk.map((row) => row.slotStart.toISOString())}::timestamptz[],
          ${chunk.map((row) => row.country)}::text[],
          ${chunk.map((row) => row.clientClass)}::text[],
          ${counts('requests')}::bigint[],
          ${counts('blocked')}::bigint[],
          ${counts('clientErrors')}::bigint[],
          ${counts('serverErrors')}::bigint[],
          ${counts('flagged')}::bigint[]
        )
        ON CONFLICT ("tenantId", "sourceId", "slotStart", "country", "clientClass") DO UPDATE SET
          "requests" = held."requests" + EXCLUDED."requests",
          "blocked" = held."blocked" + EXCLUDED."blocked",
          "clientErrors" = held."clientErrors" + EXCLUDED."clientErrors",
          "serverErrors" = held."serverErrors" + EXCLUDED."serverErrors",
          "flagged" = held."flagged" + EXCLUDED."flagged"`;
    }
  }

  /** O balanceador e a hora mais antigos ainda por passar para as horas, ou null. */
  async nextToRollup(
    tenantId: string,
    cutoff: Date,
  ): Promise<{ tenantId: string; sourceId: string; hour: Date } | null> {
    const oldest = await this.prisma.webTrafficSlot.findFirst({
      where: { tenantId, slotStart: { lt: cutoff } },
      orderBy: { slotStart: 'asc' },
      select: { sourceId: true, slotStart: true },
    });
    if (oldest === null) return null;
    return { tenantId, sourceId: oldest.sourceId, hour: floorTo(oldest.slotStart, HOUR_MS) };
  }

  /**
   * Passa uma hora de um balanceador para as horas, numa instrução: apaga as linhas de 5 minutos e soma o que apagou.
   * Duas passagens ao mesmo tempo não dobram (cada linha é apagada por uma só), e a soma que chega no meio ou entra nesta
   * ou fica para a próxima. Devolve quantas linhas passaram.
   */
  async rollupHour(target: { tenantId: string; sourceId: string; hour: Date }): Promise<number> {
    const { tenantId, sourceId, hour } = target;
    const end = new Date(hour.getTime() + HOUR_MS);
    const rows = await this.prisma.$queryRaw<{ moved: number }[]>`
      WITH moved AS (
        DELETE FROM "WebTrafficSlot"
        WHERE "tenantId" = ${tenantId}::uuid AND "sourceId" = ${sourceId}::uuid
          AND "slotStart" >= ${hour}::timestamptz AND "slotStart" < ${end}::timestamptz
        RETURNING *
      ), summed AS (
        INSERT INTO "WebTrafficHour" AS held (
          "tenantId", "sourceId", "hourStart", "country", "clientClass",
          "requests", "blocked", "clientErrors", "serverErrors", "flagged"
        )
        SELECT "tenantId", "sourceId", ${hour}::timestamptz, "country", "clientClass",
          sum("requests")::bigint, sum("blocked")::bigint, sum("clientErrors")::bigint,
          sum("serverErrors")::bigint, sum("flagged")::bigint
        FROM moved
        GROUP BY "tenantId", "sourceId", "country", "clientClass"
        ORDER BY "country", "clientClass"
        ON CONFLICT ("tenantId", "sourceId", "hourStart", "country", "clientClass") DO UPDATE SET
          "requests" = held."requests" + EXCLUDED."requests",
          "blocked" = held."blocked" + EXCLUDED."blocked",
          "clientErrors" = held."clientErrors" + EXCLUDED."clientErrors",
          "serverErrors" = held."serverErrors" + EXCLUDED."serverErrors",
          "flagged" = held."flagged" + EXCLUDED."flagged"
      )
      SELECT count(*)::int AS moved FROM moved`;
    return rows[0]?.moved ?? 0;
  }

  /** Passa para as horas tudo o que tem mais de 48 h (a tarefa `web-logs` chama de hora em hora; o expurgo diário faz o mesmo em lotes). */
  async rollup(now: Date, tenantIds?: readonly string[], signal?: AbortSignal): Promise<number> {
    const cutoff = trafficSlotCutoff(now);
    let moved = 0;
    for (const tenantId of await this.tenants(tenantIds)) {
      for (;;) {
        signal?.throwIfAborted();
        const target = await this.nextToRollup(tenantId, cutoff);
        if (target === null) break;
        const count = await this.rollupHour(target);
        moved += count;
        // Outra passagem levou a mesma hora: a busca seguinte já não a acha.
      }
    }
    return moved;
  }

  /** A hora mais antiga, de um balanceador, que já passou dos 35 dias, ou null. */
  async nextToPurge(
    tenantId: string,
    cutoff: Date,
  ): Promise<{ tenantId: string; sourceId: string; hour: Date } | null> {
    const oldest = await this.prisma.webTrafficHour.findFirst({
      where: { tenantId, hourStart: { lt: cutoff } },
      orderBy: { hourStart: 'asc' },
      select: { sourceId: true, hourStart: true },
    });
    return oldest === null ? null : { tenantId, sourceId: oldest.sourceId, hour: oldest.hourStart };
  }

  async purgeHour(target: { tenantId: string; sourceId: string; hour: Date }): Promise<number> {
    const { tenantId, sourceId, hour } = target;
    return (await this.prisma.webTrafficHour.deleteMany({ where: { tenantId, sourceId, hourStart: hour } }))
      .count;
  }

  /** Apaga as horas com mais de 35 dias. */
  async purge(now: Date, tenantIds?: readonly string[], signal?: AbortSignal): Promise<number> {
    const cutoff = trafficHourCutoff(now);
    let deleted = 0;
    for (const tenantId of await this.tenants(tenantIds)) {
      for (;;) {
        signal?.throwIfAborted();
        const target = await this.nextToPurge(tenantId, cutoff);
        if (target === null) break;
        deleted += await this.purgeHour(target);
      }
    }
    return deleted;
  }

  private async tenants(tenantIds: readonly string[] | undefined): Promise<readonly string[]> {
    if (tenantIds !== undefined) return tenantIds;
    // Busca de sistema, entre todos os clientes do nó.
    const rows = await this.prisma.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    return rows.map((row) => row.id);
  }

  /**
   * O tráfego do cliente por país e classe, de `from` (inclusive) a `to` (exclusive), do maior para o menor. Até 48 h atrás
   * a resolução é de 5 minutos; antes disso, só entram as horas inteiras dentro do intervalo: a hora cortada por uma das
   * pontas somaria o que está fora dele. As duas tabelas são lidas numa instrução (um retrato só): a passagem para as
   * horas no meio da leitura não some com nada nem conta duas vezes.
   *
   * `tenantId` é o da sessão (`prisma.scopeTenantId()`) ou o da tarefa, nunca um vindo do request.
   */
  async byCountry(tenantId: string, from: Date, to: Date): Promise<CountryTraffic[]> {
    const fromHour = ceilTo(from, HOUR_MS);
    const toHour = floorTo(to, HOUR_MS);
    // Cada tabela é somada antes da união: o banco sabe quantos países há em cada uma e agrega na memória. Somar só depois
    // dela ordenava as linhas todas em disco (dez vezes mais, no pior caso de 24 h).
    return this.prisma.db().$queryRaw<CountryTraffic[]>`
      SELECT "country", "clientClass",
        sum("requests")::bigint AS "requests", sum("blocked")::bigint AS "blocked",
        sum("clientErrors")::bigint AS "clientErrors", sum("serverErrors")::bigint AS "serverErrors",
        sum("flagged")::bigint AS "flagged"
      FROM (
        SELECT "country", "clientClass", sum("requests") AS "requests", sum("blocked") AS "blocked",
          sum("clientErrors") AS "clientErrors", sum("serverErrors") AS "serverErrors", sum("flagged") AS "flagged"
        FROM "WebTrafficSlot"
        WHERE "tenantId" = ${tenantId}::uuid
          AND "slotStart" >= ${from}::timestamptz AND "slotStart" < ${to}::timestamptz
        GROUP BY "country", "clientClass"
        UNION ALL
        SELECT "country", "clientClass", sum("requests"), sum("blocked"), sum("clientErrors"), sum("serverErrors"),
          sum("flagged")
        FROM "WebTrafficHour"
        WHERE "tenantId" = ${tenantId}::uuid
          AND "hourStart" >= ${fromHour}::timestamptz AND "hourStart" < ${toHour}::timestamptz
        GROUP BY "country", "clientClass"
      ) AS traffic
      GROUP BY "country", "clientClass"
      ORDER BY sum("requests") DESC, "country", "clientClass"`;
  }
}

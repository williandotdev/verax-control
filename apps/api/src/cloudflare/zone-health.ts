import { randomUUID } from 'node:crypto';
import type { CloudflareZoneState } from '@verax/shared';
import { errorKind } from '../common/logger/error-kind.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';

/**
 * A última leitura gravada de uma zona só anda depois disto: as janelas são de 15 min, e recuperar o atraso (várias
 * leituras seguidas) não grava a cada execução.
 */
export const ZONE_READ_REFRESH_MS = 10 * 60 * 1000;
/** A zona que nada mudou é regravada uma vez por dia, só pela data em que ainda apareceu na conta. */
export const ZONE_SEEN_REFRESH_MS = 24 * 60 * 60 * 1000;
/** Linhas guardadas por conta, com as que sumiram: além disto, uma zona nova não ganha linha. */
export const ZONE_HEALTH_MAX_ROWS = 2_000;
const PLAN_MAX = 64;

/** O que o worker loga da saúde das zonas (o pino; um dublê nos testes): só ids do banco, contagens e códigos. */
export interface ZoneHealthLogger {
  warn(fields: object, message: string): void;
}

/** A conta cujas zonas foram vistas. */
export interface ZoneHealthAccount {
  id: string;
  tenantId: string;
}

/** A lista das zonas da conta, como o coletor a leu e dividiu. */
export interface ZoneListing {
  /** Todas as zonas da conta, pelo ID, com o nome. */
  ids: ReadonlyMap<string, string>;
  plans: ReadonlyMap<string, string>;
  /** Lida inteira: só então a ausência de uma zona está provada. */
  complete: boolean;
  /** As que serão lidas. */
  selected: readonly string[];
  /** As que a conta pede e ficaram além do máximo. */
  overLimit: readonly string[];
}

type Access = 'usable' | 'not_entitled' | 'forbidden';

interface Seen {
  name: string;
  plan: string | null;
  place: 'selected' | 'over_limit' | 'not_monitored';
  access: Access | null;
  readAt: Date | null;
  error: string | null;
}

/** Uma linha guardada. */
interface Stored {
  zoneId: string;
  name: string;
  plan: string | null;
  state: string;
  lastReadAt: Date | null;
  lastErrorCode: string | null;
  lastSeenAt: Date;
  missingSince: Date | null;
}

/**
 * O que uma leitura dos eventos de segurança viu de cada zona, só em memória: quem lê anota de passagem, e nada aqui
 * consulta, grava ou falha. A gravação é depois, à parte (`ZoneHealth`).
 */
export class ZoneObserver {
  private readonly zones = new Map<string, Seen>();
  private listing: ZoneListing | null = null;
  private listError: string | null = null;
  private inFlight: readonly string[] = [];

  listed(listing: ZoneListing): void {
    this.listing = listing;
    const selected = new Set(listing.selected);
    const overLimit = new Set(listing.overLimit);
    for (const [tag, name] of listing.ids) {
      this.zones.set(tag, {
        name,
        plan: planText(listing.plans.get(tag)),
        place: selected.has(tag) ? 'selected' : overLimit.has(tag) ? 'over_limit' : 'not_monitored',
        access: null,
        readAt: null,
        error: null,
      });
    }
  }

  /** As zonas do pedido em curso: a falha dele é delas. */
  asking(tags: readonly string[]): void {
    this.inFlight = tags;
  }

  /** O que o plano e a permissão dão em cada zona lida dos limites. */
  access(tag: string, access: Access): void {
    const zone = this.zones.get(tag);
    if (zone !== undefined) zone.access = access;
  }

  /** Uma janela inteira destas zonas foi lida e gravada. */
  read(tags: readonly string[], at: Date): void {
    this.inFlight = [];
    for (const tag of tags) {
      const zone = this.zones.get(tag);
      if (zone !== undefined) zone.readAt = at;
    }
  }

  /** O pedido em curso terminou sem leitura (a janela fora da retenção, o orçamento): não é falha das zonas. */
  idle(): void {
    this.inFlight = [];
  }

  /** A falha da origem que terminou a leitura: da lista de zonas ou do pedido em curso. */
  failed(code: string): void {
    // O limite de requisições é do acesso inteiro, e a espera dele aparece na conta.
    if (code === 'rate_limited') {
      this.inFlight = [];
      return;
    }
    if (this.listing === null) this.listError = code;
    for (const tag of this.inFlight) {
      const zone = this.zones.get(tag);
      if (zone !== undefined) zone.error = code;
    }
    this.inFlight = [];
  }

  /** Nada foi visto: nada a gravar. */
  get empty(): boolean {
    return this.listing === null && this.listError === null;
  }

  /** As linhas que mudaram em relação às guardadas. */
  changes(stored: readonly Stored[], now: Date): { rows: ZoneRow[]; dropped: number } {
    const before = new Map(stored.map((row) => [row.zoneId, row]));
    const rows: ZoneRow[] = [];
    let dropped = 0;
    if (this.listing === null) {
      // A lista não veio: as que eram lidas guardam o motivo, e o resto fica como estava.
      const code = this.listError;
      if (code === null) return { rows, dropped };
      for (const row of stored) {
        if (!READABLE.has(row.state) || row.lastErrorCode === code) continue;
        rows.push({ ...row, lastErrorCode: code });
      }
      return { rows, dropped };
    }
    let room = ZONE_HEALTH_MAX_ROWS - stored.length;
    for (const [zoneId, zone] of this.zones) {
      const previous = before.get(zoneId);
      if (previous === undefined) {
        if (room <= 0) {
          dropped += 1;
          continue;
        }
        room -= 1;
      }
      const row = nextRow(zoneId, zone, previous, now);
      if (previous === undefined || differs(row, previous, zone, now)) rows.push(row);
    }
    if (this.listing.complete) {
      for (const row of stored) {
        if (row.state === 'missing' || this.zones.has(row.zoneId)) continue;
        rows.push({ ...row, state: 'missing', missingSince: now, lastErrorCode: null });
      }
    }
    return { rows, dropped };
  }
}

/** As situações em que a zona está sendo lida (ou vai ser): só elas guardam o erro da leitura. */
const READABLE: ReadonlySet<string> = new Set<CloudflareZoneState>(['reading', 'pending']);

/** A linha a gravar. */
type ZoneRow = Stored;

function stateOf(zone: Seen, previous: Stored | undefined): CloudflareZoneState {
  if (zone.place !== 'selected') return zone.place;
  if (zone.access === 'not_entitled' || zone.access === 'forbidden') return zone.access;
  if (zone.readAt !== null) return 'reading';
  // Sem leitura nesta execução: a que era lida continua; a que não tinha acesso também, até os limites dizerem outra coisa.
  if (previous?.state === 'reading') return 'reading';
  if (zone.access === null && (previous?.state === 'not_entitled' || previous?.state === 'forbidden')) {
    return previous.state;
  }
  return 'pending';
}

function nextRow(zoneId: string, zone: Seen, previous: Stored | undefined, now: Date): ZoneRow {
  const state = stateOf(zone, previous);
  const kept = zone.readAt === null ? (previous?.lastErrorCode ?? null) : null;
  return {
    zoneId,
    name: zone.name,
    plan: zone.plan ?? previous?.plan ?? null,
    state,
    lastReadAt: zone.readAt ?? previous?.lastReadAt ?? null,
    lastErrorCode: READABLE.has(state) ? (zone.error ?? kept) : null,
    lastSeenAt: now,
    missingSince: null,
  };
}

/** Vale gravar? O que não mudou espera: a leitura, dez minutos; a data em que foi vista, um dia. */
function differs(row: ZoneRow, previous: Stored, zone: Seen, now: Date): boolean {
  if (
    row.state !== previous.state ||
    row.name !== previous.name ||
    row.plan !== previous.plan ||
    row.lastErrorCode !== previous.lastErrorCode
  ) {
    return true;
  }
  if (zone.readAt !== null) {
    const last = previous.lastReadAt;
    if (last === null || zone.readAt.getTime() - last.getTime() >= ZONE_READ_REFRESH_MS) return true;
  }
  return now.getTime() - previous.lastSeenAt.getTime() >= ZONE_SEEN_REFRESH_MS;
}

function planText(value: string | undefined): string | null {
  const text = [...(value ?? '')]
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('')
    .trim()
    .slice(0, PLAN_MAX);
  return text === '' ? null : text;
}

/**
 * A saúde das zonas de cada conta do Cloudflare (`CloudflareZone`), gravada pelo worker depois da leitura dos eventos de
 * segurança, para a conta por OAuth e para a com token colado. Não faz parte da coleta:
 * - a gravação roda à parte, sem segurar a leitura das contas seguintes, e é limitada no banco (o lock e o comando);
 * - uma falha dela vai só ao log, por código, e as outras gravações da execução são deixadas para a próxima;
 * - nenhuma consulta a mais no Cloudflare: só o que o coletor já leu.
 *
 * Grava num comando só as linhas que mudaram. A zona que some da conta fica, com a data. A auditoria não passa por aqui:
 * ela é por conta, e a saúde dela é o próprio cursor.
 */
export class ZoneHealth {
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: ZoneHealthLogger | null,
  ) {}

  /** Começo de uma execução do coletor. */
  begin(): void {
    this.stopped = false;
    this.queue = Promise.resolve();
  }

  /** Põe a gravação na fila, sem esperar por ela. */
  save(account: ZoneHealthAccount, observer: ZoneObserver, now: Date): void {
    if (observer.empty || this.stopped) return;
    this.queue = this.queue.then(() => this.write(account, observer, now));
  }

  /** Fim da execução: espera o que ficou na fila. Nunca lança. */
  async settle(): Promise<void> {
    await this.queue;
  }

  private async write(account: ZoneHealthAccount, observer: ZoneObserver, now: Date): Promise<void> {
    if (this.stopped) return;
    try {
      const dropped = await this.store(account, observer, now);
      if (dropped > 0) {
        this.logger?.warn(
          { cloudAccountId: account.id, code: 'zone_health_full', dropped },
          'saúde das zonas do Cloudflare: zonas demais para guardar',
        );
      }
    } catch (error) {
      this.stopped = true;
      this.logger?.warn(
        { cloudAccountId: account.id, code: errorKind(error) },
        'saúde das zonas do Cloudflare não gravada',
      );
    }
  }

  private store({ id, tenantId }: ZoneHealthAccount, observer: ZoneObserver, now: Date): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
        await tx.$executeRaw`SET LOCAL statement_timeout = '3s'`;
        const stored = await tx.cloudflareZone.findMany({
          where: { cloudAccountId: id, tenantId },
          select: {
            zoneId: true,
            name: true,
            plan: true,
            state: true,
            lastReadAt: true,
            lastErrorCode: true,
            lastSeenAt: true,
            missingSince: true,
          },
        });
        const { rows, dropped } = observer.changes(stored, now);
        if (rows.length === 0) return dropped;
        const data = JSON.stringify(rows.map((row) => ({ ...row, id: randomUUID() })));
        // Um comando só, com as linhas num parâmetro JSON; a chave (conta e zona) decide entre criar e atualizar.
        await tx.$executeRaw`
          INSERT INTO "CloudflareZone" (
            "id", "tenantId", "cloudAccountId", "zoneId", "name", "plan", "state", "lastReadAt", "lastErrorCode",
            "firstSeenAt", "lastSeenAt", "missingSince", "createdAt", "updatedAt"
          )
          SELECT
            r."id", ${tenantId}::uuid, ${id}::uuid, r."zoneId", r."name", r."plan", r."state", r."lastReadAt",
            r."lastErrorCode", ${now}::timestamptz, r."lastSeenAt", r."missingSince", now(), now()
          FROM jsonb_to_recordset(${data}::jsonb) AS r(
            "id" uuid, "zoneId" text, "name" text, "plan" text, "state" text, "lastReadAt" timestamptz,
            "lastErrorCode" text, "lastSeenAt" timestamptz, "missingSince" timestamptz
          )
          ON CONFLICT ("cloudAccountId", "zoneId") DO UPDATE SET
            "name" = EXCLUDED."name",
            "plan" = EXCLUDED."plan",
            "state" = EXCLUDED."state",
            "lastReadAt" = EXCLUDED."lastReadAt",
            "lastErrorCode" = EXCLUDED."lastErrorCode",
            "lastSeenAt" = EXCLUDED."lastSeenAt",
            "missingSince" = EXCLUDED."missingSince",
            "updatedAt" = now()
          WHERE "CloudflareZone"."tenantId" = EXCLUDED."tenantId"`;
        return dropped;
      },
      { maxWait: 1_000, timeout: 5_000 },
    );
  }
}

import { createHash } from 'node:crypto';
import { addDays, brasiliaDay, dayAsDate, dayOfDate } from '@verax/shared';
import type { WebIdentityCredentials } from '../aws/web-identity.js';
import type { NodeMode } from '../common/config/env.schema.js';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { type CollectorCursor, CollectorCursors, type CursorKey } from '../collectors/collector-cursor.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { AwsCredentialIdentity } from '../inventory/read-only-session.js';
import { COLLECTING_TENANT } from '../tenants/tenant-status.js';
import { UsageMeter } from './usage-meter.js';

/**
 * Medição do volume da AWS na origem (CE-09, célula compartilhada): a tarefa `aws-volume` do worker. Na célula, um
 * `analysisd` lê os logs de todos os clientes e não separa o que leu por cliente; o volume de cada cliente é medido nos
 * buckets dele, com a identidade dele.
 *
 * Para cada conta AWS ativa já verificada (`meteredFrom`, o instante da primeira verificação bem-sucedida), de cliente
 * `active`, e cada bucket cadastrado:
 * 1. lista, com `ListObjectsV2`, as pastas de dia da conta, só nos prefixos dela: `AWSLogs/<conta>/CloudTrail/<região>/`
 *    (e `AWSLogs/<organização>/<conta>/…` da trilha de organização), `AWSLogs/<conta>/GuardDuty/<região>/` e
 *    `AWSLogs/<conta>/WAFLogs/<região>/<web ACL>/` (com `cloudfront` além das regiões monitoradas). As pastas são do
 *    dia em UTC; cada execução relê a pasta da véspera do cursor, para o objeto que chega atrasado;
 * 2. para cada objeto ainda não medido (`AwsVolumeObject`, pelo hash do bucket e da chave) e criado a partir do
 *    `meteredFrom` (o histórico anterior à primeira verificação nunca é cobrado), lê os 4 últimos bytes
 *    (`GetObject`, `Range: bytes=-4`): o ISIZE do gzip, o tamanho descompactado dos arquivos de um membro só que a AWS
 *    grava. Fora da faixa possível (menor que o compactado, ou mais de 1032 vezes ele, o máximo do deflate), conta o
 *    compactado vezes `ISIZE_FALLBACK_RATIO` e marca `isizeFallback`. Objeto sem `.gz` conta o próprio tamanho;
 * 3. grava o objeto no registro, no dia de Brasília do `LastModified` (o dia em que o log foi criado: uma parada do nó
 *    e a leitura atrasada não mudam o dia), soma o objeto novo ao mês do cliente (`IngestUsage`, no mês de criação) e
 *    regrava o total de cada dia relido (`IngestUsageDay`, fonte `aws`): a soma do registro, um valor absoluto. Nenhum
 *    objeto conta duas vezes, mesmo com duas execuções ao mesmo tempo (a chave do registro).
 *
 * O cursor de cada fluxo e região (`CollectorCursor`, `aws_volume_<fluxo>`) guarda o último dia UTC lido inteiro, e a
 * próxima leitura (uma vez por hora; logo, enquanto houver atraso a recuperar, até 7 dias por execução e
 * `MAX_GETS_PER_CURSOR` leituras de objeto). Uma falha da AWS marca o cursor com o tipo do erro e o recuo.
 *
 * **A identidade de cada cliente** (`TenantAwsIdentity`) é a do CE-11: na célula, cada cliente entra no papel dele com a
 * conta de serviço dele. Até o CE-11, a célula não tem identidade de cliente nenhum (`pendingCellIdentity`): a tarefa
 * não chama a AWS e conta as contas em `identityUnavailable`. O nó dedicado tem a identidade do nó
 * (`nodeTenantIdentity`), mas não roda esta tarefa: lá, o volume da AWS continua vindo do analysisd (`wazuh-usage.ts`).
 *
 * Os registros saem depois de 62 dias (dois ciclos): o total de cada dia fica no `IngestUsageDay`.
 * A leitura nunca volta mais de 60 dias (`MAX_LOOKBACK_DAYS`): o que é relido ainda está no registro, e nada é
 * cobrado duas vezes. Duas execuções ao mesmo tempo regravam o total do dia uma depois da outra (lock por cliente).
 */

export const AWS_VOLUME_TASK = 'aws-volume';
/** O passo da tarefa: cada cursor tem a própria hora de ler de novo. */
export const AWS_VOLUME_TICK_MS = 5 * 60_000;
/** Uma leitura por hora de cada cursor em dia. */
export const AWS_VOLUME_INTERVAL_MS = 60 * 60_000;
export const AWS_VOLUME_BUDGET_MS = 10 * 60_000;
/** Dias de pasta lidos por execução de um cursor atrasado (a recuperação segue na execução seguinte). */
export const MAX_DAYS_PER_CURSOR = 7;
/** Leituras de objeto (`GetObject` de 4 bytes) por execução de um cursor. */
export const MAX_GETS_PER_CURSOR = 2000;
/** Leituras de objeto ao mesmo tempo. */
const GET_CONCURRENCY = 8;
/** Os registros dos objetos ficam 62 dias (dois ciclos). */
export const VOLUME_OBJECT_RETENTION_DAYS = 62;
/**
 * Até onde a leitura das pastas volta, em dias UTC antes de hoje: dois dias dentro do prazo do registro. Um objeto de
 * uma pasta lida é sempre de um dia que o registro ainda guarda (a pasta do dia `d` só tem objetos criados a partir
 * das 21:00 de `d−1` em Brasília), então nada que o expurgo do registro apagou é lido, e cobrado, de novo. Um atraso
 * maior que isso (o nó parado por mais de dois meses) perde os dias mais antigos: a dúvida fica a favor do cliente.
 */
export const MAX_LOOKBACK_DAYS = VOLUME_OBJECT_RETENTION_DAYS - 2;
/** A razão máxima do deflate: um ISIZE acima de 1032 vezes o compactado é impossível. */
export const MAX_DEFLATE_RATIO = 1032;
/** A razão usada quando o ISIZE não serve (JSON de log compacta cerca de 10 vezes). */
export const ISIZE_FALLBACK_RATIO = 10;

/** Os fluxos medidos, o campo do bucket na conta e a pasta do serviço em `AWSLogs/<conta>/`. */
export const VOLUME_STREAMS = [
  { stream: 'cloudtrail', bucketField: 'cloudtrailBucket', service: 'CloudTrail' },
  { stream: 'guardduty', bucketField: 'guarddutyBucket', service: 'GuardDuty' },
  { stream: 'waf', bucketField: 'wafBucket', service: 'WAFLogs' },
] as const;
export type VolumeStream = (typeof VOLUME_STREAMS)[number]['stream'];

/** O cursor do fluxo: `aws_volume_cloudtrail`, `aws_volume_guardduty` ou `aws_volume_waf`. */
export function volumeCursorStream(stream: VolumeStream): string {
  return `aws_volume_${stream}`;
}

/** O WAF do CloudFront grava na "região" `cloudfront`. */
const WAF_GLOBAL_REGION = 'cloudfront';

// ---------------------------------------------------------------------------------------------------------------------
// Identidade de cada cliente (o CE-11 a liga na célula)
// ---------------------------------------------------------------------------------------------------------------------

/** As sessões no papel de leitura das contas de um cliente (`WebIdentityCredentials.credentialsFor`). */
export type AwsSessionSource = Pick<WebIdentityCredentials, 'credentialsFor'>;

/**
 * De onde vem a sessão no papel de leitura de cada cliente. A conta de um cliente nunca é lida com a identidade de
 * outro: quem implementa devolve a identidade do cliente pedido, ou null se o nó ainda não a tem.
 */
export interface TenantAwsIdentity {
  sessionsFor(tenantId: string): AwsSessionSource | null;
}

/** Nó dedicado: um cliente por nó, e a identidade é a do nó (o metadata da VM). */
export function nodeTenantIdentity(credentials: AwsSessionSource): TenantAwsIdentity {
  return { sessionsFor: () => credentials };
}

/**
 * Célula, até o CE-11: nenhum cliente tem identidade própria ainda, e a identidade da célula nunca serve para ler a
 * conta de um cliente (o confused deputy). Recusa todos.
 */
export function pendingCellIdentity(): TenantAwsIdentity {
  return { sessionsFor: () => null };
}

/** A identidade de cada cliente no modo do nó. Sem a identidade do nó (`NODE_SA_UNIQUE_ID`), ninguém tem. */
export function tenantAwsIdentityFor(mode: NodeMode, node: AwsSessionSource | null): TenantAwsIdentity {
  if (mode === 'cell' || node === null) return pendingCellIdentity();
  return nodeTenantIdentity(node);
}

// ---------------------------------------------------------------------------------------------------------------------
// O tamanho descompactado (ISIZE)
// ---------------------------------------------------------------------------------------------------------------------

export interface MeasuredSize {
  bytes: number;
  fallback: boolean;
}

/** A estimativa quando o ISIZE não serve. */
function fallbackSize(compressed: number): MeasuredSize {
  return { bytes: compressed * ISIZE_FALLBACK_RATIO, fallback: true };
}

/**
 * O tamanho descompactado de um objeto, pelos 4 últimos bytes (`tail`) e pelo tamanho compactado. O ISIZE é o tamanho
 * descompactado módulo 2³², em little-endian, no fim do gzip de um membro só. Objeto sem `.gz` conta o próprio
 * tamanho. Um ISIZE impossível (menor que o compactado, ou acima de 1032 vezes ele) ou não lido (`tail` com menos de
 * 4 bytes) vira a estimativa.
 */
export function decompressedSize(key: string, compressed: number, tail: Uint8Array | null): MeasuredSize {
  if (!key.endsWith('.gz')) return { bytes: compressed, fallback: false };
  if (compressed <= 0) return { bytes: 0, fallback: false };
  if (tail === null || tail.length < 4) return fallbackSize(compressed);
  const view = new DataView(tail.buffer, tail.byteOffset + tail.length - 4, 4);
  const isize = view.getUint32(0, true);
  if (isize < compressed || isize > compressed * MAX_DEFLATE_RATIO) return fallbackSize(compressed);
  return { bytes: isize, fallback: false };
}

/** O hash do objeto no registro: SHA-256 do bucket e da chave (a chave não fica guardada). */
export function objectHash(bucket: string, key: string): string {
  return createHash('sha256').update(`${bucket}\n${key}`, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------------------------------------------------
// O S3 que a tarefa usa (os testes trocam por um falso)
// ---------------------------------------------------------------------------------------------------------------------

export interface ListedObject {
  key: string;
  size: number;
  lastModified: Date;
}

export interface ListPage {
  objects: ListedObject[];
  /** As "pastas" com `delimiter`. */
  prefixes: string[];
  /** A continuação; null na última página. */
  next: string | null;
}

export interface VolumeS3 {
  list(
    input: { bucket: string; prefix: string; delimiter?: string; continuation?: string | null },
    signal: AbortSignal,
  ): Promise<ListPage>;
  /** Os últimos 4 bytes do objeto (o objeto inteiro, se menor). */
  tail(bucket: string, key: string, signal: AbortSignal): Promise<Uint8Array>;
  destroy?(): void;
}

/** O S3 da conta, com a sessão do papel (o SDK pede outra ao provedor quando ela vai vencer). */
export type VolumeS3Factory = (credentials: () => Promise<AwsCredentialIdentity>, region: string) => VolumeS3;

// ---------------------------------------------------------------------------------------------------------------------
// A tarefa
// ---------------------------------------------------------------------------------------------------------------------

/** Contagens de uma execução (vão para o log; nenhum dado de cliente). */
export interface AwsVolumeReport {
  accounts: number;
  /** Contas de cliente sem identidade no nó (na célula, todas até o CE-11): nada foi pedido à AWS. */
  identityUnavailable: number;
  cursors: number;
  failed: number;
  listed: number;
  counted: number;
  fallbacks: number;
  bytes: number;
  pruned: number;
}

export interface AwsVolumeLogger {
  warn(fields: object, message: string): void;
}

export interface AwsVolumeOptions {
  now?: () => Date;
  logger?: AwsVolumeLogger;
  /** Só os testes, que dividem o banco: restringe a tarefa às contas destes clientes. */
  tenantIds?: readonly string[];
  maxGetsPerCursor?: number;
}

const ACCOUNT_SELECT = {
  id: true,
  tenantId: true,
  accountId: true,
  regions: true,
  meteredFrom: true,
  cloudtrailBucket: true,
  guarddutyBucket: true,
  wafBucket: true,
} as const satisfies Prisma.CloudAccountSelect;
type AccountRow = Prisma.CloudAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>;

/** Uma leitura de um cursor: a conta, o fluxo, o bucket e a região. */
interface CursorRead {
  account: AccountRow & { meteredFrom: Date };
  stream: VolumeStream;
  service: string;
  bucket: string;
  region: string;
  key: CursorKey;
}

/** O dia UTC de um instante (a pasta da AWS é do dia UTC). */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayPath(day: string): string {
  return `${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8, 10)}/`;
}

class BudgetExhausted extends Error {
  constructor() {
    super('limite de leituras de objeto da execução');
    this.name = 'BudgetExhausted';
  }
}

export class AwsVolumeAudit {
  private readonly cursors: CollectorCursors;
  private readonly now: () => Date;
  private readonly logger: AwsVolumeLogger | undefined;
  private readonly tenantIds: readonly string[] | undefined;
  private readonly maxGets: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: TenantAwsIdentity,
    private readonly s3For: VolumeS3Factory,
    {
      now = () => new Date(),
      logger,
      tenantIds,
      maxGetsPerCursor = MAX_GETS_PER_CURSOR,
    }: AwsVolumeOptions = {},
  ) {
    this.cursors = new CollectorCursors(prisma);
    this.now = now;
    this.logger = logger;
    this.tenantIds = tenantIds;
    this.maxGets = maxGetsPerCursor;
  }

  async runOnce(signal: AbortSignal = new AbortController().signal): Promise<AwsVolumeReport> {
    const report: AwsVolumeReport = {
      accounts: 0,
      identityUnavailable: 0,
      cursors: 0,
      failed: 0,
      listed: 0,
      counted: 0,
      fallbacks: 0,
      bytes: 0,
      pruned: 0,
    };
    // Busca de sistema, entre todos os clientes do nó: as contas AWS verificadas, de cliente ativo, com bucket.
    const accounts = await this.prisma.cloudAccount.findMany({
      where: {
        provider: 'aws',
        status: 'active',
        ...COLLECTING_TENANT,
        meteredFrom: { not: null },
        OR: [
          { cloudtrailBucket: { not: null } },
          { guarddutyBucket: { not: null } },
          { wafBucket: { not: null } },
        ],
        ...(this.tenantIds !== undefined && { tenantId: { in: [...this.tenantIds] } }),
      },
      select: ACCOUNT_SELECT,
      orderBy: { id: 'asc' },
    });
    for (const row of accounts) {
      signal.throwIfAborted();
      if (row.meteredFrom === null) continue;
      const account = { ...row, meteredFrom: row.meteredFrom };
      report.accounts += 1;
      // A identidade é a do cliente da conta, nunca a de outro (nem a da célula).
      const sessions = this.identity.sessionsFor(account.tenantId);
      if (sessions === null) {
        report.identityUnavailable += 1;
        continue;
      }
      const home = account.regions[0];
      if (home === undefined) continue;
      const s3 = this.s3For(sessions.credentialsFor(account.accountId, home), home);
      try {
        for (const read of this.readsOf(account)) {
          signal.throwIfAborted();
          await this.runCursor(read, s3, report, signal);
        }
      } finally {
        s3.destroy?.();
      }
    }
    report.pruned = await this.prune();
    return report;
  }

  /** Os cursores da conta: cada fluxo com bucket, em cada região monitorada (o WAF também no `cloudfront`). */
  private readsOf(account: CursorRead['account']): CursorRead[] {
    const reads: CursorRead[] = [];
    for (const { stream, bucketField, service } of VOLUME_STREAMS) {
      const bucket = account[bucketField];
      if (bucket === null) continue;
      const regions = stream === 'waf' ? [...account.regions, WAF_GLOBAL_REGION] : account.regions;
      for (const region of new Set(regions)) {
        reads.push({
          account,
          stream,
          service,
          bucket,
          region,
          key: { cloudAccountId: account.id, stream: volumeCursorStream(stream), region },
        });
      }
    }
    return reads;
  }

  private async runCursor(read: CursorRead, s3: VolumeS3, report: AwsVolumeReport, signal: AbortSignal) {
    const now = this.now();
    const cursor = await this.cursors.read(read.key, now);
    if (cursor.nextRunAt.getTime() > now.getTime()) return;
    report.cursors += 1;
    const { from, to } = this.dayRange(cursor, read.account.meteredFrom, now);
    let lastComplete: string | null = null;
    const gets = { left: this.maxGets };
    try {
      const roots = await this.dayRoots(read, s3, signal);
      for (let day = from; day <= to; day = addDays(day, 1)) {
        for (const root of roots)
          await this.readDay(read, s3, `${root}${dayPath(day)}`, gets, report, signal);
        lastComplete = day;
      }
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof BudgetExhausted)) {
        report.failed += 1;
        this.logger?.warn(
          { stream: read.stream, kind: (error as Error).name },
          'medição da AWS na origem: a leitura do bucket falhou',
        );
        await this.recompute(read.account.tenantId, from, lastComplete ?? from);
        await this.cursors.fail(read.key, error, now);
        return;
      }
    }
    await this.recompute(read.account.tenantId, from, to);
    const caughtUp = lastComplete === to && to === utcDay(now);
    await this.cursors.advance(
      read.key,
      {
        ...(lastComplete !== null && { cursorAt: dayAsDate(lastComplete) }),
        continuation: null,
        // Em dia: a próxima leitura daqui a uma hora. Atrasado (ou no limite de leituras): já no próximo passo.
        nextRunAt: caughtUp ? new Date(now.getTime() + AWS_VOLUME_INTERVAL_MS) : now,
      },
      now,
    );
  }

  /**
   * Os dias UTC a ler: da véspera do último dia lido inteiro (o objeto que chega atrasado na pasta) até hoje, nunca
   * antes do dia do `meteredFrom` nem de `MAX_LOOKBACK_DAYS` atrás (o registro ainda guarda tudo o que é relido), e no
   * máximo `MAX_DAYS_PER_CURSOR` dias.
   */
  private dayRange(cursor: CollectorCursor, meteredFrom: Date, now: Date): { from: string; to: string } {
    const today = utcDay(now);
    const floor = addDays(today, -MAX_LOOKBACK_DAYS);
    const first = utcDay(meteredFrom);
    const resume = cursor.cursorAt === null ? first : addDays(dayOfDate(cursor.cursorAt), -1);
    const from = [first, resume, floor].reduce((latest, day) => (day > latest ? day : latest));
    const limit = addDays(from, MAX_DAYS_PER_CURSOR - 1);
    return { from, to: limit < today ? limit : today };
  }

  /**
   * As pastas do fluxo, antes do dia: `AWSLogs/<conta>/<serviço>/<região>/` e, no CloudTrail, a da trilha de
   * organização (`AWSLogs/<o-…>/<conta>/…`); no WAF, uma por web ACL.
   */
  private async dayRoots(read: CursorRead, s3: VolumeS3, signal: AbortSignal): Promise<string[]> {
    const accountId = read.account.accountId;
    const bases = [`AWSLogs/${accountId}/`];
    if (read.stream === 'cloudtrail') {
      const organizations = await this.folders(s3, read.bucket, 'AWSLogs/', signal);
      for (const folder of organizations) {
        if (/^AWSLogs\/o-[a-z0-9]{10,32}\/$/.test(folder)) bases.push(`${folder}${accountId}/`);
      }
    }
    const roots = bases.map((base) => `${base}${read.service}/${read.region}/`);
    if (read.stream !== 'waf') return roots;
    const acls: string[] = [];
    for (const root of roots) acls.push(...(await this.folders(s3, read.bucket, root, signal)));
    return acls;
  }

  /** As "pastas" logo abaixo do prefixo (até 5 páginas). */
  private async folders(
    s3: VolumeS3,
    bucket: string,
    prefix: string,
    signal: AbortSignal,
  ): Promise<string[]> {
    const folders: string[] = [];
    let continuation: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const listed = await s3.list({ bucket, prefix, delimiter: '/', continuation }, signal);
      folders.push(...listed.prefixes.filter((folder) => folder.startsWith(prefix)));
      continuation = listed.next;
      if (continuation === null) break;
    }
    return folders;
  }

  /** Uma pasta de dia: lista tudo, mede o que ainda não foi medido e grava, uma página por vez. */
  private async readDay(
    read: CursorRead,
    s3: VolumeS3,
    prefix: string,
    gets: { left: number },
    report: AwsVolumeReport,
    signal: AbortSignal,
  ): Promise<void> {
    let continuation: string | null = null;
    do {
      const page = await s3.list({ bucket: read.bucket, prefix, continuation }, signal);
      report.listed += page.objects.length;
      const eligible = page.objects.filter(
        (object) =>
          object.key.startsWith(prefix) &&
          object.lastModified.getTime() >= read.account.meteredFrom.getTime() &&
          Number.isSafeInteger(object.size) &&
          object.size >= 0,
      );
      await this.measure(read, s3, eligible, gets, report, signal);
      continuation = page.next;
    } while (continuation !== null);
  }

  private async measure(
    read: CursorRead,
    s3: VolumeS3,
    objects: readonly ListedObject[],
    gets: { left: number },
    report: AwsVolumeReport,
    signal: AbortSignal,
  ): Promise<void> {
    if (objects.length === 0) return;
    const hashes = new Map(objects.map((object) => [objectHash(read.bucket, object.key), object]));
    const known = await this.prisma.awsVolumeObject.findMany({
      where: { cloudAccountId: read.account.id, objectHash: { in: [...hashes.keys()] } },
      select: { objectHash: true },
    });
    for (const { objectHash: hash } of known) hashes.delete(hash);
    const pending = [...hashes.entries()];
    const rows: Prisma.AwsVolumeObjectCreateManyInput[] = [];
    let exhausted = false;
    for (let start = 0; start < pending.length;) {
      if (gets.left === 0) {
        exhausted = true;
        break;
      }
      const batch = pending.slice(start, start + Math.min(GET_CONCURRENCY, gets.left));
      start += batch.length;
      gets.left -= batch.length;
      const measured = await Promise.all(
        batch.map(async ([hash, object]) => {
          const tail =
            object.key.endsWith('.gz') && object.size > 0
              ? await s3.tail(read.bucket, object.key, signal)
              : null;
          return { hash, object, size: decompressedSize(object.key, object.size, tail) };
        }),
      );
      for (const { hash, object, size } of measured) {
        rows.push({
          cloudAccountId: read.account.id,
          tenantId: read.account.tenantId,
          objectHash: hash,
          day: dayAsDate(brasiliaDay(object.lastModified)),
          stream: read.stream,
          compressedBytes: BigInt(object.size),
          bytes: BigInt(size.bytes),
          isizeFallback: size.fallback,
        });
      }
    }
    await this.save(read, rows, objects, report);
    if (exhausted) throw new BudgetExhausted();
  }

  /** Grava os objetos medidos e soma ao mês só os que entraram agora (outra execução pode ter gravado algum antes). */
  private async save(
    read: CursorRead,
    rows: readonly Prisma.AwsVolumeObjectCreateManyInput[],
    objects: readonly ListedObject[],
    report: AwsVolumeReport,
  ): Promise<void> {
    if (rows.length === 0) return;
    const createdAt = new Map(
      objects.map((object) => [objectHash(read.bucket, object.key), object.lastModified]),
    );
    await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.awsVolumeObject.createManyAndReturn({
        data: [...rows],
        skipDuplicates: true,
        select: { objectHash: true, bytes: true, isizeFallback: true },
      });
      const meter = new UsageMeter();
      for (const row of inserted) {
        const bytes = Number(row.bytes);
        meter.add(read.account.tenantId, 'aws', bytes, 0, createdAt.get(row.objectHash) ?? this.now());
        report.counted += 1;
        report.bytes += bytes;
        if (row.isizeFallback) report.fallbacks += 1;
      }
      await meter.flushIn(tx);
    });
  }

  /**
   * Regrava o total da AWS de cada dia de Brasília que os dias UTC lidos alcançam (a soma do registro do cliente, um
   * valor absoluto). O dia UTC `d` vai das 21:00 de `d−1` às 20:59 de `d` em Brasília.
   *
   * Duas execuções ao mesmo tempo (duas réplicas do worker; a tarefa não tem concessão) são serializadas por cliente
   * (`pg_advisory_xact_lock`) antes de somar: a soma de cada uma é feita depois de a outra gravar, e enxerga todo
   * objeto já gravado. Assim, um total mais antigo nunca é regravado por cima de um mais novo.
   */
  private async recompute(tenantId: string, fromUtc: string, toUtc: string): Promise<void> {
    const first = dayAsDate(addDays(fromUtc, -1));
    const last = dayAsDate(toUtc);
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`verax:aws-volume:${tenantId}`}))`;
      const sums = await tx.awsVolumeObject.groupBy({
        by: ['day'],
        where: { tenantId, day: { gte: first, lte: last } },
        _sum: { bytes: true },
      });
      for (const { day, _sum } of sums) {
        const bytes = _sum.bytes ?? 0n;
        await tx.ingestUsageDay.upsert({
          where: { tenantId_day_source: { tenantId, day, source: 'aws' } },
          create: { tenantId, day, source: 'aws', bytes, events: 0n },
          update: { bytes, events: 0n },
        });
      }
    });
  }

  /** Apaga os registros com mais de 62 dias (o total de cada dia fica no `IngestUsageDay`). */
  private async prune(): Promise<number> {
    const cutoff = dayAsDate(addDays(brasiliaDay(this.now()), -VOLUME_OBJECT_RETENTION_DAYS));
    const { count } = await this.prisma.awsVolumeObject.deleteMany({
      where: {
        day: { lt: cutoff },
        ...(this.tenantIds !== undefined && { tenantId: { in: [...this.tenantIds] } }),
      },
    });
    return count;
  }
}

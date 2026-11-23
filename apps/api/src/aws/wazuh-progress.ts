import { z } from 'zod';
import type { WazuhMarkerRef } from './wazuh-sources.js';

/**
 * O sinal `progress` do host (onboarding self-service da AWS): até onde o módulo aws-s3 do Wazuh do nó já leu cada
 * fonte, tirado, só para leitura, dos bancos SQLite em que o próprio módulo guarda os marcadores
 * (`infra/wazuh/scripts/export-aws-progress.py`, rodado a cada 5 min pelo `infra/node/bin/wazuh-progress.sh`). É a prova
 * de que o Wazuh leu uma fonte: o worker não fala com o manager, e o alerta no indexer só existe para o evento que
 * casou com uma regra.
 *
 * - S3 (`s3_cloudtrail.db`, uma tabela por tipo de bucket): por tabela, `bucket_path`, conta e região (os flow logs,
 *   também o ID do flow log), o último objeto lido (a maior chave), quando o módulo o leu e o dia do objeto;
 * - CloudWatch Logs (`aws_services.db`): por região e grupo, o horário do evento mais recente lido e quantos streams o
 *   módulo já olhou.
 *
 * O arquivo é entrada não confiável (vem do contêiner do manager, que processa log de fora): tamanho limitado, o
 * envelope conferido por schema, e cada linha conferida sozinha (a que não serve fica de fora, sem derrubar as
 * outras). Nenhum conteúdo de log passa por aqui: só nomes de bucket, de objeto e de grupo, e horários.
 */

/** O teto do arquivo: o host recusa o que passar disso, e o worker nem lê. */
export const WAZUH_PROGRESS_MAX_BYTES = 4 * 1024 * 1024;
/** O teto de linhas de cada parte (o exportador corta antes e avisa com `truncated`). */
export const WAZUH_PROGRESS_MAX_ENTRIES = 5000;
/**
 * O sinal com mais idade que isso não diz mais nada da coleta de agora (quatro execuções perdidas do timer de 5 min):
 * a saúde das fontes fica como estava, sem fonte nenhuma mudar de estado por um marcador velho.
 */
export const WAZUH_PROGRESS_STALE_AFTER_MS = 20 * 60 * 1000;

/**
 * O que o exportador conseguiu ler de um banco: `ok`; `missing` (o banco ou a tabela ainda não existem: o módulo nunca
 * leu nada daquele tipo); `locked` (o módulo estava gravando); `error` (o banco não abriu).
 */
const sectionStatus = z.enum(['ok', 'missing', 'locked', 'error']);
const section = z.object({
  status: sectionStatus,
  truncated: z.boolean(),
  entries: z.array(z.unknown()).max(WAZUH_PROGRESS_MAX_ENTRIES),
});
const envelopeSchema = z.object({
  version: z.literal(1),
  at: z.iso.datetime(),
  s3: section,
  cloudwatch: section,
});

const accountId = z.string().regex(/^\d{12}$/);
const s3EntrySchema = z.strictObject({
  table: z.enum(['cloudtrail', 'vpcflow', 'guardduty', 'waf']),
  bucketPath: z.string().min(1).max(1200),
  accountId,
  region: z.string().min(1).max(32).nullable(),
  flowLogId: z.string().min(1).max(64).nullable(),
  lastKey: z.string().min(1).max(1024),
  processedAt: z.iso.datetime(),
  /** O dia do objeto como o módulo o guarda (`AAAAMMDD`). */
  createdDate: z.number().int().min(19_700_101).max(99_991_231).nullable(),
  keys: z.number().int().nonnegative(),
});
const logGroupEntrySchema = z.strictObject({
  region: z.string().min(1).max(32),
  logGroup: z.string().min(1).max(512),
  /** O horário do evento mais recente lido, em milissegundos; null: o módulo olhou o grupo e ainda não leu evento. */
  endTime: z.number().int().nonnegative().max(8_640_000_000_000_000).nullable(),
  streams: z.number().int().nonnegative(),
});
export type WazuhS3Progress = z.infer<typeof s3EntrySchema>;
export type WazuhLogGroupProgress = z.infer<typeof logGroupEntrySchema>;

interface ProgressSection<T> {
  status: z.infer<typeof sectionStatus>;
  truncated: boolean;
  entries: T[];
}

export interface WazuhProgress {
  /** Quando o host tirou o retrato. */
  at: Date;
  s3: ProgressSection<WazuhS3Progress>;
  cloudwatch: ProgressSection<WazuhLogGroupProgress>;
  /** Linhas fora do formato, deixadas de fora. */
  invalidEntries: number;
}

/** O sinal conferido, ou null fora do formato. */
export function parseWazuhProgress(json: unknown): WazuhProgress | null {
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  let invalidEntries = 0;
  const entries = <T>(raw: readonly unknown[], schema: z.ZodType<T>): T[] => {
    const valid: T[] = [];
    for (const item of raw) {
      const parsed = schema.safeParse(item);
      if (parsed.success) valid.push(parsed.data);
      else invalidEntries += 1;
    }
    return valid;
  };
  const { at, s3, cloudwatch } = envelope.data;
  const progress: WazuhProgress = {
    at: new Date(at),
    s3: { status: s3.status, truncated: s3.truncated, entries: entries(s3.entries, s3EntrySchema) },
    cloudwatch: {
      status: cloudwatch.status,
      truncated: cloudwatch.truncated,
      entries: entries(cloudwatch.entries, logGroupEntrySchema),
    },
    invalidEntries,
  };
  return progress;
}

/** O marcador de uma fonte: o que o módulo leu dela por último. */
export interface WazuhSourceMarker {
  /** S3: quando o módulo leu o objeto mais recente. CloudWatch Logs: null (o módulo não guarda quando leu). */
  ingestedAt: Date | null;
  /** O horário do evento mais recente: o do nome do objeto (ou o dia dele), ou o do último evento do grupo. */
  eventAt: Date | null;
  /** S3: o último objeto lido e a região dele, para a conferência de fonte parada. */
  lastKey: string | null;
  region: string | null;
}

/**
 * O que o sinal diz de uma fonte. `known: false`: não dá para saber (o banco estava travado ou não abriu, ou a parte
 * veio cortada e a fonte não está nela). `marker: null`: sabe-se que o módulo ainda não leu nada dela.
 */
export type WazuhMarkerLookup = { known: false } | { known: true; marker: WazuhSourceMarker | null };

const UNKNOWN: WazuhMarkerLookup = { known: false };
const DAY_MS = 24 * 60 * 60 * 1000;
/** `…_20261123T1205Z_…`: o horário no nome dos objetos do CloudTrail, dos flow logs e do log nativo do WAF. */
const COMPACT_TIME = /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z/;
/** `…-2026-11-23-12-05-33-…`: o horário no nome dos objetos entregues pelo Firehose. */
const DASHED_TIME = /(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/;
/** `…/2026/11/23/…`: a pasta do dia. */
const DAY_FOLDER = /\/(\d{4})\/(\d{2})\/(\d{2})\//;

function utc(parts: readonly string[]): Date | null {
  const [year, month, day, hour = 0, minute = 0, second = 0] = parts.map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  // Uma data que não existe (mês 13, dia 40, hora 25) volta outra: recusada.
  const same =
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute;
  return same ? date : null;
}

/**
 * O horário do evento mais recente de um objeto lido: o do nome dele (ao minuto ou ao segundo) ou, sem ele, o dia da
 * pasta (ou o que o módulo guardou), contado até o fim do dia. Nunca depois de o objeto ter sido lido.
 */
export function objectEventTime(
  entry: Pick<WazuhS3Progress, 'lastKey' | 'createdDate' | 'processedAt'>,
): Date {
  const processed = new Date(entry.processedAt);
  const exact = COMPACT_TIME.exec(entry.lastKey) ?? DASHED_TIME.exec(entry.lastKey);
  const named = exact === null ? null : utc(exact.slice(1));
  if (named !== null) return named < processed ? named : processed;
  const folder = DAY_FOLDER.exec(entry.lastKey);
  const created = entry.createdDate === null ? null : String(entry.createdDate);
  const day =
    (folder === null ? null : utc(folder.slice(1))) ??
    (created === null ? null : utc([created.slice(0, 4), created.slice(4, 6), created.slice(6, 8)]));
  if (day === null) return processed;
  const endOfDay = new Date(day.getTime() + DAY_MS - 1);
  return endOfDay < processed ? endOfDay : processed;
}

/** O marcador de uma fonte no sinal, pela referência que a lista calculou para ela (`WazuhMarkerRef`). */
export function findWazuhMarker(progress: WazuhProgress, ref: WazuhMarkerRef): WazuhMarkerLookup {
  if (ref.method === 'cloudwatch') {
    const { status, truncated, entries } = progress.cloudwatch;
    if (status === 'locked' || status === 'error') return UNKNOWN;
    const entry = entries.find((item) => item.region === ref.region && item.logGroup === ref.logGroup);
    if (entry === undefined) return truncated ? UNKNOWN : { known: true, marker: null };
    return {
      known: true,
      marker: {
        ingestedAt: null,
        eventAt: entry.endTime === null ? null : new Date(entry.endTime),
        lastKey: null,
        region: ref.region,
      },
    };
  }
  const { status, truncated, entries } = progress.s3;
  if (status === 'locked' || status === 'error') return UNKNOWN;
  let latest: { entry: WazuhS3Progress; time: number } | null = null;
  for (const entry of entries) {
    if (entry.table !== ref.table || entry.bucketPath !== ref.bucketPath) continue;
    if (ref.accountId !== null && entry.accountId !== ref.accountId) continue;
    if (ref.regions !== null && (entry.region === null || !ref.regions.includes(entry.region))) continue;
    if (ref.flowLogId !== null && entry.flowLogId !== ref.flowLogId) continue;
    // O mais recente pelo horário da leitura; no empate, a maior chave.
    const time = Date.parse(entry.processedAt);
    if (
      latest === null ||
      time > latest.time ||
      (time === latest.time && entry.lastKey > latest.entry.lastKey)
    ) {
      latest = { entry, time };
    }
  }
  if (latest === null) return truncated ? UNKNOWN : { known: true, marker: null };
  return {
    known: true,
    marker: {
      ingestedAt: new Date(latest.time),
      eventAt: objectEventTime(latest.entry),
      lastKey: latest.entry.lastKey,
      region: latest.entry.region,
    },
  };
}

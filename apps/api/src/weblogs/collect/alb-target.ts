import { type AwsSourceDetails, bucketNameProblem, webLoadBalancerSchema } from '@verax/shared';
import { AWS_LOGS_SERVICE, awsLogsPrefix, parseLoadBalancerArn } from '../../aws/discovery/catalogue.js';
import { matchesExpectation, parseAlbKey } from '../alb/alb-key.js';
import { SLOT_MS } from '../limits.js';

/**
 * Onde ficam os arquivos de um balanceador autorizado, e só dele. Tudo sai da conta, da região e do que a descoberta guardou
 * (o bucket, o ARN e o prefixo), conferido aqui de novo: um detalhe fora do formato não vira chamada ao S3.
 */
export interface AlbTarget {
  bucket: string;
  /** O prefixo antes de `AWSLogs/`, sem a barra do fim; vazio sem um. */
  prefix: string;
  accountId: string;
  region: string;
  /** `app/<nome>/<id>`. */
  loadBalancer: string;
  /** Até a região, com a barra no fim; o resto é o dia. */
  root: string;
  /** O começo do nome de todo arquivo dele: `<conta>_elasticloadbalancing_<região>_app.<nome>.<id>_`. */
  head: string;
}

/**
 * `invalid_details`: falta o bucket ou o ARN não é de um ALB. `web_prefix_unsupported`: o prefixo do bucket tem um caractere
 * que a leitura não aceita (nenhuma chave dele passaria na gramática).
 */
export type AlbTargetProblem = 'invalid_details' | 'web_prefix_unsupported';

export interface AlbObject {
  key: string;
  size: number;
  /** O fim do intervalo do arquivo. */
  endMs: number;
  /** O slot: `fim / 5 min`, para cima. */
  index: number;
}

export function albTargetOf(
  accountId: string,
  region: string,
  details: AwsSourceDetails,
): AlbTarget | AlbTargetProblem {
  const { bucket, customPrefix } = details;
  // Só o `app/<nome>/<id>` passa: o NLB e o GWLB, não.
  const parsed = webLoadBalancerSchema.safeParse(parseLoadBalancerArn(details.arn)?.loadBalancer);
  if (bucket === undefined || bucketNameProblem(bucket) !== null) return 'invalid_details';
  if (!parsed.success) return 'invalid_details';
  const loadBalancer = parsed.data;
  const root = awsLogsPrefix({
    customPrefix: customPrefix ?? null,
    accountId,
    service: AWS_LOGS_SERVICE.elb_logs,
    region,
  });
  // O que a descoberta gravou tem de ser o mesmo: a conta, a região e o prefixo da linha.
  if (details.prefix !== root) return 'invalid_details';
  const target: AlbTarget = {
    bucket,
    prefix: customPrefix ?? '',
    accountId,
    region,
    loadBalancer,
    root,
    head: `${accountId}_elasticloadbalancing_${region}_${loadBalancer.split('/').join('.')}_`,
  };
  // Um nome de arquivo possível tem de passar na gramática; senão, nenhum passaria, e a fonte pareceria vazia.
  const sample = `${folderOf(target, '2026-01-01')}${compactTime(Date.UTC(2026, 0, 1))}_10.0.0.1_a.log.gz`;
  return ownObject(target, sample, 0) === null ? 'web_prefix_unsupported' : target;
}

/** A pasta de um dia (o da **entrega**), com o começo do nome dos arquivos do balanceador. */
export function folderOf(target: AlbTarget, day: string): string {
  return `${target.root}${day.split('-').join('/')}/${target.head}`;
}

/** `20261124T1005Z`, como no nome do arquivo. */
export function compactTime(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
}

/** O dia UTC de um instante. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Os dias UTC de um instante a outro, inclusive. */
export function utcDays(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  const last = utcDay(Math.max(fromMs, toMs));
  for (let at = fromMs; ; at += 24 * 60 * 60_000) {
    const day = utcDay(at);
    if (day > last) return days;
    days.push(day);
  }
}

export const slotOf = (ms: number): number => Math.ceil(ms / SLOT_MS);

/** O objeto, se a chave é deste balanceador pela gramática da AWS. A chave vem do bucket: não é confiável. */
export function ownObject(target: AlbTarget, key: string, size: number): AlbObject | null {
  const parsed = parseAlbKey(key);
  if (parsed === null || !matchesExpectation(parsed, target)) return null;
  return { key, size, endMs: parsed.endMs, index: slotOf(parsed.endMs) };
}

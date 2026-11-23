import { isAwsRegion } from '@verax/shared';
import { normalizeTimestamp } from '../../alerts/wazuh-alert.js';

/**
 * Leitura dos campos de um achado da API da AWS. A resposta da AWS é entrada externa: nada é usado sem conferir o tipo
 * e o tamanho, e nenhum achado é guardado inteiro. O `Finding` só leva os campos abaixo, cada um cortado no tamanho da
 * coluna dele.
 */

/** Teto do registro de um achado (o ASFF aceita até 240 KB): acima disso, o registro é recusado sem ser lido. */
export const MAX_FINDING_RECORD_BYTES = 512 * 1024;

const ACCOUNT_ID = /^\d{12}$/;

/** O tamanho do registro, em bytes UTF-8 do JSON dele (a medida do volume); null se não der para serializar. */
export function recordBytes(record: unknown): number | null {
  try {
    const json = JSON.stringify(record);
    return typeof json === 'string' ? Buffer.byteLength(json, 'utf8') : null;
  } catch {
    return null;
  }
}

/** Um objeto comum (nem lista, nem null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Um texto para mostrar (título, tipo, nome): sem caractere de controle (viram espaço), sem espaço nas pontas e cortado
 * em `max`. O que não é texto, ou fica vazio, vira ausente.
 */
export function label(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  let clean = '';
  // Só o começo do texto interessa: o corte vem antes da limpeza, para um texto enorme não ser percorrido inteiro.
  for (const char of value.slice(0, max * 2)) {
    const code = char.charCodeAt(0);
    clean += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? ' ' : char;
  }
  clean = clean.trim().slice(0, max).trim();
  return clean.length > 0 ? clean : undefined;
}

/** O ID de uma conta AWS (12 dígitos), ou ausente. */
export function accountId(value: unknown): string | undefined {
  return typeof value === 'string' && ACCOUNT_ID.test(value) ? value : undefined;
}

/**
 * As contas citadas num achado, como em `accountsOf` (`alerts/wazuh-alert.ts`): um campo de conta presente e fora do
 * formato invalida a lista (`null`), e o achado vai para a fila sem dono em vez de ser atribuído por um campo que sobrou.
 */
export function citedAccounts(...values: unknown[]): string[] | null {
  const accounts = new Set<string>();
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const found = accountId(value);
    if (found === undefined) return null;
    accounts.add(found);
  }
  return [...accounts].sort();
}

/** Uma região da AWS, ou ausente. */
export function region(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 32 && isAwsRegion(value) ? value : undefined;
}

/** Datas plausíveis de um achado: de 2000 a um dia depois de agora (o relógio da origem pode estar adiantado). */
const EARLIEST = Date.UTC(2000, 0, 1);

/**
 * Um horário da AWS em ISO 8601 (UTC): o SDK entrega `Date` nos serviços que mandam o número (Inspector, Access
 * Analyzer) e o texto nos que mandam texto (GuardDuty, Security Hub). Fora do formato ou de uma faixa plausível, ausente.
 */
export function timestamp(value: unknown, now: Date): string | undefined {
  let iso: string | null = null;
  if (value instanceof Date) {
    iso = Number.isNaN(value.getTime()) ? null : value.toISOString();
  } else if (typeof value === 'string' && value.length <= 64) {
    iso = normalizeTimestamp(value);
  }
  if (iso === null) return undefined;
  const at = Date.parse(iso);
  return at >= EARLIEST && at <= now.getTime() + 24 * 60 * 60 * 1000 ? iso : undefined;
}

interface Arn {
  service: string;
  region: string;
  account: string;
  resource: string;
}

const PARTITIONS: ReadonlySet<string> = new Set(['aws', 'aws-cn', 'aws-us-gov', 'aws-eusc']);

/** `arn:<partição>:<serviço>:<região>:<conta>:<recurso>`; o recurso pode ter dois-pontos. */
export function parseArn(value: unknown): Arn | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const parts = value.split(':');
  if (parts.length < 6 || parts[0] !== 'arn' || !PARTITIONS.has(parts[1] ?? '')) return null;
  const [, , service = '', arnRegion = '', account = '', ...resource] = parts;
  return { service, region: arnRegion, account, resource: resource.join(':') };
}

const INSTANCE = /^i-[0-9a-f]{8,32}$/;
const SECURITY_GROUP = /^sg-[0-9a-f]{8,32}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** O último trecho de um caminho (`role/servico/nome` vira `nome`). */
function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * O recurso de um achado no formato dos outros achados (`tipo:identificador`: `s3:meu-bucket`, `ec2:i-0abc`, `sg:sg-0abc`,
 * `iam-user:nome`, `iam-role:nome`), para a correlação, a lista de proteção e as exceções valerem entre as fontes. O
 * que não tem formato curto fica com o ARN (ou o ID) como veio.
 */
export function resourceRef(value: unknown): string | undefined {
  const raw = label(value, 2048);
  if (raw === undefined) return undefined;
  if (INSTANCE.test(raw)) return `ec2:${raw}`;
  if (SECURITY_GROUP.test(raw)) return `sg:${raw}`;
  const arn = parseArn(raw);
  if (arn === null) return raw;
  if (arn.service === 's3' && BUCKET.test(arn.resource)) return `s3:${arn.resource}`;
  if (arn.service === 'ec2') {
    const id = lastSegment(arn.resource);
    if (arn.resource.startsWith('instance/') && INSTANCE.test(id)) return `ec2:${id}`;
    if (arn.resource.startsWith('security-group/') && SECURITY_GROUP.test(id)) return `sg:${id}`;
  }
  if (arn.service === 'iam') {
    const name = lastSegment(arn.resource);
    if (name.length > 0 && arn.resource.startsWith('user/')) return `iam-user:${name}`;
    if (name.length > 0 && arn.resource.startsWith('role/')) return `iam-role:${name}`;
  }
  return raw;
}

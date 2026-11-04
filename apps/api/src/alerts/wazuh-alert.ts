import { isIP } from 'node:net';
import { z } from 'zod';

/**
 * Alerta do Wazuh como a API o lê do indexer (T5.2 e T5.3).
 *
 * O envelope (id, horário e regra) é validado por schema. Do evento da AWS, em `data.aws`, só saem os campos que a
 * API usa, cada um conferido no formato; o resto do documento não é guardado (o detalhe do achado relê o evento no
 * indexer, saneado). Formatos conferidos no código do módulo aws-s3 do Wazuh 4.14.9:
 * - o evento original da AWS fica em `data.aws`, com `source` e `log_info.s3bucket` (o bucket que o módulo leu);
 * - só o CloudTrail ganha `aws_account_id`, a conta da pasta `AWSLogs/<conta>` lida. No GuardDuty e no WAF, a conta
 *   vem do próprio evento, que o cliente controla (por isso a T5.2 cruza com o bucket de origem);
 * - listas de um elemento viram o próprio elemento (os acessos aceitam os dois);
 * - o decoder JSON do analysisd grava cada campo de `data.aws` como texto (conferido no wazuh-logtest do 4.14.9): o
 *   inteiro que cabe em 32 bits sai como o próprio número (`"22"`, `"8"`), os outros números com seis casas
 *   (`"5.500000"` e o horário do WAF, em milissegundos, `"1793527200000.000000"`), e os booleanos como `"true"` e
 *   `"false"`. Os números lidos aqui aceitam esse texto e o número em si, e os dois dão o mesmo valor.
 */

/** As fontes que o módulo aws-s3 coleta (infra/wazuh/scripts/render-manager-config.py). */
export const AWS_SOURCES = ['cloudtrail', 'guardduty', 'waf'] as const;
export type AwsSource = (typeof AWS_SOURCES)[number];

export interface WazuhAwsAlert {
  /** ID do alerta no Wazuh. Muda a cada leitura do mesmo evento; o detalhe do achado busca o evento bruto por ele. */
  id: string;
  /**
   * Identidade do evento na própria AWS, montada só com campos do log original (`NATIVE_ID`):
   * - CloudTrail: `eventID`;
   * - GuardDuty: `id` do achado e, na sondagem de porta, `/<IP>:<porta>` de quem sondou;
   * - WAF: `<timestamp>/<clientIp>/<requestId>`.
   * Repete-se quando o mesmo evento volta ao indexer (snapshot restaurado, `--reparse`, achado do GuardDuty
   * atualizado), por isso é a base da chave do achado. Ausente ou fora do formato, a chave usa o `id` do alerta.
   */
  nativeId?: string;
  /** ISO 8601 em UTC. */
  timestamp: string;
  rule: {
    id: string;
    level: number;
    description: string;
    groups: string[];
    mitre: { ids: string[]; tactics: string[]; techniques: string[] };
  };
  source: AwsSource;
  /** Bucket de onde o módulo leu o evento. */
  bucket: string;
  /** Contas citadas no evento (sem repetição). `null` quando algum campo de conta está fora do formato. */
  accounts: string[] | null;
  region?: string;
  /** Nome do evento: `eventName` do CloudTrail, `type` do GuardDuty, ação e regra do WAF. */
  eventName?: string;
  /** Severidade dada pela própria AWS (GuardDuty, de 0 a 10). */
  awsSeverity?: number;
  actor: {
    /** ARN ou nome da identidade que agiu. */
    user?: string;
    /** Tipo da identidade (Root, IAMUser, AssumedRole...). */
    identityType?: string;
    accessKeyId?: string;
    ip?: string;
  };
  /** Recurso afetado, como `tipo:identificador` (ex.: `s3:meu-bucket`, `ec2:i-0abc`). */
  resource?: string;
}

export type ParsedAlert =
  { ok: true; alert: WazuhAwsAlert } | { ok: false; reason: 'invalid_alert' | 'not_aws'; id: string | null };

const isoTimestamp = z.iso.datetime({ offset: true });
const ALERT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ACCOUNT_ID = /^\d{12}$/;
const ACCESS_KEY_ID = /^(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,124}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;

/** O Wazuh grava o fuso sem dois-pontos (`+0000`), que o validador ISO recusa; o resto da API usa UTC. */
export function normalizeTimestamp(value: string): string | null {
  const withColon = /[+-]\d{4}$/.test(value) ? `${value.slice(0, -2)}:${value.slice(-2)}` : value;
  if (!isoTimestamp.safeParse(withColon).success) return null;
  return new Date(withColon).toISOString();
}

const shortList = (max: number) => z.array(z.string().max(max)).max(64).default([]);

const envelopeSchema = z.object({
  id: z.string().regex(ALERT_ID),
  timestamp: z.string().max(64),
  rule: z.object({
    id: z.string().regex(/^\d{1,9}$/),
    level: z.number().int().min(0).max(16),
    description: z.string().min(1).max(2048),
    groups: shortList(128),
    mitre: z.object({ id: shortList(32), tactic: shortList(128), technique: shortList(256) }).optional(),
  }),
  data: z
    .object({
      integration: z.string().max(64).optional(),
      aws: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});

/**
 * Lê um caminho no evento. Numa lista, segue o primeiro item (o wodle transforma listas de um item em objeto). Só
 * lê: cada passo pega a propriedade própria pelo descritor, sem passar pelo protótipo nem chamar getter.
 */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current)) current = current[0];
    if (current === null || typeof current !== 'object') return undefined;
    current = Object.getOwnPropertyDescriptor(current, key)?.value;
  }
  return current;
}

/** Caractere de controle (categoria Cc do Unicode: U+0000 a U+001F e U+007F a U+009F). */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/** Texto curto e sem caractere de controle; qualquer outra coisa vira ausente. */
function text(value: unknown, max = 256): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !hasControlCharacter(value)
    ? value
    : undefined;
}

/**
 * Texto curto que bate com um dos padrões deste arquivo. Os padrões são lineares (ancorados, com classes de
 * caracteres e quantificadores limitados, sem aninhamento), e o texto já chega com no máximo `max` caracteres.
 */
function matching(value: unknown, pattern: RegExp, max = 256): string | undefined {
  // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos
  const found = text(value, max);
  return found !== undefined && pattern.test(found) ? found : undefined;
}

function ip(value: unknown): string | undefined {
  const found = text(value, 64);
  return found !== undefined && isIP(found) !== 0 ? found : undefined;
}

function firstOf<T>(...values: (T | undefined)[]): T | undefined {
  return values.find((value) => value !== undefined);
}

/** Inteiro sem sinal: o número ou o texto que o Wazuh grava (`"22"`, `"1793527200000.000000"`). */
const unsignedSchema = (max: number) =>
  z
    .union([
      z.number(),
      z
        .string()
        .regex(/^\d{1,16}$|^\d{1,16}\.0{1,6}$/)
        .transform(Number),
    ])
    .pipe(z.number().int().min(0).max(max));

/** Severidade do GuardDuty, de 0 a 10: o número ou o texto que o Wazuh grava (`"8"`, `"5.500000"`). */
const awsSeveritySchema = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^\d{1,2}$|^\d{1,2}\.\d{1,6}$/)
      .transform(Number),
  ])
  .pipe(z.number().min(0).max(10));

interface Arn {
  service: string;
  region: string;
  account: string;
  resource: string;
}

const PARTITIONS = new Set(['aws', 'aws-cn', 'aws-us-gov', 'aws-eusc']);

/** `arn:<partição>:<serviço>:<região>:<conta>:<recurso>`; o recurso pode ter dois-pontos. */
function parseArn(value: string): Arn | null {
  const parts = value.split(':');
  if (parts.length < 6 || parts[0] !== 'arn' || !PARTITIONS.has(parts[1] ?? '')) return null;
  const [, , service = '', region = '', account = '', ...resource] = parts;
  return { service, region, account, resource: resource.join(':') };
}

/**
 * Contas citadas no evento, pelos campos de cada fonte. Um campo presente fora do formato invalida a lista (`null`):
 * o alerta vai para a fila sem dono em vez de ser atribuído por um campo que sobrou.
 */
function accountsOf(source: AwsSource, aws: Record<string, unknown>): string[] | null {
  const plain: unknown[] = [];
  const arns: { value: unknown; service: string }[] = [];
  if (source === 'cloudtrail') {
    plain.push(aws['aws_account_id'], aws['recipientAccountId']);
  } else if (source === 'guardduty') {
    plain.push(aws['accountId']);
    arns.push({ value: aws['arn'], service: 'guardduty' });
  } else {
    arns.push({ value: aws['webaclId'], service: 'wafv2' });
  }

  const accounts = new Set<string>();
  for (const value of plain) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) return null;
    accounts.add(value);
  }
  for (const { value, service } of arns) {
    if (value === undefined) continue;
    const arn = typeof value === 'string' && value.length <= 2048 ? parseArn(value) : null;
    if (arn === null || arn.service !== service || !ACCOUNT_ID.test(arn.account)) return null;
    accounts.add(arn.account);
  }
  return [...accounts].sort();
}

function cloudTrailDetails(aws: Record<string, unknown>): Partial<WazuhAwsAlert> {
  const identity = aws['userIdentity'];
  const params = aws['requestParameters'];
  const bucket = matching(at(params, 'bucketName'), BUCKET);
  const instance = matching(at(params, 'instanceId'), /^i-[0-9a-f]{8,32}$/);
  const group = matching(at(params, 'groupId'), /^sg-[0-9a-f]{8,32}$/);
  const userName = text(at(params, 'userName'), 128);
  const roleName = text(at(params, 'roleName'), 128);
  return {
    region: matching(aws['awsRegion'], REGION),
    eventName: text(aws['eventName'], 128),
    actor: {
      user: firstOf(
        text(at(identity, 'arn'), 2048),
        text(at(identity, 'sessionContext', 'sessionIssuer', 'arn'), 2048),
        text(at(identity, 'userName'), 128),
      ),
      identityType: text(at(identity, 'type'), 64),
      accessKeyId: matching(at(identity, 'accessKeyId'), ACCESS_KEY_ID, 128),
      // Chamadas feitas por serviços da AWS trazem o nome do serviço, não um IP.
      ip: ip(aws['sourceIPAddress']),
    },
    resource: firstOf(
      bucket && `s3:${bucket}`,
      instance && `ec2:${instance}`,
      group && `sg:${group}`,
      userName && `iam-user:${userName}`,
      roleName && `iam-role:${roleName}`,
    ),
  };
}

function guardDutyDetails(aws: Record<string, unknown>): Partial<WazuhAwsAlert> {
  const resource = aws['resource'];
  const action = at(aws, 'service', 'action');
  const severity = awsSeveritySchema.safeParse(aws['severity']);
  const instance = matching(at(resource, 'instanceDetails', 'instanceId'), /^i-[0-9a-f]{8,32}$/);
  const bucket = matching(at(resource, 's3BucketDetails', 'name'), BUCKET);
  return {
    region: matching(aws['region'], REGION),
    eventName: text(aws['type'], 256),
    awsSeverity: severity.success ? severity.data : undefined,
    actor: {
      user: firstOf(
        text(at(resource, 'accessKeyDetails', 'userName'), 128),
        text(at(resource, 'accessKeyDetails', 'principalId'), 256),
      ),
      identityType: text(at(resource, 'accessKeyDetails', 'userType'), 64),
      accessKeyId: matching(at(resource, 'accessKeyDetails', 'accessKeyId'), ACCESS_KEY_ID, 128),
      ip: firstOf(
        ip(at(action, 'awsApiCallAction', 'remoteIpDetails', 'ipAddressV4')),
        ip(at(action, 'networkConnectionAction', 'remoteIpDetails', 'ipAddressV4')),
        ip(at(action, 'portProbeAction', 'portProbeDetails', 'remoteIpDetails', 'ipAddressV4')),
      ),
    },
    resource: firstOf(instance && `ec2:${instance}`, bucket && `s3:${bucket}`),
  };
}

function wafDetails(aws: Record<string, unknown>): Partial<WazuhAwsAlert> {
  const webAcl = text(aws['webaclId'], 2048);
  const arn = webAcl === undefined ? null : parseArn(webAcl);
  const action = text(aws['action'], 32);
  const rule = text(aws['terminatingRuleId'], 256);
  return {
    region: arn !== null && REGION.test(arn.region) ? arn.region : undefined,
    eventName: action && (rule ? `${action}:${rule}` : action),
    actor: { ip: ip(at(aws, 'httpRequest', 'clientIp')) },
    resource: webAcl && `waf:${webAcl}`,
  };
}

const DETAILS: Record<AwsSource, (aws: Record<string, unknown>) => Partial<WazuhAwsAlert>> = {
  cloudtrail: cloudTrailDetails,
  guardduty: guardDutyDetails,
  waf: wafDetails,
};

/**
 * ID do evento na AWS, como cada fonte grava: UUID no CloudTrail, 32 caracteres hexadecimais no GuardDuty e, no WAF,
 * o ID da requisição de quem fica na frente dele (ALB, CloudFront em base64, API Gateway). Uma classe de caracteres só,
 * sem espaço nem caractere de controle, com tamanho limitado.
 */
const nativeIdSchema = z.string().regex(/^[A-Za-z0-9._:+/=-]{1,128}$/);

/** IP (v4 ou v6) só com dígitos, letras hexadecimais, pontos e dois-pontos: sem zona (`%`) nem espaço. */
const ipSchema = z
  .string()
  .regex(/^[0-9A-Fa-f.:]{2,45}$/)
  .refine((value) => isIP(value) !== 0);

/**
 * Quem sondou, no achado de sondagem de porta do GuardDuty. O módulo aws-s3 do Wazuh
 * (`AWSGuardDutyBucket.reformat_msg`) divide o achado com mais de um item em `portProbeDetails` em um evento por
 * item, todos com o mesmo `id`, e cada evento traz um item só, como objeto. Sem o IP e a porta na chave, só o
 * primeiro item viraria achado, e os outros IPs cairiam como duplicados.
 */
const portProbeDetailSchema = z
  .object({
    remoteIpDetails: z.object({ ipAddressV4: ipSchema }),
    localPortDetails: z.object({ port: unsignedSchema(65_535) }),
  })
  .transform((detail) => `${detail.remoteIpDetails.ipAddressV4}:${detail.localPortDetails.port}`);

/**
 * Identidade de cada evento, só com campos do log original (os mesmos a cada releitura):
 * - CloudTrail: `eventID`, gerado pela AWS.
 * - GuardDuty: `id` do achado. Na sondagem de porta, mais `/<IP>:<porta>` do item; item fora do formato (sem IPv4,
 *   por exemplo) deixa o alerta sem id nativo, e a chave fica no `id` do alerta: nunca junta dois IPs.
 * - WAF: `<timestamp>/<clientIp>/<requestId>`. Atrás de um ALB, o `requestId` é o trace ID, que o cliente HTTP
 *   escolhe (`X-Amzn-Trace-Id: Root=...`) e que se repete em todas as chamadas de um mesmo trace do X-Ray. Sozinho,
 *   ele deixaria quem ataca repetir o mesmo valor e fazer cada rajada nova cair como duplicada da primeira. O horário
 *   (em milissegundos) é o do WAF, e o IP é o da conexão que a AWS recebeu: nenhum dos dois vem de cabeçalho. Com 13
 *   dígitos, o horário passa de 32 bits e chega do Wazuh com seis casas (`"1793527200000.000000"`); no id, vai o
 *   inteiro.
 */
const NATIVE_ID: Record<AwsSource, z.ZodType<string>> = {
  cloudtrail: z.object({ eventID: nativeIdSchema }).transform((event) => event.eventID),
  guardduty: z.object({ id: nativeIdSchema, service: z.unknown() }).transform((finding, context) => {
    const probe = at(finding.service, 'action', 'portProbeAction', 'portProbeDetails');
    if (probe === undefined) return finding.id;
    const detail = portProbeDetailSchema.safeParse(probe);
    if (detail.success) return `${finding.id}/${detail.data}`;
    context.issues.push({ code: 'custom', message: 'portProbeDetails fora do formato', input: probe });
    return z.NEVER;
  }),
  waf: z
    .object({
      timestamp: unsignedSchema(Number.MAX_SAFE_INTEGER),
      httpRequest: z.object({ clientIp: ipSchema, requestId: nativeIdSchema }),
    })
    .transform(
      ({ timestamp, httpRequest }) => `${timestamp}/${httpRequest.clientIp}/${httpRequest.requestId}`,
    ),
};

function nativeIdOf(source: AwsSource, aws: Record<string, unknown>): string | undefined {
  const parsed = NATIVE_ID[source].safeParse(aws);
  return parsed.success ? parsed.data : undefined;
}

/** Valida o documento do indexer e extrai o que a API usa. Nunca lança: o que não serve vira um motivo. */
export function parseWazuhAlert(document: unknown): ParsedAlert {
  const envelope = envelopeSchema.safeParse(document);
  if (!envelope.success) {
    const id = matching(at(document, 'id'), ALERT_ID, 128) ?? null;
    return { ok: false, reason: 'invalid_alert', id };
  }
  const { id, rule, data } = envelope.data;
  const aws = data?.aws;
  if (data?.integration !== 'aws' || aws === undefined) {
    return { ok: false, reason: 'not_aws', id };
  }
  const timestamp = normalizeTimestamp(envelope.data.timestamp);
  const source = (AWS_SOURCES as readonly unknown[]).includes(aws['source'])
    ? (aws['source'] as AwsSource)
    : null;
  const bucket = matching(at(aws, 'log_info', 's3bucket'), BUCKET);
  if (timestamp === null || source === null || bucket === undefined) {
    return { ok: false, reason: 'invalid_alert', id };
  }

  const details = DETAILS[source](aws);
  return {
    ok: true,
    alert: {
      id,
      nativeId: nativeIdOf(source, aws),
      timestamp,
      rule: {
        id: rule.id,
        level: rule.level,
        description: rule.description,
        groups: rule.groups,
        mitre: {
          ids: rule.mitre?.id ?? [],
          tactics: rule.mitre?.tactic ?? [],
          techniques: rule.mitre?.technique ?? [],
        },
      },
      source,
      bucket,
      accounts: accountsOf(source, aws),
      region: details.region,
      eventName: details.eventName,
      awsSeverity: details.awsSeverity,
      actor: details.actor ?? {},
      resource: details.resource,
    },
  };
}

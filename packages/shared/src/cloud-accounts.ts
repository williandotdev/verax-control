import { z } from 'zod';
import { cloudCredentialStatusSchema } from './cloud-credentials.js';
import { withPagination } from './pagination.js';

/** AWS, GCP (o SOC da própria Verax) e Cloudflare (WAF e DNS de quem usa). */
export const CLOUD_PROVIDERS = ['aws', 'gcp', 'cloudflare'] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export const CLOUD_ACCOUNT_STATUSES = ['active', 'inactive'] as const;
/**
 * Estado da coleta: aguardando o primeiro sinal de vida, conectada ou com erro na última leitura. Na AWS e na GCP
 * (entregues por evento), o sinal é o evento recebido; nos coletados por API (Cloudflare), a leitura bem-sucedida.
 */
export const CLOUD_ACCOUNT_CONNECTIONS = ['waiting', 'connected', 'error'] as const;
export type CloudAccountConnection = (typeof CLOUD_ACCOUNT_CONNECTIONS)[number];

/**
 * Erros de conexão do coletor do Cloudflare (fase 2, PR-12) que param a coleta da conta: o Cloudflare recusou o token
 * (inválido ou revogado), o token não lê a auditoria desta conta (permissão ou filtro de IP), venceu ou foi desativado.
 * O worker não chama mais o Cloudflare com aquele token; a coleta volta quando um admin cola outro token (ou o mesmo,
 * depois de corrigido no Cloudflare), o que recomeça a conexão.
 */
export const CLOUDFLARE_BLOCKING_ERRORS = [
  'credential_rejected',
  'credential_forbidden',
  'credential_expired',
  'credential_disabled',
] as const;
export type CloudflareBlockingError = (typeof CLOUDFLARE_BLOCKING_ERRORS)[number];

export function isCloudflareBlockingError(code: string | null): code is CloudflareBlockingError {
  return code !== null && (CLOUDFLARE_BLOCKING_ERRORS as readonly string[]).includes(code);
}
/** Fontes de log que o Wazuh lê de buckets S3 da conta do cliente (T4.4 a T4.6). */
export const LOG_SOURCES = ['cloudtrail', 'guardduty', 'waf'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

export const awsAccountIdSchema = z.string().regex(/^\d{12}$/, { error: 'ID de conta AWS tem 12 dígitos' });

/** ID do projeto da GCP: 6 a 30 caracteres, minúsculas, números e hífen; começa com letra e não termina em hífen. */
export const gcpProjectIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, { error: 'ID de projeto da GCP inválido' });

/** ID da conta do Cloudflare: 32 caracteres hexadecimais (aparece na URL e na página inicial da conta). */
export const cloudflareAccountIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/, { error: 'ID de conta do Cloudflare tem 32 caracteres hexadecimais' });

/**
 * Conta de qualquer provedor, onde achados, incidentes e postura citam a conta. Os três formatos não se
 * sobrepõem: 12 dígitos, projeto que começa com letra (até 30 caracteres) e 32 hexadecimais.
 */
export const cloudAccountRefSchema = z.union(
  [awsAccountIdSchema, gcpProjectIdSchema, cloudflareAccountIdSchema],
  {
    error: 'conta inválida',
  },
);
const PARTITION_QUALIFIERS = new Set(['gov', 'iso', 'isob', 'isoe', 'isof']);

/** Código de região da AWS: `sa-east-1`, `us-gov-west-1`, `us-isob-east-1`. Conferido por partes, sem regex aninhada. */
export function isAwsRegion(name: string): boolean {
  const parts = name.split('-');
  if (parts.length !== 3 && parts.length !== 4) return false;
  const [country = '', ...rest] = parts;
  const [area = '', number = ''] = rest.slice(-2);
  const qualifierOk = parts.length === 3 || PARTITION_QUALIFIERS.has(rest[0] ?? '');
  return /^[a-z]{2}$/.test(country) && qualifierOk && /^[a-z]{1,16}$/.test(area) && /^\d$/.test(number);
}

const regionSchema = z.string().max(32).refine(isAwsRegion, { error: 'região AWS inválida' });

/**
 * O logging do WAF direto para o S3 só grava em bucket com este prefixo (exigência da AWS); é o `aws-waf-logs-*` que o
 * template cita em `LogBucketArns`.
 */
export const WAF_LOG_BUCKET_PREFIX = 'aws-waf-logs-';

/** Começos e fins de nome que a AWS reserva (access points, Multi-Region Access Points, directory e table buckets). */
const RESERVED_BUCKET_PREFIXES = ['xn--', 'sthree-', 'amzn-s3-demo-'] as const;
const RESERVED_BUCKET_SUFFIXES = ['-s3alias', '--ol-s3', '.mrap', '--x-s3', '--table-s3'] as const;

function isBucketLowerAlnum(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
}

/** Quatro grupos de dígitos separados por ponto: o formato de IP que o S3 recusa como nome. */
function looksLikeIpAddress(name: string): boolean {
  const parts = name.split('.');
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part));
}

/**
 * O que está errado no nome de um bucket de uso geral do S3, em português, ou null se ele segue as regras da AWS
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html): 3 a 63 caracteres; só minúsculas,
 * números, ponto e hífen; começa e termina com letra ou número; sem dois pontos seguidos; sem formato de IP; sem os
 * começos e fins reservados. Conferido caractere a caractere, sem regex sobre o texto inteiro. Os buckets antigos de
 * us-east-1 com maiúscula ou sublinhado (de antes de 2018) ficam de fora, como no `AllowedPattern` do template.
 */
export function bucketNameProblem(name: string): string | null {
  if (name.length < 3 || name.length > 63) return 'O nome do bucket tem de 3 a 63 caracteres.';
  for (const char of name) {
    if (!isBucketLowerAlnum(char) && char !== '.' && char !== '-') {
      return 'Use só letras minúsculas, números, ponto (.) e hífen (-) no nome do bucket.';
    }
  }
  if (!isBucketLowerAlnum(name.charAt(0)) || !isBucketLowerAlnum(name.charAt(name.length - 1))) {
    return 'O nome do bucket começa e termina com letra minúscula ou número.';
  }
  if (name.includes('..')) return 'O nome do bucket não pode ter dois pontos seguidos.';
  if (looksLikeIpAddress(name)) return 'O nome do bucket não pode ter o formato de um endereço IP.';
  const prefix = RESERVED_BUCKET_PREFIXES.find((reserved) => name.startsWith(reserved));
  if (prefix) return `O começo ${prefix} é reservado pela AWS e não serve para um bucket de log.`;
  const suffix = RESERVED_BUCKET_SUFFIXES.find((reserved) => name.endsWith(reserved));
  if (suffix) return `O fim ${suffix} é reservado pela AWS e não serve para um bucket de log.`;
  return null;
}

/** Nome de bucket de uso geral do S3 (`bucketNameProblem`), com a mensagem do que está errado. */
const bucketSchema = z.string().superRefine((name, ctx) => {
  const problem = bucketNameProblem(name);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem });
});

/** O ARN de um bucket: `arn:<partição>:s3:::`, com a partição de minúsculas e hífen (`aws`, `aws-cn`, `aws-us-gov`). */
function bucketArnPrefixLength(value: string): number {
  const marker = ':s3:::';
  if (!value.startsWith('arn:')) return 0;
  const end = value.indexOf(marker);
  if (end <= 'arn:'.length) return 0;
  for (const char of value.slice('arn:'.length, end)) {
    if (!(char >= 'a' && char <= 'z') && char !== '-') return 0;
  }
  return end + marker.length;
}

/**
 * O que o cliente cola no campo do bucket vira o nome: sem os espaços das pontas, sem o `s3://` ou o ARN
 * (`arn:aws:s3:::`, como as saídas `TrailBucketArn` e `GuardDutyBucketArn` da pilha e o `LogBucketArns` mostram) e sem
 * uma barra no fim. Nada além disso muda: maiúscula, caminho ou outro texto ficam, e o schema recusa com a mensagem.
 */
export function normalizeBucketName(value: string): string {
  let name = value.trim();
  name = name.startsWith('s3://') ? name.slice('s3://'.length) : name.slice(bucketArnPrefixLength(name));
  return name.endsWith('/') ? name.slice(0, -1) : name;
}

/**
 * Assinatura do Pub/Sub de onde o nó lê os logs do projeto (o coletor do Cloud Logging publica no tópico dela),
 * pelo nome completo: `projects/<projeto>/subscriptions/<id>`. O ID só é único dentro do projeto dono, e o
 * projeto pode ser outro que não o monitorado (coletor agregado). Do ID, um subconjunto das regras da GCP: começa
 * com letra, 3 a 255 caracteres, sem o prefixo reservado `goog`. Conferido por partes, sem regex aninhada.
 */
export function isPubsubSubscriptionName(name: string): boolean {
  const parts = name.split('/');
  if (parts.length !== 4 || parts[0] !== 'projects' || parts[2] !== 'subscriptions') return false;
  const [, project = '', , id = ''] = parts;
  return (
    gcpProjectIdSchema.safeParse(project).success &&
    /^[A-Za-z][A-Za-z0-9._-]{2,254}$/.test(id) &&
    !id.toLowerCase().startsWith('goog')
  );
}

/** Só o ID digitado vira o nome completo no projeto da conta; um nome completo fica como está. */
export function qualifyPubsubSubscription(projectId: string, value: string): string {
  const trimmed = value.trim();
  return trimmed.includes('/') ? trimmed : `projects/${projectId}/subscriptions/${trimmed}`;
}

const pubsubSubscriptionSchema = z.string().max(320).refine(isPubsubSubscriptionName, {
  error: 'assinatura inválida: use projects/<projeto>/subscriptions/<nome>',
});

/**
 * Identidade de escrita (`writerIdentity`) do sink que o cliente cria no projeto dele com o comando de Contas cloud:
 * o agente do Cloud Logging daquele projeto, que a própria GCP cria (`service-<número do projeto>@gcp-sa-logging`).
 * Não é segredo. É ela que ganha, no Terraform do nó, a permissão de publicar só no tópico do projeto
 * (`customer_projects` em `infra/gcp/modules/node/variables.tf`, com a mesma regra; um teste confere). Uma conta de
 * serviço comum, uma pessoa, a identidade compartilhada antiga (`cloud-logs@system`) ou o agente de uma pasta ou
 * organização dariam a publicação a quem não é o sink daquele projeto.
 */
export const SINK_WRITER_IDENTITY_PATTERN =
  /^serviceAccount:service-[0-9]+@gcp-sa-logging\.iam\.gserviceaccount\.com$/;

export const sinkWriterIdentitySchema = z.string().max(128).regex(SINK_WRITER_IDENTITY_PATTERN, {
  error:
    'identidade do sink inválida: use serviceAccount:service-<número>@gcp-sa-logging.iam.gserviceaccount.com',
});

/** O que envolve a identidade colada: espaço em branco (o `\s` do JavaScript), crase e aspas. Um caractere por vez. */
const SINK_WRITER_IDENTITY_WRAPPER = /[\s`'"]/;

/**
 * A identidade como o gcloud mostra (entre crases, no aviso do `sinks create`) ou só o e-mail dela vira a forma
 * completa, `serviceAccount:<e-mail>`, que é a que o IAM aceita. Outro tipo (`user:`, `group:`) fica como está, e o
 * schema recusa. As pontas são andadas caractere a caractere, em tempo linear: a regex `^[...]+|[...]+$` com `g`
 * tentava a segunda alternativa em cada posição, e milhares de tabulações seguidas de outro caractere custavam
 * tempo quadrático (CodeQL, regex polinomial sobre dado não confiável).
 */
export function normalizeSinkWriterIdentity(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && SINK_WRITER_IDENTITY_WRAPPER.test(value.charAt(start))) start += 1;
  while (end > start && SINK_WRITER_IDENTITY_WRAPPER.test(value.charAt(end - 1))) end -= 1;
  const trimmed = value.slice(start, end);
  return trimmed.includes(':') ? trimmed : `serviceAccount:${trimmed}`;
}

/**
 * Filtro do sink de um projeto de cliente: os eventos de segurança do `security_log_filter` de
 * `infra/gcp/modules/node/logs.tf` (auditoria e bloqueios do Cloud Armor), sem a exclusão das leituras do próprio nó,
 * que acontecem no projeto do nó e nunca no do cliente. Um teste confere que os dois continuam iguais.
 */
export const GCP_SINK_LOG_FILTER = [
  'log_id("cloudaudit.googleapis.com/activity") OR',
  'log_id("cloudaudit.googleapis.com/system_event") OR',
  'log_id("cloudaudit.googleapis.com/policy") OR',
  'log_id("cloudaudit.googleapis.com/data_access") OR',
  '(resource.type="http_load_balancer" AND jsonPayload.enforcedSecurityPolicy.outcome="DENY")',
].join('\n');

/** Nome do sink que o comando cria no projeto do cliente. */
export const GCP_SINK_NAME = 'verax-control-security';

/**
 * Comando que o cliente roda no Cloud Shell do projeto dele: um sink que só copia os eventos de segurança para o
 * tópico do nó (`projects/<projeto-do-nó>/topics/<nome>`). A Verax não recebe nenhum papel no projeto do cliente. Os
 * valores entram no comando sem escape: o projeto e o tópico chegam aqui já validados (só letras, números, hífen e
 * barra), e o filtro não tem aspa simples.
 */
export function gcpSinkCommand(projectId: string, topic: string): string {
  return [
    `gcloud logging sinks create ${GCP_SINK_NAME} pubsub.googleapis.com/${topic} \\`,
    `  --project=${projectId} \\`,
    "  --description='Eventos de segurança para o Verax Control (só cópia; os logs originais não mudam).' \\",
    `  --log-filter='${GCP_SINK_LOG_FILTER}'`,
  ].join('\n');
}

/** Mostra só a identidade do sink criado, para colar no painel. */
export function gcpSinkIdentityCommand(projectId: string): string {
  return `gcloud logging sinks describe ${GCP_SINK_NAME} --project=${projectId} --format='value(writerIdentity)'`;
}

/** Nome de domínio (zona do Cloudflare), conferido rótulo a rótulo, sem regex aninhada. */
export function isDomainName(name: string): boolean {
  if (name.length > 253) return false;
  const labels = name.split('.');
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9-]+$/.test(label) &&
        !label.startsWith('-') &&
        !label.endsWith('-'),
    )
  );
}

const zonesSchema = z
  .array(
    z.string().max(253).refine(isDomainName, { error: 'zona inválida: use o domínio, como exemplo.com.br' }),
  )
  .max(50)
  .refine((zones) => new Set(zones).size === zones.length, { error: 'zona repetida' });

const regionsSchema = z
  .array(regionSchema)
  .min(1)
  .max(40)
  .refine((regions) => new Set(regions).size === regions.length, { error: 'região repetida' });

/**
 * Buckets de log da conta AWS: no máximo um por fonte (`LOG_SOURCES`), então três no total; uma fonte que não está no
 * objeto não muda, e `null` tira o bucket dela. O objeto é estrito: outra fonte, uma lista ou um prefixo são recusados.
 * O mesmo bucket em duas fontes da mesma conta vale (uma trilha e o export do GuardDuty num bucket central, em pastas
 * diferentes); em outro cliente, a API recusa (`assertOriginsFree`).
 */
const bucketsSchema = z.strictObject({
  cloudtrail: bucketSchema.nullable().optional(),
  guardduty: bucketSchema.nullable().optional(),
  waf: bucketSchema
    .refine((name) => name.startsWith(WAF_LOG_BUCKET_PREFIX), {
      error: `O bucket do WAF começa com ${WAF_LOG_BUCKET_PREFIX}: a AWS só grava o log do WAF num bucket com esse começo.`,
    })
    .nullable()
    .optional(),
});

/** Os buckets de log de uma conta AWS por fonte (null: a fonte sem bucket), como a API devolve. */
export type LogBuckets = Readonly<Record<LogSource, string | null>>;

/**
 * Os nomes dos buckets da conta, sem repetir, na ordem das fontes: o que vai em `LogBucketArns` e o que o "Verificar"
 * lê.
 */
export function logBucketNames(buckets: LogBuckets): string[] {
  return [...new Set(LOG_SOURCES.map((source) => buckets[source]).filter((name) => name !== null))];
}

/**
 * Se dois conjuntos de buckets têm os mesmos nomes, qualquer que seja a fonte de cada um. É o que a pilha (o
 * `LogBucketArns`) e o "Verificar" (um objeto de cada bucket) enxergam: trocar só a fonte de um bucket não pede
 * atualizar a pilha nem verificar de novo.
 */
export function sameLogBucketNames(a: LogBuckets, b: LogBuckets): boolean {
  const before = new Set(logBucketNames(a));
  const after = logBucketNames(b);
  return before.size === after.length && after.every((name) => before.has(name));
}

/** Os buckets depois de uma alteração: a fonte que não veio fica como estava; `null` tira o bucket. */
export function mergeLogBuckets(
  current: LogBuckets,
  update: Partial<Record<LogSource, string | null>> | undefined,
): LogBuckets {
  const merged: Record<LogSource, string | null> = { ...current };
  for (const source of LOG_SOURCES) {
    const value = update?.[source];
    if (value !== undefined) merged[source] = value;
  }
  return merged;
}

/**
 * Conta cloud do cliente (T3.3), com os campos do provedor. Não há campo de credencial em nenhum deles:
 * - AWS: o nó entra no papel de leitura sem chave da conta (`verax-control-reader`, derivado do ID) com o token que o
 *   Google assina para a conta de serviço dele. Não há chave nem ExternalId;
 * - GCP: o nó lê a assinatura com a identidade dele, sem chave de conta de serviço. A identidade do sink do cliente
 *   não é credencial: é só quem pode publicar no tópico do nó;
 * - Cloudflare: o token somente leitura fica no cofre de segredos do nó, nunca no cadastro.
 */
export const cloudAccountCreateSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('aws'),
    accountId: awsAccountIdSchema,
    regions: regionsSchema,
    /** Buckets de onde o Wazuh lê os logs desta conta; vinculam cada alerta ao cliente (T5.2). */
    buckets: bucketsSchema.optional(),
  }),
  z.strictObject({
    provider: z.literal('gcp'),
    accountId: gcpProjectIdSchema,
    pubsubSubscription: pubsubSubscriptionSchema.nullable().optional(),
    /** Projeto de cliente: a identidade do sink que ele criou com o comando do painel. Pode chegar depois. */
    sinkWriterIdentity: sinkWriterIdentitySchema.nullable().optional(),
  }),
  z.strictObject({
    provider: z.literal('cloudflare'),
    accountId: cloudflareAccountIdSchema,
    zones: zonesSchema.optional(),
  }),
]);
export type CloudAccountCreate = z.infer<typeof cloudAccountCreateSchema>;

/** O provedor e o ID não mudam: outra conta é outro cadastro. Cada campo só vale para o provedor dele. */
export const cloudAccountUpdateSchema = z
  .strictObject({
    regions: regionsSchema.optional(),
    buckets: bucketsSchema.optional(),
    pubsubSubscription: pubsubSubscriptionSchema.nullable().optional(),
    sinkWriterIdentity: sinkWriterIdentitySchema.nullable().optional(),
    zones: zonesSchema.optional(),
    status: z.enum(CLOUD_ACCOUNT_STATUSES).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, { error: 'informe ao menos um campo' });
export type CloudAccountUpdate = z.infer<typeof cloudAccountUpdateSchema>;

const PROVIDER_FIELDS: Record<CloudProvider, readonly string[]> = {
  aws: ['regions', 'buckets', 'status'],
  gcp: ['pubsubSubscription', 'sinkWriterIdentity', 'status'],
  cloudflare: ['zones', 'status'],
};

/** Campos de uma alteração que não existem no provedor da conta (a API recusa, em vez de ignorar). */
export function fieldsOutsideProvider(provider: CloudProvider, update: CloudAccountUpdate): string[] {
  return Object.keys(update).filter((field) => !PROVIDER_FIELDS[provider].includes(field));
}

export const cloudAccountListQuerySchema = withPagination({
  status: z.enum(CLOUD_ACCOUNT_STATUSES).optional(),
});
export type CloudAccountListQuery = z.infer<typeof cloudAccountListQuerySchema>;

export const cloudAccountSchema = z.strictObject({
  id: z.uuid(),
  provider: z.enum(CLOUD_PROVIDERS),
  accountId: cloudAccountRefSchema,
  /** AWS: regiões monitoradas. Vazio nos demais provedores. */
  regions: z.array(z.string()),
  /**
   * AWS: o papel de leitura sem chave que a pilha cria, `arn:aws:iam::<conta>:role/verax/verax-control-reader`,
   * derivado do ID da conta (nunca digitado). Null nos demais.
   */
  readerRoleArn: z.string().nullable(),
  /**
   * AWS: o ID único da conta de serviço do nó no Google (`NodeServiceAccountId` da pilha, 21 dígitos), que o
   * `start.sh` informa à API (`NODE_SA_UNIQUE_ID`). Não é segredo. Null nos demais provedores e no nó que não informa.
   */
  nodeServiceAccountId: z
    .string()
    .regex(/^\d{21}$/)
    .nullable(),
  /** AWS: o audience do token do nó (`Audience` da pilha). Null nos demais. */
  webIdentityAudience: z.string().max(256).nullable(),
  /** AWS: buckets de log por fonte. Todos null nos demais. */
  buckets: z.strictObject({
    cloudtrail: z.string().nullable(),
    guardduty: z.string().nullable(),
    waf: z.string().nullable(),
  }),
  /** GCP: assinatura do Pub/Sub lida pelo nó; null antes de configurada e nos demais. */
  pubsubSubscription: z.string().nullable(),
  /**
   * GCP: tópico do nó para onde o sink do cliente publica (`projects/<projeto-do-nó>/topics/<nome>`), o do comando
   * pronto. Null nos demais provedores e no nó que não informa o próprio tópico (ambiente local).
   */
  sinkTopic: z.string().nullable(),
  /** GCP: identidade do sink que o cliente criou e colou no painel; null antes disso e nos demais. Não é segredo. */
  sinkWriterIdentity: z.string().nullable(),
  /** Cloudflare: zonas (domínios) monitoradas. Vazio nos demais. */
  zones: z.array(z.string()),
  /**
   * Credencial guardada no cofre do nó (fase 2): só os metadados (tipo, `…abcd`, validade, última conferência). Null
   * sem credencial. O segredo nunca sai pela API.
   */
  keyStatus: cloudCredentialStatusSchema.nullable(),
  /**
   * IPs de saída do nó (`NODE_EGRESS_IPS`, IPv4 com /32). Na AWS, o `NodeEgressIps` da pilha (o papel só aceita o nó
   * vindo deles); no Cloudflare, o filtro de IP recomendado para o token. Vazio na GCP e no nó que não informa. Não é
   * segredo.
   */
  egressIps: z.array(z.string()),
  status: z.enum(CLOUD_ACCOUNT_STATUSES),
  /**
   * Estado da coleta, gravado pelo worker: `waiting` até o primeiro sinal de vida, `connected` depois dele e `error`
   * quando a última leitura da fonte falhou. Na GCP, o sinal é o evento recebido; no Cloudflare, a leitura
   * bem-sucedida, mesmo sem evento; na AWS, a verificação do papel de leitura ("Verificar") ou o primeiro evento.
   */
  connection: z.enum(CLOUD_ACCOUNT_CONNECTIONS),
  /**
   * Tipo do último erro de coleta (`AccessDenied`; na AWS, os códigos de `AWS_CONNECTION_ERROR_CODES`), em `error`.
   * Na AWS, também em `connected`, com um aviso que não para a coleta (`AWS_CONNECTION_WARNING_CODES`). Nunca a
   * mensagem nem segredo.
   */
  connectionError: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .nullable(),
  /**
   * AWS: quando um administrador pediu "Verificar" e o worker ainda não respondeu (a conexão fica em `waiting`). Null
   * sem pedido pendente e nos demais provedores.
   */
  checkRequestedAt: z.iso.datetime().nullable(),
  /**
   * AWS: a data (`AAAA-MM-DD`) a partir da qual o Wazuh lê os logs dos buckets: a da primeira verificação bem-sucedida,
   * menos um dia. Gravada uma vez só, pelo worker. Null antes dela e nos demais provedores.
   */
  ingestFrom: z.iso.date().nullable(),
  /** Última leitura bem-sucedida da fonte, com ou sem evento; null antes da primeira. */
  lastCollectedAt: z.iso.datetime().nullable(),
  /** Horário do último alerta recebido desta conta (T5.3); null se nunca chegou nada. */
  lastEventAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CloudAccount = z.infer<typeof cloudAccountSchema>;

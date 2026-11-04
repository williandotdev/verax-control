import { z } from 'zod';
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
/** Fontes de log que o Wazuh lê de buckets S3 da conta do cliente (T4.4 a T4.6). */
export const LOG_SOURCES = ['cloudtrail', 'guardduty', 'waf'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** Papel criado pelo template do conector (T4.3) em toda conta: o cadastro não escolhe papel. */
export const READ_ONLY_ROLE_NAME = 'VeraxControlReadOnly';

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

/** Regras de nome de bucket do S3: 3 a 63 caracteres, minúsculas, números, ponto e hífen, sem formato de IP. */
const bucketSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, { error: 'nome de bucket S3 inválido' })
  .refine((name) => !/^\d+\.\d+\.\d+\.\d+$/.test(name) && !name.includes('..'), {
    error: 'nome de bucket S3 inválido',
  });

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

/**
 * A identidade como o gcloud mostra (entre crases, no aviso do `sinks create`) ou só o e-mail dela vira a forma
 * completa, `serviceAccount:<e-mail>`, que é a que o IAM aceita. Outro tipo (`user:`, `group:`) fica como está, e o
 * schema recusa.
 */
export function normalizeSinkWriterIdentity(value: string): string {
  const trimmed = value.replace(/^[\s`'"]+|[\s`'"]+$/g, '');
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

const bucketsSchema = z.strictObject({
  cloudtrail: bucketSchema.nullable().optional(),
  guardduty: bucketSchema.nullable().optional(),
  // O logging do WAF só grava em bucket com este prefixo (exigência da AWS).
  waf: bucketSchema
    .refine((name) => name.startsWith('aws-waf-logs-'), { error: 'o bucket do WAF começa com aws-waf-logs-' })
    .nullable()
    .optional(),
});

/**
 * Conta cloud do cliente (T3.3), com os campos do provedor. Não há campo de credencial em nenhum deles:
 * - AWS: a Verax só assume o papel de leitura com o ExternalId, gerado pelo servidor e nunca aceito do request;
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
  /** AWS: papel de leitura do conector. Null nos demais. */
  roleArn: z.string().nullable(),
  /** AWS, só para quem configura o conector (`cloud_accounts:write`); para os demais e fora da AWS, null. */
  externalId: z.string().nullable(),
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
  status: z.enum(CLOUD_ACCOUNT_STATUSES),
  /**
   * Estado da coleta, gravado pelo sync da conta: `waiting` até o primeiro sinal de vida, `connected` depois dele e
   * `error` quando a última leitura da fonte falhou. Na AWS e na GCP, o sinal é o evento recebido; no Cloudflare,
   * a leitura bem-sucedida, mesmo sem evento.
   */
  connection: z.enum(CLOUD_ACCOUNT_CONNECTIONS),
  /** Tipo do último erro de coleta (`AccessDenied`, `TimeoutError`), só em `error`. Nunca a mensagem nem segredo. */
  connectionError: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,64}$/)
    .nullable(),
  /** Última leitura bem-sucedida da fonte, com ou sem evento; null antes da primeira. */
  lastCollectedAt: z.iso.datetime().nullable(),
  /** Horário do último alerta recebido desta conta (T5.3); null se nunca chegou nada. */
  lastEventAt: z.iso.datetime().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type CloudAccount = z.infer<typeof cloudAccountSchema>;

export function readOnlyRoleArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role/${READ_ONLY_ROLE_NAME}`;
}

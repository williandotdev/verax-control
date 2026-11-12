import {
  isMailAddress,
  isNodeImagesRepository,
  isNodeMailAddress,
  isNodeSmtpHost,
  isNodeSmtpUser,
  NODE_RELEASE_PATTERN,
} from '../common/config/env.schema.js';
import { isUlid } from '../common/ulid.js';
import { COMPANY_NAME_MAX_LENGTH } from '../tenants/tenant.schema.js';

/**
 * As variáveis de cada execução do Job `cp-terraform` (plano §4c, passo 4), que o cp-worker manda em
 * `overrides.containerOverrides.env` e o `entrypoint.sh` da imagem (`infra/control-plane/terraform`) confere de novo,
 * com as mesmas expressões, antes do `terraform init`; o `envs/tenant` confere uma terceira vez nas `validation`. As
 * fixas do Job (projeto, região, zona, bucket do estado, conta do cp-worker) vêm do Terraform do plano de controle
 * (`job_env` em `envs/control-plane/run.tf`) e não vão aqui.
 *
 * Nada de segredo: o nome do cliente e os e-mails são dados de cadastro, que o Terraform põe nos metadados da VM. O
 * Cloud Run guarda as variáveis na execução (`executions.get`), visíveis a quem lê o Job no projeto da Verax. Do e-mail
 * dos nós vão só o servidor, a porta e o usuário: a senha nunca passa pelo Job nem pelo Terraform (o cp-worker a copia
 * para o cofre do nó, passo `secrets.smtp_password`).
 */
export const EXECUTOR_ACTIONS = ['apply', 'destroy'] as const;
export type ExecutorAction = (typeof EXECUTOR_ACTIONS)[number];

/**
 * O tipo da execução (plano §3, `provisioningRuns.kind`). O `entrypoint.sh` amarra a ação ao tipo (CP-11): `apply` só
 * em `provision` e `resume`; `destroy` (a Exclusão 1, a única que apaga a conta de serviço do nó) só em `delete`; e
 * `purge` (a Exclusão 2: o cofre `credentials-key`, o bucket de backups e o estado) só em `crypto_destroy`.
 */
export const RUN_KINDS = ['provision', 'resume', 'delete', 'crypto_destroy'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

/** A ação de cada tipo de execução, a mesma tabela do `entrypoint.sh`. */
export const ACTION_OF_KIND: Readonly<Record<RunKind, ExecutorAction | 'purge'>> = {
  provision: 'apply',
  resume: 'apply',
  delete: 'destroy',
  crypto_destroy: 'purge',
};

/**
 * As variáveis da Exclusão 2 (`EXECUTOR_ACTION=purge`, `RUN_KIND=crypto_destroy`): só o endereço (o slug e a execução).
 * O executor deriva dele os nomes que apaga (`vx-<slug>-credentials-key`, `<projeto>-vx-<slug>-backups` e
 * `tenants/<slug>/default.tfstate`) e não recebe dado pessoal nenhum (o e-mail do admin já saiu na Exclusão 1).
 */
export function purgeExecutorEnv(input: { runId: string; slug: string }): { name: string; value: string }[] {
  check(isUlid(input.runId), 'RUN_ID');
  check(isSlug(input.slug), 'TENANT_SLUG');
  return [
    { name: 'EXECUTOR_ACTION', value: 'purge' },
    { name: 'RUN_KIND', value: 'crypto_destroy' },
    { name: 'RUN_ID', value: input.runId },
    { name: 'TENANT_SLUG', value: input.slug },
  ];
}

export interface ExecutorInput {
  action: ExecutorAction;
  kind: RunKind;
  runId: string;
  slug: string;
  /** `enterprise` com os quatro limites (preço configurável, `node-limits.ts`). */
  plan: 'essencial' | 'profissional' | 'enterprise';
  limits?: { maxCloudAccounts: number; maxUsers: number; monthlyGib: number; historyDays: number };
  nodeVersion: string;
  nodePackageSha256: string;
  webOrigin: string;
  apiOrigin: string;
  mailFrom: string;
  subnetCidr: string;
  adminEmail: string;
  tenantName: string;
  supportEmail: string;
  imagesRepository: string;
  /** A caixa de envio dos nós (`SMTP_*_NODES`); sem ela, as três variáveis vão vazias e o nó nasce sem e-mail. */
  nodeMail?: { host: string; port: number; user: string };
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HOST_LABEL_CHARS = /^[a-z0-9-]{1,63}$/;
/** Uma /24 em 10.0.0.0/8 pelo endereço da rede, sem zero à esquerda (o `cidrhost` do envs/tenant não aceita 10.08). */
const SUBNET_PATTERN = /^10\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.0\/24$/;
const LIMIT_PATTERN = /^[1-9][0-9]{0,5}$/;
const PORT_PATTERN = /^[1-9][0-9]{0,4}$/;
// Faixa de controle: o C0 inteiro e o DEL (o `[[:cntrl:]]` do `envs/tenant`).
// eslint-disable-next-line no-control-regex -- é exatamente a faixa de controle que a regra recusa
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

/** Os limites que o `envs/tenant` aceita (`plans.ts`): uma configuração vendida fora disso não sobe sem mudar o nó. */
export const NODE_LIMIT_RANGES = {
  maxCloudAccounts: [1, 1000],
  maxUsers: [1, 1000],
  monthlyGib: [1, 100_000],
  historyDays: [30, 3650],
} as const;

/** O valor fora do formato: só o nome da variável vai para o erro (e para o log), nunca o valor. */
export class ExecutorInputError extends Error {
  constructor(readonly variable: string) {
    super(`variável do executor fora do formato: ${variable}`);
    this.name = 'ExecutorInputError';
  }
}

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value) && value.slice(2, 4) !== '--';
}

/** Só a origem https (`https://<nome>`), em minúsculas, sem porta, caminho nem barra no fim; dois rótulos ou mais. */
export function isOrigin(value: string): boolean {
  if (value.length > 261 || !value.startsWith('https://')) return false;
  const labels = value.slice('https://'.length).split('.');
  return labels.length >= 2 && labels.every(isHostLabel);
}

/**
 * Um rótulo de nome de domínio em minúsculas, de 1 a 63 caracteres, sem hífen nas pontas: a regra
 * `[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?` do `envs/tenant` e do `boot-install.sh`, sem quantificador aninhado.
 */
function isHostLabel(label: string): boolean {
  return HOST_LABEL_CHARS.test(label) && !label.startsWith('-') && !label.endsWith('-');
}

export function isSubnetCidr(value: string): boolean {
  const match = SUBNET_PATTERN.exec(value);
  return match !== null && Number(match[1]) <= 255 && Number(match[2]) <= 255;
}

/** O e-mail como o `z.email()` do zod 4 e o `envs/tenant` aceitam (com apóstrofo e `+`). */
export function isTenantEmail(value: string): boolean {
  return isMailAddress(value);
}

/**
 * Nome do cliente no nó: de 2 a 120 caracteres (`COMPANY_NAME_MAX_LENGTH`, o `Tenant.name` do nó), sem espaço nas
 * pontas e sem controle. O mínimo em pontos de código, como o `entrypoint.sh`; o máximo em unidades UTF-16 (o `length`
 * do JS), como o checkout e o `node-bootstrap` do nó contam: o que passa aqui nunca é recusado pelo executor (até 120
 * pontos de código), pelo `envs/tenant` nem pelo nó. É a conferência de defesa do provisionamento: o checkout e o
 * `customer.updated` já limitam a 120, e só um cliente gravado antes do limite chega aqui com mais
 * (`tenant_name_invalid`).
 */
export function isTenantName(value: string): boolean {
  return (
    [...value].length >= 2 &&
    value.length <= COMPANY_NAME_MAX_LENGTH &&
    value.trim() === value &&
    !CONTROL_PATTERN.test(value)
  );
}

function inRange(value: number, [min, max]: readonly [number, number]): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** `true` se os limites cabem no que o `envs/tenant` aceita. */
export function limitsFitNode(limits: NonNullable<ExecutorInput['limits']>): boolean {
  return (
    inRange(limits.maxCloudAccounts, NODE_LIMIT_RANGES.maxCloudAccounts) &&
    inRange(limits.maxUsers, NODE_LIMIT_RANGES.maxUsers) &&
    inRange(limits.monthlyGib, NODE_LIMIT_RANGES.monthlyGib) &&
    inRange(limits.historyDays, NODE_LIMIT_RANGES.historyDays)
  );
}

function check(ok: boolean, variable: string): void {
  if (!ok) throw new ExecutorInputError(variable);
}

/** A porta do servidor de envio: de 1 a 65535, só dígitos e sem zero à esquerda (a regra do `envs/tenant`). */
export function isSmtpPort(value: string): boolean {
  return PORT_PATTERN.test(value) && Number(value) <= 65535;
}

/**
 * A lista `env` do `overrides` do Job, conferida variável a variável (`ExecutorInputError` cita só o nome). A ordem é
 * fixa, para o teste comparar a lista inteira.
 */
export function executorEnv(input: ExecutorInput): { name: string; value: string }[] {
  check((EXECUTOR_ACTIONS as readonly string[]).includes(input.action), 'EXECUTOR_ACTION');
  check((RUN_KINDS as readonly string[]).includes(input.kind), 'RUN_KIND');
  // A ação é a do tipo (a Exclusão 1 destrói; nenhuma outra execução destrói): a mesma recusa do entrypoint.sh.
  check(ACTION_OF_KIND[input.kind] === input.action, 'EXECUTOR_ACTION');
  check(isUlid(input.runId), 'RUN_ID');
  check(isSlug(input.slug), 'TENANT_SLUG');
  check(['essencial', 'profissional', 'enterprise'].includes(input.plan), 'PLAN');
  check(input.plan !== 'enterprise' || input.limits !== undefined, 'PLAN_MAX_CLOUD_ACCOUNTS');
  if (input.limits !== undefined) check(limitsFitNode(input.limits), 'PLAN_MAX_CLOUD_ACCOUNTS');
  check(NODE_RELEASE_PATTERN.test(input.nodeVersion), 'NODE_VERSION');
  check(SHA256_PATTERN.test(input.nodePackageSha256), 'NODE_PACKAGE_SHA256');
  check(isOrigin(input.webOrigin), 'WEB_ORIGIN');
  check(isOrigin(input.apiOrigin) && input.apiOrigin !== input.webOrigin, 'API_ORIGIN');
  check(isNodeMailAddress(input.mailFrom), 'MAIL_FROM');
  check(isSubnetCidr(input.subnetCidr), 'SUBNET_CIDR');
  check(isTenantEmail(input.adminEmail), 'BOOTSTRAP_ADMIN_EMAIL');
  check(isTenantName(input.tenantName), 'BOOTSTRAP_TENANT_NAME');
  check(
    isTenantEmail(input.supportEmail) && input.supportEmail.toLowerCase() !== input.adminEmail.toLowerCase(),
    'BOOTSTRAP_SUPPORT_EMAIL',
  );
  check(isNodeImagesRepository(input.imagesRepository), 'IMAGES_REPOSITORY');
  const mail = input.nodeMail;
  if (mail !== undefined) {
    check(isNodeSmtpHost(mail.host), 'SMTP_HOST');
    check(Number.isInteger(mail.port) && isSmtpPort(String(mail.port)), 'SMTP_PORT');
    check(isNodeSmtpUser(mail.user), 'SMTP_USER');
  }
  const limit = (value: number | undefined): string => (value === undefined ? '' : String(value));
  const env: [string, string][] = [
    ['EXECUTOR_ACTION', input.action],
    ['RUN_KIND', input.kind],
    ['RUN_ID', input.runId],
    ['TENANT_SLUG', input.slug],
    ['PLAN', input.plan],
    ['PLAN_MAX_CLOUD_ACCOUNTS', limit(input.limits?.maxCloudAccounts)],
    ['PLAN_MAX_USERS', limit(input.limits?.maxUsers)],
    ['PLAN_MONTHLY_GIB', limit(input.limits?.monthlyGib)],
    ['PLAN_HISTORY_DAYS', limit(input.limits?.historyDays)],
    ['NODE_VERSION', input.nodeVersion],
    ['NODE_PACKAGE_SHA256', input.nodePackageSha256],
    ['WEB_ORIGIN', input.webOrigin],
    ['API_ORIGIN', input.apiOrigin],
    ['MAIL_FROM', input.mailFrom],
    ['SUBNET_CIDR', input.subnetCidr],
    ['BOOTSTRAP_ADMIN_EMAIL', input.adminEmail],
    ['BOOTSTRAP_TENANT_NAME', input.tenantName],
    ['BOOTSTRAP_SUPPORT_EMAIL', input.supportEmail],
    ['IMAGES_REPOSITORY', input.imagesRepository],
    ['SMTP_HOST', mail?.host ?? ''],
    ['SMTP_PORT', mail === undefined ? '' : String(mail.port)],
    ['SMTP_USER', mail?.user ?? ''],
  ];
  for (const [name, value] of env) {
    if (name.startsWith('PLAN_') && value !== '') check(LIMIT_PATTERN.test(value), name);
  }
  return env.map(([name, value]) => ({ name, value }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Cliente da célula (CE-07): o `infra/gcp/envs/cell-tenant` de um cliente, no mesmo Job `cp-terraform`, com o estado em
// `cells/<célula>/tenants/<slug>/` e os recursos no projeto da célula. O `entrypoint.sh` amarra a ação ao tipo e confere
// cada variável de novo, com as mesmas regras; o `envs/cell-tenant` confere uma terceira vez.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Os tipos de execução do cliente da célula: `cell_provision` (o provisionamento), `cell_sources` (as contas GCP do
 * cliente mudaram, CE-08) e `cell_delete` (o expurgo do cliente, CE-16, o único que apaga a conta de serviço dele).
 */
export const CELL_RUN_KINDS = ['cell_provision', 'cell_sources', 'cell_delete'] as const;
export type CellRunKind = (typeof CELL_RUN_KINDS)[number];

/** A ação de cada tipo de execução da célula, a mesma tabela do `entrypoint.sh`. */
export const CELL_ACTION_OF_KIND: Readonly<Record<CellRunKind, ExecutorAction>> = {
  cell_provision: 'apply',
  cell_sources: 'apply',
  cell_delete: 'destroy',
};

/** Uma conta GCP do cliente da célula: o UUID da conta cloud, o projeto e a identidade do sink que ele colou. */
export interface CellGcpSource {
  cloudAccountId: string;
  projectId: string;
  writerIdentity: string;
}

export interface CellTenantExecutorInput {
  kind: CellRunKind;
  runId: string;
  slug: string;
  /** O registro da célula (`cells/<id>`, CE-15): o `cell_id`, o projeto, a região e a conta da VM do envs/celula. */
  cellId: string;
  cellProjectId: string;
  cellRegion: string;
  cellNodeServiceAccount: string;
  gcpSources: readonly CellGcpSource[];
}

const CELL_ID_PATTERN = /^[a-z][a-z0-9]{1,7}$/;
/** As regras do `gcpProjectIdSchema` e do `SINK_WRITER_IDENTITY_PATTERN` (packages/shared), do módulo do nó e do envs/cell-tenant. */
const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const SINK_WRITER_IDENTITY_PATTERN =
  /^serviceAccount:service-[0-9]+@gcp-sa-logging\.iam\.gserviceaccount\.com$/;
const GCP_REGION_PATTERN = /^[a-z]+-[a-z]+[0-9]$/;
const SERVICE_ACCOUNT_LOCAL_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** O UUID da conta cloud do nó, em minúsculas (o `id` da conta no painel). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** O limite do `envs/cell-tenant` (e do entrypoint) de contas GCP por cliente. */
export const CELL_GCP_SOURCES_MAX = 50;

/** A conta de serviço da VM da célula, no projeto da célula (e em nenhum outro). */
function isCellServiceAccount(email: string, project: string): boolean {
  const suffix = `@${project}.iam.gserviceaccount.com`;
  return email.endsWith(suffix) && SERVICE_ACCOUNT_LOCAL_PATTERN.test(email.slice(0, -suffix.length));
}

/**
 * As contas GCP em JSON, na forma canônica que o `entrypoint.sh` também produz (`jq -cS`: chaves em ordem, compacto). O
 * nome de cada tópico sai do UUID da conta, nunca do projeto (envs/cell-tenant).
 */
function gcpSourcesJson(sources: readonly CellGcpSource[]): string {
  const ordered = [...sources].sort((a, b) => (a.cloudAccountId < b.cloudAccountId ? -1 : 1));
  const entries = ordered.map(
    (source) =>
      `${JSON.stringify(source.cloudAccountId)}:{"project_id":${JSON.stringify(source.projectId)},"writer_identity":${JSON.stringify(source.writerIdentity)}}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * A lista `env` do `overrides` do Job para o cliente da célula, conferida variável a variável (`ExecutorInputError` cita
 * só o nome). Nada de dado pessoal: o e-mail do administrador vai pelo comando da célula (CE-05), nunca pelo Terraform.
 */
export function cellTenantExecutorEnv(input: CellTenantExecutorInput): { name: string; value: string }[] {
  check((CELL_RUN_KINDS as readonly string[]).includes(input.kind), 'RUN_KIND');
  check(isUlid(input.runId), 'RUN_ID');
  check(isSlug(input.slug), 'TENANT_SLUG');
  check(CELL_ID_PATTERN.test(input.cellId), 'CELL_ID');
  check(GCP_PROJECT_PATTERN.test(input.cellProjectId), 'CELL_PROJECT_ID');
  check(GCP_REGION_PATTERN.test(input.cellRegion), 'CELL_REGION');
  check(isCellServiceAccount(input.cellNodeServiceAccount, input.cellProjectId), 'CELL_NODE_SA');
  const sources = input.gcpSources;
  check(sources.length <= CELL_GCP_SOURCES_MAX, 'GCP_SOURCES');
  for (const source of sources) {
    check(
      UUID_PATTERN.test(source.cloudAccountId) &&
        GCP_PROJECT_PATTERN.test(source.projectId) &&
        source.writerIdentity.length <= 128 &&
        SINK_WRITER_IDENTITY_PATTERN.test(source.writerIdentity),
      'GCP_SOURCES',
    );
  }
  const distinct = (values: string[]) => new Set(values).size === values.length;
  check(
    distinct(sources.map((source) => source.cloudAccountId)) &&
      distinct(sources.map((source) => source.projectId)) &&
      distinct(sources.map((source) => source.writerIdentity)),
    'GCP_SOURCES',
  );
  const env: [string, string][] = [
    ['EXECUTOR_ACTION', CELL_ACTION_OF_KIND[input.kind]],
    ['RUN_KIND', input.kind],
    ['RUN_ID', input.runId],
    ['TENANT_SLUG', input.slug],
    ['CELL_ID', input.cellId],
    ['CELL_PROJECT_ID', input.cellProjectId],
    ['CELL_REGION', input.cellRegion],
    ['CELL_NODE_SA', input.cellNodeServiceAccount],
    ['GCP_SOURCES', gcpSourcesJson(sources)],
  ];
  return env.map(([name, value]) => ({ name, value }));
}

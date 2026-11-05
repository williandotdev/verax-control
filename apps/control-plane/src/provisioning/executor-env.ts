import {
  isMailAddress,
  isNodeImagesRepository,
  isNodeMailAddress,
  NODE_RELEASE_PATTERN,
} from '../common/config/env.schema.js';
import { isUlid } from '../common/ulid.js';

/**
 * As variáveis de cada execução do Job `cp-terraform` (plano §4c, passo 4), que o cp-worker manda em
 * `overrides.containerOverrides.env` e o `entrypoint.sh` da imagem (`infra/control-plane/terraform`) confere de novo,
 * com as mesmas expressões, antes do `terraform init`; o `envs/tenant` confere uma terceira vez nas `validation`. As
 * fixas do Job (projeto, região, zona, bucket do estado, conta do cp-worker) vêm do Terraform do plano de controle
 * (`job_env` em `envs/control-plane/run.tf`) e não vão aqui.
 *
 * Nada de segredo: o nome do cliente e os e-mails são dados de cadastro, que o Terraform põe nos metadados da VM. O
 * Cloud Run guarda as variáveis na execução (`executions.get`), visíveis a quem lê o Job no projeto da Verax.
 */
export const EXECUTOR_ACTIONS = ['apply', 'destroy'] as const;
export type ExecutorAction = (typeof EXECUTOR_ACTIONS)[number];

/**
 * O tipo da execução (plano §3, `provisioningRuns.kind`). Só `delete` e `crypto_destroy` (a exclusão do cliente, CP-11)
 * podem destruir ou recriar a conta de serviço do nó; o `entrypoint.sh` recusa o resto antes do `apply`.
 */
export const RUN_KINDS = ['provision', 'resume', 'delete', 'crypto_destroy'] as const;
export type RunKind = (typeof RUN_KINDS)[number];

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
}

const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,14}[a-z0-9]$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const HOST_LABEL_CHARS = /^[a-z0-9-]{1,63}$/;
/** Uma /24 em 10.0.0.0/8 pelo endereço da rede, sem zero à esquerda (o `cidrhost` do envs/tenant não aceita 10.08). */
const SUBNET_PATTERN = /^10\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.0\/24$/;
const LIMIT_PATTERN = /^[1-9][0-9]{0,5}$/;
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

/** Nome do cliente no nó: de 2 a 200 caracteres (pontos de código), sem espaço nas pontas e sem controle. */
export function isTenantName(value: string): boolean {
  const length = [...value].length;
  return length >= 2 && length <= 200 && value.trim() === value && !CONTROL_PATTERN.test(value);
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

/**
 * A lista `env` do `overrides` do Job, conferida variável a variável (`ExecutorInputError` cita só o nome). A ordem é
 * fixa, para o teste comparar a lista inteira.
 */
export function executorEnv(input: ExecutorInput): { name: string; value: string }[] {
  check((EXECUTOR_ACTIONS as readonly string[]).includes(input.action), 'EXECUTOR_ACTION');
  check((RUN_KINDS as readonly string[]).includes(input.kind), 'RUN_KIND');
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
  ];
  for (const [name, value] of env) {
    if (name.startsWith('PLAN_') && value !== '') check(LIMIT_PATTERN.test(value), name);
  }
  return env.map(([name, value]) => ({ name, value }));
}

/**
 * O nome do cliente no nó: o nó guarda até 120 caracteres (`Tenant.name`, `VarChar(120)`, CP-10), e o checkout aceita
 * até 200. Uma razão social mais longa é cortada em 120 pontos de código (sem espaço no fim) só no nó, que a usa como
 * rótulo; a razão social inteira continua no plano de controle e na Stripe.
 */
export const NODE_TENANT_NAME_MAX = 120;
export function nodeTenantName(legalName: string): string {
  const points = [...legalName.trim()];
  return points.length <= NODE_TENANT_NAME_MAX
    ? points.join('')
    : points.slice(0, NODE_TENANT_NAME_MAX).join('').trimEnd();
}

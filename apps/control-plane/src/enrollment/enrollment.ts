import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import { ULID_PATTERN } from '../common/ulid.js';
import { SIZE_IDS } from '../pricing/pricing.schema.js';
import type { Tenant, TenantState } from '../tenants/tenant.schema.js';

/**
 * O registro da VM do cliente (`hosting = customer`, `NODE_PLATFORM=vm`; contrato de 18/11/2026). O responsável gera um
 * código de uso único no console; o instalador na VM o troca (`claim`) pelo que é da Verax (o token do túnel e a senha
 * do e-mail dos nós) e por uma chave do nó, com que depois avisa que ficou pronto (`report`) e entrega a senha
 * temporária do primeiro admin. O código e a chave do nó são 32 bytes aleatórios em base64url (43 caracteres) e ficam
 * no cliente só como SHA-256 em hexadecimal (`tenant.enrollment`); nunca vão a log, auditoria nem erro.
 */

/** O código e a chave do nó: 32 bytes em base64url, sem preenchimento. */
export const ENROLLMENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** O código vale 7 dias; gerar outro revoga o anterior. */
export const ENROLLMENT_CODE_TTL_MS = 7 * 24 * 60 * 60_000;
/** O código de erro que a VM manda no `report` (o mesmo formato do `verax/error` do nó gerenciado, com dígitos). */
export const NODE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Estados em que o responsável pode gerar um código: a espera da instalação (o primeiro, que começa o provisionamento
 * reduzido), o provisionamento em andamento ou parado (um código novo; parado, recomeça a execução) e o ambiente já
 * pronto (reinstalar a VM). Cancelado e excluído, nunca.
 */
export const ENROLLMENT_CODE_STATES: readonly TenantState[] = [
  'waiting_customer_install',
  'provisioning',
  'provisioning_failed',
  'waiting_customer_connection',
  'active',
];

/**
 * Estados em que a VM pode fazer o `claim` e o `report`: o provisionamento em andamento (a primeira instalação) e o
 * ambiente pronto (uma reinstalação com um código novo). `past_due` fica de fora: é só da cobrança pela Stripe, e o
 * ambiente na VM do cliente é sempre contrato direto.
 */
export const ENROLLMENT_ACTIVE_STATES: ReadonlySet<TenantState> = new Set([
  'provisioning',
  'waiting_customer_connection',
  'active',
]);

/** O cofre da senha temporária do primeiro admin no projeto dos nós (o mesmo nome do módulo `node`). */
export function adminBootstrapSecret(slug: string): string {
  return `vx-${slug}-admin-bootstrap`;
}

/** Um segredo novo do registro (o código ou a chave do nó). */
export function newEnrollmentSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** O SHA-256 em hexadecimal, a única forma em que o código e a chave do nó são guardados. */
export function enrollmentHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Compara dois hashes em tempo constante (os dois têm 64 caracteres hexadecimais quando bem formados). */
export function sameHash(expected: string | undefined, actual: string): boolean {
  if (expected === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * O código ainda pode ser trocado: o hash confere (em tempo constante), o cliente roda no cliente, num estado em que a
 * VM pode se registrar, o código não venceu e ainda não foi usado. Tudo o que não confere é o mesmo 404.
 */
export function codeClaimable(tenant: Tenant, codeHash: string, now: Date): boolean {
  const enrollment = tenant.enrollment;
  return (
    tenant.hosting === 'customer' &&
    ENROLLMENT_ACTIVE_STATES.has(tenant.state) &&
    enrollment !== undefined &&
    sameHash(enrollment.codeHash, codeHash) &&
    enrollment.claimedAt === undefined &&
    enrollment.codeExpiresAt.getTime() > now.getTime()
  );
}

/** A chave do nó vale: o hash confere (em tempo constante), num cliente no cliente e num estado em que a VM reporta. */
export function nodeKeyValid(tenant: Tenant, nodeKeyHash: string): boolean {
  return (
    tenant.hosting === 'customer' &&
    ENROLLMENT_ACTIVE_STATES.has(tenant.state) &&
    sameHash(tenant.enrollment?.nodeKeyHash, nodeKeyHash)
  );
}

const secretSchema = z.string().regex(ENROLLMENT_SECRET_PATTERN);

/** `POST /v1/node-enrollment/claim`: o código, a versão que o instalador baixou e o que ele viu da máquina. */
export const claimRequestSchema = z.strictObject({
  code: secretSchema,
  release: z.string().regex(NODE_RELEASE_PATTERN),
  host: z.strictObject({
    cpus: z.number().int().min(1).max(1024),
    memoryMb: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
    diskGb: z
      .number()
      .int()
      .min(1)
      .max(1024 * 1024),
    os: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9 ._()/+-]+$/),
    arch: z
      .string()
      .min(1)
      .max(32)
      .regex(/^[A-Za-z0-9_-]+$/),
  }),
});
export type ClaimRequest = z.infer<typeof claimRequestSchema>;

/** `POST /v1/node-enrollment/report` (com `Authorization: Bearer <nodeKey>`): pronto, com a senha, ou o erro. */
export const reportRequestSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('ready'),
    version: z.string().regex(NODE_RELEASE_PATTERN),
    adminBootstrapPassword: z.string().min(16).max(256),
  }),
  z.strictObject({ status: z.literal('error'), code: z.string().regex(NODE_ERROR_CODE_PATTERN) }),
]);
export type ReportRequest = z.infer<typeof reportRequestSchema>;

/** A chave do nó no cabeçalho `Authorization: Bearer <nodeKey>`; fora do formato, `undefined`. */
export function nodeKeyFromAuthorization(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string' || header.length > 100) return undefined;
  const [scheme, value, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || value === undefined || rest.length > 0) return undefined;
  return ENROLLMENT_SECRET_PATTERN.test(value) ? value : undefined;
}

/** Uma linha do `node.conf` que o contrato define (o plano e os limites, `nodeLimitsEnv`). */
const nodeConfLineSchema = z.strictObject({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  value: z.string().max(200),
});

/**
 * A resposta do `claim`, uma vez só. O cp-public confere o que o cp-worker devolveu antes de repassar à VM. `mail` é
 * `null` com o e-mail dos nós desligado (sem `SMTP_HOST_NODES`): o nó sobe com `MAIL_TRANSPORT=none`, como o gerenciado.
 */
export const claimResponseSchema = z.strictObject({
  tenantId: z.string().regex(ULID_PATTERN),
  slug: z.string().min(3).max(16),
  apiOrigin: z.url({ protocol: /^https$/ }).max(300),
  webOrigin: z.url({ protocol: /^https$/ }).max(300),
  release: z.string().regex(NODE_RELEASE_PATTERN),
  size: z.enum(SIZE_IDS),
  nodeConf: z.array(nodeConfLineSchema).max(20),
  tenantName: z.string().min(1).max(200),
  adminEmail: z.email().max(254),
  adminName: z.string().min(1).max(200).optional(),
  supportEmail: z.email().max(254).optional(),
  mail: z
    .strictObject({
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65_535),
      user: z.string().min(1).max(254),
      from: z.string().min(1).max(320),
      password: z.string().min(1).max(256),
    })
    .nullable(),
  tunnelToken: z.string().min(1).max(4096),
  nodeKey: secretSchema,
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

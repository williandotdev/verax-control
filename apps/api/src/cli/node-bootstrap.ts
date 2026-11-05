import 'reflect-metadata';
import {
  gcpProjectIdSchema,
  isPubsubSubscriptionName,
  type ResolvedPlan,
  type TemporaryPassword,
} from '@verax/shared';
import { readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type Auth, createAuth } from '../auth/auth.factory.js';
import { setTemporaryPassword } from '../auth/temporary-password.js';
import { provisionUser } from '../auth/user-provisioning.js';
import { AuditService } from '../common/audit/audit.service.js';
import { nodePlan } from '../common/config/env.schema.js';
import { loadConfig } from '../common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from '../common/config/load-env-file.js';
import { errorKind } from '../common/logger/error-kind.js';
import { registerLiveSecret, sanitize } from '../common/logger/sanitize.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { mailTransport } from '../mail/mail.module.js';

/**
 * Primeira configuração de um nó, rodada na instalação (`docker compose run --rm api node dist/cli/node-bootstrap.js`):
 * - o primeiro `admin_verax`, com uma senha temporária (a mesma regra do painel: no primeiro login, troca a senha e
 *   cadastra o MFA). A senha sai numa linha marcada da saída, que o `start.sh` grava num arquivo só de root na VM: ela
 *   não fica no log nem na tela de quem rodou;
 * - o cliente do nó e as contas da GCP dele, cada uma com a sua assinatura do Pub/Sub;
 * - o rótulo do plano do nó (`PLAN`) em `Tenant.plan`. Quem vale é o ambiente: o cadastro só mostra o plano, e cada
 *   execução o atualiza se o `PLAN` mudou.
 *
 * Idempotente: o que já existe fica como está (inclusive um admin que já definiu a própria senha). Cada criação entra
 * na trilha de auditoria como ação do sistema. Os valores vêm do ambiente da instalação, nunca do repositório.
 *
 * Saída de emergência: com `BOOTSTRAP_RENEW_ADMIN_PASSWORD=true`, o admin que esqueceu a senha recebe uma temporária
 * nova (o MFA continua). Num nó sem e-mail não há link de redefinição, e só quem é root na VM roda isto.
 *
 * Esse é o modo `verax` (o padrão, sem `BOOTSTRAP_MODE`): o nó da Verax e a instalação com SSH, exatamente como antes.
 * O modo `customer` (`BOOTSTRAP_MODE=customer`, fase 3, CP-10) é o do nó de cliente que o plano de controle cria; ver
 * `bootstrapCustomerNode`, abaixo.
 */

const gcpAccountsSchema = z
  .string()
  .default('')
  .transform((value, ctx) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [project = '', subscription = ''] = item.split('=');
        if (!gcpProjectIdSchema.safeParse(project).success || !isPubsubSubscriptionName(subscription)) {
          ctx.addIssue({
            code: 'custom',
            message: `conta GCP inválida: use <projeto>=projects/<p>/subscriptions/<id>`,
          });
        }
        return { project, subscription };
      }),
  );

/** Marcadores das linhas com a senha temporária na saída do bootstrap (lidas pelo start.sh). */
const TEMPORARY_LINE_MARKER = 'VERAX_SENHA_TEMPORARIA=';
const EXPIRY_LINE_MARKER = 'VERAX_SENHA_TEMPORARIA_VALE_ATE=';

/** Pedido de senha nova (`true`/`false`, padrão `false`), nas saídas de emergência dos dois modos. */
const renewFlagSchema = z
  .enum(['true', 'false'], { error: 'use true ou false' })
  .default('false')
  .transform((value) => value === 'true');

export const bootstrapEnvSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z.email({ error: 'e-mail do primeiro administrador inválido' }),
  BOOTSTRAP_ADMIN_NAME: z.string().min(1).max(120).default('Administrador Verax'),
  // O start.sh sempre escreve a linha; vazia, vale como ausente (só o admin, como na saída de emergência).
  BOOTSTRAP_TENANT_NAME: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).max(120).optional(),
  ),
  BOOTSTRAP_GCP_ACCOUNTS: gcpAccountsSchema,
  BOOTSTRAP_RENEW_ADMIN_PASSWORD: renewFlagSchema,
});

export type BootstrapInput = z.infer<typeof bootstrapEnvSchema>;

export interface BootstrapResult {
  /** `renewed`: ainda não tinha entrado (ou ficou sem senha); `reset`: senha nova a pedido, pela saída de emergência. */
  admin: 'created' | 'renewed' | 'reset' | 'exists';
  /** Só quando a senha temporária foi gerada nesta execução. */
  temporaryPassword?: { temporaryPassword: string; expiresAt: string };
  tenant: 'created' | 'exists' | 'skipped';
  /** Rótulo do plano em `Tenant.plan`: gravado agora (`set`) ou já igual (`unchanged`). */
  plan?: 'set' | 'unchanged';
  accounts: { project: string; outcome: 'created' | 'exists' | 'other-tenant' }[];
}

/**
 * O cliente do nó, pelo nome (o mais antigo, se houver mais de um), com o rótulo do plano em `Tenant.plan`: cria se não
 * existe e atualiza o rótulo se o `PLAN` mudou, cada escrita com a auditoria de sistema na trilha do cliente. Os dois
 * modos usam o mesmo passo.
 */
async function ensureNodeTenant(
  prisma: PrismaService,
  name: string,
  plan: ResolvedPlan,
  audit: AuditService,
): Promise<{ tenant: { id: string }; outcome: 'created' | 'exists'; plan: 'set' | 'unchanged' }> {
  const system = { type: 'system' as const };
  const found = await prisma.tenant.findFirst({
    where: { name },
    select: { id: true, plan: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!found) {
    const tenant = await prisma.tenant.create({
      data: { name, plan: plan.label },
      select: { id: true, plan: true },
    });
    await audit.write(prisma, {
      actor: { ...system, tenantId: tenant.id },
      action: 'tenant.create',
      outcome: 'success',
      resourceType: 'tenant',
      resourceId: tenant.id,
      after: { name, plan: plan.label },
    });
    return { tenant, outcome: 'created', plan: 'set' };
  }
  if (found.plan !== plan.label) {
    // O plano mudou no node.conf (ou o cliente veio de antes do plano): o cadastro passa a mostrar o do ambiente.
    await prisma.forTenant(found.id).tenant.update({ where: { id: found.id }, data: { plan: plan.label } });
    await audit.write(prisma, {
      actor: { ...system, tenantId: found.id },
      action: 'tenant.update',
      outcome: 'success',
      resourceType: 'tenant',
      resourceId: found.id,
      before: { plan: found.plan },
      after: { plan: plan.label },
    });
    return { tenant: found, outcome: 'exists', plan: 'set' };
  }
  return { tenant: found, outcome: 'exists', plan: 'unchanged' };
}

/** O que o bootstrap faz, separado da leitura do ambiente para os testes. */
export async function bootstrapNode(
  prisma: PrismaService,
  auth: Auth,
  input: BootstrapInput,
  plan: ResolvedPlan,
): Promise<BootstrapResult> {
  const audit = new AuditService();
  const system = { type: 'system' as const };
  const email = input.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();

  // Primeiro admin com senha temporária. Se ainda não entrou (a temporária não foi trocada) ou ficou sem senha (uma
  // execução anterior parou entre criar a conta e gravar a senha), gera outra; se já definiu a própria senha, nada
  // muda, a não ser pela saída de emergência.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      role: true,
      mustChangePassword: true,
      status: true,
      accounts: { where: { providerId: 'credential', password: { not: null } }, select: { id: true } },
    },
  });
  let admin: BootstrapResult['admin'];
  let temporaryPassword: BootstrapResult['temporaryPassword'];
  if (!existing) {
    // Sem acesso até a senha temporária ser gravada: se o processo cair no meio, a próxima execução a gera.
    const { id } = await provisionUser(auth, {
      email,
      name: input.BOOTSTRAP_ADMIN_NAME,
      role: 'admin_verax',
      tenantId: null,
      status: 'invited',
    });
    temporaryPassword = await setTemporaryPassword(auth, prisma, { id, email });
    await audit.write(prisma, {
      actor: system,
      action: 'user.create',
      outcome: 'success',
      resourceType: 'user',
      resourceId: id,
      after: { role: 'admin_verax', status: 'active', mustChangePassword: true },
    });
    admin = 'created';
  } else if (existing.role !== 'admin_verax') {
    throw new Error(
      'O e-mail informado já pertence a um usuário de cliente; use outro para o administrador da Verax.',
    );
  } else if (
    input.BOOTSTRAP_RENEW_ADMIN_PASSWORD ||
    existing.mustChangePassword ||
    existing.status === 'invited' ||
    existing.accounts.length === 0
  ) {
    if (existing.status === 'disabled') {
      throw new Error(
        'O administrador informado está desativado: reative-o pelo painel com outro administrador.',
      );
    }
    temporaryPassword = await setTemporaryPassword(auth, prisma, { id: existing.id, email });
    await audit.write(prisma, {
      actor: system,
      action: 'user.temporary_password',
      outcome: 'success',
      resourceType: 'user',
      resourceId: existing.id,
      before: { status: existing.status, mustChangePassword: existing.mustChangePassword },
      after: { status: 'active', mustChangePassword: true },
    });
    admin =
      input.BOOTSTRAP_RENEW_ADMIN_PASSWORD && !existing.mustChangePassword && existing.accounts.length > 0
        ? 'reset'
        : 'renewed';
  } else {
    admin = 'exists';
  }

  if (!input.BOOTSTRAP_TENANT_NAME) return { admin, temporaryPassword, tenant: 'skipped', accounts: [] };

  const {
    tenant,
    outcome: tenantOutcome,
    plan: planOutcome,
  } = await ensureNodeTenant(prisma, input.BOOTSTRAP_TENANT_NAME, plan, audit);

  const accounts: BootstrapResult['accounts'] = [];
  for (const { project, subscription } of input.BOOTSTRAP_GCP_ACCOUNTS) {
    const found = await prisma.cloudAccount.findUnique({
      where: { provider_accountId: { provider: 'gcp', accountId: project } },
      select: { tenantId: true },
    });
    if (found) {
      // Uma conta pertence a um só cliente: se já está em outro, o bootstrap não a move.
      accounts.push({ project, outcome: found.tenantId === tenant.id ? 'exists' : 'other-tenant' });
      continue;
    }
    const created = await prisma.forTenant(tenant.id).cloudAccount.create({
      data: {
        tenantId: tenant.id,
        provider: 'gcp',
        accountId: project,
        regions: [],
        pubsubSubscription: subscription,
      },
      select: { id: true },
    });
    await audit.write(prisma, {
      actor: { ...system, tenantId: tenant.id },
      action: 'cloud_account.create',
      outcome: 'success',
      resourceType: 'cloud_account',
      resourceId: created.id,
      after: { provider: 'gcp', accountId: project, pubsubSubscription: subscription },
    });
    accounts.push({ project, outcome: 'created' });
  }
  return { admin, temporaryPassword, tenant: tenantOutcome, plan: planOutcome, accounts };
}

/**
 * A saída do modo `verax`, linha a linha. As duas linhas marcadas (senha e validade) o `start.sh bootstrap` tira da
 * saída e grava num arquivo só de root; o resto aparece na tela.
 */
export function veraxBootstrapLines(result: BootstrapResult, planLabel: string): string[] {
  const adminMessage = {
    created: 'Administrador criado com senha temporária.',
    renewed:
      'Administrador ainda não tinha entrado: senha temporária nova gerada (a anterior deixou de valer).',
    reset:
      'Senha temporária nova para o administrador, a pedido: a senha anterior e as sessões abertas deixaram de valer; o MFA continua.',
    exists:
      'Administrador já definiu a própria senha: nada alterado (para gerar outra, use BOOTSTRAP_RENEW_ADMIN_PASSWORD=true).',
  }[result.admin];
  const lines = [adminMessage];
  if (result.temporaryPassword) {
    // Linhas marcadas: o start.sh tira estas duas da saída e grava num arquivo só de root.
    lines.push(`${TEMPORARY_LINE_MARKER}${result.temporaryPassword.temporaryPassword}`);
    lines.push(`${EXPIRY_LINE_MARKER}${result.temporaryPassword.expiresAt}`);
  }
  lines.push(`Cliente do nó: ${result.tenant}.`);
  if (result.plan) lines.push(`Plano do nó: ${planLabel} (${result.plan}).`);
  for (const account of result.accounts) lines.push(`Conta GCP ${account.project}: ${account.outcome}.`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------
// Modo `customer` (fase 3, CP-10): o nó de cliente criado pelo plano de controle, sem SSH.
//
// O host (`start.sh customer-bootstrap`) lê dos metadados da VM o nome do cliente, o e-mail do administrador do cliente
// e o e-mail da conta de suporte, e roda este CLI com `BOOTSTRAP_MODE=customer`. Ele cria o cliente (com o rótulo do
// plano), o `admin_cliente` e o `admin_verax` de suporte, cada conta com a sua senha temporária (no primeiro login, a
// troca e o MFA, como em qualquer conta). Cada senha nova vira um arquivo JSON numa pasta do tmpfs só de root montada no
// contêiner, e o host o grava como versão nova do segredo de mesmo nome no Secret Manager (`<prefixo>-admin-bootstrap`,
// que o plano de controle revela uma vez ao cliente, e `<prefixo>-support-bootstrap`, que só o responsável lê). A senha
// nunca vai para a saída padrão, para o log nem para a auditoria.
//
// Idempotente, e mais estrito que o modo `verax`: conta que já tem senha fica como está, mesmo antes do primeiro login
// (a senha dela está no cofre, à espera da revelação), e nenhuma senha nova sai sem o pedido explícito
// (`BOOTSTRAP_RENEW_ADMIN_PASSWORD` ou `BOOTSTRAP_RENEW_SUPPORT_PASSWORD`). A exceção é a conta sem senha nenhuma, que
// sobra quando uma execução anterior parou entre criar a conta e gravar a senha: ela recebe a primeira.
// ---------------------------------------------------------------------------------------------------------------------

/** Cada senha nova vira o arquivo `<nome>.json` na pasta de saída; o nome é o sufixo do segredo no Secret Manager. */
export const CUSTOMER_PAYLOADS = ['admin-bootstrap', 'support-bootstrap'] as const;
export type CustomerPayload = (typeof CUSTOMER_PAYLOADS)[number];

/** A pasta de saída dentro do contêiner: o host monta nela uma pasta só de root do tmpfs (`/run/verax`). */
export const CUSTOMER_OUTPUT_DIR = '/run/verax-bootstrap';

const emptyAsUndefined = (value: unknown) => (value === '' ? undefined : value);

/** `verax` (o padrão, como sempre) ou `customer`. */
export const bootstrapModeSchema = z.preprocess(
  emptyAsUndefined,
  z.enum(['verax', 'customer'], { error: 'use verax ou customer' }).default('verax'),
);

const accountName = (fallback: string) =>
  z.preprocess(emptyAsUndefined, z.string().trim().min(1).max(120).default(fallback));

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const customerBootstrapEnvSchema = z
  .object({
    /** Login do primeiro `admin_cliente` (o e-mail do checkout). */
    BOOTSTRAP_ADMIN_EMAIL: z.email({ error: 'e-mail do administrador do cliente inválido' }).max(254),
    BOOTSTRAP_ADMIN_NAME: accountName('Administrador'),
    BOOTSTRAP_TENANT_NAME: z.string({ error: 'nome do cliente obrigatório' }).trim().min(1).max(120),
    /** Login da conta de suporte da Verax neste nó (`admin_verax`). */
    BOOTSTRAP_SUPPORT_EMAIL: z.email({ error: 'e-mail da conta de suporte inválido' }).max(254),
    BOOTSTRAP_SUPPORT_NAME: accountName('Suporte Verax'),
    BOOTSTRAP_RENEW_ADMIN_PASSWORD: renewFlagSchema,
    BOOTSTRAP_RENEW_SUPPORT_PASSWORD: renewFlagSchema,
    BOOTSTRAP_OUTPUT_DIR: z
      .string()
      .refine((value) => isAbsolute(value), { error: 'use um caminho absoluto' })
      .default(CUSTOMER_OUTPUT_DIR),
  })
  .refine(
    (env) => normalizeEmail(env.BOOTSTRAP_ADMIN_EMAIL) !== normalizeEmail(env.BOOTSTRAP_SUPPORT_EMAIL),
    { path: ['BOOTSTRAP_SUPPORT_EMAIL'], error: 'deve ser diferente do e-mail do administrador do cliente' },
  );

export type CustomerBootstrapInput = z.infer<typeof customerBootstrapEnvSchema>;

/**
 * `created`: conta nova; `renewed`: a conta existia sem senha (uma execução anterior parou no meio) e recebeu a
 * primeira; `reset`: senha nova a pedido; `exists`: nada mudou.
 */
export type CustomerAccountOutcome = 'created' | 'renewed' | 'reset' | 'exists';

export interface CustomerBootstrapResult {
  tenant: 'created' | 'exists';
  /** Rótulo do plano em `Tenant.plan`: gravado agora (`set`) ou já igual (`unchanged`). */
  plan: 'set' | 'unchanged';
  admin: CustomerAccountOutcome;
  support: CustomerAccountOutcome;
  /** Os arquivos gravados nesta execução, um por senha nova (vazio quando nada mudou). */
  written: CustomerPayload[];
}

/**
 * Recusa com o motivo para quem opera. A mensagem vai para a saída de erro: nunca com senha, e-mail ou nome de
 * cliente.
 */
export class CustomerBootstrapRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomerBootstrapRefusal';
  }
}

/**
 * O conteúdo de cada versão dos segredos `admin-bootstrap` e `support-bootstrap`. É o contrato com o plano de controle
 * (`parseBootstrapPayload`, em `apps/control-plane/src/access/bootstrap-secrets.ts`): um JSON UTF-8 com exatamente
 * `email`, `password` (16 a 256 caracteres) e `expiresAt` (ISO 8601 com fuso; aqui, sempre em UTC). O teste do
 * contrato confere com o leitor de lá.
 */
export function customerBootstrapPayload(email: string, credentials: TemporaryPassword): string {
  return JSON.stringify({ email, password: credentials.temporaryPassword, expiresAt: credentials.expiresAt });
}

/** Para onde vão as senhas novas: a pasta montada pelo host (`directorySink`) ou um dublê nos testes. */
export interface PayloadSink {
  /** Os arquivos ainda na pasta: de uma execução anterior cuja gravação no Secret Manager não terminou. */
  pending(): Promise<CustomerPayload[]>;
  write(name: CustomerPayload, content: string): Promise<void>;
}

/**
 * A pasta de saída. Cada arquivo nasce 0600 com outro nome e entra no lugar de uma vez (rename): o host nunca lê um
 * arquivo pela metade. A pasta é do usuário do contêiner, dentro de `/run/verax` (tmpfs, 0700 de root): no host, só o
 * root a alcança.
 */
export function directorySink(dir: string): PayloadSink {
  return {
    async pending() {
      let names: string[];
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração, não do request
        names = await readdir(dir);
      } catch {
        throw new CustomerBootstrapRefusal(
          `A pasta das senhas (${dir}) não existe ou não abre: o host a monta antes de rodar o bootstrap.`,
        );
      }
      return CUSTOMER_PAYLOADS.filter((name) => names.includes(`${name}.json`));
    },
    async write(name, content) {
      const temporary = join(dir, `.${name}.json.tmp`);
      await rm(temporary, { force: true });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração, nome fixo daqui
      await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta da configuração, nome fixo daqui
      await rename(temporary, join(dir, `${name}.json`));
    },
  };
}

interface CustomerAccountSpec {
  payload: CustomerPayload;
  /** Como a conta aparece nas mensagens. */
  label: string;
  email: string;
  name: string;
  role: Extract<UserRole, 'admin_cliente' | 'admin_verax'>;
  renew: boolean;
}

interface ExistingAccount {
  id: string;
  role: UserRole;
  tenantId: string | null;
  status: 'invited' | 'active' | 'disabled';
  mustChangePassword: boolean;
  /** Tem senha (conta `credential` com hash): a primeira já foi gerada e entregue. */
  hasPassword: boolean;
}

async function findAccount(prisma: PrismaService, email: string): Promise<ExistingAccount | null> {
  const found = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      role: true,
      tenantId: true,
      status: true,
      mustChangePassword: true,
      accounts: { where: { providerId: 'credential', password: { not: null } }, select: { id: true } },
    },
  });
  if (!found) return null;
  const { accounts, ...user } = found;
  return { ...user, hasPassword: accounts.length > 0 };
}

/** Recusa o que não pode seguir, antes de qualquer escrita. A mensagem nunca cita o e-mail nem o outro cliente. */
function checkAccount(
  spec: CustomerAccountSpec,
  existing: ExistingAccount | null,
  tenantId: string | null,
): void {
  if (!existing) return;
  if (existing.role !== spec.role) {
    throw new CustomerBootstrapRefusal(
      `O e-mail da ${spec.label} já pertence a uma conta com outro papel neste nó: use outro e-mail.`,
    );
  }
  if (spec.role === 'admin_cliente' && existing.tenantId !== tenantId) {
    throw new CustomerBootstrapRefusal(
      `O e-mail da ${spec.label} já pertence a outro cliente neste nó: use outro e-mail.`,
    );
  }
  if (existing.status === 'disabled' && (spec.renew || !existing.hasPassword)) {
    throw new CustomerBootstrapRefusal(
      `A ${spec.label} está desativada: reative-a pelo painel antes de gerar uma senha.`,
    );
  }
}

/**
 * Cria a conta ou gera a senha dela, quando é o caso. A senha entra na máscara do logger assim que `setTemporaryPassword`
 * a devolve, antes de qualquer outro `await` (lá dentro, só o hash vai para o banco, e nada é logado), e vai direto para
 * o arquivo da pasta de saída; a auditoria registra só o estado da conta.
 */
async function ensureCustomerAccount(
  prisma: PrismaService,
  auth: Auth,
  audit: AuditService,
  sink: PayloadSink,
  spec: CustomerAccountSpec,
  existing: ExistingAccount | null,
  tenantId: string | null,
): Promise<CustomerAccountOutcome> {
  if (existing && existing.hasPassword && !spec.renew) return 'exists';
  let id: string;
  let outcome: CustomerAccountOutcome;
  if (!existing) {
    // Sem acesso até a senha temporária ser gravada: se o processo cair no meio, a próxima execução a gera.
    ({ id } = await provisionUser(auth, {
      email: spec.email,
      name: spec.name,
      role: spec.role,
      tenantId,
      status: 'invited',
    }));
    outcome = 'created';
  } else {
    id = existing.id;
    outcome = existing.hasPassword ? 'reset' : 'renewed';
  }
  const credentials = await setTemporaryPassword(auth, prisma, { id, email: spec.email });
  registerLiveSecret(credentials.temporaryPassword);
  await sink.write(spec.payload, customerBootstrapPayload(spec.email, credentials));
  // A conta de suporte é da Verax (sem cliente): o registro fica fora da trilha do cliente, como toda operação global.
  const actor = { type: 'system' as const, ...(spec.role === 'admin_cliente' && { tenantId }) };
  const after = { role: spec.role, status: 'active', mustChangePassword: true };
  await audit.write(
    prisma,
    existing
      ? {
          actor,
          action: 'user.temporary_password',
          outcome: 'success',
          resourceType: 'user',
          resourceId: id,
          before: { status: existing.status, mustChangePassword: existing.mustChangePassword },
          after: { status: 'active', mustChangePassword: true },
        }
      : { actor, action: 'user.create', outcome: 'success', resourceType: 'user', resourceId: id, after },
  );
  return outcome;
}

/** O que o modo `customer` faz, separado da leitura do ambiente e da saída para os testes. */
export async function bootstrapCustomerNode(
  prisma: PrismaService,
  auth: Auth,
  input: CustomerBootstrapInput,
  plan: ResolvedPlan,
  sink: PayloadSink,
): Promise<CustomerBootstrapResult> {
  const audit = new AuditService();
  // Uma senha de uma execução anterior ainda não foi para o cofre: nenhuma outra sai antes dela.
  if ((await sink.pending()).length > 0) {
    throw new CustomerBootstrapRefusal(
      'Há senha de uma execução anterior ainda não gravada no Secret Manager: o host a grava antes de rodar o bootstrap.',
    );
  }
  const admin: CustomerAccountSpec = {
    payload: 'admin-bootstrap',
    label: 'conta do administrador do cliente',
    email: normalizeEmail(input.BOOTSTRAP_ADMIN_EMAIL),
    name: input.BOOTSTRAP_ADMIN_NAME,
    role: 'admin_cliente',
    renew: input.BOOTSTRAP_RENEW_ADMIN_PASSWORD,
  };
  const support: CustomerAccountSpec = {
    payload: 'support-bootstrap',
    label: 'conta de suporte da Verax',
    email: normalizeEmail(input.BOOTSTRAP_SUPPORT_EMAIL),
    name: input.BOOTSTRAP_SUPPORT_NAME,
    role: 'admin_verax',
    renew: input.BOOTSTRAP_RENEW_SUPPORT_PASSWORD,
  };

  // Tudo conferido antes da primeira escrita: uma recusa não deixa cliente, conta nem senha pela metade.
  const known = await prisma.tenant.findFirst({
    where: { name: input.BOOTSTRAP_TENANT_NAME },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  const existingAdmin = await findAccount(prisma, admin.email);
  const existingSupport = await findAccount(prisma, support.email);
  checkAccount(admin, existingAdmin, known?.id ?? null);
  checkAccount(support, existingSupport, null);

  const {
    tenant,
    outcome,
    plan: planOutcome,
  } = await ensureNodeTenant(prisma, input.BOOTSTRAP_TENANT_NAME, plan, audit);
  const adminOutcome = await ensureCustomerAccount(
    prisma,
    auth,
    audit,
    sink,
    admin,
    existingAdmin,
    tenant.id,
  );
  const supportOutcome = await ensureCustomerAccount(
    prisma,
    auth,
    audit,
    sink,
    support,
    existingSupport,
    null,
  );
  const written = [
    ...(adminOutcome === 'exists' ? [] : [admin.payload]),
    ...(supportOutcome === 'exists' ? [] : [support.payload]),
  ];
  return { tenant: outcome, plan: planOutcome, admin: adminOutcome, support: supportOutcome, written };
}

/** A saída do modo `customer`, linha a linha: só o que aconteceu, nunca senha, e-mail ou nome de cliente. */
export function customerBootstrapLines(result: CustomerBootstrapResult, planLabel: string): string[] {
  const account: Record<CustomerAccountOutcome, string> = {
    created: 'criada com senha temporária',
    renewed: 'existia sem senha: senha temporária gerada',
    reset:
      'senha temporária nova, a pedido (a anterior e as sessões abertas deixaram de valer; o MFA continua)',
    exists: 'já existe: nada alterado',
  };
  return [
    `Cliente do nó: ${result.tenant}.`,
    `Plano do nó: ${planLabel} (${result.plan}).`,
    `Conta do administrador do cliente: ${account[result.admin]}.`,
    `Conta de suporte da Verax: ${account[result.support]}.`,
    result.written.length > 0
      ? `Senhas para o Secret Manager: ${result.written.join(', ')}.`
      : 'Nenhuma senha nova: nada para gravar no Secret Manager.',
  ];
}

export interface CliOutput {
  out(line: string): void;
  err(line: string): void;
}

/**
 * O modo `customer` da leitura do ambiente à saída, com as dependências à mostra (o `main` e os testes). Devolve o
 * código de saída. Erro que não é uma recusa sai só pelo tipo: a mensagem de um erro do banco pode trazer dado do
 * cliente.
 */
export async function runCustomerBootstrap(
  env: NodeJS.ProcessEnv,
  prisma: PrismaService,
  auth: Auth,
  plan: ResolvedPlan,
  output: CliOutput,
  sink?: PayloadSink,
): Promise<number> {
  const input = customerBootstrapEnvSchema.safeParse(env);
  if (!input.success) {
    // Só os nomes e o problema; nenhum valor é impresso.
    output.err(input.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
    return 1;
  }
  try {
    const result = await bootstrapCustomerNode(
      prisma,
      auth,
      input.data,
      plan,
      sink ?? directorySink(input.data.BOOTSTRAP_OUTPUT_DIR),
    );
    for (const line of customerBootstrapLines(result, plan.label)) output.out(line);
    return 0;
  } catch (error) {
    output.err(
      error instanceof CustomerBootstrapRefusal
        ? error.message
        : `Falha no bootstrap do nó de cliente (${errorKind(error)}). O que já foi feito fica; rode de novo.`,
    );
    return 1;
  }
}

/** O console do CLI com a limpeza do logger: as senhas geradas aqui (segredos vivos) nunca saem por ele. */
const maskedConsole = {
  warn: (...args: unknown[]) => console.warn(...args.map((arg) => sanitize(arg))),
  error: (...args: unknown[]) => console.error(...args.map((arg) => sanitize(arg))),
};

async function mainCustomer(): Promise<void> {
  const config = loadConfig();
  const prisma = new PrismaService(config);
  try {
    const auditService = new AuditService();
    const auth = createAuth({
      config,
      prisma,
      logger: maskedConsole,
      mail: mailTransport(config),
      audit: (entry) => auditService.write(prisma, entry),
    });
    process.exitCode = await runCustomerBootstrap(process.env, prisma, auth, nodePlan(config), {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();
  const mode = bootstrapModeSchema.safeParse(process.env.BOOTSTRAP_MODE);
  if (!mode.success) {
    console.error('BOOTSTRAP_MODE: use verax ou customer');
    process.exit(1);
  }
  if (mode.data === 'customer') {
    await mainCustomer();
    return;
  }
  const config = loadConfig();
  const input = bootstrapEnvSchema.safeParse(process.env);
  if (!input.success) {
    // Só os nomes e o problema; nenhum valor é impresso.
    console.error(input.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('\n'));
    process.exit(1);
  }
  const prisma = new PrismaService(config);
  try {
    const auditService = new AuditService();
    const auth = createAuth({
      config,
      prisma,
      logger: console,
      mail: mailTransport(config),
      audit: (entry) => auditService.write(prisma, entry),
    });
    const plan = nodePlan(config);
    const result = await bootstrapNode(prisma, auth, input.data, plan);
    for (const line of veraxBootstrapLines(result, plan.label)) console.log(line);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

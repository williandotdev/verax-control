import 'reflect-metadata';
import { gcpProjectIdSchema, isPubsubSubscriptionName, type ResolvedPlan } from '@verax/shared';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type Auth, createAuth } from '../auth/auth.factory.js';
import { setTemporaryPassword } from '../auth/temporary-password.js';
import { provisionUser } from '../auth/user-provisioning.js';
import { AuditService } from '../common/audit/audit.service.js';
import { nodePlan } from '../common/config/env.schema.js';
import { loadConfig } from '../common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from '../common/config/load-env-file.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import { mailTransport } from '../mail/mail.module.js';
import { assertWithinPlan, PlanLimitReached } from '../plan/plan-limits.js';

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

export const bootstrapEnvSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z.email({ error: 'e-mail do primeiro administrador inválido' }),
  BOOTSTRAP_ADMIN_NAME: z.string().min(1).max(120).default('Administrador Verax'),
  // O start.sh sempre escreve a linha; vazia, vale como ausente (só o admin, como na saída de emergência).
  BOOTSTRAP_TENANT_NAME: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().min(1).max(120).optional(),
  ),
  BOOTSTRAP_GCP_ACCOUNTS: gcpAccountsSchema,
  BOOTSTRAP_RENEW_ADMIN_PASSWORD: z
    .enum(['true', 'false'], { error: 'use true ou false' })
    .default('false')
    .transform((value) => value === 'true'),
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
  /** `plan-limit`: o cliente já está no limite de contas do plano (PR-18); a conta não é criada. */
  accounts: { project: string; outcome: 'created' | 'exists' | 'other-tenant' | 'plan-limit' }[];
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

  let tenant = await prisma.tenant.findFirst({
    where: { name: input.BOOTSTRAP_TENANT_NAME },
    select: { id: true, plan: true },
    orderBy: { createdAt: 'asc' },
  });
  let tenantOutcome: BootstrapResult['tenant'] = 'exists';
  let planOutcome: BootstrapResult['plan'] = 'unchanged';
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { name: input.BOOTSTRAP_TENANT_NAME, plan: plan.label },
      select: { id: true, plan: true },
    });
    await audit.write(prisma, {
      actor: { ...system, tenantId: tenant.id },
      action: 'tenant.create',
      outcome: 'success',
      resourceType: 'tenant',
      resourceId: tenant.id,
      after: { name: input.BOOTSTRAP_TENANT_NAME, plan: plan.label },
    });
    tenantOutcome = 'created';
    planOutcome = 'set';
  } else if (tenant.plan !== plan.label) {
    // O plano mudou no node.conf (ou o cliente veio de antes do plano): o cadastro passa a mostrar o do ambiente.
    await prisma.forTenant(tenant.id).tenant.update({ where: { id: tenant.id }, data: { plan: plan.label } });
    await audit.write(prisma, {
      actor: { ...system, tenantId: tenant.id },
      action: 'tenant.update',
      outcome: 'success',
      resourceType: 'tenant',
      resourceId: tenant.id,
      before: { plan: tenant.plan },
      after: { plan: plan.label },
    });
    planOutcome = 'set';
  }

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
    // A conta nova pede vaga no plano, como no painel (PR-18): a checagem e a criação na mesma transação, sob o lock do
    // plano. No limite, a conta fica de fora (`plan-limit`, com a recusa na auditoria) e o resto do bootstrap segue.
    const tenantId = tenant.id;
    const outcome = await prisma.$transaction(async (tx) => {
      try {
        await assertWithinPlan(tx, plan, 'cloudAccounts', tenantId);
      } catch (error) {
        if (!(error instanceof PlanLimitReached)) throw error;
        await audit.write(tx, {
          actor: { ...system, tenantId },
          action: 'cloud_account.create',
          outcome: 'failure',
          statusCode: error.getStatus(),
          resourceType: 'cloud_account',
        });
        return 'plan-limit' as const;
      }
      const created = await scopeToTenant(tx, tenantId).cloudAccount.create({
        data: {
          tenantId,
          provider: 'gcp',
          accountId: project,
          regions: [],
          pubsubSubscription: subscription,
        },
        select: { id: true },
      });
      await audit.write(tx, {
        actor: { ...system, tenantId },
        action: 'cloud_account.create',
        outcome: 'success',
        resourceType: 'cloud_account',
        resourceId: created.id,
        after: { provider: 'gcp', accountId: project, pubsubSubscription: subscription },
      });
      return 'created' as const;
    });
    accounts.push({ project, outcome });
  }
  return { admin, temporaryPassword, tenant: tenantOutcome, plan: planOutcome, accounts };
}

async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();
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
    const adminMessage = {
      created: 'Administrador criado com senha temporária.',
      renewed:
        'Administrador ainda não tinha entrado: senha temporária nova gerada (a anterior deixou de valer).',
      reset:
        'Senha temporária nova para o administrador, a pedido: a senha anterior e as sessões abertas deixaram de valer; o MFA continua.',
      exists:
        'Administrador já definiu a própria senha: nada alterado (para gerar outra, use BOOTSTRAP_RENEW_ADMIN_PASSWORD=true).',
    }[result.admin];
    console.log(adminMessage);
    if (result.temporaryPassword) {
      // Linhas marcadas: o start.sh tira estas duas da saída e grava num arquivo só de root.
      console.log(`${TEMPORARY_LINE_MARKER}${result.temporaryPassword.temporaryPassword}`);
      console.log(`${EXPIRY_LINE_MARKER}${result.temporaryPassword.expiresAt}`);
    }
    console.log(`Cliente do nó: ${result.tenant}.`);
    if (result.plan) console.log(`Plano do nó: ${plan.label} (${result.plan}).`);
    for (const account of result.accounts) console.log(`Conta GCP ${account.project}: ${account.outcome}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

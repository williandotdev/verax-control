import 'reflect-metadata';
import { gcpProjectIdSchema, isPubsubSubscriptionName } from '@verax/shared';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type Auth, createAuth } from '../auth/auth.factory.js';
import { setTemporaryPassword } from '../auth/temporary-password.js';
import { provisionUser } from '../auth/user-provisioning.js';
import { AuditService } from '../common/audit/audit.service.js';
import { loadConfig } from '../common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from '../common/config/load-env-file.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { mailTransport } from '../mail/mail.module.js';

/**
 * Primeira configuração de um nó, rodada na instalação (`docker compose run --rm api node dist/cli/node-bootstrap.js`):
 * - o primeiro `admin_verax`, com uma senha temporária (a mesma regra do painel: no primeiro login, troca a senha e
 *   cadastra o MFA). A senha sai numa linha marcada da saída, que o `start.sh` grava num arquivo só de root na VM: ela
 *   não fica no log nem na tela de quem rodou;
 * - o cliente do nó e as contas da GCP dele, cada uma com a sua assinatura do Pub/Sub.
 *
 * Idempotente: o que já existe fica como está (inclusive um admin que já ativou a conta). Cada criação entra na trilha
 * de auditoria como ação do sistema. Os valores vêm do ambiente da instalação, nunca do repositório.
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
  BOOTSTRAP_TENANT_NAME: z.string().min(1).max(120).optional(),
  BOOTSTRAP_GCP_ACCOUNTS: gcpAccountsSchema,
});

export type BootstrapInput = z.infer<typeof bootstrapEnvSchema>;

export interface BootstrapResult {
  admin: 'created' | 'renewed' | 'exists';
  /** Só quando a senha temporária foi gerada nesta execução. */
  temporaryPassword?: { temporaryPassword: string; expiresAt: string };
  tenant: 'created' | 'exists' | 'skipped';
  accounts: { project: string; outcome: 'created' | 'exists' | 'other-tenant' }[];
}

/** O que o bootstrap faz, separado da leitura do ambiente para os testes. */
export async function bootstrapNode(
  prisma: PrismaService,
  auth: Auth,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const audit = new AuditService();
  const system = { type: 'system' as const };
  const email = input.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase();

  // Primeiro admin com senha temporária. Se ainda não entrou (a temporária não foi trocada), gera outra; se já definiu a
  // própria senha, nada muda.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, mustChangePassword: true, status: true },
  });
  let admin: BootstrapResult['admin'];
  let temporaryPassword: BootstrapResult['temporaryPassword'];
  if (!existing) {
    const { id } = await provisionUser(auth, {
      email,
      name: input.BOOTSTRAP_ADMIN_NAME,
      role: 'admin_verax',
      tenantId: null,
      status: 'active',
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
  } else if (existing.mustChangePassword || existing.status === 'invited') {
    temporaryPassword = await setTemporaryPassword(auth, prisma, { id: existing.id, email });
    await audit.write(prisma, {
      actor: system,
      action: 'user.temporary_password',
      outcome: 'success',
      resourceType: 'user',
      resourceId: existing.id,
      after: { mustChangePassword: true },
    });
    admin = 'renewed';
  } else {
    admin = 'exists';
  }

  if (!input.BOOTSTRAP_TENANT_NAME) return { admin, temporaryPassword, tenant: 'skipped', accounts: [] };

  let tenant = await prisma.tenant.findFirst({
    where: { name: input.BOOTSTRAP_TENANT_NAME },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  let tenantOutcome: BootstrapResult['tenant'] = 'exists';
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: { name: input.BOOTSTRAP_TENANT_NAME },
      select: { id: true },
    });
    await audit.write(prisma, {
      actor: { ...system, tenantId: tenant.id },
      action: 'tenant.create',
      outcome: 'success',
      resourceType: 'tenant',
      resourceId: tenant.id,
      after: { name: input.BOOTSTRAP_TENANT_NAME },
    });
    tenantOutcome = 'created';
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
  return { admin, temporaryPassword, tenant: tenantOutcome, accounts };
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
    const result = await bootstrapNode(prisma, auth, input.data);
    const adminMessage = {
      created: 'Administrador criado com senha temporária.',
      renewed:
        'Administrador ainda não tinha entrado: senha temporária nova gerada (a anterior deixou de valer).',
      exists: 'Administrador já definiu a própria senha: nada alterado.',
    }[result.admin];
    console.log(adminMessage);
    if (result.temporaryPassword) {
      // Linhas marcadas: o start.sh tira estas duas da saída e grava num arquivo só de root.
      console.log(`${TEMPORARY_LINE_MARKER}${result.temporaryPassword.temporaryPassword}`);
      console.log(`${EXPIRY_LINE_MARKER}${result.temporaryPassword.expiresAt}`);
    }
    console.log(`Cliente do nó: ${result.tenant}.`);
    for (const account of result.accounts) console.log(`Conta GCP ${account.project}: ${account.outcome}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

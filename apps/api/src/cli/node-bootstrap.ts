import 'reflect-metadata';
import { gcpProjectIdSchema, isPubsubSubscriptionName } from '@verax/shared';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type Auth, createAuth } from '../auth/auth.factory.js';
import { invitationRequest } from '../auth/password-links.js';
import { provisionUser } from '../auth/user-provisioning.js';
import { AuditService } from '../common/audit/audit.service.js';
import { loadConfig } from '../common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from '../common/config/load-env-file.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import { mailTransport } from '../mail/mail.module.js';

/**
 * Primeira configuração de um nó, rodada na instalação (`docker compose run --rm api node dist/cli/node-bootstrap.js`):
 * - o primeiro `admin_verax`, sem senha: ele recebe por e-mail o convite (o mesmo link de uso único do painel), define a
 *   senha e cadastra o MFA no primeiro login;
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

export const bootstrapEnvSchema = z.object({
  BOOTSTRAP_ADMIN_EMAIL: z.email({ error: 'e-mail do primeiro administrador inválido' }),
  BOOTSTRAP_ADMIN_NAME: z.string().min(1).max(120).default('Administrador Verax'),
  BOOTSTRAP_TENANT_NAME: z.string().min(1).max(120).optional(),
  BOOTSTRAP_GCP_ACCOUNTS: gcpAccountsSchema,
});

export type BootstrapInput = z.infer<typeof bootstrapEnvSchema>;

export interface BootstrapResult {
  admin: 'invited' | 'reinvited' | 'exists';
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

  // Primeiro admin: convidado, sem senha. Se ainda não ativou, o convite é reenviado; ativo, nada muda.
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, status: true, role: true },
  });
  let admin: BootstrapResult['admin'];
  if (!existing) {
    const { id } = await provisionUser(auth, {
      email,
      name: input.BOOTSTRAP_ADMIN_NAME,
      role: 'admin_verax',
      tenantId: null,
      status: 'invited',
    });
    await audit.write(prisma, {
      actor: system,
      action: 'user.invite',
      outcome: 'success',
      resourceType: 'user',
      resourceId: id,
      after: { role: 'admin_verax', status: 'invited' },
    });
    admin = 'invited';
  } else if (existing.role !== 'admin_verax') {
    throw new Error(
      'O e-mail informado já pertence a um usuário de cliente; use outro para o administrador da Verax.',
    );
  } else {
    admin = existing.status === 'invited' ? 'reinvited' : 'exists';
  }
  if (admin !== 'exists') {
    await invitationRequest.run(true, () => auth.api.requestPasswordReset({ body: { email } }));
  }

  if (!input.BOOTSTRAP_TENANT_NAME) return { admin, tenant: 'skipped', accounts: [] };

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
  return { admin, tenant: tenantOutcome, accounts };
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
      invited: 'Administrador criado: o convite foi enviado por e-mail.',
      reinvited: 'Administrador ainda sem senha: o convite foi enviado de novo.',
      exists: 'Administrador já ativo: nada alterado.',
    }[result.admin];
    console.log(adminMessage);
    console.log(`Cliente do nó: ${result.tenant}.`);
    for (const account of result.accounts) console.log(`Conta GCP ${account.project}: ${account.outcome}.`);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

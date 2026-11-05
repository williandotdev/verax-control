import { describe, expect, it } from 'vitest';
import {
  type ExecutorInput,
  executorEnv,
  ExecutorInputError,
  isOrigin,
  isSubnetCidr,
  isTenantEmail,
  isTenantName,
  nodeTenantName,
} from './executor-env.js';
import { subnetCidrOf } from './provisioning-store.js';

const input: ExecutorInput = {
  action: 'apply',
  kind: 'provision',
  runId: '01JBTESTE0000000000000RVN1',
  slug: 'cliente-demo-a',
  plan: 'enterprise',
  limits: { maxCloudAccounts: 15, maxUsers: 20, monthlyGib: 60, historyDays: 365 },
  nodeVersion: 'node-v1.2.3',
  nodePackageSha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  webOrigin: 'https://cliente-demo-a.control.veraxsistemas.com.br',
  apiOrigin: 'https://api-cliente-demo-a.veraxsistemas.com.br',
  mailFrom: 'nao-responda@verax.example',
  subnetCidr: '10.0.7.0/24',
  adminEmail: "o'neil+ti@cliente-demo-a.example",
  tenantName: 'Ação & "Filhos" Comércio Ltda.',
  supportEmail: 'suporte@verax.example',
  imagesRepository: 'ghcr.io/williandotdev/verax-control',
};

describe('variáveis da execução do Job', () => {
  it('a lista inteira, na ordem, com os limites como texto (o entrypoint e o envs/tenant leem assim)', () => {
    expect(executorEnv(input)).toEqual([
      { name: 'EXECUTOR_ACTION', value: 'apply' },
      { name: 'RUN_KIND', value: 'provision' },
      { name: 'RUN_ID', value: input.runId },
      { name: 'TENANT_SLUG', value: 'cliente-demo-a' },
      { name: 'PLAN', value: 'enterprise' },
      { name: 'PLAN_MAX_CLOUD_ACCOUNTS', value: '15' },
      { name: 'PLAN_MAX_USERS', value: '20' },
      { name: 'PLAN_MONTHLY_GIB', value: '60' },
      { name: 'PLAN_HISTORY_DAYS', value: '365' },
      { name: 'NODE_VERSION', value: 'node-v1.2.3' },
      { name: 'NODE_PACKAGE_SHA256', value: input.nodePackageSha256 },
      { name: 'WEB_ORIGIN', value: input.webOrigin },
      { name: 'API_ORIGIN', value: input.apiOrigin },
      { name: 'MAIL_FROM', value: input.mailFrom },
      { name: 'SUBNET_CIDR', value: '10.0.7.0/24' },
      { name: 'BOOTSTRAP_ADMIN_EMAIL', value: input.adminEmail },
      { name: 'BOOTSTRAP_TENANT_NAME', value: input.tenantName },
      { name: 'BOOTSTRAP_SUPPORT_EMAIL', value: input.supportEmail },
      { name: 'IMAGES_REPOSITORY', value: input.imagesRepository },
    ]);
  });

  it.each<[string, Partial<ExecutorInput>]>([
    ['TENANT_SLUG', { slug: 'cl--iente' }],
    ['TENANT_SLUG', { slug: 'Cliente' }],
    ['RUN_ID', { runId: '01jbteste0000000000000rvn1' }],
    [
      'PLAN_MAX_CLOUD_ACCOUNTS',
      { limits: { maxCloudAccounts: 1001, maxUsers: 20, monthlyGib: 60, historyDays: 365 } },
    ],
    [
      'PLAN_MAX_CLOUD_ACCOUNTS',
      { limits: { maxCloudAccounts: 15, maxUsers: 20, monthlyGib: 60, historyDays: 29 } },
    ],
    ['PLAN_MAX_CLOUD_ACCOUNTS', { limits: undefined }],
    ['NODE_VERSION', { nodeVersion: 'v1.2.3' }],
    ['NODE_PACKAGE_SHA256', { nodePackageSha256: 'A'.repeat(64) }],
    ['WEB_ORIGIN', { webOrigin: 'https://cliente-demo-a.control.veraxsistemas.com.br/' }],
    ['API_ORIGIN', { apiOrigin: 'https://cliente-demo-a.control.veraxsistemas.com.br' }],
    ['MAIL_FROM', { mailFrom: "o'neil@verax.example" }],
    ['SUBNET_CIDR', { subnetCidr: '10.256.0.0/24' }],
    ['SUBNET_CIDR', { subnetCidr: '10.08.0.0/24' }],
    ['BOOTSTRAP_ADMIN_EMAIL', { adminEmail: 'admin@cliente\n.example' }],
    ['BOOTSTRAP_TENANT_NAME', { tenantName: ' Cliente' }],
    ['BOOTSTRAP_TENANT_NAME', { tenantName: 'Cliente\nDemo' }],
    ['BOOTSTRAP_SUPPORT_EMAIL', { supportEmail: "O'NEIL+TI@CLIENTE-DEMO-A.EXAMPLE" }],
    ['IMAGES_REPOSITORY', { imagesRepository: 'docker.io/williandotdev/verax-control' }],
  ])('%s fora do formato: recusado citando só o nome', (variable, change) => {
    const call = (): unknown => executorEnv({ ...input, ...change });
    expect(call).toThrow(ExecutorInputError);
    try {
      call();
    } catch (error) {
      expect((error as ExecutorInputError).variable).toBe(variable);
      for (const value of Object.values(change)) {
        if (typeof value === 'string' && value.length > 5)
          expect((error as Error).message).not.toContain(value);
      }
    }
  });

  it('as regras de formato, as mesmas do entrypoint e do envs/tenant', () => {
    expect(isOrigin('https://a.b')).toBe(true);
    expect(isOrigin('https://-a.b')).toBe(false);
    expect(isOrigin('https://a.b.')).toBe(false);
    expect(isOrigin('https://a')).toBe(false);
    expect(isOrigin('https://a.b:443')).toBe(false);
    expect(isSubnetCidr('10.255.255.0/24')).toBe(true);
    expect(isSubnetCidr('10.1.1.1/24')).toBe(false);
    expect(isTenantEmail("o'neil+ti@a.example")).toBe(true);
    expect(isTenantEmail('.a@a.example')).toBe(false);
    expect(isTenantEmail('a..b@a.example')).toBe(false);
    expect(isTenantEmail('a@a.e')).toBe(false);
    expect(isTenantName('ã'.repeat(200))).toBe(true);
    expect(isTenantName('ã'.repeat(201))).toBe(false);
    expect(isTenantName('Cliente ')).toBe(false);
  });

  it('o nome do cliente no nó: até 120 caracteres, sem cortar no meio de um acento nem deixar espaço no fim', () => {
    expect(nodeTenantName('Cliente Demo A')).toBe('Cliente Demo A');
    const long = `${'Ação '.repeat(30)}Ltda.`;
    const name = nodeTenantName(long);
    expect([...name].length).toBeLessThanOrEqual(120);
    expect(name).toBe(name.trimEnd());
    expect(long.startsWith(name)).toBe(true);
  });

  it('a faixa de rede do contador: dois octetos do meio', () => {
    expect(subnetCidrOf(1)).toBe('10.0.1.0/24');
    expect(subnetCidrOf(256)).toBe('10.1.0.0/24');
    expect(subnetCidrOf(65_535)).toBe('10.255.255.0/24');
    expect(isSubnetCidr(subnetCidrOf(12_345))).toBe(true);
  });
});

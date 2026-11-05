import { describe, expect, it } from 'vitest';
import { isNodeSmtpHost, isNodeSmtpPassword, isNodeSmtpUser } from '../common/config/env.schema.js';
import {
  type ExecutorInput,
  executorEnv,
  ExecutorInputError,
  isOrigin,
  isSmtpPort,
  isSubnetCidr,
  isTenantEmail,
  isTenantName,
  purgeExecutorEnv,
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

describe('a ação de cada tipo de execução (CP-11)', () => {
  it('apply só no provisionamento; destroy só na Exclusão 1 (a única que apaga a conta do nó)', () => {
    expect(executorEnv({ ...input, kind: 'resume' })[1]).toEqual({ name: 'RUN_KIND', value: 'resume' });
    const destroy = executorEnv({ ...input, action: 'destroy', kind: 'delete' });
    expect(destroy.slice(0, 2)).toEqual([
      { name: 'EXECUTOR_ACTION', value: 'destroy' },
      { name: 'RUN_KIND', value: 'delete' },
    ]);
    for (const [action, kind] of [
      ['destroy', 'provision'],
      ['destroy', 'resume'],
      ['apply', 'delete'],
      ['apply', 'crypto_destroy'],
      ['destroy', 'crypto_destroy'],
    ] as const) {
      expect(() => executorEnv({ ...input, action, kind })).toThrow(
        new ExecutorInputError('EXECUTOR_ACTION'),
      );
    }
  });

  it('a Exclusão 2 leva só o endereço: nenhum dado do cliente', () => {
    expect(purgeExecutorEnv({ runId: input.runId, slug: 'cliente-demo-a' })).toEqual([
      { name: 'EXECUTOR_ACTION', value: 'purge' },
      { name: 'RUN_KIND', value: 'crypto_destroy' },
      { name: 'RUN_ID', value: input.runId },
      { name: 'TENANT_SLUG', value: 'cliente-demo-a' },
    ]);
    expect(() => purgeExecutorEnv({ runId: 'x', slug: 'cliente-demo-a' })).toThrow(ExecutorInputError);
    expect(() => purgeExecutorEnv({ runId: input.runId, slug: 'cl--iente' })).toThrow(ExecutorInputError);
  });
});

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
      { name: 'SMTP_HOST', value: '' },
      { name: 'SMTP_PORT', value: '' },
      { name: 'SMTP_USER', value: '' },
    ]);
  });

  it('com o e-mail dos nós: o servidor, a porta e o usuário no fim da lista; nunca uma senha', () => {
    const env = executorEnv({
      ...input,
      nodeMail: { host: 'smtp.caixa-exemplo.example', port: 587, user: 'avisos+nos@verax.example' },
    });
    expect(env.slice(-3)).toEqual([
      { name: 'SMTP_HOST', value: 'smtp.caixa-exemplo.example' },
      { name: 'SMTP_PORT', value: '587' },
      { name: 'SMTP_USER', value: 'avisos+nos@verax.example' },
    ]);
    expect(env.map((entry) => entry.name).filter((name) => /PASSWORD|SECRET|TOKEN/.test(name))).toEqual([]);
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
    // Um cliente gravado antes do limite de 120: nunca chega ao Job.
    ['BOOTSTRAP_TENANT_NAME', { tenantName: 'a'.repeat(121) }],
    ['BOOTSTRAP_SUPPORT_EMAIL', { supportEmail: "O'NEIL+TI@CLIENTE-DEMO-A.EXAMPLE" }],
    ['IMAGES_REPOSITORY', { imagesRepository: 'docker.io/williandotdev/verax-control' }],
    ['SMTP_HOST', { nodeMail: { host: 'SMTP.caixa-exemplo.example', port: 465, user: 'avisos' } }],
    ['SMTP_HOST', { nodeMail: { host: 'smtp;touch-x.example', port: 465, user: 'avisos' } }],
    ['SMTP_HOST', { nodeMail: { host: 'localhost', port: 465, user: 'avisos' } }],
    ['SMTP_PORT', { nodeMail: { host: 'smtp.caixa-exemplo.example', port: 0, user: 'avisos' } }],
    ['SMTP_PORT', { nodeMail: { host: 'smtp.caixa-exemplo.example', port: 65_536, user: 'avisos' } }],
    ['SMTP_PORT', { nodeMail: { host: 'smtp.caixa-exemplo.example', port: 46.5, user: 'avisos' } }],
    [
      'SMTP_USER',
      { nodeMail: { host: 'smtp.caixa-exemplo.example', port: 465, user: "o'neil@verax.example" } },
    ],
    ['SMTP_USER', { nodeMail: { host: 'smtp.caixa-exemplo.example', port: 465, user: 'avisos verax' } }],
    ['SMTP_USER', { nodeMail: { host: 'smtp.caixa-exemplo.example', port: 465, user: '-avisos' } }],
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
    expect(isNodeSmtpHost('smtp.caixa-exemplo.example')).toBe(true);
    expect(isNodeSmtpHost('smtp-.example')).toBe(false);
    expect(isNodeSmtpHost(`${'a'.repeat(63)}.example`)).toBe(true);
    expect(isNodeSmtpHost(`${'a'.repeat(64)}.example`)).toBe(false);
    expect(isNodeSmtpHost(`${'a.'.repeat(126)}ex`)).toBe(false);
    expect(isSmtpPort('465')).toBe(true);
    expect(isSmtpPort('65535')).toBe(true);
    expect(isSmtpPort('0465')).toBe(false);
    expect(isSmtpPort('65536')).toBe(false);
    expect(isNodeSmtpUser('apikey')).toBe(true);
    expect(isNodeSmtpUser('a'.repeat(254))).toBe(true);
    expect(isNodeSmtpUser('a'.repeat(255))).toBe(false);
    expect(isNodeSmtpPassword('Senha-ficticia_1!')).toBe(true);
    expect(isNodeSmtpPassword('x'.repeat(512))).toBe(true);
    expect(isNodeSmtpPassword('x'.repeat(513))).toBe(false);
    expect(isNodeSmtpPassword("com'aspa")).toBe(false);
    expect(isNodeSmtpPassword('com espaco')).toBe(false);
    expect(isNodeSmtpPassword('quebra\n')).toBe(false);
    expect(isNodeSmtpPassword('acentuação')).toBe(false);
    expect(isNodeSmtpPassword('')).toBe(false);
    expect(isTenantName('Cliente ')).toBe(false);
  });

  it('o nome do cliente no nó: de 2 a 120 caracteres, o limite do checkout e do nó, sem corte', () => {
    expect(isTenantName('ã'.repeat(120))).toBe(true);
    expect(isTenantName('ã'.repeat(121))).toBe(false);
    expect(isTenantName('Cliente Demo A')).toBe(true);
    expect(isTenantName('A')).toBe(false);
    // O nó conta como o zod (unidades UTF-16): 60 emojis são 120 e passam; 61 são 122 e param aqui, e não no nó.
    expect(isTenantName('\u{1F600}'.repeat(60))).toBe(true);
    expect(isTenantName('\u{1F600}'.repeat(61))).toBe(false);
  });

  it('a faixa de rede do contador: dois octetos do meio', () => {
    expect(subnetCidrOf(1)).toBe('10.0.1.0/24');
    expect(subnetCidrOf(256)).toBe('10.1.0.0/24');
    expect(subnetCidrOf(65_535)).toBe('10.255.255.0/24');
    expect(isSubnetCidr(subnetCidrOf(12_345))).toBe(true);
  });
});

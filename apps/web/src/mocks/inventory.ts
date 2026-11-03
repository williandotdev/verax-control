import {
  type AccessKeyAsset,
  ASSET_KINDS,
  ASSET_RISKS,
  type AssetKind,
  assetListQuerySchema,
  assetSchemas,
  type BucketAsset,
  type IamUserAsset,
  type InstanceAsset,
  type InventorySummary,
  inventorySummarySchema,
  type SecurityGroupAsset,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_ACCOUNTS, DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';

/**
 * Inventário fictício (T5.9), coerente com as outras telas: a chave do incidente é antiga, o bucket de relatórios
 * está público, o grupo `sg-0123…` libera a porta 22 e o root da produção não tem MFA.
 */

interface AssetsByKind {
  users: IamUserAsset[];
  keys: AccessKeyAsset[];
  instances: InstanceAsset[];
  buckets: BucketAsset[];
  'security-groups': SecurityGroupAsset[];
}

interface TenantInventory {
  summary: InventorySummary;
  assets: AssetsByKind;
}

/** O que cada cliente fictício tem, antes de validar pelos schemas do contrato. */
interface RawInventory {
  roots: { accountId: string; root: InventorySummary['accounts'][number]['root'] }[];
  assets: Record<AssetKind, unknown[]>;
}

const days = (now: Date, count: number): string => new Date(now.getTime() - count * 86_400_000).toISOString();
const minutes = (now: Date, count: number): string => new Date(now.getTime() - count * 60_000).toISOString();

function alfa(now: Date): RawInventory {
  const prod = DEMO_ACCOUNTS.alfaProducao;
  const homolog = DEMO_ACCOUNTS.alfaHomologacao;
  const user = (
    accountId: string,
    userName: string,
    consoleAccess: boolean,
    mfaEnabled: boolean,
    activeKeys: number,
    risk: IamUserAsset['risk'],
    reasons: IamUserAsset['reasons'],
    createdDaysAgo: number,
  ): IamUserAsset => ({
    accountId,
    userName,
    arn: `arn:aws:iam::${accountId}:user/${userName}`,
    createdAt: days(now, createdDaysAgo),
    consoleAccess,
    mfaEnabled,
    activeKeys,
    risk,
    reasons,
  });
  const users: IamUserAsset[] = [
    user(prod, 'deploy-bot', false, false, 1, 'high', ['old_access_key'], 400),
    user(prod, 'joao.lima', true, false, 0, 'high', ['console_without_mfa'], 300),
    user(prod, 'marcos.vendas', true, false, 0, 'high', ['console_without_mfa'], 120),
    user(prod, 'suporte-temporario', true, false, 0, 'high', ['console_without_mfa'], 0),
    user(prod, 'backup-job', false, false, 1, 'high', ['old_access_key'], 500),
    user(prod, 'ana.souza', true, true, 1, 'medium', ['unused_access_key'], 600),
    user(prod, 'admin-financeiro', true, true, 1, 'none', [], 700),
    user(prod, 'carlos.dev', true, true, 0, 'none', [], 200),
    user(homolog, 'ci-homolog', false, false, 1, 'none', [], 60),
  ];
  // IDs fictícios com prefixo DEMO: o formato real (AKIA/ASIA) é barrado pela varredura do bundle.
  const keys: AccessKeyAsset[] = [
    {
      accountId: prod,
      id: 'DEMO3QX7Z2KD9WLB5N8R',
      userName: 'deploy-bot',
      status: 'Active',
      createdAt: days(now, 240),
      lastUsedAt: minutes(now, 25),
      risk: 'high',
      reasons: ['old_access_key'],
    },
    {
      accountId: prod,
      id: 'DEMO8HB4QP1TV6YC2J7F',
      userName: 'backup-job',
      status: 'Active',
      createdAt: days(now, 410),
      lastUsedAt: minutes(now, 1_000),
      risk: 'high',
      reasons: ['old_access_key'],
    },
    {
      accountId: prod,
      id: 'DEMO5MW2XR9LK3ZD7H4E',
      userName: 'ana.souza',
      status: 'Active',
      createdAt: days(now, 80),
      lastUsedAt: null,
      risk: 'medium',
      reasons: ['unused_access_key'],
    },
    {
      accountId: prod,
      id: 'DEMO1NV6TF8QA4GS0K2P',
      userName: 'admin-financeiro',
      status: 'Active',
      createdAt: minutes(now, 35),
      lastUsedAt: null,
      risk: 'none',
      reasons: [],
    },
    {
      accountId: homolog,
      id: 'DEMO9CH4LG7MB2XW6R1T',
      userName: 'ci-homolog',
      status: 'Active',
      createdAt: days(now, 30),
      lastUsedAt: minutes(now, 300),
      risk: 'none',
      reasons: [],
    },
  ];
  const instances: InstanceAsset[] = [
    {
      accountId: prod,
      instanceId: 'i-0a1b2c3d4e5f67890',
      region: 'sa-east-1',
      state: 'running',
      publicIp: '198.51.100.40',
      imdsV2Required: false,
      securityGroupIds: ['sg-0123456789abcdef0'],
      risk: 'high',
      reasons: ['public_ip_imdsv1'],
    },
    {
      accountId: prod,
      instanceId: 'i-0f1e2d3c4b5a69788',
      region: 'sa-east-1',
      state: 'running',
      publicIp: null,
      imdsV2Required: false,
      securityGroupIds: ['sg-0cc33dd44ee55ff66'],
      risk: 'medium',
      reasons: ['imdsv1'],
    },
    {
      accountId: prod,
      instanceId: 'i-0123abcd4567ef890',
      region: 'sa-east-1',
      state: 'running',
      publicIp: '198.51.100.41',
      imdsV2Required: true,
      securityGroupIds: ['sg-0aa11bb22cc33dd44'],
      risk: 'none',
      reasons: [],
    },
    {
      accountId: homolog,
      instanceId: 'i-0123456789abcdef1',
      region: 'sa-east-1',
      state: 'stopped',
      publicIp: null,
      imdsV2Required: false,
      securityGroupIds: ['sg-0dd44ee55ff660011'],
      risk: 'medium',
      reasons: ['imdsv1'],
    },
  ];
  const bucket = (
    name: string,
    policyPublic: boolean,
    publicAccessBlocked: boolean,
    risk: BucketAsset['risk'],
    reasons: BucketAsset['reasons'],
  ): BucketAsset => ({
    accountId: prod,
    name,
    region: 'sa-east-1',
    policyPublic,
    aclPublic: false,
    publicAccessBlocked,
    risk,
    reasons,
  });
  const buckets: BucketAsset[] = [
    bucket('loja-exemplo-relatorios', true, false, 'critical', [
      'bucket_public',
      'bucket_without_public_block',
    ]),
    bucket('loja-exemplo-tmp', false, false, 'medium', ['bucket_without_public_block']),
    bucket('loja-exemplo-imagens', false, true, 'none', []),
    bucket('loja-exemplo-backups', false, true, 'none', []),
    bucket(`cloudtrail-logs-${prod}`, false, true, 'none', []),
  ];
  const group = (
    accountId: string,
    groupId: string,
    name: string,
    openToWorld: SecurityGroupAsset['openToWorld'],
    risk: SecurityGroupAsset['risk'],
    reasons: SecurityGroupAsset['reasons'],
  ): SecurityGroupAsset => ({
    accountId,
    groupId,
    region: 'sa-east-1',
    name,
    vpcId: 'vpc-0abc1234def567890',
    openToWorld,
    risk,
    reasons,
  });
  const securityGroups: SecurityGroupAsset[] = [
    group(
      prod,
      'sg-0123456789abcdef0',
      'acesso-ssh',
      [{ protocol: 'tcp', fromPort: 22, toPort: 22 }],
      'critical',
      ['admin_port_open'],
    ),
    group(
      prod,
      'sg-0bb22cc33dd44ee55',
      'banco-legado',
      [{ protocol: 'tcp', fromPort: 5432, toPort: 5432 }],
      'high',
      ['database_port_open'],
    ),
    group(
      prod,
      'sg-0aa11bb22cc33dd44',
      'web-publico',
      [
        { protocol: 'tcp', fromPort: 443, toPort: 443 },
        { protocol: 'tcp', fromPort: 80, toPort: 80 },
      ],
      'low',
      ['web_port_open'],
    ),
    group(prod, 'sg-0cc33dd44ee55ff66', 'interno', [], 'none', []),
    group(
      homolog,
      'sg-0dd44ee55ff660011',
      'homolog-ssh',
      [{ protocol: 'tcp', fromPort: 22, toPort: 22 }],
      'critical',
      ['admin_port_open'],
    ),
  ];
  return {
    roots: [
      {
        accountId: prod,
        root: {
          mfaEnabled: false,
          accessKeysPresent: false,
          risk: 'critical' as const,
          reasons: ['root_without_mfa' as const],
        },
      },
      {
        accountId: homolog,
        root: { mfaEnabled: true, accessKeysPresent: false, risk: 'none' as const, reasons: [] },
      },
    ],
    assets: { users, keys, instances, buckets, 'security-groups': securityGroups },
  };
}

function beta(now: Date): RawInventory {
  const account = DEMO_ACCOUNTS.beta;
  return {
    roots: [
      {
        accountId: account,
        root: { mfaEnabled: true, accessKeysPresent: false, risk: 'none' as const, reasons: [] },
      },
    ],
    assets: {
      users: [
        {
          accountId: account,
          userName: 'paulo.ti',
          arn: `arn:aws:iam::${account}:user/paulo.ti`,
          createdAt: days(now, 300),
          consoleAccess: true,
          mfaEnabled: true,
          activeKeys: 0,
          risk: 'none' as const,
          reasons: [],
        },
      ],
      keys: [],
      instances: [],
      buckets: [
        {
          accountId: account,
          name: 'beta-site-estatico',
          region: 'sa-east-1',
          policyPublic: false,
          aclPublic: false,
          publicAccessBlocked: true,
          risk: 'none' as const,
          reasons: [],
        },
      ],
      'security-groups': [
        {
          accountId: account,
          groupId: 'sg-0ee55ff6600112233',
          region: 'sa-east-1',
          name: 'site',
          vpcId: 'vpc-0def5678abc123456',
          openToWorld: [{ protocol: 'tcp', fromPort: 443, toPort: 443 }],
          risk: 'low' as const,
          reasons: ['web_port_open' as const],
        },
      ],
    },
  };
}

export function demoInventory(now: Date = new Date()): Map<string, TenantInventory> {
  const [alfaId, betaId] = DEMO_TENANTS.map((tenant) => tenant.id);
  const build = ({ roots, assets }: RawInventory): TenantInventory => {
    const parsed: AssetsByKind = {
      users: assets.users.map((item) => assetSchemas.users.parse(item)),
      keys: assets.keys.map((item) => assetSchemas.keys.parse(item)),
      instances: assets.instances.map((item) => assetSchemas.instances.parse(item)),
      buckets: assets.buckets.map((item) => assetSchemas.buckets.parse(item)),
      'security-groups': assets['security-groups'].map((item) => assetSchemas['security-groups'].parse(item)),
    };
    const count = (items: { risk: string }[]) => ({
      total: items.length,
      atRisk: items.filter((item) => item.risk !== 'none').length,
    });
    return {
      summary: inventorySummarySchema.parse({
        accounts: roots.map(({ accountId, root }) => ({
          accountId,
          collectedAt: minutes(now, 4 * 60),
          root,
        })),
        counts: {
          users: count(parsed.users),
          keys: count(parsed.keys),
          instances: count(parsed.instances),
          buckets: count(parsed.buckets),
          'security-groups': count(parsed['security-groups']),
        },
      }),
      assets: parsed,
    };
  };
  return new Map([
    [alfaId ?? '', build(alfa(now))],
    [betaId ?? '', build(beta(now))],
  ]);
}

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

/** Inventário do modo mock, com o contrato da T5.9: visão geral e uma lista por tipo, do maior risco ao menor. */
export function createInventoryHandlers(
  state: MockState,
  store: Map<string, TenantInventory> = demoInventory(),
) {
  const scoped = () => {
    if (!state.me) return { error: problem(401, 'Não autenticado') } as const;
    const tenantId = state.me.scopeTenantId;
    if (!tenantId) return { error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') } as const;
    return { inventory: store.get(tenantId) ?? null } as const;
  };

  return [
    http.get(url('/v1/assets'), () => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const empty = { total: 0, atRisk: 0 };
      return HttpResponse.json(
        scope.inventory?.summary ?? {
          accounts: [],
          counts: { users: empty, keys: empty, instances: empty, buckets: empty, 'security-groups': empty },
        },
      );
    }),
    http.get(url('/v1/assets/:kind'), ({ params, request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const kind = ASSET_KINDS.find((candidate) => candidate === params['kind']);
      if (!kind) return problem(404, 'Tipo de ativo desconhecido');
      const query = assetListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!query.success) return problem(400, 'Filtro inválido');
      const { accountId, atRisk, page, pageSize } = query.data;
      const items = (scope.inventory?.assets[kind] ?? [])
        .filter((item) => (!accountId || item.accountId === accountId) && (!atRisk || item.risk !== 'none'))
        .sort((a, b) => ASSET_RISKS.indexOf(a.risk) - ASSET_RISKS.indexOf(b.risk));
      const start = (page - 1) * pageSize;
      return HttpResponse.json({
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        total: items.length,
      });
    }),
  ];
}

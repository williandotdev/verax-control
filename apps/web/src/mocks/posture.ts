import {
  GLOBAL_REGION,
  NATIVE_POSTURE_CHECKS,
  type PostureAccount,
  postureAccountSchema,
  type PostureCheck,
  postureCheckListQuerySchema,
  postureCheckSchema,
  postureCheckStatus,
  POSTURE_SEVERITIES,
  type PostureSectionError,
  type PostureSeverity,
  type PostureOverview,
  postureOverviewSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_ACCOUNTS, DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';

/**
 * Postura fictícia (T5.8 e PR-15'): o catálogo nativo de 18 checagens (`NATIVE_POSTURE_CHECKS`, o mesmo da API), com
 * os resultados coerentes com o inventário da demonstração (`mocks/inventory.ts`): o root da produção sem MFA, o bucket
 * de relatórios público, o grupo `sg-0123…` com SSH aberto, as chaves antigas. A produção monitora também us-east-1,
 * onde a SCP fictícia nega o EC2: lá as checagens de EC2 ficam "não lidas" e a varredura é parcial. A nota de cada
 * conta sai da mesma fórmula da API (crítica 10, alta 5, média 2, baixa 1); a Alfa fica abaixo do limite, como a Torre
 * mostra, e a Beta, bem acima.
 */

/** Uma reprovação: a região (ou `global`) e o recurso. */
interface FailureSpec {
  region?: string;
  resource?: string | null;
}

/** O resultado de uma checagem numa conta; o que não aparece não se aplica. */
interface CheckSpec {
  passed?: number;
  failed?: FailureSpec[];
  unknown?: number;
}

const WEIGHTS: Readonly<Record<PostureSeverity, number>> = {
  critical: 10,
  high: 5,
  medium: 2,
  low: 1,
  informational: 0,
};

interface DemoAccount {
  account: PostureAccount;
  failures: PostureCheck[];
  /** Os pesos, para a nota do cliente (a mesma soma da API). */
  weightPassed: number;
  weightTotal: number;
}

/** Nota diária dos últimos 30 dias, de `start` a `end`, com a oscilação de um ambiente de verdade. */
function history(start: number, end: number, now: Date): { date: string; score: number }[] {
  const wobble = [0, 1, -1, 0, 2, -1, 0, 1, -2, 0];
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(now.getTime() - (29 - index) * 86_400_000).toISOString().slice(0, 10);
    const trend = start + ((end - start) * index) / 29;
    const score = index === 29 ? end : Math.round(trend + (wobble[index % wobble.length] ?? 0));
    return { date, score: Math.min(100, Math.max(0, score)) };
  });
}

function demoAccount(
  accountId: string,
  specs: Record<string, CheckSpec>,
  options: { startScore: number; scannedHoursAgo: number; errors?: PostureSectionError[]; now: Date },
): DemoAccount {
  const failedBySeverity = Object.fromEntries(POSTURE_SEVERITIES.map((severity) => [severity, 0])) as Record<
    PostureSeverity,
    number
  >;
  const failures: PostureCheck[] = [];
  let weightPassed = 0;
  let weightTotal = 0;
  let passed = 0;
  let unknown = 0;
  const checks = NATIVE_POSTURE_CHECKS.map((check) => {
    const spec = specs[check.id] ?? {};
    const failed = spec.failed ?? [];
    const counts = { passed: spec.passed ?? 0, failed: failed.length, unknown: spec.unknown ?? 0 };
    passed += counts.passed;
    unknown += counts.unknown;
    weightPassed += counts.passed * WEIGHTS[check.severity];
    weightTotal += (counts.passed + counts.failed) * WEIGHTS[check.severity];
    failedBySeverity[check.severity] += counts.failed;
    failed.forEach(({ region = GLOBAL_REGION, resource = null }, index) => {
      failures.push(
        postureCheckSchema.parse({
          id: `demo-${accountId}-${check.id}-${index}`,
          checkId: check.id,
          title: check.failTitle,
          severity: check.severity,
          accountId,
          region,
          resource,
          resourceType: check.resourceType,
          risk: check.risk,
          remediation: check.remediation({ accountId, region, resource }),
          references: [...check.references],
        }),
      );
    });
    return {
      checkId: check.id,
      title: check.title,
      severity: check.severity,
      ...counts,
      status: postureCheckStatus(counts),
    };
  });
  const score = Math.round((weightPassed / weightTotal) * 100);
  return {
    account: postureAccountSchema.parse({
      accountId,
      score,
      scannedAt: new Date(options.now.getTime() - options.scannedHoursAgo * 3_600_000).toISOString(),
      passed,
      failed: failures.length,
      unknown,
      failedBySeverity,
      history: history(options.startScore, score, options.now),
      checks,
      errors: options.errors ?? [],
    }),
    failures,
    weightPassed,
    weightTotal,
  };
}

const sa = 'sa-east-1';
const us = 'us-east-1';
const at = (region: string, resource: string | null = null): FailureSpec => ({ region, resource });
const account = (resource: string | null = null): FailureSpec => ({ resource });

/** A produção da Alfa: o retrato de Ativos, com o EC2 de us-east-1 negado pela SCP fictícia. */
function alfaProduction(now: Date): DemoAccount {
  const id = DEMO_ACCOUNTS.alfaProducao;
  // A região recusada: cada checagem de EC2 fica não lida lá (um resultado por checagem).
  const refusedRegion = { unknown: 1 };
  return demoAccount(
    id,
    {
      iam_root_mfa_enabled: { failed: [account(`arn:aws:iam::${id}:root`)] },
      iam_no_root_access_key: { passed: 1 },
      iam_user_mfa_enabled_console_access: {
        passed: 3,
        failed: [account('joao.lima'), account('marcos.vendas'), account('suporte-temporario')],
      },
      iam_rotate_access_key_90_days: {
        passed: 2,
        failed: [account('deploy-bot · DEMO3QX7Z2KD9WLB5N8R'), account('backup-job · DEMO8HB4QP1TV6YC2J7F')],
      },
      iam_user_accesskey_unused: { passed: 3, failed: [account('ana.souza · DEMO5MW2XR9LK3ZD7H4E')] },
      iam_password_policy_minimum_length_14: { failed: [account()] },
      iam_password_policy_reuse_24: { failed: [account()] },
      ec2_securitygroup_allow_ingress_from_internet_to_all_ports: { passed: 4, ...refusedRegion },
      ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22: {
        passed: 3,
        failed: [at(sa, 'sg-0123456789abcdef0 (acesso-ssh)')],
        ...refusedRegion,
      },
      ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389: { passed: 4, ...refusedRegion },
      ec2_securitygroup_allow_ingress_from_internet_to_database_ports: {
        passed: 3,
        failed: [at(sa, 'sg-0bb22cc33dd44ee55 (banco-legado)')],
        ...refusedRegion,
      },
      ec2_instance_imdsv2_enabled: {
        passed: 1,
        failed: [at(sa, 'i-0a1b2c3d4e5f67890'), at(sa, 'i-0f1e2d3c4b5a69788')],
        ...refusedRegion,
      },
      ec2_ebs_default_encryption: { failed: [at(sa)], ...refusedRegion },
      s3_bucket_public_access: { passed: 4, failed: [at(sa, 'loja-exemplo-relatorios')] },
      s3_bucket_level_public_access_block: {
        passed: 3,
        failed: [at(sa, 'loja-exemplo-relatorios'), at(sa, 'loja-exemplo-tmp')],
      },
      s3_account_level_public_access_blocks: { failed: [account()] },
      cloudtrail_multi_region_enabled: { passed: 1 },
      guardduty_is_enabled: { passed: 1, failed: [at(us)] },
    },
    {
      startScore: 58,
      scannedHoursAgo: 6,
      errors: [
        { section: 'ec2', region: us, code: 'UnauthorizedOperation' },
        { section: 'sg', region: us, code: 'UnauthorizedOperation' },
        { section: 'ebs', region: us, code: 'UnauthorizedOperation' },
      ],
      now,
    },
  );
}

/** A homologação da Alfa (com erro de conexão há 30 horas: a última varredura é de antes). */
function alfaStaging(now: Date): DemoAccount {
  return demoAccount(
    DEMO_ACCOUNTS.alfaHomologacao,
    {
      iam_root_mfa_enabled: { passed: 1 },
      iam_no_root_access_key: { passed: 1 },
      iam_rotate_access_key_90_days: { passed: 1 },
      iam_user_accesskey_unused: { passed: 1 },
      iam_password_policy_minimum_length_14: { passed: 1 },
      iam_password_policy_reuse_24: { failed: [account()] },
      ec2_securitygroup_allow_ingress_from_internet_to_all_ports: { passed: 1 },
      ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22: {
        failed: [at(sa, 'sg-0dd44ee55ff660011 (homolog-ssh)')],
      },
      ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389: { passed: 1 },
      ec2_securitygroup_allow_ingress_from_internet_to_database_ports: { passed: 1 },
      ec2_instance_imdsv2_enabled: { failed: [at(sa, 'i-0123456789abcdef1')] },
      ec2_ebs_default_encryption: { passed: 1 },
      s3_account_level_public_access_blocks: { passed: 1 },
      cloudtrail_multi_region_enabled: { failed: [account()] },
      guardduty_is_enabled: { failed: [at(sa)] },
    },
    { startScore: 69, scannedHoursAgo: 31, now },
  );
}

function betaAccount(now: Date): DemoAccount {
  const groups = { passed: 1 };
  return demoAccount(
    DEMO_ACCOUNTS.beta,
    {
      iam_root_mfa_enabled: { passed: 1 },
      iam_no_root_access_key: { passed: 1 },
      iam_user_mfa_enabled_console_access: { passed: 1 },
      iam_password_policy_minimum_length_14: { passed: 1 },
      iam_password_policy_reuse_24: { failed: [account()] },
      ec2_securitygroup_allow_ingress_from_internet_to_all_ports: groups,
      ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22: groups,
      ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389: groups,
      ec2_securitygroup_allow_ingress_from_internet_to_database_ports: groups,
      ec2_ebs_default_encryption: { failed: [at(sa)] },
      s3_bucket_public_access: { passed: 1 },
      s3_bucket_level_public_access_block: { passed: 1 },
      s3_account_level_public_access_blocks: { passed: 1 },
      cloudtrail_multi_region_enabled: { passed: 1 },
      guardduty_is_enabled: { passed: 1 },
    },
    { startScore: 85, scannedHoursAgo: 7, now },
  );
}

export interface DemoPosture {
  overview: PostureOverview;
  checks: PostureCheck[];
}

/** A visão do cliente: a nota soma os pesos de todas as contas, como a API (`combinedScore`). */
function tenantPosture(accounts: DemoAccount[]): DemoPosture {
  const passed = accounts.reduce((sum, item) => sum + item.weightPassed, 0);
  const total = accounts.reduce((sum, item) => sum + item.weightTotal, 0);
  return {
    overview: postureOverviewSchema.parse({
      score: Math.round((passed / total) * 100),
      warningBelow: 70,
      accounts: accounts.map((item) => item.account),
    }),
    checks: accounts.flatMap((item) => item.failures),
  };
}

export function demoPosture(now: Date = new Date()): Map<string, DemoPosture> {
  const [alfa, beta] = DEMO_TENANTS.map((tenant) => tenant.id);
  return new Map([
    [alfa ?? '', tenantPosture([alfaProduction(now), alfaStaging(now)])],
    [beta ?? '', tenantPosture([betaAccount(now)])],
  ]);
}

const url = (path: string): string => `${API_URL}${path}`;
const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });

/** Postura do modo mock, com o contrato da T5.8: visão por conta e checagens reprovadas da mais grave à menos. */
export function createPostureHandlers(state: MockState, store: Map<string, DemoPosture> = demoPosture()) {
  const scoped = () => {
    if (!state.me) return { error: problem(401, 'Não autenticado') } as const;
    const tenantId = state.me.scopeTenantId;
    if (!tenantId) return { error: problem(400, 'Escolha um cliente', 'TENANT_REQUIRED') } as const;
    return {
      posture: store.get(tenantId) ?? {
        overview: postureOverviewSchema.parse({ score: null, warningBelow: 70, accounts: [] }),
        checks: [],
      },
    } as const;
  };

  return [
    http.get(url('/v1/posture'), () => {
      const scope = scoped();
      return 'error' in scope ? scope.error : HttpResponse.json(scope.posture.overview);
    }),
    http.get(url('/v1/posture/checks'), ({ request }) => {
      const scope = scoped();
      if ('error' in scope) return scope.error;
      const query = postureCheckListQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
      if (!query.success) return problem(400, 'Filtro inválido');
      const { accountId, severity, page, pageSize } = query.data;
      const items = scope.posture.checks
        .filter(
          (item) => (!accountId || item.accountId === accountId) && (!severity || item.severity === severity),
        )
        .sort(
          (a, b) =>
            POSTURE_SEVERITIES.indexOf(a.severity) - POSTURE_SEVERITIES.indexOf(b.severity) ||
            a.title.localeCompare(b.title, 'pt-BR'),
        );
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

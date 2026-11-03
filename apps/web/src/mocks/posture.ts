import {
  type PostureAccount,
  postureAccountSchema,
  type PostureCheck,
  postureCheckListQuerySchema,
  postureCheckSchema,
  POSTURE_SEVERITIES,
  type PostureSeverity,
  type PostureOverview,
  postureOverviewSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_ACCOUNTS, DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';

/**
 * Postura fictícia (T5.8): checagens reais do Prowler (os IDs), com título, risco e correção em português, e a
 * evolução da nota nos últimos 30 dias. A Alfa está abaixo do limite, como a Torre mostra; a Beta, bem acima.
 */

type CheckTemplate = Omit<PostureCheck, 'id' | 'accountId' | 'references'> & { reference: string };

const DOCS = 'https://docs.aws.amazon.com';

const CHECKS: Record<string, CheckTemplate> = {
  rootMfa: {
    checkId: 'iam_root_mfa_enabled',
    title: 'Usuário root sem MFA',
    severity: 'critical',
    region: 'us-east-1',
    resource: 'root',
    resourceType: 'AwsIamUser',
    risk: 'Quem descobrir a senha do root controla a conta inteira, sem nenhum segundo fator.',
    remediation:
      'Entre no console como root, abra "Credenciais de segurança" e ative um dispositivo de MFA (de preferência uma chave física).',
    reference: `${DOCS}/IAM/latest/UserGuide/enable-virt-mfa-for-root.html`,
  },
  bucketPublico: {
    checkId: 's3_bucket_public_access',
    title: 'Bucket S3 com leitura pública',
    severity: 'critical',
    region: 'sa-east-1',
    resource: 'loja-exemplo-relatorios',
    resourceType: 'AwsS3Bucket',
    risk: 'Qualquer pessoa na internet pode listar e baixar os arquivos do bucket.',
    remediation:
      'Ligue o bloqueio de acesso público do bucket:\naws s3api put-public-access-block --bucket loja-exemplo-relatorios --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true',
    reference: `${DOCS}/AmazonS3/latest/userguide/access-control-block-public-access.html`,
  },
  ssh: {
    checkId: 'ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22',
    title: 'Grupo de segurança libera SSH (porta 22) para a internet',
    severity: 'high',
    region: 'sa-east-1',
    resource: 'sg-0123456789abcdef0',
    resourceType: 'AwsEc2SecurityGroup',
    risk: 'A porta 22 aberta para 0.0.0.0/0 recebe tentativas de força bruta o tempo todo.',
    remediation:
      'Remova a regra de entrada 0.0.0.0/0 na porta 22 e use o Session Manager do SSM para acessar as instâncias.',
    reference: `${DOCS}/vpc/latest/userguide/security-group-rules.html`,
  },
  chaveAntiga: {
    checkId: 'iam_rotate_access_key_90_days',
    title: 'Chave de acesso com mais de 90 dias',
    severity: 'high',
    region: 'us-east-1',
    resource: 'deploy-bot',
    resourceType: 'AwsIamAccessKey',
    risk: 'Chave antiga tem mais chance de ter vazado em algum lugar (repositório, máquina antiga, log).',
    remediation:
      'Crie uma chave nova para o usuário, troque onde a antiga é usada, desative a antiga e apague-a depois de alguns dias sem uso.',
    reference: `${DOCS}/IAM/latest/UserGuide/id_credentials_access-keys.html#rotating_access_keys_console`,
  },
  trilhaSemValidacao: {
    checkId: 'cloudtrail_log_file_validation_enabled',
    title: 'Trilha do CloudTrail sem validação de integridade',
    severity: 'high',
    region: 'us-east-1',
    resource: 'trilha-principal',
    resourceType: 'AwsCloudTrailTrail',
    risk: 'Sem a validação, não dá para provar que os registros de auditoria não foram alterados.',
    remediation: 'aws cloudtrail update-trail --name trilha-principal --enable-log-file-validation',
    reference: `${DOCS}/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html`,
  },
  guardDutyRegiao: {
    checkId: 'guardduty_is_enabled',
    title: 'GuardDuty desligado na região us-west-2',
    severity: 'high',
    region: 'us-west-2',
    resource: null,
    resourceType: 'AwsGuardDutyDetector',
    risk: 'Um invasor costuma usar regiões que ninguém olha para subir máquinas de mineração.',
    remediation:
      'Ative o GuardDuty em todas as regiões habilitadas da conta (ou desabilite as regiões que não usa).',
    reference: `${DOCS}/guardduty/latest/ug/guardduty_settingup.html`,
  },
  ebs: {
    checkId: 'ec2_ebs_volume_encryption',
    title: 'Volume EBS sem criptografia',
    severity: 'high',
    region: 'sa-east-1',
    resource: 'vol-0a1b2c3d4e5f67890',
    resourceType: 'AwsEc2Volume',
    risk: 'Snapshots e cópias do disco ficam legíveis por quem tiver acesso a eles.',
    remediation:
      'Ative a criptografia padrão do EBS na região e migre o volume: snapshot, cópia cifrada do snapshot e novo volume a partir dela.',
    reference: `${DOCS}/ebs/latest/userguide/ebs-encryption.html`,
  },
  senhaFraca: {
    checkId: 'iam_password_policy_minimum_length_14',
    title: 'Política de senha da conta aceita menos de 14 caracteres',
    severity: 'medium',
    region: 'us-east-1',
    resource: null,
    resourceType: 'AwsAccount',
    risk: 'Senhas curtas são quebradas mais rápido.',
    remediation:
      'aws iam update-account-password-policy --minimum-password-length 14 --require-symbols --require-numbers',
    reference: `${DOCS}/IAM/latest/UserGuide/id_credentials_passwords_account-policy.html`,
  },
  bloqueioConta: {
    checkId: 's3_account_level_public_access_blocks',
    title: 'Bloqueio de acesso público do S3 desligado na conta',
    severity: 'medium',
    region: 'us-east-1',
    resource: null,
    resourceType: 'AwsAccount',
    risk: 'Um bucket novo pode ficar público por engano.',
    remediation:
      'Ligue o bloqueio de acesso público no nível da conta (S3 → Bloquear acesso público para esta conta).',
    reference: `${DOCS}/AmazonS3/latest/userguide/configuring-block-public-access-account.html`,
  },
  imdsv1: {
    checkId: 'ec2_instance_imdsv2_enabled',
    title: 'Instância aceita IMDSv1',
    severity: 'medium',
    region: 'sa-east-1',
    resource: 'i-0f1e2d3c4b5a69788',
    resourceType: 'AwsEc2Instance',
    risk: 'Uma falha de SSRF na aplicação pode vazar as credenciais da instância pelo IMDSv1.',
    remediation:
      'aws ec2 modify-instance-metadata-options --instance-id i-0f1e2d3c4b5a69788 --http-tokens required',
    reference: `${DOCS}/AWSEC2/latest/UserGuide/configuring-IMDS-existing-instances.html`,
  },
  flowLogs: {
    checkId: 'vpc_flow_logs_enabled',
    title: 'VPC sem flow logs',
    severity: 'medium',
    region: 'sa-east-1',
    resource: 'vpc-0abc1234def567890',
    resourceType: 'AwsEc2Vpc',
    risk: 'Sem registro do tráfego, não dá para investigar de onde veio uma conexão.',
    remediation: 'Ative os flow logs da VPC, gravando no S3 (mais barato) ou no CloudWatch Logs.',
    reference: `${DOCS}/vpc/latest/userguide/flow-logs.html`,
  },
  versionamento: {
    checkId: 's3_bucket_object_versioning',
    title: 'Bucket sem versionamento',
    severity: 'low',
    region: 'sa-east-1',
    resource: 'loja-exemplo-imagens',
    resourceType: 'AwsS3Bucket',
    risk: 'Um arquivo apagado ou sobrescrito por engano não tem volta.',
    remediation:
      'aws s3api put-bucket-versioning --bucket loja-exemplo-imagens --versioning-configuration Status=Enabled',
    reference: `${DOCS}/AmazonS3/latest/userguide/Versioning.html`,
  },
  alarmeIam: {
    checkId: 'cloudwatch_changes_to_iam_policies_alarm_configured',
    title: 'Sem alarme para mudanças em políticas do IAM',
    severity: 'low',
    region: 'us-east-1',
    resource: null,
    resourceType: 'AwsAccount',
    risk: 'Uma permissão ampliada passa sem ninguém saber.',
    remediation:
      'Crie um filtro de métrica no grupo de log da trilha para eventos do IAM e um alarme ligado a ele.',
    reference: `${DOCS}/awscloudtrail/latest/userguide/cloudwatch-alarms-for-cloudtrail.html`,
  },
};

function check(name: keyof typeof CHECKS, accountId: string): PostureCheck {
  const { reference, ...template } = CHECKS[name] as CheckTemplate;
  return postureCheckSchema.parse({
    ...template,
    id: `prowler-aws-${template.checkId}-${accountId}-${template.region}-${template.resource ?? 'conta'}`,
    accountId,
    references: [reference],
  });
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

function account(
  accountId: string,
  score: number,
  startScore: number,
  checks: PostureCheck[],
  passed: number,
  now: Date,
): PostureAccount {
  const failedBySeverity = Object.fromEntries(POSTURE_SEVERITIES.map((severity) => [severity, 0])) as Record<
    PostureSeverity,
    number
  >;
  for (const item of checks) failedBySeverity[item.severity] += 1;
  return postureAccountSchema.parse({
    accountId,
    score,
    scannedAt: new Date(now.getTime() - 6 * 3_600_000).toISOString(),
    passed,
    failed: checks.length,
    failedBySeverity,
    history: history(startScore, score, now),
  });
}

export interface DemoPosture {
  overview: PostureOverview;
  checks: PostureCheck[];
}

export function demoPosture(now: Date = new Date()): Map<string, DemoPosture> {
  const [alfa, beta] = DEMO_TENANTS.map((tenant) => tenant.id);
  const prod = DEMO_ACCOUNTS.alfaProducao;
  const homolog = DEMO_ACCOUNTS.alfaHomologacao;
  const prodChecks = (
    [
      'rootMfa',
      'bucketPublico',
      'ssh',
      'chaveAntiga',
      'trilhaSemValidacao',
      'ebs',
      'senhaFraca',
      'bloqueioConta',
      'imdsv1',
      'flowLogs',
      'versionamento',
      'alarmeIam',
    ] as const
  ).map((name) => check(name, prod));
  const homologChecks = (['guardDutyRegiao', 'ssh', 'imdsv1', 'flowLogs', 'versionamento'] as const).map(
    (name) => check(name, homolog),
  );
  const betaChecks = (['senhaFraca', 'versionamento', 'alarmeIam'] as const).map((name) =>
    check(name, DEMO_ACCOUNTS.beta),
  );
  return new Map([
    [
      alfa ?? '',
      {
        overview: postureOverviewSchema.parse({
          score: 64,
          warningBelow: 70,
          accounts: [
            account(prod, 61, 52, prodChecks, 148, now),
            account(homolog, 72, 69, homologChecks, 131, now),
          ],
        }),
        checks: [...prodChecks, ...homologChecks],
      },
    ],
    [
      beta ?? '',
      {
        overview: postureOverviewSchema.parse({
          score: 91,
          warningBelow: 70,
          accounts: [account(DEMO_ACCOUNTS.beta, 91, 84, betaChecks, 176, now)],
        }),
        checks: betaChecks,
      },
    ],
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

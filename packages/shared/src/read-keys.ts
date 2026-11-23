import {
  AWS_LOG_GROUP_TAG,
  AWS_READER_CAPABILITIES,
  AWS_READER_ROLE_PATH,
  AWS_READER_ROLE_TAGS,
  AWS_READER_TEMPLATE_VERSION,
  type AwsReaderCapability,
  awsLogBucketArns,
  awsReaderCapabilitiesTagValue,
  isNodeEgressIp,
  MAX_NODE_EGRESS_IPS,
} from './aws-reader.js';
import { GCP_SINK_LOG_FILTER } from './cloud-accounts.js';

/**
 * As chaves de leitura do nó na VM própria do cliente (`NODE_PLATFORM=vm`; `docs/ARQUITETURA.md`, "Cofre de
 * credenciais"). Lá o nó não tem identidade do Google: não entra no papel sem chave da AWS nem lê o Pub/Sub com a conta
 * da VM. O cliente cria, na conta e no projeto dele, uma identidade só de leitura e cola a chave no painel, que vai
 * cifrada para o cofre do nó (como o token do Cloudflare).
 *
 * - **AWS:** um usuário IAM `/verax/verax-control-reader` com as mesmas duas políticas do papel de leitura
 *   (`infra/cloudformation/verax-control-reader.policy.json`; um teste confere que as ações são as mesmas): a
 *   `VeraxControlReader` (leitura, também o limite de permissões do usuário) e a `VeraxControlGuardrails` (negações).
 *   Muda só o que é do papel: a autoinspeção é no próprio usuário (`iam:GetUser` no lugar do `iam:GetRole`: as
 *   etiquetas do modelo e do que foi autorizado ficam no usuário), e a chave KMS dos buckets cadastrados é qualquer
 *   uma da conta, mas só pelo S3 (o cadastro não tem as chaves). O IP de saída da VM, quando o nó o informa, entra na
 *   negação de fora dele. A descoberta vale sempre, e as três autorizações do cliente (`AWS_READER_CAPABILITIES`)
 *   somam, cada uma, as mesmas declarações que somam ao papel.
 * - **GCP:** o cliente cria no projeto dele o tópico, a assinatura e o sink (o mesmo filtro do gerenciado), e uma conta
 *   de serviço com `roles/pubsub.subscriber` só na assinatura. O nó lê a assinatura com a chave dessa conta. Nada no
 *   projeto do nó (não há projeto do nó na VM própria).
 */

/** O usuário IAM de leitura: mesmo caminho e mesmo nome do papel, para as políticas e os alertas valerem igual. */
export const AWS_READER_USER_PATH = AWS_READER_ROLE_PATH;
export const AWS_READER_IAM_NAME = 'verax-control-reader';
export const AWS_READER_POLICY_NAME = 'VeraxControlReader';
export const AWS_GUARDRAILS_POLICY_NAME = 'VeraxControlGuardrails';
/** Os arquivos que os comandos esperam (o painel mostra o conteúdo de cada um para copiar). */
export const AWS_READER_POLICY_FILE = 'verax-control-reader.json';
export const AWS_GUARDRAILS_POLICY_FILE = 'verax-control-guardrails.json';

export function awsReaderUserArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:user${AWS_READER_USER_PATH}${AWS_READER_IAM_NAME}`;
}

/** As ações de leitura do papel (`ValidarFontes` e `PosturaEAtivos` do template), as mesmas no usuário. */
export const AWS_READER_SOURCE_ACTIONS = [
  'cloudtrail:DescribeTrails',
  'cloudtrail:GetTrailStatus',
  'guardduty:ListDetectors',
  'guardduty:GetDetector',
  'guardduty:ListPublishingDestinations',
  'guardduty:DescribePublishingDestination',
] as const;
export const AWS_READER_POSTURE_ACTIONS = [
  'iam:GetAccountSummary',
  'iam:GetAccountPasswordPolicy',
  'iam:ListUsers',
  'iam:ListAccessKeys',
  'iam:GetAccessKeyLastUsed',
  'iam:ListMFADevices',
  'iam:GetLoginProfile',
  'ec2:DescribeRegions',
  'ec2:DescribeInstances',
  'ec2:DescribeSecurityGroups',
  'ec2:GetEbsEncryptionByDefault',
  's3:ListAllMyBuckets',
  's3:GetBucketAcl',
  's3:GetBucketPolicyStatus',
  's3:GetBucketPublicAccessBlock',
  's3:GetAccountPublicAccessBlock',
] as const;
/** A descoberta das fontes (`DescobrirFontes` do template, modelo 2): só configuração, em toda a conta. */
export const AWS_READER_DISCOVERY_ACTIONS = [
  'access-analyzer:ListAnalyzers',
  'cloudtrail:GetEventSelectors',
  'config:DescribeConfigurationRecorders',
  'config:DescribeConfigurationRecorderStatus',
  'config:DescribeDeliveryChannels',
  'ec2:DescribeFlowLogs',
  'ec2:DescribeVpcs',
  'elasticloadbalancing:DescribeLoadBalancers',
  'elasticloadbalancing:DescribeLoadBalancerAttributes',
  'inspector2:BatchGetAccountStatus',
  'logs:DescribeLogGroups',
  'logs:ListTagsForResource',
  'rds:DescribeDBInstances',
  'rds:DescribeDBClusters',
  's3:GetBucketLocation',
  's3:GetEncryptionConfiguration',
  'securityhub:DescribeHub',
  'wafv2:GetLoggingConfiguration',
  'wafv2:ListLoggingConfigurations',
  'wafv2:ListWebACLs',
] as const;
/** A autoinspeção do papel (`AutoInspecao`): as próprias etiquetas e a simulação das próprias permissões. */
export const AWS_READER_SELF_ACTIONS = ['iam:GetRole', 'iam:SimulatePrincipalPolicy'] as const;
/** A do usuário IAM (VM própria do cliente): o mesmo, com as etiquetas lidas do usuário. */
export const AWS_READER_USER_SELF_ACTIONS = ['iam:GetUser', 'iam:SimulatePrincipalPolicy'] as const;
/** Os logs que a AWS grava no S3 (`ReadAwsServiceLogs`): os objetos, a listagem e o Decrypt, só pelo S3. */
export const AWS_READER_SERVICE_LOG_ACTIONS = ['s3:GetObject', 's3:ListBucket', 'kms:Decrypt'] as const;
/** Os achados de segurança (`LerAchadosDeSeguranca`, `ReadSecurityFindings`). */
export const AWS_READER_FINDINGS_ACTIONS = [
  'access-analyzer:GetFinding',
  'access-analyzer:ListFindings',
  'guardduty:GetFindings',
  'guardduty:ListFindings',
  'inspector2:ListCoverage',
  'inspector2:ListFindings',
  'securityhub:GetEnabledStandards',
  'securityhub:GetFindings',
] as const;
/** Os eventos dos grupos de log etiquetados (`LerGruposDeLogEtiquetados`, `ReadTaggedLogGroups`). */
export const AWS_READER_LOG_GROUP_ACTIONS = [
  'logs:DescribeLogStreams',
  'logs:FilterLogEvents',
  'logs:GetLogEvents',
] as const;

/**
 * As ações que cada capacidade dá ao papel de leitura (modelo 2), como o template as escreve: o que a descoberta e as
 * sondas de permissão esperam poder chamar com cada uma ligada. A descoberta inclui a conferência das fontes e a
 * postura do modelo 1.
 */
export const AWS_READER_CAPABILITY_ACTIONS = {
  discovery: [
    ...AWS_READER_SELF_ACTIONS,
    ...AWS_READER_SOURCE_ACTIONS,
    ...AWS_READER_POSTURE_ACTIONS,
    ...AWS_READER_DISCOVERY_ACTIONS,
  ],
  'service-logs': AWS_READER_SERVICE_LOG_ACTIONS,
  findings: AWS_READER_FINDINGS_ACTIONS,
  'log-groups': AWS_READER_LOG_GROUP_ACTIONS,
} as const satisfies Record<AwsReaderCapability, readonly string[]>;

/** As negações do papel (`NuncaAlterarLogs` e `NuncaAmpliarOProprioAcesso`), as mesmas no usuário. */
export const AWS_GUARDRAIL_LOG_ACTIONS = [
  'access-analyzer:Delete*',
  'access-analyzer:Update*',
  'cloudtrail:Create*',
  'cloudtrail:Delete*',
  'cloudtrail:Put*',
  'cloudtrail:Stop*',
  'cloudtrail:Update*',
  'guardduty:Archive*',
  'guardduty:Create*',
  'guardduty:Delete*',
  'guardduty:Disable*',
  'guardduty:Disassociate*',
  'guardduty:Update*',
  'inspector2:Delete*',
  'inspector2:Disable*',
  'inspector2:Update*',
  'kms:Delete*',
  'kms:Disable*',
  'kms:Put*',
  'kms:ScheduleKeyDeletion',
  'kms:Update*',
  'logs:Associate*',
  'logs:Create*',
  'logs:Delete*',
  'logs:Disassociate*',
  'logs:Put*',
  'logs:Tag*',
  'logs:Unmask',
  'logs:Untag*',
  'logs:Update*',
  's3:Abort*',
  's3:Bypass*',
  's3:Create*',
  's3:Delete*',
  's3:Put*',
  's3:Replicate*',
  's3:Restore*',
  's3:Update*',
  'securityhub:BatchImport*',
  'securityhub:BatchUpdate*',
  'securityhub:Delete*',
  'securityhub:Disable*',
  'securityhub:Update*',
  'wafv2:Delete*',
  'wafv2:Put*',
  'wafv2:Update*',
] as const;
/** As negações que o modelo 2 soma (`NuncaAlterarOutrasFontes`): as outras fontes e os serviços de achados. */
export const AWS_GUARDRAIL_SOURCE_ACTIONS = [
  'access-analyzer:Apply*',
  'access-analyzer:Cancel*',
  'access-analyzer:Create*',
  'access-analyzer:Start*',
  'access-analyzer:Tag*',
  'access-analyzer:Untag*',
  'config:Delete*',
  'config:Put*',
  'config:Start*',
  'config:Stop*',
  'ec2:CreateFlowLogs',
  'ec2:DeleteFlowLogs',
  'elasticloadbalancing:Modify*',
  'inspector2:Associate*',
  'inspector2:BatchUpdate*',
  'inspector2:Cancel*',
  'inspector2:Create*',
  'inspector2:Disassociate*',
  'inspector2:Enable*',
  'inspector2:Reset*',
  'inspector2:Send*',
  'inspector2:Start*',
  'inspector2:Stop*',
  'inspector2:Tag*',
  'inspector2:Untag*',
  'securityhub:Accept*',
  'securityhub:BatchDelete*',
  'securityhub:BatchDisable*',
  'securityhub:BatchEnable*',
  'securityhub:Create*',
  'securityhub:Decline*',
  'securityhub:Disassociate*',
  'securityhub:Enable*',
  'securityhub:Invite*',
  'securityhub:Start*',
  'securityhub:Tag*',
  'securityhub:Untag*',
  'wafv2:Associate*',
  'wafv2:Create*',
  'wafv2:Disassociate*',
  'wafv2:Tag*',
  'wafv2:Untag*',
] as const;
/** As etiquetas do próprio papel (ou usuário) e qualquer outra do IAM (`NuncaTrocarAsPropriasEtiquetas`). */
export const AWS_GUARDRAIL_TAG_ACTIONS = ['iam:Tag*', 'iam:Untag*'] as const;
export const AWS_GUARDRAIL_ACCESS_ACTIONS = [
  'iam:Add*',
  'iam:Attach*',
  'iam:Create*',
  'iam:Delete*',
  'iam:Detach*',
  'iam:PassRole',
  'iam:Put*',
  'iam:Remove*',
  'iam:Set*',
  'iam:Update*',
  'iam:Upload*',
  'sts:AssumeRole',
  'sts:AssumeRoleWithSAML',
  'sts:AssumeRoleWithWebIdentity',
  'sts:GetFederationToken',
] as const;

/** Uma declaração de política do IAM (só o que estas políticas usam). */
export interface IamStatement {
  Sid: string;
  Effect: 'Allow' | 'Deny';
  Action: string | readonly string[];
  Resource: string | readonly string[];
  Condition?: Record<string, Record<string, string | readonly string[]>>;
}

export interface IamPolicy {
  Version: '2012-10-17';
  Statement: IamStatement[];
}

export interface AwsReaderUserValues {
  accountId: string;
  /** Os buckets de log cadastrados na conta. */
  buckets: readonly string[];
  /** Os IPs de saída da VM (`NODE_EGRESS_IPS`), com /32; vazio quando o nó não informa. */
  egressIps: readonly string[];
  /** As autorizações dadas; sem o campo, as três (o padrão do template). A descoberta vale sempre. */
  capabilities?: readonly AwsReaderCapability[];
}

/** Só o S3 em nome de quem pede: a condição de todo `kms:Decrypt` da leitura. */
const DECRYPT_ONLY_VIA_S3 = { StringLike: { 'kms:ViaService': 's3.*.amazonaws.com' } } as const;

/** A autorização está dada? Sem a lista, as três estão (o padrão do template). */
function grants(values: Pick<AwsReaderUserValues, 'capabilities'>, capability: AwsReaderCapability): boolean {
  return values.capabilities === undefined || values.capabilities.includes(capability);
}

/**
 * As declarações que os logs da AWS no S3 somam (`ReadAwsServiceLogs`), as mesmas do papel: os objetos só em
 * `AWSLogs/<conta>/` (e na pasta da trilha de organização), a listagem dessas pastas, o primeiro nível de um bucket
 * (só nomes, sempre com o separador `/`) e o Decrypt, só pelo S3.
 */
function serviceLogStatements(accountId: string): IamStatement[] {
  const own = `AWSLogs/${accountId}/*`;
  const organization = `AWSLogs/o-*/${accountId}/*`;
  return [
    {
      Sid: 'LerLogsDaAwsDestaConta',
      Effect: 'Allow',
      Action: 's3:GetObject',
      Resource: [`arn:aws:s3:::*/${own}`, `arn:aws:s3:::*/${organization}`],
    },
    {
      Sid: 'ListarLogsDaAwsDestaConta',
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: 'arn:aws:s3:::*',
      Condition: { StringLike: { 's3:prefix': [own, organization] } },
    },
    {
      Sid: 'VerPrimeiroNivelDosBuckets',
      Effect: 'Allow',
      Action: 's3:ListBucket',
      Resource: 'arn:aws:s3:::*',
      Condition: { StringEquals: { 's3:delimiter': '/', 's3:prefix': ['', 'AWSLogs', 'AWSLogs/'] } },
    },
    {
      Sid: 'DecifrarLogsDaAwsSoPeloS3',
      Effect: 'Allow',
      Action: 'kms:Decrypt',
      Resource: '*',
      Condition: DECRYPT_ONLY_VIA_S3,
    },
  ];
}

/**
 * A política de leitura do usuário (`VeraxControlReader`), na ordem do template: a descoberta e a postura (sempre, com
 * a autoinspeção no próprio usuário), as declarações de cada autorização dada e os buckets cadastrados (listar e ler;
 * o KMS deles, só pelo S3 e só sem a autorização dos logs da AWS, que já decifra o que o usuário lê). Também é o limite
 * de permissões do usuário: uma política que alguém anexe depois não passa do que está aqui.
 */
export function awsReaderUserPolicy(values: AwsReaderUserValues): IamPolicy {
  const arns = awsLogBucketArns(values.buckets);
  const statements: IamStatement[] = [
    {
      Sid: 'AutoInspecao',
      Effect: 'Allow',
      Action: [...AWS_READER_USER_SELF_ACTIONS],
      Resource: awsReaderUserArn(values.accountId),
    },
    { Sid: 'ValidarFontes', Effect: 'Allow', Resource: '*', Action: [...AWS_READER_SOURCE_ACTIONS] },
    { Sid: 'PosturaEAtivos', Effect: 'Allow', Resource: '*', Action: [...AWS_READER_POSTURE_ACTIONS] },
    { Sid: 'DescobrirFontes', Effect: 'Allow', Resource: '*', Action: [...AWS_READER_DISCOVERY_ACTIONS] },
  ];
  if (grants(values, 'service-logs')) statements.push(...serviceLogStatements(values.accountId));
  if (grants(values, 'findings')) {
    statements.push({
      Sid: 'LerAchadosDeSeguranca',
      Effect: 'Allow',
      Resource: '*',
      Action: [...AWS_READER_FINDINGS_ACTIONS],
    });
  }
  if (grants(values, 'log-groups')) {
    const groups = `arn:aws:logs:*:${values.accountId}:log-group:*`;
    statements.push({
      Sid: 'LerGruposDeLogEtiquetados',
      Effect: 'Allow',
      Action: [...AWS_READER_LOG_GROUP_ACTIONS],
      Resource: [groups, `${groups}:*`],
      Condition: { StringEquals: { [`aws:ResourceTag/${AWS_LOG_GROUP_TAG.key}`]: AWS_LOG_GROUP_TAG.value } },
    });
  }
  if (arns.length > 0) {
    statements.push(
      {
        Sid: 'ListarBucketsDeLog',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation'],
        Resource: arns,
      },
      {
        Sid: 'LerObjetosDeLog',
        Effect: 'Allow',
        Action: 's3:GetObject',
        Resource: arns.map((arn) => `${arn}/*`),
      },
    );
    if (!grants(values, 'service-logs')) {
      statements.push({
        Sid: 'DecifrarSoPeloS3',
        Effect: 'Allow',
        Action: 'kms:Decrypt',
        Resource: `arn:aws:kms:*:${values.accountId}:key/*`,
        Condition: DECRYPT_ONLY_VIA_S3,
      });
    }
  }
  return { Version: '2012-10-17', Statement: statements };
}

/**
 * As negações (`VeraxControlGuardrails`), as do papel: nada de fora do IP da VM (quando o nó o informa; a única
 * exceção é a chamada que um serviço da AWS faz em nome do usuário, como o S3 pedindo ao KMS o objeto que o nó leu),
 * nenhuma alteração de logs, das outras fontes ou das próprias etiquetas, e nenhuma ampliação do próprio acesso. Valem
 * mesmo que alguém anexe outra política ao usuário.
 */
export function awsGuardrailsPolicy(values: Pick<AwsReaderUserValues, 'egressIps'>): IamPolicy {
  const ips =
    values.egressIps.length > 0 &&
    values.egressIps.length <= MAX_NODE_EGRESS_IPS &&
    values.egressIps.every(isNodeEgressIp)
      ? [...values.egressIps]
      : [];
  const statements: IamStatement[] = [];
  if (ips.length > 0) {
    statements.push({
      Sid: 'SoDoNoDaVerax',
      Effect: 'Deny',
      Action: '*',
      Resource: '*',
      Condition: { NotIpAddress: { 'aws:SourceIp': ips }, Bool: { 'aws:ViaAWSService': 'false' } },
    });
  }
  statements.push(
    { Sid: 'NuncaAlterarLogs', Effect: 'Deny', Resource: '*', Action: [...AWS_GUARDRAIL_LOG_ACTIONS] },
    {
      Sid: 'NuncaAlterarOutrasFontes',
      Effect: 'Deny',
      Resource: '*',
      Action: [...AWS_GUARDRAIL_SOURCE_ACTIONS],
    },
    {
      Sid: 'NuncaTrocarAsPropriasEtiquetas',
      Effect: 'Deny',
      Resource: '*',
      Action: [...AWS_GUARDRAIL_TAG_ACTIONS],
    },
    {
      Sid: 'NuncaAmpliarOProprioAcesso',
      Effect: 'Deny',
      Resource: '*',
      Action: [...AWS_GUARDRAIL_ACCESS_ACTIONS],
    },
  );
  return { Version: '2012-10-17', Statement: statements };
}

/**
 * As etiquetas do usuário, as mesmas do papel: a versão do modelo e o que foi autorizado. Só os nomes de
 * `AWS_READER_CAPABILITIES` entram no valor (qualquer outro texto da lista fica de fora), que vai entre aspas simples
 * por causa do espaço.
 */
function awsReaderUserTags(capabilities: readonly AwsReaderCapability[] | undefined): string {
  const granted = awsReaderCapabilitiesTagValue(capabilities ?? AWS_READER_CAPABILITIES);
  return [
    `Key=${AWS_READER_ROLE_TAGS.template},Value=${AWS_READER_TEMPLATE_VERSION}`,
    `'Key=${AWS_READER_ROLE_TAGS.capabilities},Value=${granted}'`,
  ].join(' ');
}

/**
 * Os comandos da CLI para criar o usuário, as duas políticas (dos arquivos que o painel mostra), o limite de
 * permissões, as etiquetas (o modelo e as autorizações dadas; sem a lista, as três) e a chave de acesso. O ID da conta
 * chega já validado (12 dígitos).
 */
export function awsReaderUserCommands(
  accountId: string,
  capabilities?: readonly AwsReaderCapability[],
): string {
  const policy = (name: string) => `arn:aws:iam::${accountId}:policy${AWS_READER_USER_PATH}${name}`;
  const principalArg = `--user-name ${AWS_READER_IAM_NAME}`;
  return [
    `aws iam create-policy --path ${AWS_READER_USER_PATH} --policy-name ${AWS_READER_POLICY_NAME} --policy-document file://${AWS_READER_POLICY_FILE}`,
    `aws iam create-policy --path ${AWS_READER_USER_PATH} --policy-name ${AWS_GUARDRAILS_POLICY_NAME} --policy-document file://${AWS_GUARDRAILS_POLICY_FILE}`,
    `aws iam create-user --path ${AWS_READER_USER_PATH} ${principalArg} --permissions-boundary ${policy(AWS_READER_POLICY_NAME)} --tags ${awsReaderUserTags(capabilities)}`,
    `aws iam attach-user-policy ${principalArg} --policy-arn ${policy(AWS_READER_POLICY_NAME)}`,
    `aws iam attach-user-policy ${principalArg} --policy-arn ${policy(AWS_GUARDRAILS_POLICY_NAME)}`,
    `aws iam create-access-key ${principalArg}`,
  ].join('\n');
}

/** Os nomes do que o cliente cria no projeto dele, na GCP. */
export const GCP_READER_TOPIC = 'verax-control-security';
export const GCP_READER_SUBSCRIPTION = 'verax-control-security';
export const GCP_READER_SERVICE_ACCOUNT = 'verax-control-reader';
/** O único papel da conta de serviço, e só na assinatura: ler e confirmar as mensagens. */
export const GCP_READER_ROLE = 'roles/pubsub.subscriber';
/** O arquivo da chave que o último comando grava (o cliente o cola no painel e depois o apaga). */
export const GCP_READER_KEY_FILE = 'verax-control-reader.json';

/** A assinatura que o nó lê, no projeto do cliente: o que vai para o cadastro da conta. */
export function gcpReaderSubscription(projectId: string): string {
  return `projects/${projectId}/subscriptions/${GCP_READER_SUBSCRIPTION}`;
}

export function gcpReaderServiceAccountEmail(projectId: string): string {
  return `${GCP_READER_SERVICE_ACCOUNT}@${projectId}.iam.gserviceaccount.com`;
}

/**
 * Os comandos que o cliente roda no Cloud Shell do projeto (o ID chega validado): o tópico e a assinatura (7 dias de
 * retenção, o que o Pub/Sub guarda se o nó ficar fora do ar), o sink com o filtro de segurança do gerenciado e a
 * publicação dele só nesse tópico, a conta de serviço com `roles/pubsub.subscriber` só na assinatura e a chave dela.
 */
export function gcpReaderCommands(projectId: string): string {
  const project = `--project=${projectId}`;
  const email = gcpReaderServiceAccountEmail(projectId);
  return [
    `gcloud pubsub topics create ${GCP_READER_TOPIC} ${project}`,
    `gcloud pubsub subscriptions create ${GCP_READER_SUBSCRIPTION} --topic=${GCP_READER_TOPIC} ${project} \\`,
    '  --ack-deadline=60 --message-retention-duration=7d --expiration-period=never',
    `gcloud logging sinks create ${GCP_READER_TOPIC} pubsub.googleapis.com/projects/${projectId}/topics/${GCP_READER_TOPIC} \\`,
    `  ${project} \\`,
    "  --description='Eventos de segurança para o Verax Control (só cópia; os logs originais não mudam).' \\",
    `  --log-filter='${GCP_SINK_LOG_FILTER}'`,
    `gcloud pubsub topics add-iam-policy-binding ${GCP_READER_TOPIC} ${project} --role=roles/pubsub.publisher \\`,
    `  --member="$(gcloud logging sinks describe ${GCP_READER_TOPIC} ${project} --format='value(writerIdentity)')"`,
    `gcloud iam service-accounts create ${GCP_READER_SERVICE_ACCOUNT} ${project} --display-name='Verax Control (somente leitura)'`,
    `gcloud pubsub subscriptions add-iam-policy-binding ${GCP_READER_SUBSCRIPTION} ${project} \\`,
    `  --member=serviceAccount:${email} --role=${GCP_READER_ROLE}`,
    `gcloud iam service-accounts keys create ${GCP_READER_KEY_FILE} --iam-account=${email}`,
  ].join('\n');
}

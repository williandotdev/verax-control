import type { PostureSection, PostureSeverity } from './posture.js';

/**
 * O catálogo nativo de postura da AWS (fase 2, PR-15'): 18 checagens conferidas pelo papel de leitura sem chave, na
 * mesma coleta do inventário, com texto em português escrito por nós. Os IDs e as severidades são os do Prowler Hub
 * (conferidos em 05/11/2026), para a nota seguir a mesma escala; a exceção é a das portas de banco de dados, que o
 * Prowler divide em uma checagem por banco e aqui é uma só, com as portas das regras de risco de Ativos.
 *
 * A lógica de cada checagem fica em `apps/api/src/posture/native-posture.ts`; aqui ficam o que a tela mostra e o passo
 * de correção. O painel de demonstração usa o mesmo catálogo.
 */

/** O alvo de uma reprovação, para o passo de correção trazer o comando já com o recurso. */
export interface PostureTarget {
  accountId: string;
  /** A região do recurso, ou `global`. */
  region: string;
  resource: string | null;
}

export interface NativePostureCheck {
  id: string;
  /** A leitura de que a checagem depende: recusada, a checagem fica "não lida" naquele escopo. */
  section: PostureSection;
  severity: PostureSeverity;
  /** O que a checagem confere (a linha do catálogo na tela). */
  title: string;
  /** O título da reprovação (a lista do que corrigir). */
  failTitle: string;
  /** O tipo do recurso conferido, no formato do Security Hub. */
  resourceType: string;
  /** Por que importa. */
  risk: string;
  /** Como corrigir; uma linha que começa com `aws ` é um comando da CLI. */
  remediation: (target: PostureTarget) => string;
  /** Documentação oficial, só HTTPS. */
  references: readonly string[];
}

/** A região das checagens da conta inteira (o IAM, a política de senha, o bloqueio da conta, a trilha). */
export const GLOBAL_REGION = 'global';

/** As portas de banco de dados: as da checagem de postura e as do risco "porta de banco aberta" de Ativos. */
export const DATABASE_PORTS: readonly number[] = [
  1433, 1521, 3306, 5432, 5984, 6379, 9200, 9300, 11211, 27017,
];

const DOCS = 'https://docs.aws.amazon.com';
const LOGIN_POLICY_DOC = `${DOCS}/IAM/latest/UserGuide/id_credentials_passwords_account-policy.html`;
const ACCESS_KEYS = `${DOCS}/IAM/latest/UserGuide/id_credentials_access-keys.html`;
const SG_RULES = `${DOCS}/vpc/latest/userguide/security-group-rules.html`;
const SESSION_MANAGER = `${DOCS}/systems-manager/latest/userguide/session-manager.html`;
const BLOCK_PUBLIC_ACCESS = `${DOCS}/AmazonS3/latest/userguide/access-control-block-public-access.html`;

const fixed = (text: string) => () => text;

const passwordPolicyRemediation = fixed(
  'Ajuste a política em IAM → Configurações da conta → Política de senha. Pela CLI, o comando substitui a política inteira: informe também as outras regras que a conta já usa.\naws iam update-account-password-policy --minimum-password-length 14 --password-reuse-prevention 24',
);

const bucketBlockCommand = (bucket: string | null) =>
  `aws s3api put-public-access-block --bucket ${bucket ?? '<bucket>'} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`;

export const NATIVE_POSTURE_CHECKS: readonly NativePostureCheck[] = [
  {
    id: 'iam_root_mfa_enabled',
    section: 'root',
    severity: 'critical',
    title: 'MFA no usuário root',
    failTitle: 'Usuário root sem MFA',
    resourceType: 'AwsAccount',
    risk: 'Quem descobrir a senha do root controla a conta inteira, sem nenhum segundo fator.',
    remediation: fixed(
      'Entre no console como root, abra "Credenciais de segurança" e ative um dispositivo de MFA (de preferência uma chave física).',
    ),
    references: [`${DOCS}/IAM/latest/UserGuide/enable-virt-mfa-for-root.html`],
  },
  {
    id: 'iam_no_root_access_key',
    section: 'root',
    severity: 'critical',
    title: 'Usuário root sem chave de acesso',
    failTitle: 'Usuário root com chave de acesso',
    resourceType: 'AwsAccount',
    risk: 'A chave do root dá acesso total à conta pela API, sem MFA, e nenhuma política consegue limitá-la.',
    remediation: fixed(
      'Entre no console como root, abra "Credenciais de segurança", desative e apague as chaves de acesso. Para automação, use um papel ou um usuário IAM com a permissão mínima.',
    ),
    references: [`${DOCS}/IAM/latest/UserGuide/id_root-user_manage_delete-key.html`],
  },
  {
    id: 'iam_user_mfa_enabled_console_access',
    section: 'iam',
    severity: 'high',
    title: 'MFA nos usuários IAM com acesso ao console',
    failTitle: 'Usuário IAM com console e sem MFA',
    resourceType: 'AwsIamUser',
    risk: 'Uma senha vazada (phishing, reaproveitamento) basta para entrar no console com as permissões do usuário.',
    remediation: fixed(
      'Ative um dispositivo de MFA para o usuário em IAM → Usuários → Credenciais de segurança, ou tire o acesso ao console de quem não usa.',
    ),
    references: [`${DOCS}/IAM/latest/UserGuide/id_credentials_mfa_enable_virtual.html`],
  },
  {
    id: 'iam_rotate_access_key_90_days',
    section: 'iam',
    severity: 'medium',
    title: 'Chaves de acesso trocadas em até 90 dias',
    failTitle: 'Chave de acesso com mais de 90 dias',
    resourceType: 'AwsIamAccessKey',
    risk: 'Chave antiga tem mais chance de ter vazado em algum lugar (repositório, máquina antiga, log).',
    remediation: fixed(
      'Crie uma chave nova para o usuário, troque onde a antiga é usada, desative a antiga e apague-a depois de alguns dias sem uso. Para o que roda na AWS, prefira um papel, sem chave.',
    ),
    references: [ACCESS_KEYS],
  },
  {
    id: 'iam_user_accesskey_unused',
    section: 'iam',
    severity: 'medium',
    title: 'Chaves de acesso ativas usadas nos últimos 90 dias',
    failTitle: 'Chave de acesso ativa sem uso há mais de 90 dias',
    resourceType: 'AwsIamAccessKey',
    risk: 'Uma chave esquecida continua valendo: se vazar, dá acesso sem que ninguém sinta a falta dela.',
    remediation: fixed(
      'Confirme com o dono do usuário que a chave não é mais usada, desative-a em IAM → Usuários → Credenciais de segurança e apague-a depois de alguns dias.',
    ),
    references: [ACCESS_KEYS],
  },
  {
    id: 'iam_password_policy_minimum_length_14',
    section: 'password_policy',
    severity: 'medium',
    title: 'Política de senha com no mínimo 14 caracteres',
    failTitle: 'Política de senha da conta aceita menos de 14 caracteres',
    resourceType: 'AwsAccount',
    risk: 'Senhas curtas são quebradas mais rápido. Sem política, a AWS aceita senhas de 8 caracteres.',
    remediation: passwordPolicyRemediation,
    references: [LOGIN_POLICY_DOC],
  },
  {
    id: 'iam_password_policy_reuse_24',
    section: 'password_policy',
    severity: 'medium',
    title: 'Política de senha impede reusar as 24 últimas',
    failTitle: 'Política de senha da conta permite reusar senhas recentes',
    resourceType: 'AwsAccount',
    risk: 'Quem volta para uma senha antiga reabre a porta para uma senha que pode já ter vazado.',
    remediation: passwordPolicyRemediation,
    references: [LOGIN_POLICY_DOC],
  },
  {
    id: 'ec2_securitygroup_allow_ingress_from_internet_to_all_ports',
    section: 'sg',
    severity: 'critical',
    title: 'Nenhum security group aberto para a internet em todas as portas',
    failTitle: 'Security group libera todas as portas para a internet',
    resourceType: 'AwsEc2SecurityGroup',
    risk: 'Todo serviço das instâncias fica exposto para a internet inteira, inclusive os que nunca deveriam sair da rede interna.',
    remediation: fixed(
      'Remova a regra de entrada de todo o tráfego para 0.0.0.0/0 ou ::/0 e libere só as portas necessárias, para as origens necessárias.',
    ),
    references: [SG_RULES],
  },
  {
    id: 'ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_22',
    section: 'sg',
    severity: 'high',
    title: 'SSH (porta 22) fechado para a internet',
    failTitle: 'Security group libera SSH (porta 22) para a internet',
    resourceType: 'AwsEc2SecurityGroup',
    risk: 'A porta 22 aberta para a internet recebe tentativas de força bruta o tempo todo.',
    remediation: fixed(
      'Remova a regra de entrada para 0.0.0.0/0 ou ::/0 na porta 22 e acesse as instâncias pelo Session Manager do SSM (ou por uma VPN).',
    ),
    references: [SG_RULES, SESSION_MANAGER],
  },
  {
    id: 'ec2_securitygroup_allow_ingress_from_internet_to_tcp_port_3389',
    section: 'sg',
    severity: 'high',
    title: 'RDP (porta 3389) fechado para a internet',
    failTitle: 'Security group libera RDP (porta 3389) para a internet',
    resourceType: 'AwsEc2SecurityGroup',
    risk: 'O RDP exposto é uma das portas de entrada mais usadas por ransomware.',
    remediation: fixed(
      'Remova a regra de entrada para 0.0.0.0/0 ou ::/0 na porta 3389 e acesse as instâncias pelo Fleet Manager do SSM (ou por uma VPN).',
    ),
    references: [SG_RULES, SESSION_MANAGER],
  },
  {
    id: 'ec2_securitygroup_allow_ingress_from_internet_to_database_ports',
    section: 'sg',
    severity: 'high',
    title: 'Portas de banco de dados fechadas para a internet',
    failTitle: 'Security group libera porta de banco de dados para a internet',
    resourceType: 'AwsEc2SecurityGroup',
    risk: 'Banco exposto para a internet recebe varredura e força bruta: um usuário fraco ou uma falha sem correção bastam para vazar os dados.',
    remediation: fixed(
      `Remova as regras de entrada para 0.0.0.0/0 ou ::/0 nas portas de banco (${DATABASE_PORTS.join(', ')}) e libere só a origem da aplicação (outro security group ou a faixa da VPC).`,
    ),
    references: [SG_RULES],
  },
  {
    id: 'ec2_instance_imdsv2_enabled',
    section: 'ec2',
    severity: 'high',
    title: 'IMDSv2 obrigatório nas instâncias EC2',
    failTitle: 'Instância EC2 aceita IMDSv1',
    resourceType: 'AwsEc2Instance',
    risk: 'Uma falha de SSRF na aplicação pode vazar as credenciais do papel da instância pelo IMDSv1.',
    remediation: ({ region, resource }) =>
      `Exija o IMDSv2 (teste antes se a aplicação usa um SDK muito antigo):\naws ec2 modify-instance-metadata-options --region ${region} --instance-id ${resource ?? '<instância>'} --http-tokens required`,
    references: [`${DOCS}/AWSEC2/latest/UserGuide/configuring-IMDS-existing-instances.html`],
  },
  {
    id: 'ec2_ebs_default_encryption',
    section: 'ebs',
    severity: 'high',
    title: 'Criptografia padrão do EBS ligada em cada região',
    failTitle: 'Criptografia padrão do EBS desligada na região',
    resourceType: 'AwsAccount',
    risk: 'Volumes e snapshots novos podem nascer sem criptografia, legíveis por quem tiver acesso a uma cópia.',
    remediation: ({ region }) =>
      `Ligue a criptografia padrão na região (vale para os volumes novos; os que já existem precisam de uma cópia cifrada):\naws ec2 enable-ebs-encryption-by-default --region ${region}`,
    references: [`${DOCS}/ebs/latest/userguide/encryption-by-default.html`],
  },
  {
    id: 's3_bucket_public_access',
    section: 's3',
    severity: 'critical',
    title: 'Nenhum bucket S3 público',
    failTitle: 'Bucket S3 público',
    resourceType: 'AwsS3Bucket',
    risk: 'Qualquer pessoa na internet pode ler (e às vezes listar) os arquivos do bucket.',
    remediation: ({ resource }) =>
      `Confirme que o bucket não precisa ser público (um site estático pode ficar atrás do CloudFront) e ligue o bloqueio de acesso público dele:\n${bucketBlockCommand(resource)}`,
    references: [BLOCK_PUBLIC_ACCESS],
  },
  {
    id: 's3_bucket_level_public_access_block',
    section: 's3',
    severity: 'high',
    title: 'Bloqueio de acesso público em cada bucket S3',
    failTitle: 'Bucket S3 sem bloqueio de acesso público',
    resourceType: 'AwsS3Bucket',
    risk: 'Sem o bloqueio (no bucket ou na conta), uma política ou ACL mal escrita torna o bucket público na hora.',
    remediation: ({ resource }) =>
      `Ligue o bloqueio de acesso público do bucket (ou o da conta, que vale para todos):\n${bucketBlockCommand(resource)}`,
    references: [BLOCK_PUBLIC_ACCESS],
  },
  {
    id: 's3_account_level_public_access_blocks',
    section: 's3_account',
    severity: 'high',
    title: 'Bloqueio de acesso público do S3 ligado na conta',
    failTitle: 'Bloqueio de acesso público do S3 desligado na conta',
    resourceType: 'AwsAccount',
    risk: 'Sem o bloqueio da conta, um bucket novo pode ficar público por engano.',
    remediation: ({ accountId }) =>
      `Confirme que nenhum bucket precisa ser público e ligue o bloqueio no nível da conta (S3 → Bloquear acesso público para esta conta):\naws s3control put-public-access-block --account-id ${accountId} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
    references: [`${DOCS}/AmazonS3/latest/userguide/configuring-block-public-access-account.html`],
  },
  {
    id: 'cloudtrail_multi_region_enabled',
    section: 'cloudtrail',
    severity: 'high',
    title: 'Trilha do CloudTrail multirregião gravando',
    failTitle: 'Nenhuma trilha do CloudTrail multirregião gravando',
    resourceType: 'AwsCloudTrailTrail',
    risk: 'Sem a trilha, o que acontece nas regiões que ninguém olha (usuários criados, máquinas de mineração) não fica registrado, e o Verax Control não recebe esses eventos.',
    remediation: fixed(
      'Crie uma trilha multirregião, ou ligue a gravação da que já existe, gravando num bucket com o bloqueio de acesso público:\naws cloudtrail create-trail --name trilha-principal --s3-bucket-name <bucket> --is-multi-region-trail\naws cloudtrail start-logging --name trilha-principal',
    ),
    references: [
      `${DOCS}/awscloudtrail/latest/userguide/receive-cloudtrail-log-files-from-multiple-regions.html`,
    ],
  },
  {
    id: 'guardduty_is_enabled',
    section: 'guardduty',
    severity: 'high',
    title: 'GuardDuty ligado em cada região monitorada',
    failTitle: 'GuardDuty desligado na região',
    resourceType: 'AwsGuardDutyDetector',
    risk: 'Um invasor costuma usar as regiões que ninguém olha para subir máquinas de mineração; sem o GuardDuty, ninguém é avisado.',
    remediation: ({ region }) =>
      `Ative o GuardDuty na região (ou retome o detector suspenso no console):\naws guardduty create-detector --enable --region ${region}`,
    references: [`${DOCS}/guardduty/latest/ug/guardduty_settingup.html`],
  },
];

/** A checagem do catálogo pelo ID; undefined fora do catálogo. */
export function nativePostureCheck(id: string): NativePostureCheck | undefined {
  return NATIVE_POSTURE_CHECKS.find((check) => check.id === id);
}

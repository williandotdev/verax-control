import type {
  AlertExceptionField,
  CloudAccountConnection,
  ProtectedResourceType,
  TenantStatus,
  UserStatus,
} from '@verax/shared';

export const TENANT_STATUS_LABELS: Readonly<Record<TenantStatus, string>> = {
  active: 'Ativo',
  inactive: 'Inativo',
};

export const USER_STATUS_LABELS: Readonly<Record<UserStatus, string>> = {
  invited: 'Convidado',
  active: 'Ativo',
  disabled: 'Desativado',
};

export const CONNECTION_LABELS: Readonly<Record<CloudAccountConnection, string>> = {
  ok: 'Conectada',
  error: 'Falha ao assumir o papel',
  pending: 'Aguardando o conector',
};

export const PROTECTED_TYPE_LABELS: Readonly<Record<ProtectedResourceType, string>> = {
  aws_account: 'Conta AWS',
  iam_user: 'Usuário IAM',
  iam_role: 'Papel IAM',
  access_key: 'Chave de acesso',
  ec2_instance: 'Instância EC2',
  s3_bucket: 'Bucket S3',
  security_group: 'Security group',
  ip_address: 'IP ou faixa',
};

export const EXCEPTION_FIELD_LABELS: Readonly<Record<AlertExceptionField, string>> = {
  user: 'Usuário',
  ip: 'IP ou faixa',
  resource: 'Recurso',
};

/** Repositório público do conector: o cliente baixa o template e lê o passo a passo. */
export const CONNECTOR_TEMPLATE_URL =
  'https://github.com/williandotdev/verax-control/blob/main/infra/cloudformation/verax-control-connector.yaml';
export const CONNECTOR_GUIDE_URL =
  'https://github.com/williandotdev/verax-control/blob/main/infra/cloudformation/README.md';

import type {
  AlertExceptionField,
  CloudAccountConnection,
  CloudProvider,
  CredentialStatus,
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

export const PROVIDER_LABELS: Readonly<Record<CloudProvider, string>> = {
  aws: 'AWS',
  gcp: 'Google Cloud',
  cloudflare: 'Cloudflare',
};

/** Como cada provedor chama a conta, com a concordância do "cadastrado". */
export const ACCOUNT_NOUNS: Readonly<Record<CloudProvider, { noun: string; registered: string }>> = {
  aws: { noun: 'Conta AWS', registered: 'cadastrada' },
  gcp: { noun: 'Projeto da GCP', registered: 'cadastrado' },
  cloudflare: { noun: 'Conta do Cloudflare', registered: 'cadastrada' },
};

/**
 * Selo da conexão. "Conectada" pede sinal de vida: na AWS e na GCP, que entregam por evento, o evento recebido; no
 * Cloudflare, coletado por API, a leitura bem-sucedida, mesmo sem evento.
 */
export const CONNECTION_LABELS: Readonly<Record<CloudAccountConnection, string>> = {
  waiting: 'Aguardando',
  connected: 'Conectada',
  error: 'Erro',
};

/** O que o selo quer dizer em cada provedor: na AWS, o papel do conector; na GCP e no Cloudflare, a leitura do nó. */
export function connectionHint(provider: CloudProvider, connection: CloudAccountConnection): string {
  if (connection === 'connected') return 'A última leitura deu certo.';
  if (provider === 'aws') {
    return connection === 'error'
      ? 'A última tentativa de assumir o papel de leitura falhou.'
      : 'Aguardando o conector: a conta conecta quando o primeiro evento chegar.';
  }
  if (connection === 'error') return 'A última leitura falhou.';
  return provider === 'gcp'
    ? 'Aguardando a configuração: a conta conecta quando o primeiro evento chegar.'
    : 'Aguardando a configuração: a conta conecta na primeira leitura bem-sucedida.';
}

/**
 * O que o código do erro de coleta quer dizer, quando há uma explicação para quem administra a conta (Cloudflare,
 * fase 2). Os demais códigos aparecem só como tipo do erro. Os que param a coleta (`isCloudflareBlockingError`) pedem
 * outro token.
 */
const CONNECTION_ERROR_HINTS: Readonly<Record<string, string>> = {
  credential_rejected: 'O Cloudflare recusou o token (inválido ou revogado).',
  credential_forbidden:
    'O token não lê a auditoria desta conta: falta a permissão Account Settings: Read nesta conta, ou o filtro de IP do token não libera o IP de saída do nó.',
  credential_expired: 'O token venceu.',
  credential_disabled: 'O token foi desativado no Cloudflare.',
  credential_unreadable: 'O nó não conseguiu abrir o token guardado. Cole o token de novo.',
  rate_limited:
    'O Cloudflare limitou as requisições deste token; a coleta volta depois da espera pedida por ele.',
  timeout: 'O Cloudflare não respondeu a tempo; a coleta tenta de novo em instantes.',
  zone_not_found: 'Uma das zonas cadastradas não existe nesta conta do Cloudflare. Confira a lista de zonas.',
  zones_forbidden:
    'O token não lista as zonas da conta (falta a permissão Zone: Read). A auditoria continua sendo lida.',
};

export function connectionErrorHint(code: string): string | null {
  return Object.hasOwn(CONNECTION_ERROR_HINTS, code) ? (CONNECTION_ERROR_HINTS[code] ?? null) : null;
}

/** Situação do token guardado no cofre, pela validade. */
export const CREDENTIAL_STATUS_LABELS: Readonly<Record<CredentialStatus, string>> = {
  active: 'Válido',
  expiring: 'Vence em breve',
  expired: 'Vencido',
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

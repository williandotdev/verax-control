import {
  type AlertExceptionField,
  type AwsConnectionErrorCode,
  type CloudAccount,
  type CloudAccountConnection,
  type CloudProvider,
  type CredentialStatus,
  isAwsConnectionErrorCode,
  type ProtectedResourceType,
  type TenantStatus,
  type UserStatus,
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

/**
 * O que o selo quer dizer em cada provedor: na AWS, a entrada no papel de leitura sem chave (o "Verificar" pendente ou
 * o resultado dele); na GCP e no Cloudflare, a leitura do nó. A conta AWS que já entrou no papel uma vez (com
 * `ingestFrom`) e voltou a aguardar mudou de buckets (ou foi reativada): a pilha pode precisar do `LogBucketArns` novo.
 */
export function connectionHint(
  account: Pick<CloudAccount, 'provider' | 'connection' | 'checkRequestedAt' | 'ingestFrom'>,
): string {
  const { provider, connection } = account;
  if (connection === 'connected') return 'A última leitura deu certo.';
  if (provider === 'aws') {
    if (connection === 'error') return 'A última tentativa de entrar no papel de leitura falhou.';
    if (account.checkRequestedAt !== null)
      return 'Verificando: o Verax está entrando no papel de leitura da conta.';
    return account.ingestFrom
      ? 'Aguardando uma nova verificação: se os buckets mudaram, atualize a pilha na conta; depois, clique em Verificar.'
      : 'Aguardando o papel de leitura: crie a pilha na conta e clique em Verificar.';
  }
  if (connection === 'error') return 'A última leitura falhou.';
  return provider === 'gcp'
    ? 'Aguardando a configuração: a conta conecta quando o primeiro evento chegar.'
    : 'Aguardando a configuração: a conta conecta na primeira leitura bem-sucedida.';
}

/**
 * O que o código do erro de coleta do Cloudflare quer dizer, quando há uma explicação para quem administra a conta
 * (fase 2, PR-12 e PR-13). Os demais códigos aparecem só como tipo do erro. Os que param a coleta
 * (`isCloudflareBlockingError`) pedem outro token.
 */
const CLOUDFLARE_CONNECTION_ERROR_HINTS: Readonly<Record<string, string>> = {
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
  security_events_forbidden:
    'O token não lê os eventos de segurança das zonas (falta a permissão Analytics: Read). A auditoria continua sendo lida, e o Verax confere de novo a cada hora.',
  security_events_not_entitled:
    'O plano das zonas desta conta não dá acesso aos eventos de segurança pela API do Cloudflare. A auditoria continua sendo lida, e o Verax confere de novo a cada hora.',
};

/** O que fazer diante do erro da coleta de uma conta do Cloudflare; null para um código sem explicação. */
export function cloudflareConnectionErrorHint(code: string): string | null {
  return Object.hasOwn(CLOUDFLARE_CONNECTION_ERROR_HINTS, code)
    ? (CLOUDFLARE_CONNECTION_ERROR_HINTS[code] ?? null)
    : null;
}

/**
 * O que fazer diante de cada erro da conexão da AWS (os códigos que a tarefa `aws-check` do worker grava). Nenhum
 * repete a mensagem da AWS: só o que conferir.
 */
export const AWS_CONNECTION_ERROR_HINTS: Readonly<Record<AwsConnectionErrorCode, string>> = {
  trust_denied:
    'A AWS recusou a entrada no papel. Confira se a pilha verax-control-reader terminou de ser criada nesta conta e se o ID da conta de serviço, o IP de saída e o audience são os desta tela. Um papel feito pelo assistente "Web identity → Google" do console nunca aceita o nó, e uma SCP ou RCP que negue a federação do Google também barra.',
  token_invalid:
    'A AWS recusou o token do nó. Tente de novo em alguns minutos; se continuar, fale com a Verax.',
  idp_unavailable:
    'O Google não respondeu ao emitir ou conferir o token do nó. Tente de novo em alguns minutos.',
  region_disabled:
    'O STS da região está desligado nesta conta. Religue-o no console do IAM (Account settings) ou fale com a Verax.',
  account_mismatch: 'O papel respondeu de outra conta AWS. Confira o ID da conta cadastrada.',
  bucket_missing: 'Um bucket cadastrado não existe nesta conta. Confira os buckets com a Verax.',
  bucket_denied:
    'O papel não lê um dos buckets cadastrados. Confira se o ARN de cada bucket está em LogBucketArns da pilha (atualize a pilha) e, num bucket de outra conta, a política do bucket.',
  kms_denied:
    'O papel não decifra os logs de um bucket. Informe a chave KMS do bucket em LogKmsKeyArns e atualize a pilha.',
  aws_unavailable: 'A AWS não respondeu a tempo. Tente de novo em alguns minutos.',
  check_unavailable: 'Este nó ainda não confere a conexão sozinho. A Verax confere com você.',
  aws_token_stale:
    'O nó não renova o próprio token do Google há mais de 40 minutos, e a coleta pode parar. Fale com a Verax.',
};

/** O que fazer diante do erro da conexão de uma conta AWS; null para um código que não é da AWS. */
export function awsConnectionErrorHint(code: string): string | null {
  return isAwsConnectionErrorCode(code) ? AWS_CONNECTION_ERROR_HINTS[code] : null;
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

/**
 * O passo a passo do papel de leitura sem chave, no repositório público: o que a pilha cria, o que o papel pode fazer,
 * a CLI e como desconectar. O template em si o painel serve (`aws-reader-template.ts`).
 */
export const AWS_READER_GUIDE_URL =
  'https://github.com/williandotdev/verax-control/blob/main/infra/cloudformation/README.md';

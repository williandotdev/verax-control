import { bucketNameProblem, isAwsRegion } from './cloud-accounts.js';

/**
 * Papel de leitura sem chave na conta AWS do cliente (fase 2, PR-V2' e PR-V3'; `docs/ARQUITETURA.md`, "Por que papel
 * sem chave"). O cliente cria a pilha `infra/cloudformation/verax-control-reader.yaml` no console da AWS com três
 * valores do nó (nenhum é segredo): o ID único da conta de serviço do nó, o IP de saída do nó e o audience do token. O
 * nó entra no papel com o token que o Google assina para a conta de serviço dele (`AssumeRoleWithWebIdentity`). Não
 * existe chave nem ExternalId.
 */

/** Caminho e nome fixos do papel no template (`CAPABILITY_NAMED_IAM`): o ARN é previsível. */
export const AWS_READER_ROLE_PATH = '/verax/';
export const AWS_READER_ROLE_NAME = 'verax-control-reader';
/** Nome da pilha que o README e o comando da CLI usam. */
export const AWS_READER_STACK_NAME = 'verax-control-reader';
/** Nome do arquivo do template, o mesmo do repositório. */
export const AWS_READER_TEMPLATE_FILE = 'verax-control-reader.yaml';

/**
 * Audience que o nó pede ao servidor de metadados da GCP: o padrão do parâmetro `Audience` do template e a condição
 * `accounts.google.com:oaud` da confiança do papel. Uma constante do produto (o `AWS_WEB_IDENTITY_AUDIENCE` do
 * `node.conf` só a troca num nó que precise de outra); mudá-la exige atualizar a pilha de todos os clientes do nó.
 */
export const AWS_READER_AUDIENCE = 'https://control.veraxsistemas.com.br/aws-reader';

/** O papel de leitura de uma conta: derivado do ID cadastrado, nunca digitado nem escolhido. */
export function awsReaderRoleArn(accountId: string): string {
  return `arn:aws:iam::${accountId}:role${AWS_READER_ROLE_PATH}${AWS_READER_ROLE_NAME}`;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isLowerAlnum(code: number): boolean {
  return isDigit(code) || (code >= 97 && code <= 122);
}

function isAsciiAlnum(code: number): boolean {
  return isLowerAlnum(code) || (code >= 65 && code <= 90);
}

/** Os caracteres de `value`, todos aceitos por `accept`; vazio é recusado. Caractere a caractere, sem regex. */
function every(value: string, accept: (code: number, char: string) => boolean): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!accept(value.charCodeAt(index), value.charAt(index))) return false;
  }
  return true;
}

/** ID único da conta de serviço do nó no Google: 21 dígitos (o `AllowedPattern` do `NodeServiceAccountId`). */
export function isNodeServiceAccountId(value: string): boolean {
  return value.length === 21 && every(value, isDigit);
}

export const MAX_AUDIENCE_LENGTH = 256;

/**
 * Audience aceito: `https://` e um host de minúsculas, números, ponto e hífen, seguido de segmentos de caminho não
 * vazios de letras, números, ponto, sublinhado e hífen. É o `AllowedPattern` do parâmetro `Audience` do template
 * (`^https://[a-z0-9.-]+(/[A-Za-z0-9._-]+)*$`), conferido por partes: sem porta, usuário, consulta, fragmento nem
 * curinga.
 */
export function isWebIdentityAudience(value: string): boolean {
  const scheme = 'https://';
  if (value.length > MAX_AUDIENCE_LENGTH || !value.startsWith(scheme)) return false;
  const [host = '', ...path] = value.slice(scheme.length).split('/');
  return (
    every(host, (code, char) => isLowerAlnum(code) || char === '.' || char === '-') &&
    path.every((segment) => every(segment, (code, char) => isAsciiAlnum(code) || '._-'.includes(char)))
  );
}

/** Um octeto do IPv4: 0 a 255, sem zero à esquerda. */
function isOctet(octet: string): boolean {
  if (octet.length > 3 || (octet.length > 1 && octet.startsWith('0'))) return false;
  return every(octet, isDigit) && Number(octet) <= 255;
}

/**
 * IP de saída do nó: IPv4 com /32 (`203.0.113.10/32`), o formato do `NODE_EGRESS_IPS` que o `install.sh` confere e do
 * `NodeEgressIps` do template. Conferido por partes.
 */
export function isNodeEgressIp(value: string): boolean {
  const [address = '', prefix, ...rest] = value.split('/');
  if (prefix !== '32' || rest.length > 0) return false;
  const octets = address.split('.');
  return octets.length === 4 && octets.every(isOctet);
}

/** O template aceita de 1 a 4 IPs de saída (`NodeEgressIps`). */
export const MAX_NODE_EGRESS_IPS = 4;

/**
 * Códigos de erro da conexão da AWS, gravados em `CloudAccount.connectionError` pela tarefa `aws-check` do worker
 * (fase 2: o "Verificar" do PR-V3'; a conferência real vem no PR-V5'). Só o código: nunca a mensagem da AWS.
 * - `trust_denied`: a AWS recusou a entrada no papel (pilha ainda não criada, ID da conta de serviço, IP ou audience
 *   diferentes dos do nó, papel feito pelo assistente do console, ou uma SCP ou RCP que nega a federação do Google);
 * - `token_invalid`: a AWS recusou o token do Google (vencido, malformado ou com claims recusadas);
 * - `idp_unavailable`: o Google ou o servidor de metadados do nó não responderam;
 * - `region_disabled`: o STS da região está desligado na conta;
 * - `account_mismatch`: a sessão é de outra conta que não a cadastrada;
 * - `bucket_missing`, `bucket_denied` e `kms_denied`: um bucket cadastrado não existe, não pôde ser lido, ou a chave
 *   KMS dele não decifra para o papel;
 * - `aws_unavailable`: a AWS não respondeu a tempo;
 * - `check_unavailable`: este nó ainda não confere a conexão sozinho;
 * - `aws_token_stale`: o token do host não é renovado há mais de 40 minutos (PR-V5').
 */
export const AWS_CONNECTION_ERROR_CODES = [
  'trust_denied',
  'token_invalid',
  'idp_unavailable',
  'region_disabled',
  'account_mismatch',
  'bucket_missing',
  'bucket_denied',
  'kms_denied',
  'aws_unavailable',
  'check_unavailable',
  'aws_token_stale',
] as const;
export type AwsConnectionErrorCode = (typeof AWS_CONNECTION_ERROR_CODES)[number];

export function isAwsConnectionErrorCode(value: string): value is AwsConnectionErrorCode {
  return (AWS_CONNECTION_ERROR_CODES as readonly string[]).includes(value);
}

/** No comando da CLI, no lugar do que o nó ainda não informa. */
export const NODE_SERVICE_ACCOUNT_ID_PLACEHOLDER = 'ID_DA_CONTA_DE_SERVICO_DO_NO';
export const NODE_EGRESS_IPS_PLACEHOLDER = 'IP_DE_SAIDA_DO_NO/32';

/** Os valores da pilha que vêm do nó e da conta cadastrada. */
export interface AwsReaderStackValues {
  /** ID único da conta de serviço do nó; null quando o nó não informa. */
  nodeServiceAccountId: string | null;
  /** IPs de saída do nó, com /32; vazio quando o nó não informa. */
  egressIps: readonly string[];
  audience: string;
  /** Nomes dos buckets de log cadastrados na conta. */
  buckets: readonly string[];
}

/** `LogBucketArns` da pilha: o ARN de cada bucket cadastrado, sem repetir; um nome que o cadastro recusa fica de fora. */
export function awsLogBucketArns(buckets: readonly string[]): string[] {
  return [...new Set(buckets.filter((name) => bucketNameProblem(name) === null))].map(
    (name) => `arn:aws:s3:::${name}`,
  );
}

/** Os IPs de saída que a pilha aceita: no formato e no máximo 4. Fora disso, nenhum (o comando leva o marcador). */
function stackEgressIps(egressIps: readonly string[]): string | null {
  if (egressIps.length === 0 || egressIps.length > MAX_NODE_EGRESS_IPS) return null;
  return egressIps.every(isNodeEgressIp) ? egressIps.join(',') : null;
}

/**
 * A alternativa ao console: o `aws cloudformation deploy` com os valores do nó e os buckets da conta (o template vai
 * direto, sem bucket, porque cabe no `TemplateBody`). Todo valor é conferido antes de entrar no comando, que o cliente
 * cola no terminal dele: um valor fora do formato vira o marcador, nunca texto livre. As chaves KMS ficam de fora,
 * porque o cadastro não as tem.
 *
 * O mesmo comando atualiza a pilha que já existe: o `deploy` mantém o valor anterior de todo parâmetro que não recebe.
 * Por isso o `LogBucketArns` vai sempre, vazio (`""`) quando a conta não tem bucket: sem ele, tirar o último bucket no
 * painel e rodar o comando de novo deixaria o papel lendo os buckets antigos.
 */
export function awsReaderDeployCommand(values: AwsReaderStackValues): string {
  const serviceAccount =
    values.nodeServiceAccountId !== null && isNodeServiceAccountId(values.nodeServiceAccountId)
      ? values.nodeServiceAccountId
      : NODE_SERVICE_ACCOUNT_ID_PLACEHOLDER;
  const audience = isWebIdentityAudience(values.audience) ? values.audience : AWS_READER_AUDIENCE;
  const overrides = [
    `NodeServiceAccountId=${serviceAccount}`,
    `NodeEgressIps=${stackEgressIps(values.egressIps) ?? NODE_EGRESS_IPS_PLACEHOLDER}`,
    `Audience=${audience}`,
  ];
  const arns = awsLogBucketArns(values.buckets);
  overrides.push(`LogBucketArns=${arns.length > 0 ? arns.join(',') : '""'}`);
  return [
    `aws cloudformation deploy --stack-name ${AWS_READER_STACK_NAME} \\`,
    `  --template-file ${AWS_READER_TEMPLATE_FILE} --capabilities CAPABILITY_NAMED_IAM \\`,
    '  --parameter-overrides \\',
    ...overrides.map((line, index) => `    ${line}${index < overrides.length - 1 ? ' \\' : ''}`),
  ].join('\n');
}

/** Região do console quando a conta não tem uma válida. */
const DEFAULT_CONSOLE_REGION = 'sa-east-1';

/** O CloudFormation no console da AWS, na região informada (a primeira monitorada), na criação de pilha. */
export function cloudFormationConsoleUrl(region: string | undefined): string {
  const chosen = region !== undefined && isAwsRegion(region) ? region : DEFAULT_CONSOLE_REGION;
  return `https://console.aws.amazon.com/cloudformation/home?region=${chosen}#/stacks/create`;
}

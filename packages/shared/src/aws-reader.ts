import { bucketNameProblem, isAwsRegion, LOG_SOURCES, type LogSource } from './cloud-accounts.js';

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

/**
 * A versão do modelo do papel (`verax-control-reader.yaml`), gravada na etiqueta `verax-control:template` do papel.
 * O modelo 1 não tem etiqueta. O 2 trouxe a descoberta das fontes e as três autorizações do cliente.
 */
export const AWS_READER_TEMPLATE_VERSION = 2;

/**
 * O que o papel pode fazer, como a etiqueta `verax-control:capabilities` dele diz:
 * - `discovery`: a descoberta das fontes e a postura (só configuração; vale sempre);
 * - `service-logs`: os logs que a AWS grava no S3 em `AWSLogs/<conta>/` (parâmetro `ReadAwsServiceLogs`);
 * - `findings`: os achados do GuardDuty, do Security Hub, do Inspector e do Access Analyzer (`ReadSecurityFindings`);
 * - `log-groups`: os grupos do CloudWatch Logs com a etiqueta `AWS_LOG_GROUP_TAG` (`ReadTaggedLogGroups`).
 * A ordem é a da etiqueta.
 */
export const AWS_READER_CAPABILITIES = ['discovery', 'service-logs', 'findings', 'log-groups'] as const;
export type AwsReaderCapability = (typeof AWS_READER_CAPABILITIES)[number];
/** As autorizações que o cliente liga ou desliga na pilha (a descoberta não tem interruptor). */
export type AwsReaderAuthorization = Exclude<AwsReaderCapability, 'discovery'>;
export const AWS_READER_AUTHORIZATIONS = [
  'service-logs',
  'findings',
  'log-groups',
] as const satisfies readonly AwsReaderAuthorization[];

export function isAwsReaderCapability(value: string): value is AwsReaderCapability {
  return (AWS_READER_CAPABILITIES as readonly string[]).includes(value);
}

/** O parâmetro `true`/`false` do template de cada autorização. */
export const AWS_READER_CAPABILITY_PARAMETERS = {
  'service-logs': 'ReadAwsServiceLogs',
  findings: 'ReadSecurityFindings',
  'log-groups': 'ReadTaggedLogGroups',
} as const satisfies Record<AwsReaderAuthorization, string>;

/** As etiquetas do papel que o nó lê (`iam:GetRole` no próprio papel). Não dão permissão: só informam. */
export const AWS_READER_ROLE_TAGS = {
  template: 'verax-control:template',
  capabilities: 'verax-control:capabilities',
} as const;
/** O separador da lista em `verax-control:capabilities`: o IAM não aceita vírgula no valor de uma etiqueta. */
export const AWS_READER_CAPABILITIES_SEPARATOR = ' ';

/** A etiqueta que o cliente põe num grupo do CloudWatch Logs para o papel poder ler os eventos dele. */
export const AWS_LOG_GROUP_TAG = { key: 'verax-control', value: 'leitura' } as const;

/** O valor da etiqueta `verax-control:capabilities` para as autorizações dadas: a descoberta sempre, na ordem fixa. */
export function awsReaderCapabilitiesTagValue(capabilities: readonly AwsReaderCapability[]): string {
  return AWS_READER_CAPABILITIES.filter(
    (capability) => capability === 'discovery' || capabilities.includes(capability),
  ).join(AWS_READER_CAPABILITIES_SEPARATOR);
}

/** Uma etiqueta como o IAM a devolve (`GetRole`, `GetUser`). */
export interface AwsReaderRoleTag {
  Key?: string | undefined;
  Value?: string | undefined;
}

/** O que as etiquetas do papel dizem dele. */
export interface AwsReaderRoleFacts {
  /** A versão do modelo; null quando a etiqueta existe e não é um número de versão. */
  templateVersion: number | null;
  /** O que o papel pode fazer, na ordem de `AWS_READER_CAPABILITIES`; a descoberta está sempre. */
  capabilities: AwsReaderCapability[];
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Um número de versão: de 1 a 4 dígitos, sem zero à esquerda. Caractere a caractere, sem regex. */
function parseTemplateVersion(value: string): number | null {
  if (value.length === 0 || value.length > 4 || value.startsWith('0')) return null;
  for (let index = 0; index < value.length; index += 1) {
    if (!isDigit(value.charCodeAt(index))) return null;
  }
  return Number(value);
}

/** Os itens de uma lista separada por espaço (ou vírgula, tabulação ou quebra de linha), sem os vazios. */
function listItems(value: string): string[] {
  const items: string[] = [];
  let current = '';
  for (const char of value) {
    if (char === ' ' || char === ',' || char === '\t' || char === '\n' || char === '\r') {
      if (current !== '') items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (current !== '') items.push(current);
  return items;
}

/** O tamanho máximo, em caracteres, do valor de uma etiqueta do IAM. */
const MAX_IAM_TAG_VALUE_LENGTH = 256;

/**
 * Lê as etiquetas do papel de leitura (o `Tags` do `iam:GetRole`), que vêm da conta do cliente e são tratadas como
 * entrada externa: só a versão num formato de número e os nomes de `AWS_READER_CAPABILITIES` contam; o resto é
 * ignorado, e nada do texto recebido sai daqui.
 *
 * - Sem a etiqueta `verax-control:template`, o papel é do modelo 1: a descoberta de antes (conferência das fontes e
 *   postura) e nenhuma das três autorizações. Os buckets do `LogBucketArns` não são uma autorização: valem à parte.
 * - Com ela, a versão é a da etiqueta (null quando não é um número) e as autorizações são as da etiqueta
 *   `verax-control:capabilities`; sem esta, só a descoberta. A chave de uma etiqueta de papel não distingue
 *   maiúsculas de minúsculas no IAM.
 */
export function parseReaderRoleTags(
  tags: readonly AwsReaderRoleTag[] | null | undefined,
): AwsReaderRoleFacts {
  const values = new Map<string, string>();
  for (const tag of tags ?? []) {
    if (typeof tag.Key !== 'string' || typeof tag.Value !== 'string') continue;
    if (tag.Value.length > MAX_IAM_TAG_VALUE_LENGTH) continue;
    values.set(tag.Key.toLowerCase(), tag.Value);
  }
  const version = values.get(AWS_READER_ROLE_TAGS.template);
  if (version === undefined) return { templateVersion: 1, capabilities: ['discovery'] };
  const granted = listItems(values.get(AWS_READER_ROLE_TAGS.capabilities) ?? '');
  return {
    templateVersion: parseTemplateVersion(version.trim()),
    capabilities: AWS_READER_CAPABILITIES.filter(
      (capability) => capability === 'discovery' || granted.includes(capability),
    ),
  };
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
 * (fase 2: o "Verificar" do PR-V3' e a conferência real do PR-V5'). Só o código: nunca a mensagem da AWS.
 * - `trust_denied`: a AWS recusou a entrada no papel (pilha ainda não criada, ID da conta de serviço, IP ou audience
 *   diferentes dos do nó, papel feito pelo assistente do console, ou uma SCP ou RCP que nega a federação do Google);
 * - `token_invalid`: a AWS recusou o token do Google (vencido, malformado ou com claims recusadas);
 * - `idp_unavailable`: o Google não respondeu à AWS ao conferir o token;
 * - `region_disabled`: o STS da região está desligado na conta;
 * - `account_mismatch`: a sessão é de outra conta que não a cadastrada;
 * - `authorization_timeout` (onboarding self-service): o papel não apareceu dentro da janela do "Conectar com AWS"
 *   (60 min, `AWS_CONNECT_WINDOW_MS`). Dentro dela, a entrada recusada só diz que a pilha ainda está sendo criada e não
 *   vira erro; fechada a janela sem o papel, é este o erro gravado, e conectar de novo abre outra janela;
 * - `bucket_missing`, `bucket_denied` e `kms_denied`: um bucket cadastrado não existe, não pôde ser lido, ou a chave
 *   KMS dele não decifra para o papel. Gravados com a fonte do bucket (`bucket_denied:cloudtrail`, ver
 *   `awsConnectionErrorValue`);
 * - `trail_not_logging`, `guardduty_export_missing` e `excess_permissions` (conferência diária, PR-V5'): nenhuma trilha
 *   ativa grava no bucket do CloudTrail cadastrado, nenhum export do GuardDuty publica no bucket dele, ou o papel tem
 *   permissão além da política. Avisos: a conta continua conectada (`AWS_CONNECTION_WARNING_CODES`);
 * - `metadata_unavailable`: o nó não conseguiu pedir o próprio token ao servidor de metadados da GCP;
 * - `aws_unavailable`: a AWS não respondeu a tempo;
 * - `check_unavailable`: este nó ainda não confere a conexão sozinho;
 * - `key_missing` e `key_invalid` (só no nó na VM própria do cliente, que lê com a chave do usuário IAM de leitura):
 *   a conta não tem chave guardada no cofre, ou a AWS recusou a chave guardada (apagada, desativada ou trocada).
 *   Nesses nós, `account_mismatch` diz também que a chave não é de um usuário IAM desta conta (a do root, por exemplo).
 *
 * Os avisos da coleta pelo Wazuh do nó (o token do Google do host sem renovar, a configuração do manager que não subiu)
 * ficam à parte, em `CloudAccount.collectionError` (`AWS_COLLECTION_ERROR_CODES`, PR-V4').
 */
export const AWS_CONNECTION_ERROR_CODES = [
  'trust_denied',
  'token_invalid',
  'idp_unavailable',
  'region_disabled',
  'account_mismatch',
  'authorization_timeout',
  'bucket_missing',
  'bucket_denied',
  'kms_denied',
  'trail_not_logging',
  'guardduty_export_missing',
  'excess_permissions',
  'metadata_unavailable',
  'aws_unavailable',
  'check_unavailable',
  'key_missing',
  'key_invalid',
] as const;
export type AwsConnectionErrorCode = (typeof AWS_CONNECTION_ERROR_CODES)[number];

export function isAwsConnectionErrorCode(value: string): value is AwsConnectionErrorCode {
  return (AWS_CONNECTION_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Avisos da conexão da AWS (PR-V5'): a conferência passou, a coleta continua, e a conta fica conectada com o código
 * em `connectionError`. Em ordem de prioridade (só um vai para a conta): o STS da região desligado (o nó entrou pelo
 * de us-east-1, mas o Wazuh usa o da região), a trilha parada, o export do GuardDuty ausente e a permissão demais.
 */
export const AWS_CONNECTION_WARNING_CODES = [
  'region_disabled',
  'trail_not_logging',
  'guardduty_export_missing',
  'excess_permissions',
] as const satisfies readonly AwsConnectionErrorCode[];
export type AwsConnectionWarningCode = (typeof AWS_CONNECTION_WARNING_CODES)[number];

export function isAwsConnectionWarningCode(value: string | null): value is AwsConnectionWarningCode {
  return value !== null && (AWS_CONNECTION_WARNING_CODES as readonly string[]).includes(value);
}

/** Erros de um bucket cadastrado: gravados com a fonte dele (`bucket_denied:waf`). */
export const AWS_BUCKET_ERROR_CODES = [
  'bucket_missing',
  'bucket_denied',
  'kms_denied',
] as const satisfies readonly AwsConnectionErrorCode[];
export type AwsBucketErrorCode = (typeof AWS_BUCKET_ERROR_CODES)[number];

function isAwsBucketErrorCode(value: string): value is AwsBucketErrorCode {
  return (AWS_BUCKET_ERROR_CODES as readonly string[]).includes(value);
}

/** O que vai para `CloudAccount.connectionError`: o código e, num erro de bucket, a fonte (`kms_denied:guardduty`). */
export function awsConnectionErrorValue(code: AwsConnectionErrorCode, source?: LogSource): string {
  return source !== undefined && isAwsBucketErrorCode(code) ? `${code}:${source}` : code;
}

/**
 * O código e a fonte de um `connectionError` da AWS; null para um valor que não é da AWS. Aceita o código sozinho
 * (um bucket sem fonte, como o PR-V3' gravava) e `código:fonte` só nos erros de bucket.
 */
export function parseAwsConnectionError(
  value: string,
): { code: AwsConnectionErrorCode; source: LogSource | null } | null {
  const [code = '', source, ...rest] = value.split(':');
  if (!isAwsConnectionErrorCode(code) || rest.length > 0) return null;
  if (source === undefined) return { code, source: null };
  if (!isAwsBucketErrorCode(code) || !(LOG_SOURCES as readonly string[]).includes(source)) return null;
  return { code, source: source as LogSource };
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
  /** Nomes dos buckets de log cadastrados na conta (os buckets adicionais da pilha, fora do padrão AWSLogs). */
  buckets: readonly string[];
  /** As autorizações dadas na pilha; sem o campo, as três (o padrão do template). A descoberta vale sempre. */
  capabilities?: readonly AwsReaderCapability[];
}

/** O valor (`true` ou `false`) do parâmetro de cada autorização, na ordem do template. */
function capabilityParameters(
  capabilities: readonly AwsReaderCapability[] | undefined,
): [parameter: string, value: 'true' | 'false'][] {
  return AWS_READER_AUTHORIZATIONS.map((capability) => [
    AWS_READER_CAPABILITY_PARAMETERS[capability],
    capabilities === undefined || capabilities.includes(capability) ? 'true' : 'false',
  ]);
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
 * painel e rodar o comando de novo deixaria o papel lendo os buckets antigos. Pelo mesmo motivo, as três autorizações
 * vão sempre, com `true` ou `false`: desligar uma no painel e rodar o comando de novo tira a permissão dela. Só os
 * nomes de `AWS_READER_CAPABILITIES` contam; qualquer outro texto na lista é ignorado.
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
    ...capabilityParameters(values.capabilities).map(([parameter, value]) => `${parameter}=${value}`),
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

/** O limite do `TemplateBody` do CloudFormation (o arquivo enviado pelo console ou pela CLI, sem bucket), em bytes. */
export const CLOUDFORMATION_TEMPLATE_BODY_MAX_BYTES = 51200;

/**
 * Por que o template não pôde ser preenchido. Só o código: o valor recusado nunca vai para a mensagem.
 * - `service_account`, `egress_ips`, `audience`, `capabilities` e `buckets`: o valor do nó ou da conta está fora do
 *   formato que o template aceita (ou falta);
 * - `template`: o texto recebido não é o template do papel de leitura (um parâmetro esperado não está nele, ou está
 *   escrito de outro jeito);
 * - `too_large`: o arquivo preenchido passaria do limite do `TemplateBody`;
 * - `account`: o ID da conta do nome do arquivo não tem 12 dígitos.
 */
export const AWS_READER_PREFILL_PROBLEMS = [
  'service_account',
  'egress_ips',
  'audience',
  'capabilities',
  'buckets',
  'template',
  'too_large',
  'account',
] as const;
export type AwsReaderPrefillProblem = (typeof AWS_READER_PREFILL_PROBLEMS)[number];

export class AwsReaderPrefillError extends Error {
  readonly problem: AwsReaderPrefillProblem;

  constructor(problem: AwsReaderPrefillProblem) {
    super(`O template do papel de leitura não pôde ser preenchido (${problem}).`);
    this.name = 'AwsReaderPrefillError';
    this.problem = problem;
  }
}

/** Os parâmetros do template que o preenchimento toca, e só eles. */
export const AWS_READER_PREFILLED_PARAMETERS = [
  'NodeServiceAccountId',
  'NodeEgressIps',
  'Audience',
  ...AWS_READER_AUTHORIZATIONS.map((capability) => AWS_READER_CAPABILITY_PARAMETERS[capability]),
  'LogBucketArns',
] as const;

/** Um valor que cabe entre aspas simples numa linha de YAML: ASCII visível, sem aspas simples. */
function isPlainAscii(value: string): boolean {
  return every(value, (code, char) => code >= 0x20 && code <= 0x7e && char !== "'");
}

/**
 * Os valores que vão para as linhas `Default:`, cada um conferido com a mesma regra do `AllowedPattern` do parâmetro
 * dele. Um valor fora do formato recusa o preenchimento inteiro: nada entra no arquivo sem passar por aqui.
 */
function prefillDefaults(values: AwsReaderStackValues): Map<string, string> {
  const serviceAccount = values.nodeServiceAccountId;
  if (serviceAccount === null || !isNodeServiceAccountId(serviceAccount)) {
    throw new AwsReaderPrefillError('service_account');
  }
  const egressIps = stackEgressIps(values.egressIps);
  if (egressIps === null) throw new AwsReaderPrefillError('egress_ips');
  if (!isWebIdentityAudience(values.audience)) throw new AwsReaderPrefillError('audience');
  if (values.capabilities !== undefined && !values.capabilities.every(isAwsReaderCapability)) {
    throw new AwsReaderPrefillError('capabilities');
  }
  if (!values.buckets.every((name) => bucketNameProblem(name) === null)) {
    throw new AwsReaderPrefillError('buckets');
  }
  const defaults = new Map<string, string>([
    ['NodeServiceAccountId', serviceAccount],
    ['NodeEgressIps', egressIps],
    ['Audience', values.audience],
    ...capabilityParameters(values.capabilities),
  ]);
  // Os buckets adicionais só entram quando a conta os tem: sem eles, a linha do template fica como está (vazia).
  const arns = awsLogBucketArns(values.buckets);
  if (arns.length > 0) defaults.set('LogBucketArns', arns.join(','));
  // A última trava antes de escrever: as regras acima já só deixam passar ASCII sem aspas, e esta conferência vale
  // mesmo que uma delas mude.
  for (const value of defaults.values()) {
    if (!isPlainAscii(value)) throw new AwsReaderPrefillError('template');
  }
  return defaults;
}

/** Os bytes do texto em UTF-8 (sem `TextEncoder`, para valer igual no navegador e no Node). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // Um par substituto: um caractere de 4 bytes em duas unidades.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const PARAMETERS_SECTION = 'Parameters:';
const DEFAULT_PROPERTY = '    Default:';
const TYPE_PROPERTY = '    Type:';

/** Um parâmetro do template: o nome e as linhas (índices) do `Type:` e do `Default:` dele, quando existem. */
interface TemplateParameter {
  name: string;
  type: number | null;
  default: number | null;
}

/** A linha sem o `\r` do fim (um arquivo com fim de linha do Windows). */
function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** O nome do parâmetro que a linha abre (`  Nome:`, com dois espaços e nada depois dos dois-pontos); null nas outras. */
function parameterHeader(line: string): string | null {
  if (!line.startsWith('  ') || line.startsWith('   ') || !line.endsWith(':')) return null;
  const name = line.slice(2, -1);
  return every(name, isAsciiAlnum) ? name : null;
}

/**
 * Os parâmetros da seção `Parameters:` do template, lidos linha a linha (sem interpretar YAML): cada um começa em
 * `  Nome:` e tem as propriedades com quatro espaços. Um `Type:` ou um `Default:` repetido, ou um `Default:` que não
 * cabe numa linha (`>-`, `|`), não é o template esperado.
 */
function templateParameters(lines: readonly string[]): TemplateParameter[] {
  const parameters: TemplateParameter[] = [];
  let inParameters = false;
  let current: TemplateParameter | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = withoutCarriageReturn(lines[index] ?? '');
    if (line !== '' && !line.startsWith(' ') && !line.startsWith('#')) {
      // Uma chave do primeiro nível: abre ou fecha a seção dos parâmetros.
      inParameters = line === PARAMETERS_SECTION;
      current = null;
      continue;
    }
    if (!inParameters) continue;
    const header = parameterHeader(line);
    if (header !== null) {
      current = { name: header, type: null, default: null };
      parameters.push(current);
    } else if (current !== null && line.startsWith(TYPE_PROPERTY)) {
      if (current.type !== null) throw new AwsReaderPrefillError('template');
      current.type = index;
    } else if (current !== null && line.startsWith(DEFAULT_PROPERTY)) {
      const written = line.slice(DEFAULT_PROPERTY.length).trim();
      if (current.default !== null || written === '' || written.startsWith('>') || written.startsWith('|')) {
        throw new AwsReaderPrefillError('template');
      }
      current.default = index;
    }
  }
  return parameters;
}

/**
 * O template do papel de leitura com os valores deste nó e desta conta já gravados como o padrão (`Default:`) dos
 * parâmetros: o arquivo que o botão "Conectar com AWS" baixa, para o cliente só revisar e confirmar no console do
 * CloudFormation. Muda só a linha `Default:` de `AWS_READER_PREFILLED_PARAMETERS` (ou a acrescenta, logo depois do
 * `Type:`, nos dois parâmetros que não têm padrão); toda outra linha sai igual, byte a byte. Função pura, sem regex e
 * sem dependência: roda no navegador.
 *
 * O texto do template é conteúdo do repositório (o arquivo servido pelo painel); os valores vêm do nó e da conta e
 * são conferidos um a um antes de entrar (`prefillDefaults`). Qualquer problema lança `AwsReaderPrefillError`, e nada
 * é devolvido pela metade. O `LogBucketArns` só é tocado quando a conta tem buckets cadastrados.
 */
export function prefillReaderTemplate(templateText: string, values: AwsReaderStackValues): string {
  const defaults = prefillDefaults(values);
  const lines = templateText.split('\n');
  const parameters = templateParameters(lines);
  /** Por linha: o padrão que a substitui, ou o que entra logo depois dela. */
  const replaced = new Map<number, string>();
  const added = new Map<number, string>();
  for (const [name, value] of defaults) {
    // Cada parâmetro esperado aparece uma vez só, com o `Type:` dele.
    const found = parameters.filter((parameter) => parameter.name === name);
    const [parameter] = found;
    if (found.length !== 1 || parameter === undefined || parameter.type === null) {
      throw new AwsReaderPrefillError('template');
    }
    const line = `${DEFAULT_PROPERTY} '${value}'`;
    if (parameter.default !== null) replaced.set(parameter.default, line);
    else added.set(parameter.type, line);
  }
  const filled: string[] = [];
  lines.forEach((raw, index) => {
    const ending = raw.endsWith('\r') ? '\r' : '';
    const replacement = replaced.get(index);
    filled.push(replacement === undefined ? raw : `${replacement}${ending}`);
    const addition = added.get(index);
    if (addition !== undefined) filled.push(`${addition}${ending}`);
  });
  const text = filled.join('\n');
  if (utf8Length(text) > CLOUDFORMATION_TEMPLATE_BODY_MAX_BYTES) throw new AwsReaderPrefillError('too_large');
  return text;
}

/** O nome do arquivo preenchido que o painel baixa: o do template com o ID da conta (12 dígitos). */
export function awsReaderPrefilledFileName(accountId: string): string {
  if (accountId.length !== 12 || !every(accountId, isDigit)) throw new AwsReaderPrefillError('account');
  return `verax-control-reader-${accountId}.yaml`;
}

/** Região do console quando a conta não tem uma válida. */
const DEFAULT_CONSOLE_REGION = 'sa-east-1';

/** A região do console: a informada, quando é uma região da AWS; senão, a padrão. */
function consoleRegion(region: string | undefined): string {
  return region !== undefined && isAwsRegion(region) ? region : DEFAULT_CONSOLE_REGION;
}

/** O CloudFormation no console da AWS, na região informada (a primeira monitorada), na criação de pilha. */
export function cloudFormationConsoleUrl(region: string | undefined): string {
  return `https://console.aws.amazon.com/cloudformation/home?region=${consoleRegion(region)}#/stacks/create`;
}

/**
 * A lista de pilhas do CloudFormation no console da AWS, na região informada: de onde o cliente abre a pilha
 * `AWS_READER_STACK_NAME` que já existe, para atualizá-la (outro modelo, uma autorização ligada ou desligada).
 */
export function cloudFormationStacksUrl(region: string | undefined): string {
  return `https://console.aws.amazon.com/cloudformation/home?region=${consoleRegion(region)}#/stacks`;
}

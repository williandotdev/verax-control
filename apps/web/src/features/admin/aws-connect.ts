import {
  AWS_LOG_GROUP_TAG,
  AWS_READER_AUDIENCE,
  AWS_READER_AUTHORIZATIONS,
  AWS_READER_CAPABILITY_PARAMETERS,
  type AwsOnboarding,
  type AwsReaderAuthorization,
  type AwsReaderCapability,
  awsReaderDeployCommand,
  awsReaderPrefilledFileName,
  AwsReaderPrefillError,
  type AwsReaderPrefillProblem,
  awsReaderRoleArn,
  type AwsReaderStackValues,
  awsReaderUserArn,
  type CloudAccount,
  isAwsRegion,
  logBucketNames,
  prefillReaderTemplate,
} from '@verax/shared';

/**
 * "Conectar com AWS" no painel (`docs/ARQUITETURA.md`, "Onboarding AWS self-service"): o que a tela monta no navegador,
 * sem servidor no meio. O arquivo que o botão baixa é o template do repositório com os valores deste nó e as
 * autorizações escolhidas gravados como o padrão dos parâmetros (`prefillReaderTemplate`, de `@verax/shared`): nenhum
 * segredo, e nada além das linhas `Default:` muda. Aqui ficam só funções puras e a gravação do arquivo; os textos estão
 * em `aws-onboarding-labels.ts`.
 */

/** As três autorizações que o cliente liga ou desliga na tela (a descoberta vale sempre). */
export type AwsAuthorizationChoice = Readonly<Record<AwsReaderAuthorization, boolean>>;

/** O padrão do template: as três ligadas. */
export const ALL_AWS_AUTHORIZATIONS: AwsAuthorizationChoice = {
  'service-logs': true,
  findings: true,
  'log-groups': true,
};

/** A escolha que repete o que o papel já tem (as capacidades lidas das etiquetas dele). */
export function authorizationChoiceOf(capabilities: readonly AwsReaderCapability[]): AwsAuthorizationChoice {
  return {
    'service-logs': capabilities.includes('service-logs'),
    findings: capabilities.includes('findings'),
    'log-groups': capabilities.includes('log-groups'),
  };
}

/** As capacidades da escolha, na ordem do catálogo: a descoberta sempre, e as autorizações ligadas. */
export function capabilitiesOfChoice(choice: AwsAuthorizationChoice): AwsReaderCapability[] {
  return ['discovery', ...chosenAuthorizations(choice)];
}

/**
 * As autorizações ligadas na escolha, como vão para a API no "Conectar" e no "Verificar" (sem a descoberta, que vale
 * sempre): é o que fica gravado como a escolha do cliente.
 */
export function chosenAuthorizations(choice: AwsAuthorizationChoice): AwsReaderAuthorization[] {
  return AWS_READER_AUTHORIZATIONS.filter((authorization) => choice[authorization]);
}

/** O que a escolha inicial e o aviso de diferença leem do estado da conta. */
type ChoiceFacts = Pick<AwsOnboarding, 'connect' | 'template'>;

/** As etiquetas do papel foram lidas, e são do modelo atual (o único que tem as três autorizações)? */
function readsCurrentTemplate({ template }: ChoiceFacts): boolean {
  return template.checkedAt !== null && template.version !== null && !template.outdated;
}

/**
 * A escolha com que a tela começa, para ela nunca marcar mais do que o cliente escolheu:
 * 1. a que ele confirmou por último aqui (a gravada no "Conectar" ou no "Verificar" depois de atualizar a pilha);
 * 2. sem escolha gravada, o que o papel já tem (as etiquetas dele, no modelo atual);
 * 3. sem nenhuma das duas (a conta nova, ou a pilha do modelo anterior, que não tinha autorizações), as três do padrão
 *    do modelo.
 */
export function storedAuthorizationChoice(onboarding: ChoiceFacts): AwsAuthorizationChoice {
  if (onboarding.connect.capabilities !== null) return authorizationChoiceOf(onboarding.connect.capabilities);
  if (readsCurrentTemplate(onboarding)) return authorizationChoiceOf(onboarding.template.capabilities);
  return ALL_AWS_AUTHORIZATIONS;
}

/** O que separa o que o papel tem na AWS do que o cliente escolheu no painel. */
export interface AwsAuthorizationMismatch {
  /** Ligadas no papel sem terem sido escolhidas aqui: o papel concede mais do que a escolha. */
  extra: AwsReaderAuthorization[];
  /** Escolhidas aqui e desligadas no papel. */
  missing: AwsReaderAuthorization[];
}

/**
 * A diferença entre as autorizações que o papel tem (as etiquetas dele) e as que o cliente escolheu no painel; null sem
 * diferença, ou sem como comparar: nenhuma escolha gravada, as etiquetas ainda não lidas, lidas antes do último
 * "Conectar" (são da pilha de antes) ou de um modelo anterior (que já tem o aviso próprio).
 */
export function authorizationMismatch(onboarding: ChoiceFacts): AwsAuthorizationMismatch | null {
  const { connect, template } = onboarding;
  if (connect.capabilities === null || !readsCurrentTemplate(onboarding)) return null;
  if (
    connect.requestedAt !== null &&
    template.checkedAt !== null &&
    template.checkedAt < connect.requestedAt
  ) {
    return null;
  }
  const chosen = connect.capabilities;
  const extra = AWS_READER_AUTHORIZATIONS.filter(
    (authorization) => template.capabilities.includes(authorization) && !chosen.includes(authorization),
  );
  const missing = AWS_READER_AUTHORIZATIONS.filter(
    (authorization) => chosen.includes(authorization) && !template.capabilities.includes(authorization),
  );
  return extra.length === 0 && missing.length === 0 ? null : { extra, missing };
}

/** O que a conta diz do nó e dos buckets cadastrados: o que entra na pilha. */
export type AwsStackAccount = Pick<
  CloudAccount,
  'accountId' | 'nodeServiceAccountId' | 'egressIps' | 'webIdentityAudience' | 'buckets' | 'regions'
>;

/** Os valores da pilha desta conta, com as autorizações escolhidas. */
export function awsStackValues(
  account: AwsStackAccount,
  choice: AwsAuthorizationChoice,
): AwsReaderStackValues {
  return {
    nodeServiceAccountId: account.nodeServiceAccountId,
    egressIps: account.egressIps,
    audience: account.webIdentityAudience ?? AWS_READER_AUDIENCE,
    buckets: logBucketNames(account.buckets),
    capabilities: capabilitiesOfChoice(choice),
  };
}

/** O arquivo preenchido, ou por que ele não pôde ser montado (só o código, nunca o valor recusado). */
export type PrefilledTemplate =
  { ok: true; text: string; fileName: string } | { ok: false; problem: AwsReaderPrefillProblem };

/**
 * O template com os valores do nó e da conta nos padrões dos parâmetros, e o nome do arquivo. Um valor que falta ou
 * está fora do formato não vira arquivo: a tela mostra o que pedir à Verax, em vez de entregar um template quebrado.
 */
export function prefilledReaderTemplate(
  templateText: string,
  account: AwsStackAccount,
  choice: AwsAuthorizationChoice,
): PrefilledTemplate {
  try {
    return {
      ok: true,
      text: prefillReaderTemplate(templateText, awsStackValues(account, choice)),
      fileName: awsReaderPrefilledFileName(account.accountId),
    };
  } catch (error) {
    if (error instanceof AwsReaderPrefillError) return { ok: false, problem: error.problem };
    throw error;
  }
}

/**
 * O nome do arquivo preenchido desta conta: o que "Conectar com AWS", "Baixar o arquivo de novo" e "Baixar o arquivo da
 * pilha" gravam (o mesmo de `prefilledReaderTemplate`). Null com o ID da conta fora do formato: aí nenhum arquivo é
 * montado.
 */
export function awsStackFileName(account: Pick<CloudAccount, 'accountId'>): string | null {
  try {
    return awsReaderPrefilledFileName(account.accountId);
  } catch (error) {
    if (error instanceof AwsReaderPrefillError) return null;
    throw error;
  }
}

/**
 * O comando da CLI que cria ou atualiza a pilha, com as autorizações escolhidas (`awsReaderDeployCommand`).
 * `templateFile` é o nome do arquivo que o painel ao lado do comando baixa, para o comando copiado ler o arquivo que o
 * cliente tem na pasta: o preenchido (`awsStackFileName`) onde o botão baixa o arquivo preenchido; sem ele, o do
 * repositório (a alternativa manual, que baixa o template sem nada preenchido).
 */
export function awsDeployCommand(
  account: AwsStackAccount,
  choice: AwsAuthorizationChoice,
  templateFile: string | null = null,
): string {
  return awsReaderDeployCommand(
    awsStackValues(account, choice),
    templateFile === null ? {} : { templateFile },
  );
}

/** O valor (`true` ou `false`) de cada parâmetro de autorização, na ordem do template. */
export function authorizationParameters(
  choice: AwsAuthorizationChoice,
): { authorization: AwsReaderAuthorization; parameter: string; value: 'true' | 'false' }[] {
  return AWS_READER_AUTHORIZATIONS.map((authorization) => ({
    authorization,
    parameter: AWS_READER_CAPABILITY_PARAMETERS[authorization],
    value: choice[authorization] ? 'true' : 'false',
  }));
}

/** Quanto esperar antes de soltar o endereço do arquivo: o navegador já começou a gravá-lo. */
export const DOWNLOAD_REVOKE_DELAY_MS = 1_000;

/**
 * Grava um texto como arquivo, no navegador: um `Blob`, um link com `download` e o clique nele. O endereço do `Blob` é
 * solto logo depois (ele prende o conteúdo na memória da página enquanto existe).
 */
export function downloadTextFile(fileName: string, text: string, type = 'application/yaml'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS);
}

/** A região do console para esta conta: a primeira monitorada (a principal do cadastro). */
export function awsConsoleRegion(account: Pick<CloudAccount, 'regions'>): string | undefined {
  return account.regions[0];
}

/** Abre o endereço em outra aba, sem dar à página aberta acesso a esta (`noopener`). */
export function openInNewTab(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/** Os caracteres que a AWS aceita no nome de um grupo de logs: letras, números e `_ - / . #`. */
function isLogGroupNameChar(code: number, char: string): boolean {
  return isDigit(code) || isAsciiLetter(code) || '_-/.#'.includes(char);
}

function every(value: string, accept: (code: number, char: string) => boolean): boolean {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!accept(value.charCodeAt(index), value.charAt(index))) return false;
  }
  return true;
}

const AWS_PARTITIONS = ['aws', 'aws-cn', 'aws-us-gov'] as const;
const LOG_GROUP_RESOURCE = 'log-group';

/**
 * O ARN de um grupo de logs, conferido por partes: `arn:<partição>:logs:<região>:<conta>:log-group:<nome>`. O `:*` do
 * fim (como algumas respostas da AWS trazem) sai. Null fora desse formato: o que vai para um comando que o cliente cola
 * no terminal nunca é texto livre.
 */
export function logGroupResourceArn(arn: string | undefined): string | null {
  if (arn === undefined) return null;
  const trimmed = arn.endsWith(':*') ? arn.slice(0, -2) : arn;
  const [prefix, partition = '', service, region = '', account = '', resource, ...name] = trimmed.split(':');
  // O nome não tem dois-pontos: um a mais é outro formato.
  if (prefix !== 'arn' || service !== 'logs' || resource !== LOG_GROUP_RESOURCE || name.length !== 1) {
    return null;
  }
  if (!(AWS_PARTITIONS as readonly string[]).includes(partition) || !isAwsRegion(region)) return null;
  if (account.length !== 12 || !every(account, isDigit)) return null;
  const [groupName = ''] = name;
  if (groupName.length > 512 || !every(groupName, isLogGroupNameChar)) return null;
  return trimmed;
}

/** O ARN do grupo pelo nome, pela região e pela conta, quando a descoberta não o trouxe; null fora do formato. */
export function logGroupArnOf(accountId: string, region: string, name: string): string | null {
  return logGroupResourceArn(`arn:aws:logs:${region}:${accountId}:${LOG_GROUP_RESOURCE}:${name}`);
}

/** No comando, no lugar do ARN que a tela não tem num formato conferido. */
export const LOG_GROUP_ARN_PLACEHOLDER = 'ARN_DO_GRUPO_DE_LOGS';

/**
 * O comando de uma linha que põe a etiqueta de leitura num grupo de logs (`verax-control = leitura`). O ARN entra entre
 * aspas simples e só depois de conferido; fora do formato, vai o marcador.
 */
export function awsLogGroupTagCommand(arn: string | null): string {
  const resource = arn === null ? LOG_GROUP_ARN_PLACEHOLDER : `'${arn}'`;
  return `aws logs tag-resource --resource-arn ${resource} --tags ${AWS_LOG_GROUP_TAG.key}=${AWS_LOG_GROUP_TAG.value}`;
}

/** Quem lê a conta: o papel sem chave ou, na VM própria do cliente, o usuário IAM de leitura. */
export function awsReaderPrincipalArn(accountId: string, credentialMode: 'role' | 'access_key'): string {
  return credentialMode === 'access_key' ? awsReaderUserArn(accountId) : awsReaderRoleArn(accountId);
}

/**
 * A declaração que a política de uma chave KMS precisa ter para o Verax decifrar os logs de um bucket: só o Decrypt, só
 * para quem lê a conta e só quando quem pede é o S3 (a mesma condição da política de leitura).
 */
export function awsKmsKeyPolicyStatement(principalArn: string): string {
  return JSON.stringify(
    {
      Sid: 'PermitirLeituraDoVeraxControl',
      Effect: 'Allow',
      Principal: { AWS: principalArn },
      Action: 'kms:Decrypt',
      Resource: '*',
      Condition: { StringLike: { 'kms:ViaService': 's3.*.amazonaws.com' } },
    },
    null,
    2,
  );
}

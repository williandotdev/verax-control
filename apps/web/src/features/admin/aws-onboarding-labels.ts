import {
  AWS_ONBOARDING_CHECK_CODES,
  AWS_SOURCE_PERMISSION_CODES,
  AWS_SOURCE_STATE_CODES,
  type AwsCredentialMode,
  type AwsDiscoveryService,
  type AwsDiscoveryStatus,
  type AwsInfrastructureSummary,
  type AwsLogGroupCategory,
  type AwsOnboardingCheck,
  type AwsOnboardingCheckId,
  type AwsOnboardingCheckStatus,
  type AwsOnboardingErrorCode,
  type AwsOnboardingState,
  type AwsReaderAuthorization,
  type AwsReaderPrefillProblem,
  type AwsSource,
  type AwsSourceAvailability,
  type AwsSourceKind,
  type AwsSourceLoggingState,
  type AwsSourceNote,
  type AwsSourcePermissionCode,
  type AwsSourceState,
  CONSOLE_MANAGED_CODE,
  isAwsConnectionWarningCode,
} from '@verax/shared';
import type { Severity } from '@/design/severity';
import { ApiRequestError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { isFindingSource } from './aws-sources';
import { awsCollectionErrorHint, awsConnectionErrorHint } from './labels';

/**
 * Os textos do onboarding self-service da AWS (`packages/shared/src/aws-onboarding.ts`): a API manda só códigos, e a
 * tela decide o que dizer. Cada mapa é tipado contra o catálogo do contrato, então um estado, um código, um tipo de
 * fonte ou uma nota nova não compila sem o texto dele (e `aws-onboarding-labels.test.ts` confere em execução).
 * Linguagem de cliente: o que aconteceu e o que fazer, sem repetir a mensagem da AWS.
 */

/** O tom de um aviso: a mesma escala das severidades, e `progress` para o que está andando sozinho. */
export type Tone = Severity | 'progress' | 'idle';

// --- Estado da conta ---

interface StateText {
  /** O nome do estado, como aparece no selo e no passo do acompanhamento. */
  label: string;
  /** O que ele quer dizer, numa frase. */
  description: string;
  tone: Tone;
}

export const AWS_ONBOARDING_STATE_TEXTS: Readonly<Record<AwsOnboardingState, StateText>> = {
  not_started: {
    label: 'Não conectada',
    description: 'Ninguém pediu a conexão desta conta ainda.',
    tone: 'idle',
  },
  awaiting_authorization: {
    label: 'Aguardando autorização na AWS',
    description:
      'O Verax está tentando entrar no papel de leitura. Enquanto a pilha é criada no CloudFormation, o papel ainda não existe: o Verax não enxerga a pilha, só sabe que ainda não entrou.',
    tone: 'progress',
  },
  authenticated: {
    label: 'Autenticação validada',
    description:
      'O Verax entrou no papel de leitura desta conta. A descoberta das fontes de log ainda não terminou nenhuma vez.',
    tone: 'low',
  },
  discovering: {
    label: 'Descoberta em andamento',
    description:
      'O Verax está lendo a configuração da conta para achar as fontes de log: só nomes e configuração, nenhum conteúdo.',
    tone: 'progress',
  },
  awaiting_sources: {
    label: 'Aguardando autorização de fontes',
    description:
      'A descoberta terminou. Nada é coletado até você escolher e autorizar as fontes, em "Fontes de log".',
    tone: 'medium',
  },
  configuring: {
    label: 'Configurando coletores',
    description: 'Há fontes autorizadas, e nenhuma coleta começou ainda.',
    tone: 'progress',
  },
  collecting: {
    label: 'Coletando eventos',
    description: 'Todas as fontes autorizadas estão sendo lidas.',
    tone: 'ok',
  },
  partial: {
    label: 'Parcialmente operacional',
    description:
      'Só parte das fontes autorizadas está coletando. Veja a situação de cada uma em "Fontes autorizadas".',
    tone: 'high',
  },
  permission_error: {
    label: 'Erro de permissão',
    description: 'Uma fonte autorizada não pode ser lida por falta de permissão na AWS.',
    tone: 'critical',
  },
  ingestion_failure: {
    label: 'Falha de ingestão',
    description:
      'A coleta de uma fonte autorizada está falhando, ou o servidor do Verax não aplicou a configuração da coleta.',
    tone: 'critical',
  },
  disconnected: {
    label: 'Desconectada',
    description:
      'A AWS recusa a entrada do Verax nesta conta, ou o Verax não consegue conferir a conexão. As fontes e as autorizações continuam guardadas.',
    tone: 'critical',
  },
  authorization_timeout: {
    label: 'Tempo esgotado',
    description:
      'O papel de leitura não apareceu nesta conta em 60 minutos. Confira a pilha no CloudFormation e conecte de novo.',
    tone: 'critical',
  },
};

/** Na VM própria do cliente não há pilha nem papel: a espera é pela conferência da chave de leitura. */
const KEY_MODE_STATE_TEXTS: Partial<Record<AwsOnboardingState, Pick<StateText, 'label' | 'description'>>> = {
  awaiting_authorization: {
    label: 'Verificando a chave de leitura',
    description: 'O Verax está conferindo a conta com a chave do usuário de leitura.',
  },
  authenticated: {
    label: 'Autenticação validada',
    description:
      'O Verax leu a conta com a chave do usuário de leitura. A descoberta das fontes de log ainda não terminou nenhuma vez.',
  },
  disconnected: {
    label: 'Desconectada',
    description:
      'A AWS recusa a chave do usuário de leitura, ou o Verax não consegue conferir a conexão. As fontes e as autorizações continuam guardadas.',
  },
};

/** O texto do estado, com a versão da VM própria do cliente quando há uma. */
export function awsOnboardingStateText(
  state: AwsOnboardingState,
  mode: AwsCredentialMode = 'role',
): StateText {
  const base = AWS_ONBOARDING_STATE_TEXTS[state];
  return mode === 'access_key' ? { ...base, ...KEY_MODE_STATE_TEXTS[state] } : base;
}

// --- Passos do acompanhamento ---

/** Os passos, na ordem em que acontecem. O último tem o nome do desfecho (coletando, parcial, erro). */
export const AWS_ONBOARDING_STEPS = [
  'authorization',
  'authentication',
  'discovery',
  'sources',
  'collectors',
  'collection',
] as const;
export type AwsOnboardingStep = (typeof AWS_ONBOARDING_STEPS)[number];

/** O nome de cada passo quando ele não é o atual (já passou, ou ainda vem). */
export const AWS_ONBOARDING_STEP_LABELS: Readonly<Record<AwsOnboardingStep, string>> = {
  authorization: 'Autorização na AWS',
  authentication: 'Autenticação',
  discovery: 'Descoberta das fontes',
  sources: 'Autorização de fontes',
  collectors: 'Configuração dos coletores',
  collection: 'Coleta de eventos',
};

/** Em que passo cada estado está, e se o passo falhou. `null`: a conexão nem começou. */
export const AWS_ONBOARDING_STATE_STEP: Readonly<
  Record<AwsOnboardingState, { step: AwsOnboardingStep; failed: boolean } | null>
> = {
  not_started: null,
  awaiting_authorization: { step: 'authorization', failed: false },
  authorization_timeout: { step: 'authorization', failed: true },
  disconnected: { step: 'authorization', failed: true },
  authenticated: { step: 'authentication', failed: false },
  discovering: { step: 'discovery', failed: false },
  awaiting_sources: { step: 'sources', failed: false },
  configuring: { step: 'collectors', failed: false },
  collecting: { step: 'collection', failed: false },
  partial: { step: 'collection', failed: false },
  permission_error: { step: 'collection', failed: true },
  ingestion_failure: { step: 'collection', failed: true },
};

export type StepStatus = 'done' | 'current' | 'failed' | 'upcoming';

export const STEP_STATUS_LABELS: Readonly<Record<StepStatus, string>> = {
  done: 'concluído',
  current: 'em andamento',
  failed: 'com problema',
  upcoming: 'ainda não começou',
};

// --- Conferências ---

export const AWS_CHECK_LABELS: Readonly<Record<AwsOnboardingCheckId, string>> = {
  assume_role: 'Entrada no papel de leitura',
  identity: 'Conta e papel conferidos',
  template: 'Modelo da pilha e autorizações',
  discovery: 'Descoberta das fontes',
  permission: 'Permissão das fontes autorizadas',
  collector_config: 'Configuração dos coletores',
  events: 'Chegada de eventos',
  last_sync: 'Última leitura das fontes',
  lag: 'Atraso da coleta',
};

/** Na VM própria do cliente, as duas primeiras conferências falam da chave e do usuário de leitura. */
const KEY_MODE_CHECK_LABELS: Partial<Record<AwsOnboardingCheckId, string>> = {
  assume_role: 'Leitura com a chave de acesso',
  identity: 'Conta e usuário conferidos',
  template: 'Modelo das políticas e autorizações',
};

export function awsCheckLabel(id: AwsOnboardingCheckId, mode: AwsCredentialMode = 'role'): string {
  return (mode === 'access_key' ? KEY_MODE_CHECK_LABELS[id] : undefined) ?? AWS_CHECK_LABELS[id];
}

export const AWS_CHECK_STATUS_LABELS: Readonly<Record<AwsOnboardingCheckStatus, string>> = {
  ok: 'Certo',
  pending: 'Pendente',
  failed: 'Com problema',
  skipped: 'Não se aplica agora',
};

export const AWS_CHECK_STATUS_TONES: Readonly<Record<AwsOnboardingCheckStatus, Tone>> = {
  ok: 'ok',
  pending: 'progress',
  failed: 'critical',
  skipped: 'idle',
};

/** O que cada conferência diz em cada situação, sem motivo específico. */
const CHECK_TEXTS: Readonly<Record<AwsOnboardingCheckId, Record<AwsOnboardingCheckStatus, string>>> = {
  assume_role: {
    ok: 'O Verax entrou no papel de leitura desta conta.',
    pending: 'O Verax ainda não tentou entrar no papel de leitura.',
    failed: 'O Verax não conseguiu entrar no papel de leitura.',
    skipped: 'Não se aplica agora.',
  },
  identity: {
    ok: 'A sessão é da conta cadastrada e do papel verax-control-reader.',
    pending: 'Aguardando a entrada no papel de leitura.',
    failed: 'A sessão não é da conta cadastrada.',
    skipped: 'Depende da entrada no papel de leitura.',
  },
  template: {
    ok: 'A pilha está no modelo atual.',
    pending: 'O Verax ainda não leu a versão do modelo e as autorizações do papel.',
    failed: 'A pilha desta conta precisa ser atualizada.',
    skipped: 'Depende da entrada no papel de leitura.',
  },
  discovery: {
    ok: 'A descoberta leu a conta.',
    pending: 'A descoberta ainda não rodou.',
    failed: 'A descoberta não conseguiu ler a conta. Rode a descoberta de novo.',
    skipped: 'Depende da entrada no papel de leitura.',
  },
  permission: {
    ok: 'O Verax tem permissão para ler todas as fontes autorizadas.',
    pending: 'A permissão de uma fonte autorizada ainda não foi conferida.',
    failed: 'Uma fonte autorizada não pode ser lida por falta de permissão.',
    skipped: 'Nenhuma fonte autorizada ainda.',
  },
  collector_config: {
    ok: 'Os coletores das fontes autorizadas estão configurados.',
    pending: 'Os coletores das fontes autorizadas ainda não estão configurados.',
    failed: 'O servidor do Verax não aplicou a configuração da coleta.',
    skipped: 'Nenhuma fonte autorizada ainda.',
  },
  events: {
    ok: 'Todas as fontes autorizadas estão entregando eventos.',
    pending: 'Ainda não chegou evento de todas as fontes autorizadas.',
    failed: 'A leitura de uma fonte autorizada está falhando.',
    skipped: 'Nenhuma fonte autorizada ainda.',
  },
  last_sync: {
    ok: 'Todas as fontes autorizadas já foram lidas.',
    pending: 'Ainda não há leitura registrada de todas as fontes autorizadas.',
    failed: 'A última leitura de uma fonte autorizada falhou.',
    skipped: 'Nenhuma fonte autorizada ainda.',
  },
  lag: {
    ok: 'A coleta está em dia.',
    pending: 'Ainda não há medida de atraso de todas as fontes autorizadas.',
    failed: 'Uma fonte autorizada está com a coleta atrasada.',
    skipped: 'Nenhuma fonte autorizada ainda.',
  },
};

/** Os motivos próprios das conferências (`AWS_ONBOARDING_CHECK_CODES`). */
export const AWS_CHECK_CODE_TEXTS: Readonly<Record<(typeof AWS_ONBOARDING_CHECK_CODES)[number], string>> = {
  not_requested: 'Ainda não foi pedida.',
  awaiting_stack:
    'Aguardando a pilha: o papel de leitura ainda não existe na conta. O Verax tenta de novo sozinho, sem você fazer nada aqui.',
  verifying: 'Verificação pedida: o Verax está conferindo a conexão.',
  template_outdated:
    'A pilha desta conta é de um modelo anterior, sem a descoberta completa nem as autorizações. Atualize a pilha, em "Pilha na AWS".',
  template_unreadable:
    'A etiqueta verax-control:template do papel não traz um número de versão. Atualize a pilha com o arquivo desta tela, em "Pilha na AWS", para as etiquetas serem gravadas de novo.',
  awaiting_collector: 'Aguardando o coletor iniciar a leitura das fontes autorizadas.',
  no_data: 'Ainda sem medida.',
};

function isCheckCode(code: string): code is (typeof AWS_ONBOARDING_CHECK_CODES)[number] {
  return (AWS_ONBOARDING_CHECK_CODES as readonly string[]).includes(code);
}

// --- Descoberta ---

export const AWS_DISCOVERY_STATUS_LABELS: Readonly<Record<AwsDiscoveryStatus, string>> = {
  pending: 'na fila',
  running: 'em andamento',
  succeeded: 'completa',
  partial: 'parcial',
  failed: 'falhou',
};

export const AWS_DISCOVERY_SERVICE_LABELS: Readonly<Record<AwsDiscoveryService, string>> = {
  sts: 'Identidade da conta (STS)',
  regions: 'Regiões da conta',
  cloudtrail: 'CloudTrail',
  flow_logs: 'VPC Flow Logs',
  waf: 'WAF',
  guardduty: 'GuardDuty',
  security_hub: 'Security Hub',
  inspector: 'Inspector',
  access_analyzer: 'IAM Access Analyzer',
  cloudwatch_logs: 'CloudWatch Logs',
  config: 'AWS Config',
  elb: 'Balanceadores de carga',
  rds: 'Bancos do RDS',
  ec2: 'Instâncias e redes (EC2)',
  s3: 'Buckets (S3)',
  iam: 'Usuários e acessos (IAM)',
  run: 'A descoberta inteira',
};

const DENIED =
  'sem permissão para ler (atualize a pilha para o modelo atual; se já está atual, uma política da organização pode estar negando)';

/** Os nomes de erro que a descoberta registra, com o que dizer de cada um. Os demais aparecem pelo nome. */
const DISCOVERY_ERROR_HINTS: Readonly<Record<string, string>> = {
  AccessDenied: DENIED,
  AccessDeniedException: DENIED,
  AccessDeniedFault: DENIED,
  AuthorizationError: DENIED,
  UnauthorizedOperation: DENIED,
  UnauthorizedException: DENIED,
  TimeoutError: 'a AWS não respondeu a tempo',
  Throttling: 'a AWS limitou as requisições; a próxima descoberta tenta de novo',
  ThrottlingException: 'a AWS limitou as requisições; a próxima descoberta tenta de novo',
  TooManyRequestsException: 'a AWS limitou as requisições; a próxima descoberta tenta de novo',
  RequestLimitExceeded: 'a AWS limitou as requisições; a próxima descoberta tenta de novo',
  Truncated: 'há mais itens do que o Verax lê por descoberta: a lista está incompleta',
  OptInRequired: 'a região não está habilitada para esta conta',
  AuthFailure: 'a região não aceitou a sessão (região não habilitada)',
  UnrecognizedClientException: 'a região não aceitou a sessão (região não habilitada)',
  InvalidClientTokenId: 'a região não aceitou a sessão (região não habilitada)',
  interrupted: 'a descoberta foi interrompida no meio (o servidor do Verax reiniciou)',
  account_unavailable: 'a conta não estava conectada quando a descoberta ia começar',
  pending: 'na fila: começa em instantes',
  running: 'em andamento',
  partial: 'terminou sem conseguir ler tudo',
};

/** O que dizer de um erro da descoberta: a explicação conhecida, ou o nome do erro que a AWS deu. */
export function awsDiscoveryErrorHint(code: string): string {
  return Object.hasOwn(DISCOVERY_ERROR_HINTS, code)
    ? (DISCOVERY_ERROR_HINTS[code] ?? code)
    : `a AWS respondeu ${code}`;
}

// --- Fontes ---

interface KindText {
  /** O nome do tipo de fonte. */
  label: string;
  /** O que ela traz, numa frase curta. */
  description: string;
}

export const AWS_SOURCE_KIND_TEXTS: Readonly<Record<AwsSourceKind, KindText>> = {
  cloudtrail: {
    label: 'CloudTrail (trilha)',
    description: 'Quem fez o quê na conta: logins, mudanças de permissão e de configuração.',
  },
  vpc_flow_logs: {
    label: 'VPC Flow Logs',
    description: 'O tráfego de rede aceito e recusado nas VPCs.',
  },
  waf: {
    label: 'WAF (log da Web ACL)',
    description: 'As requisições que o firewall de aplicação bloqueou ou deixou passar.',
  },
  guardduty_export: {
    label: 'GuardDuty (export para o S3)',
    description: 'Os achados de ameaça do GuardDuty, pelos arquivos que ele exporta.',
  },
  guardduty: {
    label: 'GuardDuty (API)',
    description: 'Os achados de ameaça do GuardDuty, lidos direto do serviço.',
  },
  security_hub: {
    label: 'Security Hub',
    description: 'Os achados que o Security Hub reúne dos serviços de segurança da conta.',
  },
  inspector: {
    label: 'Inspector',
    description: 'As vulnerabilidades que o Inspector encontra em instâncias, imagens e funções.',
  },
  access_analyzer: {
    label: 'IAM Access Analyzer',
    description: 'Os recursos da conta que estão acessíveis de fora dela.',
  },
  cloudwatch_log_group: {
    label: 'Grupo do CloudWatch Logs',
    description: 'Os eventos de um grupo de logs que você etiquetar.',
  },
  config: {
    label: 'AWS Config',
    description: 'O histórico de configuração dos recursos.',
  },
  elb_logs: {
    label: 'Balanceador (log de acesso)',
    description: 'As requisições que passam pelos balanceadores de carga.',
  },
};

/** O nome da fonte na tela: a linha de um serviço desligado tem o próprio tipo como nome, e mostra só o rótulo dele. */
export function awsSourceName(source: Pick<AwsSource, 'kind' | 'name'>): string {
  return source.name === '' || source.name === source.kind ? '' : source.name;
}

interface SourceStateText {
  label: string;
  tone: Tone;
}

export const AWS_SOURCE_STATE_TEXTS: Readonly<Record<AwsSourceState, SourceStateText>> = {
  available: { label: 'Disponível', tone: 'low' },
  needs_permission: { label: 'Precisa de permissão', tone: 'medium' },
  unavailable: { label: 'Indisponível', tone: 'idle' },
  authorized: { label: 'Aguardando o coletor iniciar', tone: 'progress' },
  configuring: { label: 'Configurando o coletor', tone: 'progress' },
  waiting_events: { label: 'Configurada, ainda sem eventos', tone: 'low' },
  collecting: { label: 'Coletando', tone: 'ok' },
  stalled: { label: 'Parada', tone: 'high' },
  permission_error: { label: 'Erro de permissão', tone: 'critical' },
  ingestion_error: { label: 'Falha de ingestão', tone: 'critical' },
  source_missing: { label: 'Não encontrada na conta', tone: 'high' },
  revoked: { label: 'Autorização retirada', tone: 'idle' },
};

/** Os motivos de estado que o contrato cataloga (`AWS_SOURCE_STATE_CODES`). */
export const AWS_SOURCE_STATE_CODE_TEXTS: Readonly<Record<(typeof AWS_SOURCE_STATE_CODES)[number], string>> =
  {
    awaiting_collector: 'A autorização está gravada, e o coletor ainda não começou a ler.',
    not_collectable_yet: 'O Verax já encontra este tipo de fonte, mas ainda não o coleta.',
    not_found: 'A última descoberta não achou mais esta fonte na conta.',
  };

function isSourceStateCode(code: string): code is (typeof AWS_SOURCE_STATE_CODES)[number] {
  return (AWS_SOURCE_STATE_CODES as readonly string[]).includes(code);
}

export const AWS_SOURCE_AVAILABILITY_TEXTS: Readonly<Record<AwsSourceAvailability, string>> = {
  available: 'Disponível para leitura',
  not_enabled: 'Desligado na conta',
  no_destination: 'Ligado, mas sem log configurado',
  unsupported_destination: 'Grava num destino que o Verax não lê (Firehose)',
  unsupported_format:
    'Grava num formato que o Verax não lê (Parquet, partições do Hive ou campos fora do padrão)',
};

export const AWS_SOURCE_LOGGING_STATE_LABELS: Readonly<Record<AwsSourceLoggingState, string>> = {
  logging: 'gravando',
  stopped: 'parado',
  enabled: 'ligado',
  disabled: 'desligado',
  publishing: 'exportando',
};

/** Por que a permissão falta, numa frase que cabe depois de "porque". O que fazer fica na tela das fontes. */
export const AWS_SOURCE_PERMISSION_CODE_TEXTS: Readonly<Record<AwsSourcePermissionCode, string>> = {
  capability_off: 'a autorização deste tipo de fonte está desligada na pilha',
  tag_missing: 'o grupo não tem a etiqueta verax-control = leitura',
  kms_denied: 'a chave KMS do bucket não decifra os logs para o Verax',
  bucket_denied: 'o bucket não deixa o Verax listar nem ler os arquivos',
  bucket_missing: 'o bucket de destino não existe mais',
  outside_awslogs_prefix: 'os arquivos ficam atrás de um prefixo antes de AWSLogs/',
  probe_failed: 'a AWS não respondeu à conferência da permissão',
};

function isPermissionCode(code: string): code is AwsSourcePermissionCode {
  return (AWS_SOURCE_PERMISSION_CODES as readonly string[]).includes(code);
}

/** O motivo da permissão que falta: um dos códigos do contrato, ou a ação do IAM que a AWS negou. */
export function awsPermissionDetailText(detail: string | null): string {
  if (detail === null) return 'a permissão ainda não foi conferida';
  if (isPermissionCode(detail)) return AWS_SOURCE_PERMISSION_CODE_TEXTS[detail];
  return `a AWS negou a ação ${detail}`;
}

function isAvailability(code: string): code is AwsSourceAvailability {
  return Object.hasOwn(AWS_SOURCE_AVAILABILITY_TEXTS, code);
}

/**
 * A saúde de uma fonte autorizada, como a tabela do acompanhamento a mostra: o selo do estado e, quando há, o motivo.
 * Sem enfeite: a fonte autorizada que o coletor ainda não leu está "aguardando o coletor iniciar", a configurada sem
 * evento diz isso, e a de achados que sincronizou sem nada novo não finge que há eventos.
 */
export function awsSourceHealthText(source: AwsSource): { label: string; tone: Tone; detail: string | null } {
  const base = AWS_SOURCE_STATE_TEXTS[source.state];
  const code = source.stateCode;
  switch (source.state) {
    case 'collecting': {
      const { eventsLast24h, lastEventAt } = source.health;
      const quiet = eventsLast24h === 0 || (eventsLast24h === null && lastEventAt === null);
      return isFindingSource(source) && quiet
        ? { label: 'Sincronizada, sem achados novos', tone: 'ok', detail: null }
        : { ...base, detail: null };
    }
    case 'permission_error':
      return {
        ...base,
        detail: `Falta permissão: ${awsPermissionDetailText(source.permissionDetail ?? code)}.`,
      };
    case 'ingestion_error':
      return { ...base, detail: code === null ? null : `Tipo do erro: ${code}.` };
    case 'stalled':
      return {
        ...base,
        detail: 'Esta fonte entrega eventos o tempo todo, e parou de entregar há mais de 2 horas.',
      };
    case 'source_missing':
      return {
        ...base,
        detail:
          code !== null && isAvailability(code)
            ? `${AWS_SOURCE_AVAILABILITY_TEXTS[code]}. Rode a descoberta de novo depois de corrigir na AWS.`
            : AWS_SOURCE_STATE_CODE_TEXTS.not_found,
      };
    default:
      return {
        ...base,
        detail:
          code !== null && isSourceStateCode(code) && code !== 'awaiting_collector'
            ? AWS_SOURCE_STATE_CODE_TEXTS[code]
            : null,
      };
  }
}

export const AWS_SOURCE_NOTE_TEXTS: Readonly<Record<AwsSourceNote, string>> = {
  aws_cost_guardduty: 'Ligar o GuardDuty tem custo na AWS.',
  aws_cost_security_hub: 'Ligar o Security Hub tem custo na AWS.',
  aws_cost_inspector: 'Ligar o Inspector tem custo na AWS.',
  aws_cost_access_analyzer:
    'Criar um analisador do IAM Access Analyzer pode ter custo na AWS, conforme o tipo.',
  aws_cost_new_trail: 'Criar uma trilha do CloudTrail tem custo na AWS.',
  aws_cost_flow_logs: 'Ligar os VPC Flow Logs tem custo na AWS, pelo volume gravado.',
  aws_cost_waf_logging: 'Ligar o log da Web ACL tem custo na AWS, pelo volume gravado.',
  high_volume: 'Volume alto: pode aumentar o volume mensal do seu plano.',
  tag_required: 'Só é lido com a etiqueta verax-control = leitura no grupo.',
  stack_update_required: 'Precisa da pilha atualizada, com a autorização deste tipo ligada.',
  additional_bucket_required:
    'Há um prefixo antes de AWSLogs/: o bucket precisa entrar em "Avançado: buckets fora do padrão".',
  central_bucket:
    'Trilha de organização: o bucket fica em outra conta, e a política dele precisa citar o papel de leitura.',
  covered_by_api: 'Coberto pela API: os mesmos achados já chegam pela API do GuardDuty.',
  covered_by_legacy: 'Já é lido pelo bucket cadastrado manualmente.',
  recommended: 'Recomendada',
  not_security_events: 'Métricas de desempenho, não eventos de segurança.',
  not_collected_yet: 'Encontrada, ainda não coletada nesta versão.',
};

/** As notas de custo: ligar o serviço é decisão do cliente, e a Verax nunca liga nada. */
export const AWS_COST_NOTES = [
  'aws_cost_guardduty',
  'aws_cost_security_hub',
  'aws_cost_inspector',
  'aws_cost_access_analyzer',
  'aws_cost_new_trail',
  'aws_cost_flow_logs',
  'aws_cost_waf_logging',
] as const satisfies readonly AwsSourceNote[];

export function isAwsCostNote(note: AwsSourceNote): boolean {
  return (AWS_COST_NOTES as readonly AwsSourceNote[]).includes(note);
}

export const AWS_LOG_GROUP_CATEGORY_LABELS: Readonly<Record<AwsLogGroupCategory, string>> = {
  cloudtrail: 'CloudTrail',
  vpc_flow_logs: 'VPC Flow Logs',
  waf: 'WAF',
  route53: 'Route 53',
  rds: 'RDS',
  api_gateway: 'API Gateway',
  lambda: 'Lambda',
  eks: 'EKS',
  amplify: 'Amplify',
  metrics: 'Métricas',
  other: 'Aplicação ou outro',
};

// --- O que o cliente autoriza ---

interface AuthorizationText {
  label: string;
  /** O que permite e o que não permite, num parágrafo. */
  description: string;
}

export const AWS_AUTHORIZATION_TEXTS: Readonly<Record<AwsReaderAuthorization, AuthorizationText>> = {
  'service-logs': {
    label: 'Logs de serviços da AWS no S3',
    description:
      'Permite ler os logs que a própria AWS grava no S3 para esta conta: CloudTrail, VPC Flow Logs, WAF e o export do GuardDuty. O Verax lê o conteúdo só do que está na pasta AWSLogs/<conta>/, em qualquer bucket, e você não informa bucket nenhum. Para achar essa pasta, ele lista os nomes do primeiro nível dos buckets: só os nomes, nunca o conteúdo. Nenhum outro arquivo seu é lido.',
  },
  findings: {
    label: 'Achados de segurança',
    description:
      'Permite ler os achados do GuardDuty, do Security Hub, do Inspector e do IAM Access Analyzer. Não liga nenhum desses serviços (ligar tem custo na AWS, e a decisão é sua) e não altera, arquiva nem apaga achado nenhum.',
  },
  'log-groups': {
    label: 'Grupos do CloudWatch Logs marcados',
    description:
      'Permite ler só os grupos de logs em que você puser a etiqueta verax-control = leitura, um a um. Sem a etiqueta, o Verax vê o nome e o tamanho do grupo, nunca o conteúdo. Logs de aplicação podem conter dados pessoais: por isso a escolha é sua, grupo a grupo.',
  },
};

/** A parte que vale sempre: sem ela não há o que mostrar nesta tela. */
export const AWS_DISCOVERY_AUTHORIZATION_TEXT: AuthorizationText = {
  label: 'Descoberta e postura (sempre ligada)',
  description:
    'Para mostrar aqui as fontes de log que existem na conta e alimentar Ativos e Postura, o Verax vê configuração e nomes. Não lê evento de log, achado, arquivo nem dado de banco.',
};

/** O que vale para as três: nada é criado nem alterado, e como tirar o acesso. */
export const AWS_AUTHORIZATION_FOOTNOTE =
  'Nada é criado nem alterado na sua conta AWS: o Verax só lê. Para tirar o acesso, desligue uma autorização (atualizando a pilha) ou apague a pilha verax-control-reader: vale na hora.';

/** Por que o arquivo preenchido não pôde ser montado, e o que fazer. */
export const AWS_PREFILL_PROBLEM_TEXTS: Readonly<Record<AwsReaderPrefillProblem, string>> = {
  service_account:
    'Este ambiente ainda não informa o ID da conta de serviço dele, que vai na pilha. Peça à Verax antes de criar a pilha.',
  egress_ips:
    'Este ambiente ainda não informa o IP de saída dele, que vai na pilha. Peça à Verax antes de criar a pilha.',
  audience:
    'O audience deste ambiente está fora do formato que a pilha aceita. Peça à Verax antes de criar a pilha.',
  capabilities: 'As autorizações escolhidas não puderam ser gravadas no arquivo. Peça à Verax.',
  buckets:
    'Um dos buckets cadastrados em "Avançado: buckets fora do padrão" está fora do formato. Corrija o nome dele e tente de novo.',
  template: 'O modelo da pilha não pôde ser preenchido. Peça à Verax, ou use a alternativa manual abaixo.',
  too_large:
    'O arquivo preenchido passaria do tamanho que o CloudFormation aceita. Peça à Verax, ou use a alternativa manual abaixo.',
  account: 'O ID desta conta AWS não tem 12 dígitos. Confira o cadastro da conta.',
};

// --- Retrato da infraestrutura ---

export const AWS_INFRASTRUCTURE_LABELS: Readonly<Record<keyof AwsInfrastructureSummary, string>> = {
  instances: 'Instâncias (EC2)',
  publicInstances: 'com IP público',
  securityGroups: 'Grupos de segurança',
  openSecurityGroups: 'abertos para a internet',
  buckets: 'Buckets (S3)',
  publicBuckets: 'públicos',
  iamUsers: 'Usuários IAM',
  rootMfaEnabled: 'MFA do usuário root',
  rdsInstances: 'Bancos do RDS',
  rdsPublic: 'públicos',
  rdsUnencrypted: 'sem cifragem',
  rdsClusters: 'Clusters do RDS',
  loadBalancers: 'Balanceadores de carga',
  internetFacingLoadBalancers: 'voltados para a internet',
  vpcs: 'VPCs',
  webAcls: 'Web ACLs do WAF',
  logGroups: 'Grupos do CloudWatch Logs',
  trails: 'Trilhas do CloudTrail',
};

// --- Recusas da API ---

export const AWS_ONBOARDING_ERROR_TEXTS: Readonly<Record<AwsOnboardingErrorCode, string>> = {
  SOURCE_NOT_AVAILABLE:
    'Uma das fontes escolhidas não está mais disponível na conta. Rode a descoberta de novo e escolha outra vez.',
  SOURCE_NOT_COLLECTABLE: 'Este tipo de fonte ainda não é coletado pelo Verax.',
  SOURCE_PERMISSION_MISSING:
    'O Verax ainda não tem permissão para ler uma das fontes escolhidas. Resolva em "Precisam de permissão adicional" e clique em Verificar de novo.',
  SOURCE_LEGACY:
    'Esta fonte é um bucket cadastrado manualmente: ela muda em "Avançado: buckets fora do padrão", não por aqui.',
  SOURCE_COVERED_BY_LEGACY:
    'O bucket desta fonte já é lido pelo cadastro manual da conta. Autorizar de novo duplicaria a coleta.',
  SOURCE_NOT_AUTHORIZED: 'Esta fonte não está autorizada: a autorização já tinha sido retirada.',
  SENSITIVE_CONFIRMATION_REQUIRED:
    'Os grupos do CloudWatch Logs precisam ser confirmados um a um. Marque a confirmação e autorize de novo.',
  SOURCE_LIMIT_REACHED:
    'Esta conta chegou ao limite de fontes autorizadas (50 grupos do CloudWatch Logs e 200 fontes do S3). Retire a autorização de uma fonte para autorizar outra.',
  ACCOUNT_NOT_CONNECTED:
    'A conta não está conectada agora. Conecte a conta (ou espere a verificação terminar) antes de pedir a descoberta ou conferir uma fonte.',
  DISCOVERY_RATE_LIMITED:
    'A descoberta acabou de rodar. Só é possível pedir outra a cada 5 minutos: tente de novo daqui a pouco.',
  DISCOVERY_UNAVAILABLE: 'A descoberta das fontes ainda não está disponível neste ambiente.',
};

const CONSOLE_MANAGED_TEXT = 'Esta conta foi cadastrada pela Verax: peça a alteração à Verax.';

function isOnboardingErrorCode(code: string): code is AwsOnboardingErrorCode {
  return Object.hasOwn(AWS_ONBOARDING_ERROR_TEXTS, code);
}

/**
 * O que dizer de uma escrita do onboarding que a API recusou: o texto do código (antes do genérico do status, que num
 * 429 diria só "muitas tentativas") ou, sem código conhecido, a mensagem de sempre.
 */
export function awsOnboardingErrorText(error: unknown): string {
  if (error instanceof ApiRequestError && error.code !== undefined) {
    if (isOnboardingErrorCode(error.code)) return AWS_ONBOARDING_ERROR_TEXTS[error.code];
    if (error.code === CONSOLE_MANAGED_CODE) return CONSOLE_MANAGED_TEXT;
  }
  return errorMessage(error);
}

// --- Texto de cada conferência ---

/** O que uma conferência pede a quem administra a conta, quando há o que fazer nesta tela. */
export type AwsCheckAction = 'connect' | 'verify' | 'discover';

/**
 * O que a conferência diz e o que fazer, pela situação e pelo motivo. Os motivos são os códigos da conexão
 * (`AWS_CONNECTION_ERROR_CODES`), os próprios das conferências, os da descoberta, os da permissão de uma fonte e os
 * avisos da coleta; um código sem texto próprio aparece como "tipo do erro", nunca como mensagem da AWS.
 */
export function awsCheckText(check: AwsOnboardingCheck): { text: string; action: AwsCheckAction | null } {
  const { id, status, code } = check;
  const base = CHECK_TEXTS[id][status];
  const unknown = (text: string) => (code === null ? text : `${text} Tipo do erro: ${code}.`);

  if (id === 'assume_role') {
    if (status === 'ok') {
      // Conectada com um aviso: a entrada vale, e o aviso diz o que conferir.
      const warning = isAwsConnectionWarningCode(code) ? awsConnectionErrorHint(code) : null;
      return { text: warning === null ? base : `${base} Aviso: ${warning}`, action: null };
    }
    if (status === 'pending') {
      return { text: code !== null && isCheckCode(code) ? AWS_CHECK_CODE_TEXTS[code] : base, action: null };
    }
    if (status === 'failed') {
      const hint = code === null ? null : awsConnectionErrorHint(code);
      return {
        text: hint ?? unknown(base),
        action: code === 'authorization_timeout' ? 'connect' : 'verify',
      };
    }
    return { text: base, action: null };
  }

  if (id === 'identity') {
    if (status !== 'failed') return { text: base, action: null };
    return { text: (code === null ? null : awsConnectionErrorHint(code)) ?? unknown(base), action: 'verify' };
  }

  if (id === 'template') {
    if (status !== 'failed') return { text: base, action: null };
    return {
      text: code !== null && isCheckCode(code) ? AWS_CHECK_CODE_TEXTS[code] : unknown(base),
      action: null,
    };
  }

  if (id === 'discovery') {
    if (status === 'ok') {
      return code === 'partial'
        ? {
            text: 'A descoberta terminou sem conseguir ler tudo. O que ficou de fora está em "O que encontramos".',
            action: 'discover',
          }
        : { text: base, action: null };
    }
    if (status === 'pending') {
      if (code === 'pending')
        return { text: 'A descoberta está na fila: começa em instantes.', action: null };
      if (code === 'running') return { text: 'A descoberta está em andamento.', action: null };
      return { text: base, action: code === 'not_requested' ? 'discover' : null };
    }
    if (status === 'failed') {
      return {
        text:
          code === null
            ? base
            : `A descoberta não conseguiu ler a conta: ${awsDiscoveryErrorHint(code)}. Rode a descoberta de novo.`,
        action: 'discover',
      };
    }
    return { text: base, action: null };
  }

  if (id === 'permission') {
    if (status !== 'failed') return { text: base, action: null };
    // O motivo é o da fonte (ou o do bucket cadastrado manualmente, que usa os mesmos códigos de bucket).
    return {
      text: `Uma fonte autorizada não pode ser lida: ${awsPermissionDetailText(code)}. O que fazer está na linha dela, em "Fontes autorizadas".`,
      action: null,
    };
  }

  if (id === 'collector_config') {
    if (status === 'pending') {
      return { text: code !== null && isCheckCode(code) ? AWS_CHECK_CODE_TEXTS[code] : base, action: null };
    }
    if (status !== 'failed') return { text: base, action: null };
    return { text: awsCollectionErrorHint(code) ?? unknown(base), action: null };
  }

  if (id === 'events') {
    if (status === 'pending') {
      if (code === 'waiting_events') {
        return { text: 'As fontes estão configuradas, e ainda não chegou evento de todas.', action: null };
      }
      return { text: code !== null && isCheckCode(code) ? AWS_CHECK_CODE_TEXTS[code] : base, action: null };
    }
    if (status !== 'failed') return { text: base, action: null };
    if (code === 'stalled') {
      return {
        text: 'Uma fonte que entrega eventos o tempo todo parou de entregar. Veja qual em "Fontes autorizadas".',
        action: null,
      };
    }
    return {
      text:
        code === null || code === 'ingestion_error'
          ? `${base} Veja qual em "Fontes autorizadas".`
          : `${base} Veja qual em "Fontes autorizadas". Tipo do erro: ${code}.`,
      action: null,
    };
  }

  if (id === 'lag' && status === 'failed') {
    return {
      text: 'Uma fonte autorizada está com mais de 2 horas de atraso. Veja qual em "Fontes autorizadas".',
      action: null,
    };
  }

  // `last_sync` e o restante de `lag`: sem motivo que mude o texto.
  if (status === 'pending' && code !== null && isCheckCode(code) && code !== 'no_data') {
    return { text: AWS_CHECK_CODE_TEXTS[code], action: null };
  }
  return { text: status === 'failed' ? unknown(base) : base, action: null };
}

// --- Regiões do cadastro ---

/** As regiões comerciais da AWS, para o seletor do cadastro (a principal da conta). */
export const AWS_REGION_OPTIONS: readonly { value: string; label: string }[] = [
  ['sa-east-1', 'América do Sul (São Paulo)'],
  ['us-east-1', 'Leste dos EUA (Norte da Virgínia)'],
  ['us-east-2', 'Leste dos EUA (Ohio)'],
  ['us-west-1', 'Oeste dos EUA (Norte da Califórnia)'],
  ['us-west-2', 'Oeste dos EUA (Oregon)'],
  ['ca-central-1', 'Canadá (Central)'],
  ['ca-west-1', 'Canadá (Calgary)'],
  ['mx-central-1', 'México (Central)'],
  ['eu-west-1', 'Europa (Irlanda)'],
  ['eu-west-2', 'Europa (Londres)'],
  ['eu-west-3', 'Europa (Paris)'],
  ['eu-central-1', 'Europa (Frankfurt)'],
  ['eu-central-2', 'Europa (Zurique)'],
  ['eu-north-1', 'Europa (Estocolmo)'],
  ['eu-south-1', 'Europa (Milão)'],
  ['eu-south-2', 'Europa (Espanha)'],
  ['af-south-1', 'África (Cidade do Cabo)'],
  ['me-south-1', 'Oriente Médio (Bahrein)'],
  ['me-central-1', 'Oriente Médio (Emirados Árabes)'],
  ['il-central-1', 'Israel (Tel Aviv)'],
  ['ap-south-1', 'Ásia-Pacífico (Mumbai)'],
  ['ap-south-2', 'Ásia-Pacífico (Hyderabad)'],
  ['ap-southeast-1', 'Ásia-Pacífico (Singapura)'],
  ['ap-southeast-2', 'Ásia-Pacífico (Sydney)'],
  ['ap-southeast-3', 'Ásia-Pacífico (Jacarta)'],
  ['ap-southeast-4', 'Ásia-Pacífico (Melbourne)'],
  ['ap-southeast-5', 'Ásia-Pacífico (Malásia)'],
  ['ap-southeast-7', 'Ásia-Pacífico (Tailândia)'],
  ['ap-northeast-1', 'Ásia-Pacífico (Tóquio)'],
  ['ap-northeast-2', 'Ásia-Pacífico (Seul)'],
  ['ap-northeast-3', 'Ásia-Pacífico (Osaka)'],
  ['ap-east-1', 'Ásia-Pacífico (Hong Kong)'],
  ['ap-east-2', 'Ásia-Pacífico (Taipei)'],
].map(([value = '', name = '']) => ({ value, label: `${value} · ${name}` }));

export const AWS_DEFAULT_REGION = 'sa-east-1';

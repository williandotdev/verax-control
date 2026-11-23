import {
  AWS_AUTHORIZATION_TIMEOUT_CODE,
  AWS_BUCKET_ERROR_CODES,
  AWS_CONNECT_WINDOW_MS,
  type AwsDiscoveryStatus,
  type AwsOnboardingCheck,
  type AwsOnboardingCheckId,
  type AwsOnboardingCheckStatus,
  type AwsOnboardingState,
  type AwsSourcePermission,
  type AwsSourceState,
  type CloudAccountConnection,
  isAwsTemplateOutdated,
  parseAwsConnectionError,
} from '@verax/shared';

/**
 * O estado da conexão de uma conta AWS e as conferências dela (onboarding self-service), derivados do que está gravado:
 * a conta (a conexão que a tarefa `aws-check` grava, o pedido pendente, as tags do papel), a descoberta mais recente e
 * as fontes. Função pura, sem banco: a API a chama a cada leitura, e nada disto é guardado.
 *
 * A regra de ouro: nunca um "tudo certo" com um passo essencial pendente. A conta só está `collecting` quando toda
 * fonte autorizada está coletando; com o coletor de uma fonte ainda sem ler, ela está `configuring`.
 *
 * A ordem das regras do estado (a primeira que vale ganha):
 * 1. conta desativada: `not_started`;
 * 2. o erro gravado é o fim da janela do "Conectar": `authorization_timeout`;
 * 3. há um pedido de verificação pendente: `awaiting_authorization`;
 * 4. a conexão está em "aguardando" sem pedido (nunca pedida, ou recomeçada): `not_started`;
 * 5. a conexão está com erro que não é de bucket (a entrada recusada, a conta errada, o nó sem conferir): `disconnected`;
 * 6. nenhuma descoberta entrou na conta ainda: `discovering` com uma pendente ou em curso, senão `authenticated`;
 * 7. nenhuma fonte com a autorização valendo: `awaiting_sources`;
 * 8. um bucket cadastrado negado, ou uma fonte autorizada sem permissão: `permission_error`;
 * 9. o aviso da coleta do nó, ou uma fonte autorizada com erro de ingestão: `ingestion_failure`;
 * 10. nenhuma fonte coletando: `configuring` se alguma ainda espera o coletor ou os eventos, senão `ingestion_failure`
 *     (todas paradas ou sumidas);
 * 11. todas coletando: `collecting`; só parte: `partial`.
 */

/** O que a derivação lê da conta. */
export interface OnboardingAccountFacts {
  status: 'active' | 'inactive';
  connection: CloudAccountConnection;
  connectionError: string | null;
  collectionError: string | null;
  checkRequestedAt: Date | null;
  awsConnectRequestedAt: Date | null;
  awsTemplateVersion: number | null;
  awsCapabilitiesCheckedAt: Date | null;
}

/** O que a derivação lê de uma execução da descoberta. */
export interface OnboardingRunFacts {
  status: AwsDiscoveryStatus;
  finishedAt: Date | null;
  /** O código do primeiro erro registrado (o motivo de uma execução que falhou). */
  firstErrorCode: string | null;
}

/** O que a derivação lê de uma fonte. */
export interface OnboardingSourceFacts {
  state: AwsSourceState;
  stateCode: string | null;
  permission: AwsSourcePermission;
  permissionDetail: string | null;
  authorizedAt: Date | null;
  revokedAt: Date | null;
  lastSyncAt: Date | null;
  lagSeconds: number | null;
}

export interface OnboardingFacts {
  account: OnboardingAccountFacts;
  /** A execução mais recente (qualquer estado); null sem nenhuma. */
  latestRun: OnboardingRunFacts | null;
  /** Quando terminou a última execução que entrou na conta (completa ou parcial); null sem nenhuma. */
  lastCompletedAt: Date | null;
  sources: readonly OnboardingSourceFacts[];
}

export interface OnboardingDerived {
  state: AwsOnboardingState;
  checks: AwsOnboardingCheck[];
  /** Até quando o nó espera o papel, dentro da janela do "Conectar"; null fora dela. */
  waitingUntil: Date | null;
}

/** O atraso a partir do qual a coleta conta como atrasada: 2 h (o limiar das fontes contínuas). */
export const AWS_LAG_LIMIT_SECONDS = 2 * 60 * 60;

const BUCKET_ERRORS: readonly string[] = AWS_BUCKET_ERROR_CODES;

/** O erro da conexão é de um bucket cadastrado? Aí o nó entrou no papel: o problema é a permissão de leitura. */
function isBucketError(connectionError: string | null): boolean {
  if (connectionError === null) return false;
  const parsed = parseAwsConnectionError(connectionError);
  return parsed !== null && BUCKET_ERRORS.includes(parsed.code);
}

/** O código do erro, sem a fonte do bucket (`bucket_denied:waf` vira `bucket_denied`). */
function errorCode(connectionError: string | null): string | null {
  if (connectionError === null) return null;
  return connectionError.split(':', 1)[0] ?? null;
}

/** A fonte com a autorização valendo, em qualquer estado (inclusive a que sumiu). */
function isAuthorized(source: OnboardingSourceFacts): boolean {
  return source.authorizedAt !== null && source.revokedAt === null;
}

const PENDING_STATES: readonly AwsSourceState[] = ['authorized', 'configuring', 'waiting_events'];
const AWAITING_COLLECTOR_STATES: readonly AwsSourceState[] = ['authorized', 'configuring'];

function check(
  id: AwsOnboardingCheckId,
  status: AwsOnboardingCheckStatus,
  code: string | null = null,
  checkedAt: Date | null = null,
): AwsOnboardingCheck {
  return { id, status, code, checkedAt: checkedAt?.toISOString() ?? null };
}

/** O pedido pendente é o do "Conectar" (o mesmo horário nos dois campos)? */
function isConnectRequest(account: OnboardingAccountFacts): boolean {
  return (
    account.checkRequestedAt !== null &&
    account.awsConnectRequestedAt !== null &&
    account.checkRequestedAt.getTime() === account.awsConnectRequestedAt.getTime()
  );
}

export function deriveAwsOnboarding(facts: OnboardingFacts): OnboardingDerived {
  const { account, latestRun, sources } = facts;
  const active = account.status === 'active';
  const pending = active && account.checkRequestedAt !== null;
  const timedOut =
    account.connection === 'error' && account.connectionError === AWS_AUTHORIZATION_TIMEOUT_CODE;
  const bucketError = account.connection === 'error' && isBucketError(account.connectionError);
  /** O nó entrou no papel na última conferência (conectada, ou com erro só num bucket). */
  const entered = active && !pending && (account.connection === 'connected' || bucketError);
  const refused = active && !pending && account.connection === 'error' && !bucketError;
  const connectionCode = errorCode(account.connectionError);
  const authorized = sources.filter(isAuthorized);

  // --- As conferências ---
  const assumeRole = pending
    ? check('assume_role', 'pending', isConnectRequest(account) ? 'awaiting_stack' : 'verifying')
    : refused
      ? check('assume_role', 'failed', connectionCode)
      : entered
        ? // Conectada com um aviso (o STS da região desligado, por exemplo): a entrada no papel vale, com o código.
          check(
            'assume_role',
            'ok',
            account.connection === 'connected' ? connectionCode : null,
            account.awsCapabilitiesCheckedAt,
          )
        : check('assume_role', 'pending', 'not_requested');

  const identity = pending
    ? check('identity', 'pending')
    : entered
      ? check('identity', 'ok', null, account.awsCapabilitiesCheckedAt)
      : refused && connectionCode === 'account_mismatch'
        ? check('identity', 'failed', 'account_mismatch')
        : check('identity', 'skipped');

  // As tags do papel ou, na VM própria do cliente, do usuário IAM de leitura: a mesma regra.
  const template = !entered
    ? check('template', 'skipped')
    : account.awsCapabilitiesCheckedAt === null
      ? check('template', 'pending')
      : isAwsTemplateOutdated(account.awsTemplateVersion)
        ? check('template', 'failed', 'template_outdated', account.awsCapabilitiesCheckedAt)
        : check('template', 'ok', null, account.awsCapabilitiesCheckedAt);

  const discovery = !entered
    ? check('discovery', 'skipped')
    : latestRun === null
      ? check('discovery', 'pending', 'not_requested')
      : latestRun.status === 'pending' || latestRun.status === 'running'
        ? check('discovery', 'pending', latestRun.status)
        : latestRun.status === 'failed'
          ? check('discovery', 'failed', latestRun.firstErrorCode, latestRun.finishedAt)
          : check('discovery', 'ok', latestRun.status === 'partial' ? 'partial' : null, latestRun.finishedAt);

  const checks: AwsOnboardingCheck[] = [assumeRole, identity, template, discovery];
  if (authorized.length === 0) {
    checks.push(
      // Um bucket cadastrado negado é falta de permissão mesmo sem a fonte dele na lista.
      bucketError ? check('permission', 'failed', connectionCode) : check('permission', 'skipped'),
      check('collector_config', 'skipped'),
      check('events', 'skipped'),
      check('last_sync', 'skipped'),
      check('lag', 'skipped'),
    );
  } else {
    const denied = authorized.find(
      (source) => source.state === 'permission_error' || source.permission === 'missing',
    );
    const unknown = authorized.some((source) => source.permission === 'unknown');
    checks.push(
      bucketError
        ? check('permission', 'failed', connectionCode)
        : denied !== undefined
          ? check('permission', 'failed', denied.permissionDetail ?? denied.stateCode)
          : unknown
            ? check('permission', 'pending')
            : check('permission', 'ok'),
    );
    const awaitingCollector = authorized.some((source) => AWAITING_COLLECTOR_STATES.includes(source.state));
    checks.push(
      account.collectionError !== null
        ? check('collector_config', 'failed', account.collectionError)
        : awaitingCollector
          ? check('collector_config', 'pending', 'awaiting_collector')
          : check('collector_config', 'ok'),
    );
    const failing = authorized.find(
      (source) => source.state === 'ingestion_error' || source.state === 'stalled',
    );
    const allCollecting = authorized.every((source) => source.state === 'collecting');
    checks.push(
      failing !== undefined
        ? check('events', 'failed', failing.stateCode ?? failing.state)
        : allCollecting
          ? check('events', 'ok')
          : check('events', 'pending', awaitingCollector ? 'awaiting_collector' : 'waiting_events'),
    );
    const synced = authorized.map((source) => source.lastSyncAt);
    const oldest = synced.every((at) => at !== null)
      ? synced.reduce<Date | null>((min, at) => (min === null || at < min ? at : min), null)
      : null;
    checks.push(
      oldest !== null ? check('last_sync', 'ok', null, oldest) : check('last_sync', 'pending', 'no_data'),
    );
    const lags = authorized.flatMap((source) => (source.lagSeconds === null ? [] : [source.lagSeconds]));
    const stalled = authorized.some((source) => source.state === 'stalled');
    checks.push(
      stalled || lags.some((lag) => lag > AWS_LAG_LIMIT_SECONDS)
        ? check('lag', 'failed', 'stalled')
        : lags.length === authorized.length
          ? check('lag', 'ok')
          : check('lag', 'pending', 'no_data'),
    );
  }

  // --- O estado ---
  const waitingUntil =
    pending && isConnectRequest(account) && account.checkRequestedAt !== null
      ? new Date(account.checkRequestedAt.getTime() + AWS_CONNECT_WINDOW_MS)
      : null;
  const state = ((): AwsOnboardingState => {
    if (!active) return 'not_started';
    if (timedOut && !pending) return 'authorization_timeout';
    if (pending) return 'awaiting_authorization';
    if (account.connection === 'waiting') return 'not_started';
    if (refused) return 'disconnected';
    if (facts.lastCompletedAt === null) {
      return latestRun !== null && (latestRun.status === 'pending' || latestRun.status === 'running')
        ? 'discovering'
        : 'authenticated';
    }
    if (authorized.length === 0) return 'awaiting_sources';
    if (
      bucketError ||
      authorized.some((source) => source.state === 'permission_error' || source.permission === 'missing')
    ) {
      return 'permission_error';
    }
    if (account.collectionError !== null || authorized.some((source) => source.state === 'ingestion_error')) {
      return 'ingestion_failure';
    }
    const collecting = authorized.filter((source) => source.state === 'collecting').length;
    if (collecting === 0) {
      return authorized.some((source) => PENDING_STATES.includes(source.state))
        ? 'configuring'
        : 'ingestion_failure';
    }
    return collecting === authorized.length ? 'collecting' : 'partial';
  })();

  return { state, checks, waitingUntil };
}

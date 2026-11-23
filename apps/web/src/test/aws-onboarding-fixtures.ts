import {
  AWS_ONBOARDING_CHECK_IDS,
  AWS_READER_AUDIENCE,
  AWS_READER_CAPABILITIES,
  AWS_SOURCE_KIND_INFO,
  type AwsDiscoveryRun,
  type AwsInfrastructureSummary,
  type AwsOnboarding,
  type AwsOnboardingCheck,
  type AwsOnboardingCheckId,
  awsOnboardingSchema,
  type AwsOnboardingState,
  awsReaderRoleArn,
  type AwsSource,
  awsSourceIdleState,
  type AwsSourceKind,
  type CloudAccount,
  cloudAccountSchema,
} from '@verax/shared';

/**
 * Respostas do onboarding da AWS montadas à mão para os testes do painel: cada teste diz só o que importa para ele
 * (o estado, uma conferência, uma fonte), e o resto sai com um padrão coerente. Tudo passa pelo schema do contrato:
 * uma resposta que a API não daria quebra o teste aqui, não na tela. Dados fictícios.
 */

/** O "agora" das respostas: o do relógio, para os textos relativos ("há 30 minutos") saírem certos na tela. */
const NOW = Date.now();
export const FIXTURE_NOW = new Date(NOW).toISOString();
const ago = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();

let sequence = 0;
/** Um ID fictício, no formato de UUID. */
export function fixtureId(): string {
  sequence += 1;
  return `018f2c1e-0000-7000-8000-00e5${sequence.toString(16).padStart(8, '0')}`;
}

const NO_HEALTH: AwsSource['health'] = {
  lastSyncAt: null,
  lastEventAt: null,
  lastIngestedAt: null,
  lagSeconds: null,
  eventsLast24h: null,
  bytesLast24h: null,
};

/** Uma fonte descoberta, disponível e com a permissão conferida; o teste muda o que quiser. */
export function sourceFixture(kind: AwsSourceKind, overrides: Partial<AwsSource> = {}): AwsSource {
  const info = AWS_SOURCE_KIND_INFO[kind];
  const availability = overrides.availability ?? 'available';
  const permission = overrides.permission ?? (availability === 'available' ? 'granted' : 'unknown');
  const idle = awsSourceIdleState(kind, availability, permission);
  return {
    id: fixtureId(),
    kind,
    region: 'sa-east-1',
    resourceId: `recurso-${sequence}`,
    name: `fonte-${kind}`,
    method: info.method,
    origin: 'discovered',
    collectable: info.collectable,
    sensitive: info.sensitive,
    availability,
    loggingState: null,
    permission,
    permissionDetail: null,
    permissionCheckedAt: permission === 'unknown' ? null : ago(30),
    probeRequestedAt: null,
    notes: [],
    details: {},
    state: idle.state,
    stateCode: idle.stateCode,
    stateSince: ago(30),
    authorization: { authorizedAt: null, authorizedBy: null, revokedAt: null },
    collectFrom: null,
    firstSeenAt: ago(600),
    lastSeenAt: ago(30),
    missingSince: null,
    health: { ...NO_HEALTH },
    ...overrides,
  };
}

/** Uma fonte com a autorização valendo, no estado dado. */
export function authorizedSourceFixture(
  kind: AwsSourceKind,
  state: AwsSource['state'],
  overrides: Partial<AwsSource> = {},
): AwsSource {
  return sourceFixture(kind, {
    state,
    stateCode: state === 'authorized' ? 'awaiting_collector' : null,
    authorization: { authorizedAt: ago(3 * 24 * 60), authorizedBy: 'demo-marina.alves', revokedAt: null },
    collectFrom: '2026-11-20',
    ...overrides,
  });
}

/** A linha de um bucket cadastrado manualmente (`origin = legacy`). */
export function legacySourceFixture(bucket: string, overrides: Partial<AwsSource> = {}): AwsSource {
  return authorizedSourceFixture('cloudtrail', 'collecting', {
    origin: 'legacy',
    region: 'global',
    resourceId: 'legacy',
    name: bucket,
    details: { bucket, legacySource: 'cloudtrail' },
    ...overrides,
  });
}

/** As nove conferências, todas "não se aplica", com as que o teste informar por cima. */
export function checksFixture(
  overrides: Partial<Record<AwsOnboardingCheckId, Partial<Omit<AwsOnboardingCheck, 'id'>>>> = {},
): AwsOnboardingCheck[] {
  return AWS_ONBOARDING_CHECK_IDS.map((id) => ({
    id,
    status: 'skipped',
    code: null,
    checkedAt: null,
    ...overrides[id],
  }));
}

export function runFixture(overrides: Partial<AwsDiscoveryRun> = {}): AwsDiscoveryRun {
  return {
    id: fixtureId(),
    trigger: 'connect',
    status: 'succeeded',
    requestedAt: ago(32),
    startedAt: ago(31),
    finishedAt: ago(30),
    regions: ['sa-east-1', 'us-east-1'],
    errors: [],
    requestedBy: null,
    ...overrides,
  };
}

export const INFRASTRUCTURE_FIXTURE: AwsInfrastructureSummary = {
  instances: 14,
  publicInstances: 3,
  securityGroups: 31,
  openSecurityGroups: 2,
  buckets: 18,
  publicBuckets: 1,
  iamUsers: 9,
  rootMfaEnabled: true,
  rdsInstances: 3,
  rdsPublic: 0,
  rdsUnencrypted: 1,
  rdsClusters: 1,
  loadBalancers: 2,
  internetFacingLoadBalancers: 1,
  vpcs: 3,
  webAcls: 3,
  logGroups: 120,
  trails: 2,
};

/** As conferências de uma conta que entrou no papel, com o modelo atual e a descoberta completa. */
const CONNECTED_CHECKS = {
  assume_role: { status: 'ok', checkedAt: ago(10) },
  identity: { status: 'ok', checkedAt: ago(10) },
  template: { status: 'ok', checkedAt: ago(10) },
  discovery: { status: 'ok', checkedAt: ago(30) },
} as const;

const OUTSIDE: readonly AwsOnboardingState[] = [
  'not_started',
  'awaiting_authorization',
  'authorization_timeout',
  'disconnected',
];

/**
 * A resposta do `GET …/aws/onboarding` para um estado. Fora da conta (antes de conectar, esperando, recusada), nada
 * foi lido; dentro, o modelo é o atual com as três autorizações e a descoberta terminou. O teste passa por cima o que
 * quiser (as conferências, as fontes, o modelo).
 */
export function onboardingFixture(
  cloudAccountId: string,
  state: AwsOnboardingState,
  overrides: Partial<AwsOnboarding> = {},
): AwsOnboarding {
  const outside = OUTSIDE.includes(state);
  const discovered = !outside && state !== 'authenticated' && state !== 'discovering';
  return awsOnboardingSchema.parse({
    cloudAccountId,
    state,
    credentialMode: 'role',
    connect: { requestedAt: null, waitingUntil: null, capabilities: null },
    checks: outside
      ? checksFixture({ assume_role: { status: 'pending', code: 'not_requested' } })
      : checksFixture(CONNECTED_CHECKS),
    template: outside
      ? { version: null, capabilities: [], outdated: false, checkedAt: null }
      : { version: 2, capabilities: [...AWS_READER_CAPABILITIES], outdated: false, checkedAt: ago(10) },
    discovery: discovered
      ? { run: runFixture(), lastCompletedAt: ago(30), regions: ['sa-east-1', 'us-east-1'] }
      : { run: null, lastCompletedAt: null, regions: [] },
    discoveryAvailable: true,
    infrastructure: discovered ? INFRASTRUCTURE_FIXTURE : null,
    sources: [],
    updatedAt: FIXTURE_NOW,
    ...overrides,
  });
}

/** O ID do cadastro da conta AWS dos testes (não o da AWS). */
export const FIXTURE_ACCOUNT_ID = '018f2c1e-0000-7000-8000-0000000c0aaa';

/** Uma conta AWS cadastrada pelo painel, ativa e ainda sem conexão, com os valores do nó; o teste muda o que quiser. */
export function awsAccountFixture(overrides: Partial<CloudAccount> = {}): CloudAccount {
  return cloudAccountSchema.parse({
    id: FIXTURE_ACCOUNT_ID,
    provider: 'aws',
    accountId: '111111111111',
    regions: ['sa-east-1'],
    readerRoleArn: awsReaderRoleArn('111111111111'),
    nodeServiceAccountId: '123456789012345678901',
    webIdentityAudience: AWS_READER_AUDIENCE,
    buckets: { cloudtrail: null, guardduty: null, waf: null },
    pubsubSubscription: null,
    sinkTopic: null,
    sinkWriterIdentity: null,
    zones: [],
    keyStatus: null,
    egressIps: ['203.0.113.10/32'],
    status: 'active',
    connection: 'waiting',
    connectionError: null,
    checkRequestedAt: null,
    ingestFrom: null,
    lastCollectedAt: null,
    lastEventAt: null,
    managedBy: 'panel',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });
}

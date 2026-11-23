import {
  AWS_ONBOARDING_CHECK_IDS,
  AWS_ONBOARDING_SOURCE_CHECK_IDS,
  AWS_ONBOARDING_STATES,
  awsOnboardingCheckSchema,
  type AwsOnboardingCheckId,
  type AwsOnboardingState,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { entersRole } from './account-access.js';
import {
  AWS_LAG_LIMIT_SECONDS,
  deriveAwsOnboarding,
  type OnboardingAccountFacts,
  type OnboardingFacts,
  type OnboardingRunFacts,
  type OnboardingSourceFacts,
} from './onboarding-state.js';
import { legacyPermission } from './onboarding-view.js';

const T0 = new Date('2026-11-22T12:00:00.000Z');
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function account(overrides: Partial<OnboardingAccountFacts> = {}): OnboardingAccountFacts {
  return {
    status: 'active',
    connection: 'connected',
    connectionError: null,
    collectionError: null,
    checkRequestedAt: null,
    awsConnectRequestedAt: T0,
    awsTemplateVersion: 2,
    awsCapabilitiesCheckedAt: later(1),
    ...overrides,
  };
}

/** Um ID de fonte por número, no formato do contrato (os testes que citam fontes escolhem o número). */
const sourceId = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
let nextSource = 1000;

function source(overrides: Partial<OnboardingSourceFacts> = {}): OnboardingSourceFacts {
  nextSource += 1;
  return {
    id: sourceId(nextSource),
    state: 'available',
    stateCode: null,
    permission: 'granted',
    permissionDetail: null,
    authorizedAt: null,
    revokedAt: null,
    lastSyncAt: null,
    lagSeconds: null,
    ...overrides,
  };
}

const authorized = (overrides: Partial<OnboardingSourceFacts> = {}) =>
  source({ state: 'authorized', stateCode: 'awaiting_collector', authorizedAt: later(5), ...overrides });
const collecting = (overrides: Partial<OnboardingSourceFacts> = {}) =>
  authorized({ state: 'collecting', stateCode: null, lastSyncAt: later(30), lagSeconds: 120, ...overrides });

const RUN_OK: OnboardingRunFacts = { status: 'succeeded', finishedAt: later(3), firstErrorCode: null };

function facts(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    account: account(),
    latestRun: RUN_OK,
    lastCompletedAt: later(3),
    sources: [],
    ...overrides,
  };
}

const statusOf = (derived: ReturnType<typeof deriveAwsOnboarding>) =>
  Object.fromEntries(derived.checks.map((check) => [check.id, check.status])) as Record<
    AwsOnboardingCheckId,
    string
  >;
const codeOf = (derived: ReturnType<typeof deriveAwsOnboarding>, id: AwsOnboardingCheckId) =>
  derived.checks.find((check) => check.id === id)?.code ?? null;
/** As fontes que cada conferência cita (só as que citam alguma). */
const sourcesOf = (derived: ReturnType<typeof deriveAwsOnboarding>) =>
  Object.fromEntries(
    derived.checks.flatMap((check) => (check.sourceIds === undefined ? [] : [[check.id, check.sourceIds]])),
  ) as Partial<Record<AwsOnboardingCheckId, string[]>>;

describe('estado da conexão da conta AWS: a tabela das regras', () => {
  const cases: [string, Partial<OnboardingFacts>, AwsOnboardingState][] = [
    [
      'ninguém pediu a conexão',
      {
        account: account({
          connection: 'waiting',
          awsConnectRequestedAt: null,
          awsCapabilitiesCheckedAt: null,
        }),
        latestRun: null,
        lastCompletedAt: null,
      },
      'not_started',
    ],
    [
      'conta desativada, mesmo com tudo coletando',
      { account: account({ status: 'inactive' }), sources: [collecting()] },
      'not_started',
    ],
    [
      'a conexão recomeçou (outra lista de buckets): aguardando, sem pedido',
      { account: account({ connection: 'waiting' }), sources: [collecting()] },
      'not_started',
    ],
    [
      '"Conectar" pedido, esperando o papel',
      {
        account: account({ connection: 'waiting', checkRequestedAt: T0, awsCapabilitiesCheckedAt: null }),
        latestRun: null,
        lastCompletedAt: null,
      },
      'awaiting_authorization',
    ],
    [
      '"Verificar" pendente numa conta que já coletava: não mostra sucesso enquanto confere',
      { account: account({ connection: 'waiting', checkRequestedAt: later(60) }), sources: [collecting()] },
      'awaiting_authorization',
    ],
    [
      'a janela do "Conectar" fechou sem o papel',
      {
        account: account({ connection: 'error', connectionError: 'authorization_timeout' }),
        latestRun: null,
        lastCompletedAt: null,
      },
      'authorization_timeout',
    ],
    [
      'tentar de novo depois do tempo esgotado: volta a esperar o papel',
      {
        account: account({
          connection: 'waiting',
          connectionError: null,
          checkRequestedAt: later(90),
          awsConnectRequestedAt: later(90),
        }),
        latestRun: null,
        lastCompletedAt: null,
      },
      'awaiting_authorization',
    ],
    [
      'a AWS recusa a entrada (o papel foi removido) numa conta que coletava',
      { account: account({ connection: 'error', connectionError: 'trust_denied' }), sources: [collecting()] },
      'disconnected',
    ],
    [
      'a sessão é de outra conta',
      { account: account({ connection: 'error', connectionError: 'account_mismatch' }) },
      'disconnected',
    ],
    [
      'o nó não confere a conexão',
      {
        account: account({ connection: 'error', connectionError: 'check_unavailable' }),
        latestRun: null,
        lastCompletedAt: null,
      },
      'disconnected',
    ],
    [
      'entrou no papel, nenhuma descoberta pedida',
      { latestRun: null, lastCompletedAt: null },
      'authenticated',
    ],
    [
      'a primeira descoberta está pendente',
      { latestRun: { status: 'pending', finishedAt: null, firstErrorCode: null }, lastCompletedAt: null },
      'discovering',
    ],
    [
      'a primeira descoberta está em curso',
      { latestRun: { status: 'running', finishedAt: null, firstErrorCode: null }, lastCompletedAt: null },
      'discovering',
    ],
    [
      'a primeira descoberta falhou inteira: autenticada, com a descoberta por refazer',
      {
        latestRun: { status: 'failed', finishedAt: later(3), firstErrorCode: 'discovery_refused' },
        lastCompletedAt: null,
      },
      'authenticated',
    ],
    [
      'a descoberta terminou e nada está autorizado',
      { sources: [source(), source({ state: 'needs_permission' })] },
      'awaiting_sources',
    ],
    [
      'a descoberta parcial também libera a escolha das fontes',
      {
        latestRun: { status: 'partial', finishedAt: later(3), firstErrorCode: 'AccessDenied' },
        sources: [source()],
      },
      'awaiting_sources',
    ],
    [
      'só fonte revogada: como nenhuma autorizada',
      { sources: [source({ state: 'revoked', authorizedAt: later(5), revokedAt: later(9) })] },
      'awaiting_sources',
    ],
    ['fonte autorizada, o coletor ainda não leu', { sources: [authorized(), source()] }, 'configuring'],
    [
      'fonte configurada, esperando o primeiro evento',
      { sources: [authorized({ state: 'waiting_events', stateCode: null })] },
      'configuring',
    ],
    ['toda fonte autorizada coletando', { sources: [collecting(), collecting(), source()] }, 'collecting'],
    ['parte coletando, parte esperando o coletor', { sources: [collecting(), authorized()] }, 'partial'],
    ['parte coletando, uma parada', { sources: [collecting(), collecting({ state: 'stalled' })] }, 'partial'],
    [
      'parte coletando, uma sumiu',
      { sources: [collecting(), authorized({ state: 'source_missing', stateCode: 'not_found' })] },
      'partial',
    ],
    [
      'uma fonte autorizada sem permissão vale mais que as que coletam',
      {
        sources: [
          collecting(),
          authorized({ state: 'permission_error', permission: 'missing', permissionDetail: 'kms_denied' }),
        ],
      },
      'permission_error',
    ],
    [
      'um bucket cadastrado negado: o nó entrou no papel, e o problema é a permissão',
      {
        account: account({ connection: 'error', connectionError: 'bucket_denied:cloudtrail' }),
        sources: [authorized()],
      },
      'permission_error',
    ],
    [
      'uma fonte com erro de ingestão',
      { sources: [collecting(), authorized({ state: 'ingestion_error', stateCode: 'parse_failed' })] },
      'ingestion_failure',
    ],
    [
      'o nó não aplica a configuração da coleta',
      { account: account({ collectionError: 'wazuh_apply_failed' }), sources: [collecting()] },
      'ingestion_failure',
    ],
    [
      'nenhuma coletando e nenhuma esperando: todas paradas ou sumidas',
      {
        sources: [
          authorized({ state: 'stalled', stateCode: null }),
          authorized({ state: 'source_missing', stateCode: 'not_found' }),
        ],
      },
      'ingestion_failure',
    ],
    [
      'a falta de permissão vale mais que a falha de ingestão',
      {
        account: account({ collectionError: 'aws_token_stale' }),
        sources: [
          authorized({ state: 'permission_error', permission: 'missing', permissionDetail: 'tag_missing' }),
        ],
      },
      'permission_error',
    ],
    [
      'descoberta nova em curso numa conta que já coleta: o estado não volta atrás',
      { latestRun: { status: 'running', finishedAt: null, firstErrorCode: null }, sources: [collecting()] },
      'collecting',
    ],
    [
      'descoberta nova falhou numa conta que já tinha fontes: as fontes continuam valendo',
      {
        latestRun: { status: 'failed', finishedAt: later(60), firstErrorCode: 'trust_denied' },
        sources: [authorized()],
      },
      'configuring',
    ],
  ];

  it.each(cases)('%s', (_label, overrides, expected) => {
    const derived = deriveAwsOnboarding(facts(overrides));
    expect(derived.state).toBe(expected);
    // As nove conferências, na ordem do contrato, sempre no formato dele.
    expect(derived.checks.map((check) => check.id)).toEqual([...AWS_ONBOARDING_CHECK_IDS]);
    for (const check of derived.checks) expect(awsOnboardingCheckSchema.safeParse(check).success).toBe(true);
  });

  it('a tabela passa por todos os estados do contrato', () => {
    expect(new Set(cases.map(([, , state]) => state))).toEqual(new Set(AWS_ONBOARDING_STATES));
  });

  it('nunca "coletando" com um passo essencial pendente', () => {
    const pendingStates: OnboardingSourceFacts[] = [
      authorized(),
      authorized({ state: 'configuring', stateCode: null }),
      authorized({ state: 'waiting_events', stateCode: null }),
      authorized({ state: 'stalled', stateCode: null }),
      authorized({ state: 'permission_error', permission: 'missing', permissionDetail: 'kms_denied' }),
      authorized({ state: 'ingestion_error', stateCode: null }),
      authorized({ state: 'source_missing', stateCode: 'not_found' }),
    ];
    for (const pending of pendingStates) {
      for (const others of [[], [collecting()], [collecting(), collecting()]]) {
        expect(deriveAwsOnboarding(facts({ sources: [...others, pending] })).state, pending.state).not.toBe(
          'collecting',
        );
      }
    }
    // E com um pedido pendente, a conta fora do ar ou a coleta do nó com aviso.
    for (const patch of [
      { checkRequestedAt: later(1), connection: 'waiting' as const },
      { connection: 'error' as const, connectionError: 'trust_denied' },
      { connection: 'error' as const, connectionError: 'kms_denied:waf' },
      { collectionError: 'aws_token_stale' },
      { status: 'inactive' as const },
    ]) {
      expect(deriveAwsOnboarding(facts({ account: account(patch), sources: [collecting()] })).state).not.toBe(
        'collecting',
      );
    }
  });
});

describe('conferências', () => {
  it('antes do "Conectar": a entrada no papel por pedir, o resto sem se aplicar', () => {
    const derived = deriveAwsOnboarding(
      facts({
        account: account({
          connection: 'waiting',
          awsConnectRequestedAt: null,
          awsCapabilitiesCheckedAt: null,
        }),
        latestRun: null,
        lastCompletedAt: null,
      }),
    );
    expect(statusOf(derived)).toEqual({
      assume_role: 'pending',
      identity: 'skipped',
      template: 'skipped',
      discovery: 'skipped',
      permission: 'skipped',
      collector_config: 'skipped',
      events: 'skipped',
      last_sync: 'skipped',
      lag: 'skipped',
    });
    expect(codeOf(derived, 'assume_role')).toBe('not_requested');
    expect(derived.waitingUntil).toBeNull();
  });

  it('dentro da janela do "Conectar": esperando a pilha, com o fim da janela (60 min depois do pedido)', () => {
    const derived = deriveAwsOnboarding(
      facts({
        account: account({ connection: 'waiting', checkRequestedAt: T0, awsCapabilitiesCheckedAt: null }),
        latestRun: null,
        lastCompletedAt: null,
      }),
    );
    expect(statusOf(derived)).toMatchObject({
      assume_role: 'pending',
      identity: 'pending',
      template: 'skipped',
    });
    expect(codeOf(derived, 'assume_role')).toBe('awaiting_stack');
    expect(derived.waitingUntil).toEqual(later(60));
  });

  it('um "Verificar" comum pendente não é a janela do "Conectar"', () => {
    const derived = deriveAwsOnboarding(
      facts({ account: account({ connection: 'waiting', checkRequestedAt: later(30) }) }),
    );
    expect(codeOf(derived, 'assume_role')).toBe('verifying');
    expect(derived.waitingUntil).toBeNull();
  });

  it('o erro da conexão vira o código da entrada no papel; a conta errada reprova a identidade', () => {
    const refused = deriveAwsOnboarding(
      facts({ account: account({ connection: 'error', connectionError: 'trust_denied' }) }),
    );
    expect(statusOf(refused)).toMatchObject({
      assume_role: 'failed',
      identity: 'skipped',
      discovery: 'skipped',
    });
    expect(codeOf(refused, 'assume_role')).toBe('trust_denied');
    const mismatch = deriveAwsOnboarding(
      facts({ account: account({ connection: 'error', connectionError: 'account_mismatch' }) }),
    );
    expect(statusOf(mismatch)).toMatchObject({ assume_role: 'failed', identity: 'failed' });
    expect(codeOf(mismatch, 'identity')).toBe('account_mismatch');
    const timedOut = deriveAwsOnboarding(
      facts({ account: account({ connection: 'error', connectionError: 'authorization_timeout' }) }),
    );
    expect(codeOf(timedOut, 'assume_role')).toBe('authorization_timeout');
  });

  it('conectada: a entrada e a identidade passam, com o horário da última leitura das tags; o aviso vai no código', () => {
    const derived = deriveAwsOnboarding(facts());
    expect(statusOf(derived)).toMatchObject({
      assume_role: 'ok',
      identity: 'ok',
      template: 'ok',
      discovery: 'ok',
    });
    expect(derived.checks[0]).toEqual({
      id: 'assume_role',
      status: 'ok',
      code: null,
      checkedAt: later(1).toISOString(),
    });
    const warned = deriveAwsOnboarding(facts({ account: account({ connectionError: 'region_disabled' }) }));
    expect(statusOf(warned).assume_role).toBe('ok');
    expect(codeOf(warned, 'assume_role')).toBe('region_disabled');
  });

  it('o template: por ler, desatualizado (v1), em dia, e com a tag da versão que não é um número', () => {
    const unread = deriveAwsOnboarding(
      facts({ account: account({ awsTemplateVersion: null, awsCapabilitiesCheckedAt: null }) }),
    );
    expect(statusOf(unread).template).toBe('pending');
    const outdated = deriveAwsOnboarding(facts({ account: account({ awsTemplateVersion: 1 }) }));
    expect(statusOf(outdated).template).toBe('failed');
    expect(codeOf(outdated, 'template')).toBe('template_outdated');
    // O template antigo não derruba o estado: a conta segue no passo em que está.
    expect(outdated.state).toBe('awaiting_sources');
    const current = deriveAwsOnboarding(facts({ account: account({ awsTemplateVersion: 3 }) }));
    expect(statusOf(current).template).toBe('ok');
    // As tags foram lidas, mas a da versão não é um número: não é "em dia", e o estado da conta segue o passo dela.
    const unreadable = deriveAwsOnboarding(facts({ account: account({ awsTemplateVersion: null }) }));
    expect([statusOf(unreadable).template, codeOf(unreadable, 'template')]).toEqual([
      'failed',
      'template_unreadable',
    ]);
    expect(unreadable.state).toBe('awaiting_sources');
  });

  it('a descoberta: por pedir, pendente, em curso, parcial e falha', () => {
    const none = deriveAwsOnboarding(facts({ latestRun: null, lastCompletedAt: null }));
    expect([statusOf(none).discovery, codeOf(none, 'discovery')]).toEqual(['pending', 'not_requested']);
    for (const status of ['pending', 'running'] as const) {
      const derived = deriveAwsOnboarding(
        facts({ latestRun: { status, finishedAt: null, firstErrorCode: null }, lastCompletedAt: null }),
      );
      expect([statusOf(derived).discovery, codeOf(derived, 'discovery')]).toEqual(['pending', status]);
    }
    const partial = deriveAwsOnboarding(
      facts({ latestRun: { status: 'partial', finishedAt: later(3), firstErrorCode: 'AccessDenied' } }),
    );
    expect([statusOf(partial).discovery, codeOf(partial, 'discovery')]).toEqual(['ok', 'partial']);
    const failed = deriveAwsOnboarding(
      facts({
        latestRun: { status: 'failed', finishedAt: later(3), firstErrorCode: 'discovery_refused' },
        lastCompletedAt: null,
      }),
    );
    expect([statusOf(failed).discovery, codeOf(failed, 'discovery')]).toEqual([
      'failed',
      'discovery_refused',
    ]);
  });

  it('com fonte autorizada esperando o coletor: a permissão passa, e o coletor, os eventos e a leitura ficam pendentes', () => {
    const derived = deriveAwsOnboarding(facts({ sources: [authorized()] }));
    expect(statusOf(derived)).toMatchObject({
      permission: 'ok',
      collector_config: 'pending',
      events: 'pending',
      last_sync: 'pending',
      lag: 'pending',
    });
    expect(codeOf(derived, 'collector_config')).toBe('awaiting_collector');
    expect(codeOf(derived, 'events')).toBe('awaiting_collector');
    expect(codeOf(derived, 'last_sync')).toBe('no_data');
  });

  it('tudo coletando: todas as conferências passam, com a leitura mais antiga', () => {
    const derived = deriveAwsOnboarding(
      facts({ sources: [collecting({ lastSyncAt: later(40) }), collecting({ lastSyncAt: later(20) })] }),
    );
    expect(new Set(Object.values(statusOf(derived)))).toEqual(new Set(['ok']));
    expect(derived.checks.find((check) => check.id === 'last_sync')?.checkedAt).toBe(later(20).toISOString());
  });

  it('a permissão: a ação que falta numa fonte autorizada; por conferir; e o bucket cadastrado negado', () => {
    const denied = deriveAwsOnboarding(
      facts({
        sources: [
          authorized({
            state: 'permission_error',
            permission: 'missing',
            permissionDetail: 'guardduty:ListFindings',
          }),
        ],
      }),
    );
    expect([statusOf(denied).permission, codeOf(denied, 'permission')]).toEqual([
      'failed',
      'guardduty:ListFindings',
    ]);
    const unknown = deriveAwsOnboarding(facts({ sources: [authorized({ permission: 'unknown' })] }));
    expect(statusOf(unknown).permission).toBe('pending');
    const bucket = deriveAwsOnboarding(
      facts({ account: account({ connection: 'error', connectionError: 'kms_denied:guardduty' }) }),
    );
    expect([statusOf(bucket).permission, codeOf(bucket, 'permission')]).toEqual(['failed', 'kms_denied']);
    // Uma fonte que não está autorizada não conta, mesmo sem permissão.
    const idle = deriveAwsOnboarding(
      facts({ sources: [source({ state: 'needs_permission', permission: 'missing' })] }),
    );
    expect(statusOf(idle).permission).toBe('skipped');
  });

  it('a coleta: o aviso do nó, a fonte parada e o atraso acima do limite', () => {
    const node = deriveAwsOnboarding(
      facts({ account: account({ collectionError: 'wazuh_apply_failed' }), sources: [collecting()] }),
    );
    expect([statusOf(node).collector_config, codeOf(node, 'collector_config')]).toEqual([
      'failed',
      'wazuh_apply_failed',
    ]);
    const stalled = deriveAwsOnboarding(facts({ sources: [collecting({ state: 'stalled' })] }));
    expect(statusOf(stalled)).toMatchObject({ events: 'failed', lag: 'failed' });
    const late = deriveAwsOnboarding(
      facts({ sources: [collecting({ lagSeconds: AWS_LAG_LIMIT_SECONDS + 1 })] }),
    );
    expect(statusOf(late).lag).toBe('failed');
    const onTime = deriveAwsOnboarding(
      facts({ sources: [collecting({ lagSeconds: AWS_LAG_LIMIT_SECONDS })] }),
    );
    expect(statusOf(onTime).lag).toBe('ok');
  });

  it('a fonte de achados (lida por API): saudável sem achado nenhum, e a leitura atrasada não é fonte "parada"', () => {
    // Lida sem erro e sem achado até agora: coletando, com todas as conferências da coleta passando.
    const quiet = deriveAwsOnboarding(
      facts({
        sources: [collecting({ method: 'api', stateCode: 'no_findings_yet', lagSeconds: 60 })],
      }),
    );
    expect(quiet.state).toBe('collecting');
    expect(statusOf(quiet)).toMatchObject({
      collector_config: 'ok',
      events: 'ok',
      last_sync: 'ok',
      lag: 'ok',
    });
    // O coletor sem ler há mais de 2 h: a conferência acusa a leitura atrasada, com o código próprio.
    const late = deriveAwsOnboarding(
      facts({ sources: [collecting({ method: 'api', lagSeconds: AWS_LAG_LIMIT_SECONDS + 1 })] }),
    );
    expect([statusOf(late).lag, codeOf(late, 'lag')]).toEqual(['failed', 'sync_delayed']);
    // Junto de uma fonte contínua atrasada, ou parada, vale o código da fonte parada.
    const mixed = deriveAwsOnboarding(
      facts({
        sources: [
          collecting({ method: 'api', lagSeconds: AWS_LAG_LIMIT_SECONDS + 1 }),
          collecting({ method: 's3', lagSeconds: AWS_LAG_LIMIT_SECONDS + 1 }),
        ],
      }),
    );
    expect(codeOf(mixed, 'lag')).toBe('stalled');
    const continuous = deriveAwsOnboarding(
      facts({ sources: [collecting({ method: 's3', lagSeconds: AWS_LAG_LIMIT_SECONDS + 1 })] }),
    );
    expect(codeOf(continuous, 'lag')).toBe('stalled');
    // A falha repetida do coletor e a permissão negada aparecem no estado da conta, com o código da fonte.
    const failing = deriveAwsOnboarding(
      facts({
        sources: [collecting({ method: 'api', state: 'ingestion_error', stateCode: 'throttled' })],
      }),
    );
    expect(failing.state).toBe('ingestion_failure');
    expect([statusOf(failing).events, codeOf(failing, 'events')]).toEqual(['failed', 'throttled']);
    const denied = deriveAwsOnboarding(
      facts({
        sources: [
          collecting({
            method: 'api',
            state: 'permission_error',
            stateCode: 'guardduty:ListFindings',
            permission: 'missing',
            permissionDetail: 'guardduty:ListFindings',
          }),
        ],
      }),
    );
    expect(denied.state).toBe('permission_error');
    expect([statusOf(denied).permission, codeOf(denied, 'permission')]).toEqual([
      'failed',
      'guardduty:ListFindings',
    ]);
  });
});

describe('as fontes que deixam cada conferência pendente ou com falha (sourceIds)', () => {
  it('sem fonte autorizada, ou com tudo coletando, nenhuma conferência cita fonte', () => {
    for (const sources of [
      [],
      [source(), source({ state: 'needs_permission', permission: 'missing' })],
      [collecting(), collecting()],
    ]) {
      expect(sourcesOf(deriveAwsOnboarding(facts({ sources })))).toEqual({});
    }
    // As quatro primeiras (a entrada no papel, a identidade, o template e a descoberta) nunca citam.
    const derived = deriveAwsOnboarding(
      facts({ account: account({ awsTemplateVersion: 1 }), sources: [authorized({ id: sourceId(1) })] }),
    );
    expect(Object.keys(sourcesOf(derived)).sort()).toEqual(
      [...AWS_ONBOARDING_SOURCE_CHECK_IDS].filter((id) => id !== 'permission').sort(),
    );
  });

  it('a permissão: todas as fontes negadas (não só a primeira); por conferir, as que faltam conferir', () => {
    const denied = deriveAwsOnboarding(
      facts({
        sources: [
          collecting({ id: sourceId(1) }),
          collecting({
            id: sourceId(2),
            state: 'permission_error',
            permission: 'missing',
            permissionDetail: 'kms_denied',
          }),
          collecting({ id: sourceId(3), permission: 'missing', permissionDetail: 'tag_missing' }),
          // A que não está autorizada não entra, mesmo sem a permissão.
          source({ id: sourceId(4), state: 'needs_permission', permission: 'missing' }),
        ],
      }),
    );
    expect([statusOf(denied).permission, codeOf(denied, 'permission')]).toEqual(['failed', 'kms_denied']);
    expect(sourcesOf(denied).permission).toEqual([sourceId(2), sourceId(3)]);

    const unknown = deriveAwsOnboarding(
      facts({
        sources: [collecting({ id: sourceId(1) }), collecting({ id: sourceId(2), permission: 'unknown' })],
      }),
    );
    expect(statusOf(unknown).permission).toBe('pending');
    expect(sourcesOf(unknown).permission).toEqual([sourceId(2)]);
  });

  it('o bucket do cadastro negado: cita a linha dele quando ela está na lista; sem ela, nenhuma', () => {
    const bucketDenied = account({ connection: 'error', connectionError: 'bucket_denied:waf' });
    const withRow = deriveAwsOnboarding(
      facts({
        account: bucketDenied,
        sources: [
          collecting({ id: sourceId(1) }),
          // Como `legacyPermission` devolve a linha do bucket que a conferência da conexão recusou.
          authorized({
            id: sourceId(2),
            state: 'permission_error',
            stateCode: 'bucket_denied',
            permission: 'missing',
            permissionDetail: 'bucket_denied',
          }),
        ],
      }),
    );
    expect([statusOf(withRow).permission, codeOf(withRow, 'permission')]).toEqual([
      'failed',
      'bucket_denied',
    ]);
    expect(sourcesOf(withRow).permission).toEqual([sourceId(2)]);
    const withoutRow = deriveAwsOnboarding(
      facts({ account: bucketDenied, sources: [collecting({ id: sourceId(1) })] }),
    );
    expect(statusOf(withoutRow).permission).toBe('failed');
    expect(sourcesOf(withoutRow).permission).toBeUndefined();
    expect(sourcesOf(deriveAwsOnboarding(facts({ account: bucketDenied }))).permission).toBeUndefined();
  });

  it('o coletor, os eventos, a leitura e o atraso: cada conferência cita só as fontes que a seguram', () => {
    const derived = deriveAwsOnboarding(
      facts({
        sources: [
          collecting({ id: sourceId(1) }),
          authorized({ id: sourceId(2) }),
          authorized({ id: sourceId(3), state: 'configuring', stateCode: 'awaiting_apply' }),
          authorized({ id: sourceId(4), state: 'waiting_events', stateCode: null, lastSyncAt: later(20) }),
        ],
      }),
    );
    expect(statusOf(derived)).toMatchObject({
      collector_config: 'pending',
      events: 'pending',
      last_sync: 'pending',
      lag: 'pending',
    });
    expect(sourcesOf(derived)).toEqual({
      // Só as que ainda esperam o coletor.
      collector_config: [sourceId(2), sourceId(3)],
      // Todas as que ainda não coletam.
      events: [sourceId(2), sourceId(3), sourceId(4)],
      // As que nunca foram lidas.
      last_sync: [sourceId(2), sourceId(3)],
      // As que ainda não têm medida de atraso.
      lag: [sourceId(2), sourceId(3), sourceId(4)],
    });
  });

  it('a falha: as fontes com erro de ingestão ou paradas nos eventos; as paradas (ou as atrasadas) no atraso', () => {
    const failing = deriveAwsOnboarding(
      facts({
        sources: [
          collecting({ id: sourceId(1) }),
          collecting({ id: sourceId(2), state: 'ingestion_error', stateCode: 'throttled' }),
          collecting({ id: sourceId(3), state: 'stalled', stateCode: 'no_progress' }),
          collecting({ id: sourceId(4), lagSeconds: AWS_LAG_LIMIT_SECONDS + 1 }),
        ],
      }),
    );
    expect([statusOf(failing).events, codeOf(failing, 'events')]).toEqual(['failed', 'throttled']);
    expect(sourcesOf(failing).events).toEqual([sourceId(2), sourceId(3)]);
    // Com uma parada, o atraso cita a parada; a atrasada só aparece quando nenhuma está parada.
    expect([codeOf(failing, 'lag'), sourcesOf(failing).lag]).toEqual(['stalled', [sourceId(3)]]);
    const late = deriveAwsOnboarding(
      facts({
        sources: [
          collecting({ id: sourceId(1) }),
          collecting({ id: sourceId(4), method: 'api', lagSeconds: AWS_LAG_LIMIT_SECONDS + 1 }),
        ],
      }),
    );
    expect([codeOf(late, 'lag'), sourcesOf(late).lag]).toEqual(['sync_delayed', [sourceId(4)]]);
  });

  it('o aviso do nó inteiro não cita fonte: a configuração não aplicada é do servidor, não de uma fonte', () => {
    const node = deriveAwsOnboarding(
      facts({
        account: account({ collectionError: 'wazuh_apply_failed' }),
        sources: [collecting({ id: sourceId(1) }), authorized({ id: sourceId(2) })],
      }),
    );
    expect([statusOf(node).collector_config, codeOf(node, 'collector_config')]).toEqual([
      'failed',
      'wazuh_apply_failed',
    ]);
    expect(sourcesOf(node).collector_config).toBeUndefined();
  });

  it('toda conferência com fontes citadas segue o contrato, e os IDs são os das fontes da própria conta', () => {
    const sources = [
      collecting({ id: sourceId(1) }),
      authorized({ id: sourceId(2), permission: 'unknown' }),
      collecting({ id: sourceId(3), state: 'stalled' }),
    ];
    const derived = deriveAwsOnboarding(facts({ sources }));
    const known = new Set(sources.map((item) => item.id));
    for (const check of derived.checks) {
      expect(awsOnboardingCheckSchema.safeParse(check).success).toBe(true);
      for (const id of check.sourceIds ?? []) expect(known.has(id)).toBe(true);
      if (check.sourceIds !== undefined) {
        expect(AWS_ONBOARDING_SOURCE_CHECK_IDS as readonly string[]).toContain(check.id);
      }
    }
  });
});

describe('retomada depois de uma falha no meio', () => {
  it('a sequência inteira: conectar, esperar, tempo esgotado, tentar de novo, descobrir, falhar, refazer, autorizar', () => {
    const steps: [Partial<OnboardingFacts>, AwsOnboardingState][] = [
      [
        {
          account: account({ connection: 'waiting', awsConnectRequestedAt: null }),
          latestRun: null,
          lastCompletedAt: null,
        },
        'not_started',
      ],
      [
        {
          account: account({ connection: 'waiting', checkRequestedAt: T0 }),
          latestRun: null,
          lastCompletedAt: null,
        },
        'awaiting_authorization',
      ],
      [
        {
          account: account({ connection: 'error', connectionError: 'authorization_timeout' }),
          latestRun: null,
          lastCompletedAt: null,
        },
        'authorization_timeout',
      ],
      [
        {
          account: account({
            connection: 'waiting',
            checkRequestedAt: later(70),
            awsConnectRequestedAt: later(70),
          }),
          latestRun: null,
          lastCompletedAt: null,
        },
        'awaiting_authorization',
      ],
      [
        {
          account: account({ awsConnectRequestedAt: later(70) }),
          latestRun: { status: 'pending', finishedAt: null, firstErrorCode: null },
          lastCompletedAt: null,
        },
        'discovering',
      ],
      [
        {
          latestRun: { status: 'failed', finishedAt: later(80), firstErrorCode: 'aws_unavailable' },
          lastCompletedAt: null,
        },
        'authenticated',
      ],
      [
        { latestRun: { status: 'running', finishedAt: null, firstErrorCode: null }, lastCompletedAt: null },
        'discovering',
      ],
      [
        {
          latestRun: { status: 'partial', finishedAt: later(90), firstErrorCode: 'AccessDenied' },
          lastCompletedAt: later(90),
          sources: [source()],
        },
        'awaiting_sources',
      ],
      [{ lastCompletedAt: later(90), sources: [authorized()] }, 'configuring'],
      [
        {
          lastCompletedAt: later(90),
          sources: [
            authorized({ state: 'permission_error', permission: 'missing', permissionDetail: 'kms_denied' }),
          ],
        },
        'permission_error',
      ],
      // A permissão corrigida e a sondagem refeita: a fonte volta a esperar o coletor.
      [{ lastCompletedAt: later(90), sources: [authorized()] }, 'configuring'],
      [{ lastCompletedAt: later(90), sources: [collecting()] }, 'collecting'],
      // O papel removido: desconectada, e as fontes continuam lá.
      [
        {
          account: account({ connection: 'error', connectionError: 'trust_denied' }),
          lastCompletedAt: later(90),
          sources: [collecting()],
        },
        'disconnected',
      ],
      [
        {
          account: account({
            connection: 'waiting',
            checkRequestedAt: later(200),
            awsConnectRequestedAt: later(200),
          }),
          lastCompletedAt: later(90),
          sources: [collecting()],
        },
        'awaiting_authorization',
      ],
      [{ lastCompletedAt: later(90), sources: [collecting()] }, 'collecting'],
    ];
    expect(steps.map(([overrides]) => deriveAwsOnboarding(facts(overrides)).state)).toEqual(
      steps.map(([, state]) => state),
    );
  });
});

describe('a conta entra no papel? (o que a descoberta e a sondagem exigem)', () => {
  it('só a conta já verificada, conectada ou com erro só num bucket', () => {
    const verified = new Date('2026-11-21T00:00:00.000Z');
    expect(entersRole({ connection: 'connected', connectionError: null, ingestFrom: verified })).toBe(true);
    expect(
      entersRole({ connection: 'connected', connectionError: 'excess_permissions', ingestFrom: verified }),
    ).toBe(true);
    expect(
      entersRole({ connection: 'error', connectionError: 'bucket_denied:waf', ingestFrom: verified }),
    ).toBe(true);
    expect(entersRole({ connection: 'error', connectionError: 'kms_denied', ingestFrom: verified })).toBe(
      true,
    );
    expect(entersRole({ connection: 'connected', connectionError: null, ingestFrom: null })).toBe(false);
    expect(entersRole({ connection: 'waiting', connectionError: null, ingestFrom: verified })).toBe(false);
    for (const code of [
      'trust_denied',
      'authorization_timeout',
      'account_mismatch',
      'check_unavailable',
      'outro',
    ]) {
      expect(entersRole({ connection: 'error', connectionError: code, ingestFrom: verified })).toBe(false);
    }
  });
});

describe('a permissão da linha de um bucket cadastrado vem da conferência da conexão', () => {
  const row = (legacySource: 'cloudtrail' | 'guardduty' | 'waf', origin = 'legacy') => ({
    origin,
    details: { bucket: 'trilha-111111111111', legacySource },
    permission: 'unknown',
    permissionDetail: null,
    state: 'authorized',
    stateCode: 'awaiting_collector',
  });
  const connected = {
    status: 'active',
    connection: 'connected',
    connectionError: null,
    checkRequestedAt: null,
  } as const;

  it('conectada: concedida; com o erro do bucket da linha: faltando; com o de outro bucket, ou outro erro: por conferir', () => {
    expect(legacyPermission(row('cloudtrail'), connected)).toMatchObject({
      permission: 'granted',
      state: 'authorized',
    });
    const denied = { ...connected, connection: 'error', connectionError: 'kms_denied:cloudtrail' } as const;
    expect(legacyPermission(row('cloudtrail'), denied)).toEqual({
      permission: 'missing',
      permissionDetail: 'kms_denied',
      state: 'permission_error',
      stateCode: 'kms_denied',
    });
    expect(legacyPermission(row('waf'), denied)).toMatchObject({
      permission: 'unknown',
      state: 'authorized',
    });
    // O erro sem a fonte (de antes de a fonte ir junto) vale para todos os buckets.
    expect(
      legacyPermission(row('waf'), { ...connected, connection: 'error', connectionError: 'bucket_denied' }),
    ).toMatchObject({ permission: 'missing', permissionDetail: 'bucket_denied' });
    expect(
      legacyPermission(row('cloudtrail'), {
        ...connected,
        connection: 'error',
        connectionError: 'trust_denied',
      }),
    ).toMatchObject({ permission: 'unknown' });
  });

  it('com um pedido pendente, em "aguardando" ou com a conta desativada: por conferir', () => {
    expect(legacyPermission(row('cloudtrail'), { ...connected, checkRequestedAt: T0 }).permission).toBe(
      'unknown',
    );
    expect(legacyPermission(row('cloudtrail'), { ...connected, connection: 'waiting' }).permission).toBe(
      'unknown',
    );
    expect(legacyPermission(row('cloudtrail'), { ...connected, status: 'inactive' }).permission).toBe(
      'unknown',
    );
  });

  it('a fonte descoberta fica com o que a sondagem gravou', () => {
    expect(
      legacyPermission(
        { ...row('cloudtrail', 'discovered'), permission: 'missing', permissionDetail: 'kms_denied' },
        connected,
      ),
    ).toMatchObject({ permission: 'missing', permissionDetail: 'kms_denied' });
  });
});

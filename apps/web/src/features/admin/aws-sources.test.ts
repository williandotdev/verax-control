import { AWS_ONBOARDING_STATES, type AwsOnboardingState } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  authorizedSourceFixture,
  checksFixture,
  legacySourceFixture,
  onboardingFixture,
  runFixture,
  sourceFixture,
} from '@/test/aws-onboarding-fixtures';
import {
  AWS_ONBOARDING_FAST_POLL_MS,
  AWS_ONBOARDING_SLOW_POLL_MS,
  awsOnboardingPollInterval,
} from './aws-onboarding-api';
import {
  attentionChecks,
  awsSourceGroup,
  groupAwsSources,
  isAuthorizableSource,
  isCoveredByGuardDutyApi,
  isFindingSource,
  isHighVolumeSource,
  isRecommendedSource,
  lastVerifiedAt,
  matchesLogGroupSearch,
} from './aws-sources';

const ACCOUNT = '018f2c1e-0000-7000-8000-0000000c0aaa';

describe('fontes da conta AWS: em que grupo cada uma aparece', () => {
  it('disponível, coberta pelo cadastro, sem permissão, não habilitada, não lida, ainda não coletada e sumida', () => {
    expect(awsSourceGroup(sourceFixture('cloudtrail'))).toBe('available');
    expect(awsSourceGroup(sourceFixture('cloudtrail', { notes: ['covered_by_legacy'] }))).toBe('covered');
    expect(
      awsSourceGroup(sourceFixture('waf', { permission: 'missing', permissionDetail: 'kms_denied' })),
    ).toBe('needs_permission');
    // A permissão que ainda não foi conferida também não deixa autorizar.
    expect(awsSourceGroup(sourceFixture('security_hub', { permission: 'unknown' }))).toBe('needs_permission');
    expect(awsSourceGroup(sourceFixture('inspector', { availability: 'not_enabled' }))).toBe('not_enabled');
    expect(awsSourceGroup(sourceFixture('waf', { availability: 'no_destination' }))).toBe('not_enabled');
    expect(awsSourceGroup(sourceFixture('waf', { availability: 'unsupported_destination' }))).toBe(
      'unsupported',
    );
    expect(awsSourceGroup(sourceFixture('vpc_flow_logs', { availability: 'unsupported_format' }))).toBe(
      'unsupported',
    );
    expect(awsSourceGroup(sourceFixture('config'))).toBe('not_collected');
    expect(awsSourceGroup(sourceFixture('elb_logs'))).toBe('not_collected');
    expect(awsSourceGroup(sourceFixture('waf', { missingSince: '2026-11-22T00:00:00.000Z' }))).toBe('gone');
  });

  it('só entra num pedido de autorização a fonte disponível que não é do cadastro manual', () => {
    expect(isAuthorizableSource(sourceFixture('guardduty'))).toBe(true);
    expect(isAuthorizableSource(sourceFixture('guardduty', { permission: 'missing' }))).toBe(false);
    expect(isAuthorizableSource(sourceFixture('config'))).toBe(false);
    expect(isAuthorizableSource(sourceFixture('cloudtrail', { notes: ['covered_by_legacy'] }))).toBe(false);
    expect(isAuthorizableSource(authorizedSourceFixture('guardduty', 'collecting'))).toBe(false);
    expect(isAuthorizableSource(legacySourceFixture('exemplo-trilha'))).toBe(false);
    // A autorização retirada pode voltar; a autorizada que sumiu e reapareceu, também.
    const revoked = sourceFixture('guardduty', {
      state: 'revoked',
      authorization: {
        authorizedAt: '2026-11-01T00:00:00.000Z',
        authorizedBy: 'demo-ana',
        revokedAt: '2026-11-10T00:00:00.000Z',
      },
    });
    expect(isAuthorizableSource(revoked)).toBe(true);
    expect(isAuthorizableSource(authorizedSourceFixture('guardduty', 'source_missing'))).toBe(true);
  });

  it('as autorizadas vão para o acompanhamento; os grupos de logs, para a lista deles; o resto, por grupo e em ordem', () => {
    const sources = [
      sourceFixture('cloudwatch_log_group', { name: '/aws/lambda/b' }),
      sourceFixture('waf', { name: 'acl', availability: 'no_destination' }),
      sourceFixture('guardduty', { name: 'GuardDuty', region: 'us-east-1' }),
      sourceFixture('guardduty', { name: 'GuardDuty', region: 'sa-east-1' }),
      sourceFixture('cloudtrail', { name: 'trilha' }),
      authorizedSourceFixture('cloudwatch_log_group', 'collecting', { name: '/aws/lambda/a' }),
      legacySourceFixture('exemplo-trilha'),
    ];
    const { authorized, groups, logGroups } = groupAwsSources(sources);
    expect(authorized.map((source) => source.name)).toEqual(['exemplo-trilha', '/aws/lambda/a']);
    expect(logGroups.map((source) => source.name)).toEqual(['/aws/lambda/b']);
    // Na ordem dos tipos na tela (a trilha antes do GuardDuty), depois pela região.
    expect(groups.available.map((source) => `${source.kind}:${source.region}`)).toEqual([
      'cloudtrail:sa-east-1',
      'guardduty:sa-east-1',
      'guardduty:us-east-1',
    ]);
    expect(groups.not_enabled.map((source) => source.name)).toEqual(['acl']);
    expect(groups.needs_permission).toEqual([]);
    // A API do GuardDuty (a forma recomendada) vem antes do export dele.
    const guardDuty = groupAwsSources([sourceFixture('guardduty_export'), sourceFixture('guardduty')]);
    expect(guardDuty.groups.available.map((source) => source.kind)).toEqual([
      'guardduty',
      'guardduty_export',
    ]);
  });

  it('GuardDuty: com a API e o export na conta, a API é a recomendada e o export fica coberto por ela', () => {
    const api = sourceFixture('guardduty');
    const exported = sourceFixture('guardduty_export');
    expect(isRecommendedSource(api, [api, exported])).toBe(true);
    expect(isCoveredByGuardDutyApi(exported, [api, exported])).toBe(true);
    // Só o export (o GuardDuty desligado na API): nada a recomendar nem a cobrir.
    const off = sourceFixture('guardduty', { availability: 'not_enabled' });
    expect(isCoveredByGuardDutyApi(exported, [off, exported])).toBe(false);
    expect(isRecommendedSource(api, [api])).toBe(false);
    // A nota da descoberta vale sozinha.
    expect(
      isCoveredByGuardDutyApi(sourceFixture('guardduty_export', { notes: ['covered_by_api'] }), []),
    ).toBe(true);
    expect(isRecommendedSource(sourceFixture('guardduty', { notes: ['recommended'] }), [])).toBe(true);
    expect(isCoveredByGuardDutyApi(api, [api, exported])).toBe(false);
  });

  it('o aviso de volume vale para os flow logs, os grupos de logs e a nota de volume alto', () => {
    expect(isHighVolumeSource(sourceFixture('vpc_flow_logs'))).toBe(true);
    expect(isHighVolumeSource(sourceFixture('cloudwatch_log_group'))).toBe(true);
    expect(isHighVolumeSource(sourceFixture('waf', { notes: ['high_volume'] }))).toBe(true);
    expect(isHighVolumeSource(sourceFixture('cloudtrail'))).toBe(false);
    expect(isFindingSource(sourceFixture('security_hub'))).toBe(true);
    expect(isFindingSource(sourceFixture('guardduty_export'))).toBe(false);
  });

  it('a busca dos grupos de logs é pelo nome ou pela região, sem diferenciar maiúsculas', () => {
    const group = sourceFixture('cloudwatch_log_group', {
      name: '/aws/Lambda/loja-checkout',
      region: 'us-east-1',
    });
    expect(matchesLogGroupSearch(group, '')).toBe(true);
    expect(matchesLogGroupSearch(group, '  LAMBDA ')).toBe(true);
    expect(matchesLogGroupSearch(group, 'us-east')).toBe(true);
    expect(matchesLogGroupSearch(group, 'rds')).toBe(false);
  });
});

describe('o que impede dizer "tudo certo"', () => {
  it('a conferência que falhou sempre; a pendente, com a coleta andando; a que passou com ressalva', () => {
    const failed = onboardingFixture(ACCOUNT, 'awaiting_sources', {
      checks: checksFixture({
        assume_role: { status: 'ok' },
        template: { status: 'failed', code: 'template_outdated' },
        discovery: { status: 'pending', code: 'running' },
      }),
    });
    expect(attentionChecks(failed).map((check) => check.id)).toEqual(['template']);
    const collecting = onboardingFixture(ACCOUNT, 'collecting', {
      checks: checksFixture({
        assume_role: { status: 'ok', code: 'excess_permissions' },
        discovery: { status: 'ok', code: 'partial' },
        events: { status: 'ok' },
        lag: { status: 'pending', code: 'no_data' },
      }),
    });
    expect(attentionChecks(collecting).map((check) => check.id)).toEqual(['assume_role', 'discovery', 'lag']);
    expect(attentionChecks(onboardingFixture(ACCOUNT, 'collecting'))).toEqual([]);
  });

  it('a última verificação é a conferência mais recente da conexão (entrada, identidade ou modelo)', () => {
    expect(lastVerifiedAt(checksFixture())).toBeNull();
    expect(
      lastVerifiedAt(
        checksFixture({
          assume_role: { status: 'ok', checkedAt: '2026-11-23T10:00:00.000Z' },
          template: { status: 'ok', checkedAt: '2026-11-23T11:00:00.000Z' },
          // A descoberta tem o horário dela, e não é a verificação da conexão.
          discovery: { status: 'ok', checkedAt: '2026-11-23T11:30:00.000Z' },
        }),
      ),
    ).toBe('2026-11-23T11:00:00.000Z');
  });
});

describe('releitura do estado: só enquanto uma mudança é esperada', () => {
  const interval = (state: AwsOnboardingState, overrides = {}) =>
    awsOnboardingPollInterval(onboardingFixture(ACCOUNT, state, overrides));

  it('a cada 5 s na espera pelo papel, na descoberta e na configuração dos coletores', () => {
    expect(AWS_ONBOARDING_FAST_POLL_MS).toBe(5_000);
    for (const state of ['awaiting_authorization', 'discovering', 'configuring'] as const) {
      expect(interval(state), state).toBe(AWS_ONBOARDING_FAST_POLL_MS);
    }
    // Acabou de entrar: a descoberta vem em seguida.
    expect(interval('authenticated')).toBe(AWS_ONBOARDING_FAST_POLL_MS);
  });

  it('a cada 60 s com fontes autorizadas; a cada 5 s se a descoberta ou uma conferência estiver em curso', () => {
    expect(AWS_ONBOARDING_SLOW_POLL_MS).toBe(60_000);
    for (const state of ['collecting', 'partial', 'permission_error', 'ingestion_failure'] as const) {
      expect(interval(state), state).toBe(AWS_ONBOARDING_SLOW_POLL_MS);
    }
    const discovering = {
      discovery: {
        run: runFixture({ status: 'running', finishedAt: null }),
        lastCompletedAt: null,
        regions: [],
      },
    };
    expect(interval('collecting', discovering)).toBe(AWS_ONBOARDING_FAST_POLL_MS);
    const probing = { sources: [sourceFixture('waf', { probeRequestedAt: '2026-11-23T11:59:00.000Z' })] };
    expect(interval('partial', probing)).toBe(AWS_ONBOARDING_FAST_POLL_MS);
  });

  it('com parte coletando e uma fonte ainda sendo configurada, a releitura continua a cada 5 s', () => {
    const now = Date.parse('2026-11-23T12:00:00.000Z');
    const at = (state: 'authorized' | 'configuring' | 'waiting_events' | 'collecting', stateSince: string) =>
      awsOnboardingPollInterval(
        onboardingFixture(ACCOUNT, 'partial', {
          sources: [
            authorizedSourceFixture('guardduty', 'collecting'),
            authorizedSourceFixture('cloudtrail', state, { stateSince }),
          ],
        }),
        now,
      );
    expect(at('authorized', '2026-11-20T00:00:00.000Z')).toBe(AWS_ONBOARDING_FAST_POLL_MS);
    expect(at('configuring', '2026-11-20T00:00:00.000Z')).toBe(AWS_ONBOARDING_FAST_POLL_MS);
    // Configurada e sem evento: logo depois, ainda se espera o primeiro; passados uns minutos, a releitura é a lenta.
    expect(at('waiting_events', '2026-11-23T11:59:00.000Z')).toBe(AWS_ONBOARDING_FAST_POLL_MS);
    expect(at('waiting_events', '2026-11-23T11:00:00.000Z')).toBe(AWS_ONBOARDING_SLOW_POLL_MS);
    expect(at('collecting', '2026-11-23T11:59:30.000Z')).toBe(AWS_ONBOARDING_SLOW_POLL_MS);
    // A fonte que não está autorizada não conta.
    expect(
      awsOnboardingPollInterval(
        onboardingFixture(ACCOUNT, 'collecting', { sources: [sourceFixture('waf', { state: 'available' })] }),
        now,
      ),
    ).toBe(AWS_ONBOARDING_SLOW_POLL_MS);
  });

  it('para quando só o cliente pode mudar algo: antes de conectar, com o tempo esgotado, desconectada, escolhendo as fontes', () => {
    for (const state of [
      'not_started',
      'authorization_timeout',
      'disconnected',
      'awaiting_sources',
    ] as const) {
      expect(interval(state), state).toBe(false);
    }
    // A descoberta que falhou inteira não anda sozinha.
    const failed = {
      discovery: { run: runFixture({ status: 'failed' }), lastCompletedAt: null, regions: [] },
    };
    expect(interval('authenticated', failed)).toBe(false);
    // Uma conferência pedida numa fonte (ou a descoberta manual) volta a reler, mesmo esperando a escolha.
    const probing = { sources: [sourceFixture('waf', { probeRequestedAt: '2026-11-23T11:59:00.000Z' })] };
    expect(interval('awaiting_sources', probing)).toBe(AWS_ONBOARDING_FAST_POLL_MS);
    expect(awsOnboardingPollInterval(undefined)).toBe(false);
  });

  it('todo estado tem uma regra de releitura', () => {
    for (const state of AWS_ONBOARDING_STATES) {
      expect([false, AWS_ONBOARDING_FAST_POLL_MS, AWS_ONBOARDING_SLOW_POLL_MS]).toContain(interval(state));
    }
  });
});

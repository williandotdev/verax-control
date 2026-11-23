import { createHash } from 'node:crypto';
import { AWS_MAX_AUTHORIZED_LOG_GROUPS, AWS_MAX_AUTHORIZED_S3_SOURCES } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  planWazuhSources,
  serializeWazuhSources,
  toWazuhSources,
  WAZUH_AWS_REGIONS,
  type WazuhAccountRow,
  wazuhDate,
  type WazuhSourceRow,
  wazuhSourcesGeneration,
} from './wazuh-sources.js';

/** Contas fictícias da documentação da AWS. */
const ACCOUNT_A = '111122223333';
const ACCOUNT_B = '444455556666';
const TENANT = '00000000-0000-7000-8000-0000000000aa';
const AUTHORIZED = new Date('2026-11-20T15:00:00.000Z');
const DAY = new Date('2026-11-20T00:00:00.000Z');
let sequence = 0;

/** Uma fonte autorizada como a busca a devolve. */
function source(overrides: Partial<WazuhSourceRow> = {}): WazuhSourceRow {
  sequence += 1;
  return {
    id: `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    tenantId: TENANT,
    cloudAccountId: '00000000-0000-7000-8000-000000000001',
    kind: 'cloudtrail',
    region: 'sa-east-1',
    resourceId: 'recurso',
    name: 'fonte',
    details: {},
    method: 's3',
    origin: 'discovered',
    authorizedAt: AUTHORIZED,
    collectFrom: DAY,
    state: 'authorized',
    stateCode: 'awaiting_collector',
    stateSince: AUTHORIZED,
    lastSyncAt: null,
    lastEventAt: null,
    lastIngestedAt: null,
    lagSeconds: null,
    ...overrides,
  };
}

const legacy = (kind: string, bucket: string, overrides: Partial<WazuhSourceRow> = {}): WazuhSourceRow =>
  source({
    kind,
    region: 'global',
    resourceId: 'legacy',
    name: bucket,
    details: { bucket, legacySource: kind === 'guardduty_export' ? 'guardduty' : kind },
    origin: 'legacy',
    collectFrom: new Date('2026-11-01T00:00:00.000Z'),
    ...overrides,
  });

const trail = (
  details: Record<string, unknown> = {},
  overrides: Partial<WazuhSourceRow> = {},
): WazuhSourceRow =>
  source({ kind: 'cloudtrail', details: { bucket: 'trilha-da-conta', ...details }, ...overrides });

const flow = (id = 'fl-0123456789abcdef0', overrides: Partial<WazuhSourceRow> = {}): WazuhSourceRow =>
  source({
    kind: 'vpc_flow_logs',
    resourceId: id,
    details: { bucket: 'fluxo-da-conta', flowLogId: id },
    ...overrides,
  });

const group = (name: string, overrides: Partial<WazuhSourceRow> = {}): WazuhSourceRow =>
  source({
    kind: 'cloudwatch_log_group',
    method: 'cloudwatch',
    resourceId: name,
    name,
    details: { logGroup: name },
    ...overrides,
  });

/** Uma conta como a busca a devolve, com as fontes autorizadas dela. */
function account(sources: WazuhSourceRow[], overrides: Partial<WazuhAccountRow> = {}): WazuhAccountRow {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenantId: TENANT,
    accountId: ACCOUNT_A,
    regions: ['sa-east-1', 'us-east-1'],
    ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
    cloudtrailBucket: null,
    guarddutyBucket: null,
    wafBucket: null,
    collectionError: null,
    awsSources: sources,
    awsDiscoveryRuns: [],
    ...overrides,
  };
}

const planOf = (sources: WazuhSourceRow[], overrides: Partial<WazuhAccountRow> = {}) =>
  planWazuhSources([account(sources, overrides)]);
const outcomes = (plan: ReturnType<typeof planWazuhSources>) =>
  plan.sources.map(({ row, outcome }) => [row.name, outcome.included ? 'included' : outcome.code]);

describe('lista das fontes da AWS para o Wazuh do nó (onboarding self-service)', () => {
  it('a data do only_logs_after no formato do Wazuh, pelo dia em UTC', () => {
    expect(wazuhDate(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-NOV-01');
    expect(wazuhDate(new Date('2027-01-09T23:59:59.999Z'))).toBe('2027-JAN-09');
    const months = Array.from({ length: 12 }, (_, month) => wazuhDate(new Date(Date.UTC(2026, month, 15))));
    expect(months.map((date) => date.slice(5, 8))).toEqual(
      'JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC'.split(' '),
    );
  });

  it('os buckets do cadastro anterior: só o tipo, o bucket, a data e a marca, na ordem de sempre', () => {
    const list = toWazuhSources([
      account(
        [
          legacy('waf', 'aws-waf-logs-da-conta'),
          legacy('guardduty_export', 'achados-da-conta'),
          legacy('cloudtrail', 'trilha-da-conta'),
        ],
        { cloudtrailBucket: 'trilha-da-conta' },
      ),
    ]);
    expect(list).toEqual({
      version: 2,
      accounts: [
        {
          accountId: ACCOUNT_A,
          region: 'sa-east-1',
          s3: [
            { type: 'cloudtrail', bucket: 'trilha-da-conta', onlyLogsAfter: '2026-NOV-01', legacy: true },
            { type: 'guardduty', bucket: 'achados-da-conta', onlyLogsAfter: '2026-NOV-01', legacy: true },
            { type: 'waf', bucket: 'aws-waf-logs-da-conta', onlyLogsAfter: '2026-NOV-01', legacy: true },
          ],
          logGroups: [],
        },
      ],
    });
    // A ordem dos campos é parte da geração.
    expect(Object.keys(list.accounts[0] ?? {})).toEqual(['accountId', 'region', 's3', 'logGroups']);
    expect(Object.keys(list.accounts[0]?.s3[0] ?? {})).toEqual(['type', 'bucket', 'onlyLogsAfter', 'legacy']);
    // Nada que identifique o cliente, a conexão de agora ou um papel: o gerador deriva o papel do ID.
    expect(serializeWazuhSources(list)).not.toMatch(/tenant|connection|role|arn:|state/i);
  });

  it('a linha do cadastro anterior entra em qualquer estado, e a data dela é a da conta quando falta', () => {
    const plan = planOf([
      legacy('cloudtrail', 'trilha-da-conta', { state: 'permission_error', collectFrom: null }),
    ]);
    expect(plan.list.accounts[0]?.s3).toEqual([
      { type: 'cloudtrail', bucket: 'trilha-da-conta', onlyLogsAfter: '2026-NOV-01', legacy: true },
    ]);
  });

  it('cada tipo de fonte descoberta com os campos dele', () => {
    const plan = planOf([
      trail({ multiRegion: false }),
      trail(
        { bucket: 'trilha-da-organizacao', organizationTrail: true, organizationId: 'o-exemplo1234' },
        { name: 'organizacao' },
      ),
      flow(),
      source({
        kind: 'guardduty_export',
        details: { bucket: 'achados-da-conta' },
        collectFrom: new Date('2026-11-22T00:00:00.000Z'),
      }),
      source({
        kind: 'waf',
        details: { bucket: 'aws-waf-logs-painel', webAclName: 'painel', webAclScope: 'REGIONAL' },
      }),
      source({
        kind: 'waf',
        region: 'global',
        details: { bucket: 'aws-waf-logs-painel', webAclName: 'site_Publico-2', webAclScope: 'CLOUDFRONT' },
      }),
      group('/aws/lambda/cobranca'),
      group('/aws/rds/instance/banco/postgresql'),
      group('/aws/route53/exemplo.com.br', { region: 'us-east-1' }),
      group('API-Gateway-Execution-Logs_a1b2c3/producao', {
        collectFrom: new Date('2026-11-23T00:00:00.000Z'),
      }),
    ]);
    expect(plan.list.accounts).toEqual([
      {
        accountId: ACCOUNT_A,
        region: 'sa-east-1',
        s3: [
          {
            type: 'cloudtrail',
            bucket: 'trilha-da-conta',
            onlyLogsAfter: '2026-NOV-20',
            regions: ['sa-east-1'],
          },
          {
            type: 'cloudtrail',
            bucket: 'trilha-da-organizacao',
            onlyLogsAfter: '2026-NOV-20',
            regions: ['sa-east-1'],
            organizationId: 'o-exemplo1234',
          },
          {
            type: 'vpcflow',
            bucket: 'fluxo-da-conta',
            onlyLogsAfter: '2026-NOV-20',
            regions: ['sa-east-1'],
            // O padrão: o tráfego aceito é descartado no módulo.
            traffic: 'rejected',
          },
          {
            type: 'guardduty',
            bucket: 'achados-da-conta',
            onlyLogsAfter: '2026-NOV-22',
            regions: ['sa-east-1'],
          },
          {
            type: 'waf',
            bucket: 'aws-waf-logs-painel',
            onlyLogsAfter: '2026-NOV-20',
            webAcl: 'site_Publico-2',
            scope: 'cloudfront',
          },
          {
            type: 'waf',
            bucket: 'aws-waf-logs-painel',
            onlyLogsAfter: '2026-NOV-20',
            webAcl: 'painel',
            scope: 'sa-east-1',
          },
        ],
        logGroups: [
          {
            region: 'sa-east-1',
            names: ['/aws/lambda/cobranca', '/aws/rds/instance/banco/postgresql'],
            onlyLogsAfter: '2026-NOV-20',
          },
          {
            region: 'sa-east-1',
            names: ['API-Gateway-Execution-Logs_a1b2c3/producao'],
            onlyLogsAfter: '2026-NOV-23',
          },
          { region: 'us-east-1', names: ['/aws/route53/exemplo.com.br'], onlyLogsAfter: '2026-NOV-20' },
        ],
      },
    ]);
    expect(plan.sources.every(({ outcome }) => outcome.included)).toBe(true);
    expect(plan.accounts).toHaveLength(1);
  });

  it('a trilha de todas as regiões lê as regiões habilitadas na conta que o módulo aceita, sempre com a dela', () => {
    const multi = trail({ multiRegion: true }, { region: 'us-east-1' });
    // Pela última descoberta: as habilitadas, menos a que o módulo do Wazuh não conhece.
    const discovered = planOf([multi], {
      awsDiscoveryRuns: [{ regions: ['sa-east-1', 'eu-west-1', 'ap-southeast-6'] }],
    });
    expect(discovered.list.accounts[0]?.s3[0]?.regions).toEqual(['eu-west-1', 'sa-east-1', 'us-east-1']);
    // Sem descoberta com as regiões, as monitoradas da conta.
    expect(planOf([multi]).list.accounts[0]?.s3[0]?.regions).toEqual(['sa-east-1', 'us-east-1']);
    expect(WAZUH_AWS_REGIONS).not.toContain('ap-southeast-6');
  });

  it('o prefixo antes de AWSLogs só vale no bucket do cadastro anterior da conta', () => {
    const details = { bucket: 'trilha-da-conta', flowLogId: 'fl-0123456789abcdef0' };
    const custom = flow('fl-0123456789abcdef0', { details: { ...details, customPrefix: 'rede/fluxo' } });
    const inLegacy = planOf([custom], { cloudtrailBucket: 'trilha-da-conta' });
    expect(inLegacy.list.accounts[0]?.s3).toEqual([
      {
        type: 'vpcflow',
        bucket: 'trilha-da-conta',
        onlyLogsAfter: '2026-NOV-20',
        regions: ['sa-east-1'],
        traffic: 'rejected',
        prefix: 'rede/fluxo',
      },
    ]);
    expect(outcomes(planOf([custom]))).toEqual([['fonte', 'custom_prefix_unsupported']]);
    const odd = flow('fl-0123456789abcdef0', { details: { ...details, customPrefix: 'minha pasta' } });
    expect(outcomes(planOf([odd], { cloudtrailBucket: 'trilha-da-conta' }))).toEqual([
      ['fonte', 'unsupported_name'],
    ]);
  });

  it('a fonte que não dá para ler fica de fora, com o motivo, sem derrubar as outras', () => {
    const plan = planOf([
      trail({}, { name: 'boa' }),
      trail({ bucket: undefined }, { name: 'sem-bucket' }),
      trail({}, { name: 'sem-data', collectFrom: null }),
      trail({ organizationTrail: true }, { name: 'organizacao-sem-id' }),
      trail({}, { name: 'regiao', region: 'ap-southeast-6' }),
      source({ kind: 'waf', name: 'waf-nome', details: { bucket: 'aws-waf-logs-x', webAclName: 'a b' } }),
      source({ kind: 'waf', name: 'waf-bucket', details: { bucket: 'logs-do-waf', webAclName: 'painel' } }),
      group('/aws/lambda/fila#1'),
      group('grupo com espaço'),
      group('/aws/a,/aws/b'),
      group('/aws/lambda/outra-regiao', { region: 'ap-southeast-6' }),
      source({ kind: 'config', name: 'config', details: { bucket: 'config-da-conta' } }),
    ]);
    expect(outcomes(plan)).toEqual([
      ['boa', 'included'],
      ['sem-bucket', 'invalid_details'],
      ['sem-data', 'invalid_details'],
      ['organizacao-sem-id', 'organization_id_unknown'],
      ['regiao', 'region_unsupported'],
      ['waf-nome', 'unsupported_name'],
      ['waf-bucket', 'invalid_details'],
      ['/aws/lambda/fila#1', 'unsupported_name'],
      ['grupo com espaço', 'unsupported_name'],
      ['/aws/a,/aws/b', 'unsupported_name'],
      ['/aws/lambda/outra-regiao', 'region_unsupported'],
      ['config', 'invalid_details'],
    ]);
    expect(plan.list.accounts[0]?.s3).toHaveLength(1);
    expect(plan.list.accounts[0]?.logGroups).toEqual([]);
    // Nada do que ficou de fora chega ao gerador.
    expect(serializeWazuhSources(plan.list)).not.toMatch(/#| com |a b|,\/aws|ap-southeast-6/);
  });

  it('a fonte descoberta só entra enquanto o estado dela é da coleta', () => {
    const states = [
      'authorized',
      'configuring',
      'waiting_events',
      'collecting',
      'stalled',
      'ingestion_error',
      'permission_error',
      'source_missing',
      'revoked',
      'available',
    ];
    const plan = planOf(
      states.map((state) => trail({ bucket: `trilha-${state.replace('_', '-')}` }, { state })),
    );
    expect(plan.sources.map(({ row }) => row.state)).toEqual(states.slice(0, 6));
    expect(plan.list.accounts[0]?.s3.map((entry) => entry.bucket)).toEqual(
      ['authorized', 'collecting', 'configuring', 'ingestion-error', 'stalled', 'waiting-events'].map(
        (state) => `trilha-${state}`,
      ),
    );
  });

  it('o estado que a própria coleta grava não muda a lista', () => {
    const base = [trail(), flow(), group('/aws/lambda/cobranca')];
    const first = serializeWazuhSources(planOf(base).list);
    const later = base.map((row) => ({
      ...row,
      state: 'collecting',
      stateCode: null,
      lastSyncAt: new Date(),
      lastIngestedAt: new Date(),
      lagSeconds: 30,
    }));
    expect(serializeWazuhSources(planOf(later).list)).toBe(first);
    const failed = base.map((row) => ({ ...row, state: 'ingestion_error', stateCode: 'wazuh_apply_failed' }));
    expect(serializeWazuhSources(planOf(failed).list)).toBe(first);
  });

  it('duas fontes com a mesma leitura dão uma entrada só, e cada uma segue com o marcador dela', () => {
    const plan = planOf([flow('fl-0123456789abcdef0'), flow('fl-0fedcba9876543210')]);
    expect(plan.list.accounts[0]?.s3).toHaveLength(1);
    const marker = {
      method: 's3',
      table: 'vpcflow',
      bucketPath: 'fluxo-da-conta/',
      accountId: ACCOUNT_A,
      regions: ['sa-east-1'],
    };
    expect(plan.sources.map(({ outcome }) => outcome.included && outcome.marker)).toEqual([
      { ...marker, flowLogId: 'fl-0123456789abcdef0' },
      { ...marker, flowLogId: 'fl-0fedcba9876543210' },
    ]);
  });

  it('o marcador de cada tipo: a pasta, a conta e as regiões que o módulo grava', () => {
    const plan = planOf(
      [
        legacy('cloudtrail', 'trilha-antiga'),
        legacy('guardduty_export', 'achados-antigos'),
        legacy('waf', 'aws-waf-logs-antigo'),
        trail({ bucket: 'trilha-antiga', customPrefix: 'contas/producao', multiRegion: true }),
        source({ kind: 'guardduty_export', details: { bucket: 'achados-da-conta' } }),
        source({
          kind: 'waf',
          details: { bucket: 'aws-waf-logs-painel', webAclName: 'painel', webAclScope: 'REGIONAL' },
        }),
        group('/aws/lambda/cobranca'),
      ],
      { cloudtrailBucket: 'trilha-antiga' },
    );
    const s3 = { method: 's3', flowLogId: null };
    expect(plan.sources.map(({ outcome }) => outcome.included && outcome.marker)).toEqual([
      // O cadastro anterior: a pasta da conta em qualquer região; o GuardDuty e o WAF, de qualquer conta no bucket.
      { ...s3, table: 'cloudtrail', bucketPath: 'trilha-antiga/', accountId: ACCOUNT_A, regions: null },
      { ...s3, table: 'guardduty', bucketPath: 'achados-antigos/', accountId: null, regions: null },
      { ...s3, table: 'waf', bucketPath: 'aws-waf-logs-antigo/', accountId: null, regions: null },
      {
        ...s3,
        table: 'cloudtrail',
        bucketPath: 'trilha-antiga/contas/producao/',
        accountId: ACCOUNT_A,
        regions: ['sa-east-1', 'us-east-1'],
      },
      { ...s3, table: 'guardduty', bucketPath: 'achados-da-conta/', accountId: ACCOUNT_A, regions: null },
      {
        ...s3,
        table: 'waf',
        bucketPath: `aws-waf-logs-painel/AWSLogs/${ACCOUNT_A}/WAFLogs/sa-east-1/painel/`,
        accountId: null,
        regions: null,
      },
      { method: 'cloudwatch', region: 'sa-east-1', logGroup: '/aws/lambda/cobranca' },
    ]);
    // A pasta dos objetos, para a conferência de fonte parada (só a trilha e os flow logs).
    const objects = plan.sources.map(({ outcome }) => (outcome.included ? outcome.objects : null));
    expect(objects.map((item) => item !== null)).toEqual([true, false, false, true, false, false, false]);
    expect(objects[0]?.regionPrefix('sa-east-1')).toBe(`AWSLogs/${ACCOUNT_A}/CloudTrail/sa-east-1/`);
    expect(objects[0]?.fileHead('sa-east-1')).toBe(`${ACCOUNT_A}_CloudTrail_sa-east-1_`);
    expect(objects[3]?.regionPrefix('us-east-1')).toBe(
      `contas/producao/AWSLogs/${ACCOUNT_A}/CloudTrail/us-east-1/`,
    );
    const flowOutcome = planOf([flow()]).sources[0]?.outcome;
    const flowObjects = flowOutcome?.included === true ? flowOutcome.objects : null;
    expect(flowObjects?.regionPrefix('sa-east-1')).toBe(`AWSLogs/${ACCOUNT_A}/vpcflowlogs/sa-east-1/`);
    expect(flowObjects?.fileHead('sa-east-1')).toBe(
      `${ACCOUNT_A}_vpcflowlogs_sa-east-1_fl-0123456789abcdef0_`,
    );
  });

  it('o mesmo grupo de logs na mesma região em duas contas: só o da autorização mais antiga entra', () => {
    const first = account([
      group('/aws/lambda/cobranca', { authorizedAt: new Date('2026-11-21T00:00:00Z') }),
    ]);
    const second = account(
      [group('/aws/lambda/cobranca', { authorizedAt: new Date('2026-11-20T00:00:00Z') })],
      {
        id: '00000000-0000-7000-8000-000000000002',
        accountId: ACCOUNT_B,
      },
    );
    const other = account([group('/aws/lambda/cobranca', { region: 'us-east-1' })], {
      id: '00000000-0000-7000-8000-000000000003',
      accountId: '777788889999',
    });
    const plan = planWazuhSources([first, second, other]);
    expect(
      plan.sources.map(({ accountId, outcome }) => [accountId, outcome.included || outcome.code]),
    ).toEqual([
      [ACCOUNT_A, 'log_group_name_conflict'],
      [ACCOUNT_B, true],
      // Em outra região, é outro marcador.
      ['777788889999', true],
    ]);
    // A conta que ficou sem fonte na lista nem aparece nela.
    expect(plan.list.accounts.map((item) => item.accountId)).toEqual([ACCOUNT_B, '777788889999']);
    expect(plan.accounts.map((row) => row.accountId)).toEqual([ACCOUNT_B, '777788889999']);
  });

  it('os tetos por conta: o que passa fica de fora, e o cadastro anterior nunca sai por causa deles', () => {
    const many = Array.from({ length: AWS_MAX_AUTHORIZED_S3_SOURCES + 1 }, (_, index) =>
      trail({ bucket: `trilha-${String(index).padStart(3, '0')}` }, { name: `trilha-${index}` }),
    );
    const groups = Array.from({ length: AWS_MAX_AUTHORIZED_LOG_GROUPS + 2 }, (_, index) =>
      group(`/aws/lambda/funcao-${String(index).padStart(2, '0')}`),
    );
    const plan = planOf([...many, ...groups, legacy('cloudtrail', 'trilha-antiga')]);
    const [entry] = plan.list.accounts;
    expect(entry?.s3).toHaveLength(AWS_MAX_AUTHORIZED_S3_SOURCES);
    expect(entry?.s3[0]).toMatchObject({ bucket: 'trilha-antiga', legacy: true });
    expect(entry?.logGroups.flatMap((item) => item.names)).toHaveLength(AWS_MAX_AUTHORIZED_LOG_GROUPS);
    const left = plan.sources.filter(({ outcome }) => !outcome.included);
    expect(left.map(({ outcome }) => !outcome.included && outcome.code)).toEqual(
      Array.from({ length: 4 }, () => 'source_limit'),
    );
    // As mais recentes (na ordem da busca: a autorização mais antiga primeiro) são as que ficam de fora.
    expect(left.map(({ row }) => row.name)).toEqual([
      `trilha-${AWS_MAX_AUTHORIZED_S3_SOURCES - 1}`,
      `trilha-${AWS_MAX_AUTHORIZED_S3_SOURCES}`,
      `/aws/lambda/funcao-${AWS_MAX_AUTHORIZED_LOG_GROUPS}`,
      `/aws/lambda/funcao-${AWS_MAX_AUTHORIZED_LOG_GROUPS + 1}`,
    ]);
  });

  it('a conta sem região ou sem o início da coleta fica de fora', () => {
    expect(toWazuhSources([account([trail()], { regions: [] })]).accounts).toEqual([]);
    expect(toWazuhSources([account([trail()], { ingestFrom: null })]).accounts).toEqual([]);
    expect(toWazuhSources([account([])]).accounts).toEqual([]);
  });

  it('a geração é o SHA-256 da linha que o CLI imprime, e muda com qualquer campo da lista', () => {
    const line = serializeWazuhSources(toWazuhSources([account([trail()])]));
    expect(line).not.toContain('\n');
    expect(wazuhSourcesGeneration(line)).toBe(createHash('sha256').update(line).digest('hex'));
    expect(serializeWazuhSources(toWazuhSources([]))).toBe('{"version":2,"accounts":[]}');
    const changed = [
      account([trail(), flow()]),
      account([trail()], { regions: ['us-east-1'] }),
      account([trail({}, { collectFrom: new Date('2026-11-21T00:00:00.000Z') })]),
      account([trail({ bucket: 'outra-trilha' })]),
      account([trail(), group('/aws/lambda/cobranca')]),
    ].map((variant) => wazuhSourcesGeneration(serializeWazuhSources(toWazuhSources([variant]))));
    expect(new Set([wazuhSourcesGeneration(line), ...changed]).size).toBe(6);
    // O aviso da própria coleta não muda a geração: o manager não reinicia por causa dele.
    expect(
      wazuhSourcesGeneration(
        serializeWazuhSources(
          toWazuhSources([account([trail()], { collectionError: 'wazuh_apply_failed' })]),
        ),
      ),
    ).toBe(wazuhSourcesGeneration(line));
  });
});

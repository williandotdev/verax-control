import {
  AWS_MAX_AUTHORIZED_S3_SOURCES,
  AWS_SOURCE_ACTIVE_STATES,
  AWS_SOURCE_KIND_INFO,
  AWS_SOURCE_KINDS,
  AWS_WAZUH_SOURCE_KINDS,
  isAwsSourceCollectable,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  planWazuhSources,
  serializeWazuhSources,
  toWazuhSources,
  type WazuhAccountRow,
  type WazuhSourceRow,
  wazuhSourcesGeneration,
} from './wazuh-sources.js';

/**
 * O balanceador autorizado (`elb_logs`) é lido pelo worker, e não pelo Wazuh: com qualquer número deles, a lista que o
 * gerador da configuração do manager recebe (a única entrada dele) é, byte a byte, a de sem nenhum.
 */

const TENANT = '00000000-0000-7000-8000-0000000000aa';
const AT = new Date('2026-11-20T15:00:00.000Z');
const DAY = new Date('2026-11-20T00:00:00.000Z');
const ACCOUNTS = ['111111111111', '222222222222', '333333333333'] as const;
let sequence = 0;

function source(overrides: Partial<WazuhSourceRow>): WazuhSourceRow {
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
    authorizedAt: AT,
    collectFrom: DAY,
    state: 'authorized',
    stateCode: 'awaiting_collector',
    stateSince: AT,
    lastSyncAt: null,
    lastEventAt: null,
    lastIngestedAt: null,
    lagSeconds: null,
    ...overrides,
  };
}

/** Um ALB autorizado, com o bucket que também tem trilha: o que mais se parece com uma fonte do Wazuh. */
const balancer = (overrides: Partial<WazuhSourceRow> = {}): WazuhSourceRow =>
  source({
    kind: 'elb_logs',
    resourceId: 'loja',
    name: 'loja',
    details: {
      arn: 'arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/app/loja/0123456789abcdef',
      destinationType: 's3',
      bucket: 'trilha-da-conta',
      prefix: 'AWSLogs/111111111111/elasticloadbalancing/sa-east-1/',
      internetFacing: true,
    },
    ...overrides,
  });

function account(accountId: string, sources: WazuhSourceRow[]): WazuhAccountRow {
  return {
    id: `00000000-0000-7000-8000-${accountId}`,
    tenantId: TENANT,
    accountId,
    regions: ['sa-east-1', 'us-east-1'],
    ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
    cloudtrailBucket: accountId === ACCOUNTS[0] ? 'cadastro-da-conta' : null,
    guarddutyBucket: null,
    wafBucket: null,
    collectionError: null,
    awsSources: sources,
    awsDiscoveryRuns: [{ regions: ['sa-east-1', 'us-east-1'] }],
  };
}

/** Duas contas com um pouco de cada tipo que o Wazuh lê. */
const collected = (): [WazuhSourceRow[], WazuhSourceRow[]] => [
  [
    source({
      resourceId: 'legacy',
      region: 'global',
      origin: 'legacy',
      name: 'cadastro-da-conta',
      details: { bucket: 'cadastro-da-conta', legacySource: 'cloudtrail' },
      collectFrom: new Date('2026-11-01T00:00:00.000Z'),
    }),
    source({ details: { bucket: 'trilha-da-conta', multiRegion: true } }),
    source({
      kind: 'vpc_flow_logs',
      resourceId: 'fl-0123456789abcdef0',
      details: { bucket: 'fluxo-da-conta', flowLogId: 'fl-0123456789abcdef0' },
    }),
    source({
      kind: 'cloudwatch_log_group',
      method: 'cloudwatch',
      resourceId: '/aws/rds/instance/banco/postgresql',
      name: '/aws/rds/instance/banco/postgresql',
      details: { logGroup: '/aws/rds/instance/banco/postgresql' },
    }),
  ],
  [
    source({
      kind: 'waf',
      region: 'us-east-1',
      details: { bucket: 'aws-waf-logs-painel', webAclName: 'painel', webAclScope: 'REGIONAL' },
    }),
    source({ kind: 'guardduty_export', region: 'us-east-1', details: { bucket: 'achados-da-conta' } }),
  ],
];

/** O que o código de antes (5e53ae48) imprimia para as duas contas acima. */
const TODAY =
  '{"version":2,"accounts":[{"accountId":"111111111111","region":"sa-east-1","s3":[' +
  '{"type":"cloudtrail","bucket":"cadastro-da-conta","onlyLogsAfter":"2026-NOV-01","legacy":true},' +
  '{"type":"cloudtrail","bucket":"trilha-da-conta","onlyLogsAfter":"2026-NOV-20","regions":["sa-east-1","us-east-1"]},' +
  '{"type":"vpcflow","bucket":"fluxo-da-conta","onlyLogsAfter":"2026-NOV-20","regions":["sa-east-1"],"traffic":"rejected"}],' +
  '"logGroups":[{"region":"sa-east-1","names":["/aws/rds/instance/banco/postgresql"],"onlyLogsAfter":"2026-NOV-20"}]},' +
  '{"accountId":"222222222222","region":"sa-east-1","s3":[' +
  '{"type":"guardduty","bucket":"achados-da-conta","onlyLogsAfter":"2026-NOV-20","regions":["us-east-1"]},' +
  '{"type":"waf","bucket":"aws-waf-logs-painel","onlyLogsAfter":"2026-NOV-20","webAcl":"painel","scope":"us-east-1"}],' +
  '"logGroups":[]}]}';

describe('o balanceador autorizado não entra na coleta do Wazuh', () => {
  it('cada tipo tem um coletor, e só os do Wazuh entram na lista', () => {
    expect(AWS_WAZUH_SOURCE_KINDS).toEqual([
      'cloudtrail',
      'vpc_flow_logs',
      'waf',
      'guardduty_export',
      'cloudwatch_log_group',
    ]);
    expect(AWS_SOURCE_KIND_INFO.elb_logs).toMatchObject({ method: 's3', collector: 'worker' });
    for (const kind of AWS_SOURCE_KINDS) {
      // O que alguém lê tem coletor; o que ninguém lê, não.
      expect(AWS_SOURCE_KIND_INFO[kind].collector !== null).toBe(
        isAwsSourceCollectable(kind, { webLogs: true }),
      );
    }
  });

  it('a lista é, byte a byte, a de hoje: nenhum, um ou centenas de balanceadores, em contas, regiões e estados diferentes', () => {
    const list = (extra: (accountId: string) => WazuhSourceRow[], third = false): string => {
      sequence = 0;
      const [first, second] = collected();
      return serializeWazuhSources(
        toWazuhSources([
          account(ACCOUNTS[0], [...extra(ACCOUNTS[0]), ...first]),
          account(ACCOUNTS[1], [...second, ...extra(ACCOUNTS[1])]),
          // A conta que só tem balanceador não entra na lista.
          ...(third ? [account(ACCOUNTS[2], extra(ACCOUNTS[2]))] : []),
        ]),
      );
    };
    expect(list(() => [])).toBe(TODAY);
    expect(wazuhSourcesGeneration(list(() => []))).toBe(wazuhSourcesGeneration(TODAY));
    expect(list(() => [balancer()], true)).toBe(TODAY);
    expect(
      list(
        () => [
          ...AWS_SOURCE_ACTIVE_STATES.map((state, i) =>
            balancer({ state, region: i % 2 === 0 ? 'sa-east-1' : 'us-east-1', name: `alb-${i}` }),
          ),
          balancer({ state: 'source_missing' }),
          // Um prefixo do cliente, sem bucket, sem data, numa região que o módulo não conhece.
          balancer({ details: { bucket: 'trilha-da-conta', customPrefix: 'logs/alb' } }),
          balancer({ details: {}, collectFrom: null, region: 'global' }),
        ],
        true,
      ),
    ).toBe(TODAY);
    // Nem o teto de 200 do planejador é gasto com eles.
    expect(
      list(
        () =>
          Array.from({ length: AWS_MAX_AUTHORIZED_S3_SOURCES + 50 }, (_, i) => balancer({ name: `a${i}` })),
        true,
      ),
    ).toBe(TODAY);
  });

  it('nem aparece entre as fontes da coleta: a saúde, a conferência de fonte parada e os donos não o veem', () => {
    const plan = planWazuhSources([
      account(ACCOUNTS[0], [balancer(), balancer({ state: 'collecting' }), balancer({ state: 'stalled' })]),
      account(ACCOUNTS[1], [balancer({ method: 'cloudwatch' }), ...collected()[1]]),
    ]);
    expect(plan.sources.map(({ row }) => row.kind)).toEqual(['waf', 'guardduty_export']);
    expect(plan.accounts.map((row) => row.accountId)).toEqual([ACCOUNTS[1]]);
  });

  it('nem um tipo que ninguém lê, se uma linha dele chegar autorizada', () => {
    const plan = planWazuhSources([
      account(ACCOUNTS[0], [source({ kind: 'config', details: { bucket: 'config-da-conta' } })]),
    ]);
    expect(plan.sources).toEqual([]);
    expect(plan.list.accounts).toEqual([]);
  });
});

import { AWS_READER_CAPABILITY_ACTIONS, awsSourceDetailsSchema } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  type CatalogueContext,
  type DiscoveredSource,
  loadBalancerSource,
  parseLoadBalancerArn,
} from '../../../src/aws/discovery/catalogue.js';
import { discoverAccount, type DiscoveryTarget } from '../../../src/aws/discovery/discovery.js';
import { probeInto } from '../../../src/aws/discovery/probes.js';
import { readSource } from '../../../src/aws/discovery/source-reading.js';
import { awsError, fakeDiscovery, type FakeDiscoveryAccount, type Handlers } from './fake-discovery.js';

/**
 * Os balanceadores na descoberta, com os ataques web desligados (o de sempre, congelado) e ligados (`AWS_WEB_LOGS_ENABLED`).
 */

const ACCOUNT = '111111111111';
const NOW = new Date('2026-11-24T12:00:00.000Z');
const REGION = 'sa-east-1';
const PREFIX = `AWSLogs/${ACCOUNT}/elasticloadbalancing/${REGION}/`;
const signal = new AbortController().signal;
const arn = (path: string) => `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:loadbalancer/${path}`;

interface Balancer {
  name: string;
  path: string;
  scheme?: 'internet-facing' | 'internal';
  /** `null`: log desligado; `error`: os atributos não foram lidos. */
  logs: { bucket: string; prefix?: string } | null | 'error';
}

const ALB_ON: Balancer = {
  name: 'interno',
  path: 'app/interno/00000000000000a1',
  scheme: 'internal',
  logs: { bucket: 'acessos' },
};
const ALB_FACING: Balancer = { name: 'loja', path: 'app/loja/00000000000000a2', logs: { bucket: 'acessos' } };
const ALB_PREFIX: Balancer = {
  name: 'prefixo',
  path: 'app/prefixo/00000000000000a3',
  logs: { bucket: 'acessos', prefix: '/logs/alb/' },
};
const ALB_OFF: Balancer = { name: 'semlog', path: 'app/semlog/00000000000000a4', logs: null };
const ALB_OFF_INTERNAL: Balancer = {
  name: 'semlog-interno',
  path: 'app/semlog-interno/00000000000000a5',
  scheme: 'internal',
  logs: null,
};
const ALB_UNREAD: Balancer = { name: 'naolido', path: 'app/naolido/00000000000000a6', logs: 'error' };
const NLB_ON: Balancer = { name: 'rede', path: 'net/rede/00000000000000b1', logs: { bucket: 'acessos' } };
const NLB_OFF: Balancer = { name: 'rede-semlog', path: 'net/rede-semlog/00000000000000b2', logs: null };
const GWLB: Balancer = { name: 'gateway', path: 'gwy/gateway/00000000000000c1', logs: null };
const EVERY = [ALB_ON, ALB_OFF_INTERNAL, NLB_ON, ALB_PREFIX, ALB_OFF, NLB_OFF, GWLB, ALB_FACING, ALB_UNREAD];

function accountWith(balancers: readonly Balancer[], s3: Handlers = {}): FakeDiscoveryAccount {
  return {
    regions: [REGION],
    handlers: {
      [`elbv2:${REGION}`]: {
        DescribeLoadBalancersCommand: () => ({
          LoadBalancers: balancers.map((balancer) => ({
            LoadBalancerName: balancer.name,
            LoadBalancerArn: arn(balancer.path),
            Scheme: balancer.scheme ?? 'internet-facing',
          })),
        }),
        DescribeLoadBalancerAttributesCommand: (input) => {
          const found = balancers.find((balancer) => arn(balancer.path) === input['LoadBalancerArn']);
          if (found === undefined || found.logs === 'error') throw awsError('AccessDeniedException', 403);
          const { logs } = found;
          return {
            Attributes:
              logs === null
                ? [{ Key: 'access_logs.s3.enabled', Value: 'false' }]
                : [
                    { Key: 'access_logs.s3.enabled', Value: 'true' },
                    { Key: 'access_logs.s3.bucket', Value: logs.bucket },
                    { Key: 'access_logs.s3.prefix', Value: logs.prefix ?? '' },
                  ],
          };
        },
      },
      's3:*': {
        ListBucketsCommand: () => ({ Buckets: [] }),
        ListObjectsV2Command: (input) => ({ Contents: [{ Key: `${String(input['Prefix'])}objeto.log.gz` }] }),
        GetObjectCommand: () => ({}),
        ...s3,
      },
    },
  };
}

async function discover(account: FakeDiscoveryAccount, overrides: Partial<DiscoveryTarget> = {}) {
  const fake = fakeDiscovery(account);
  const result = await discoverAccount(
    {
      accountId: ACCOUNT,
      regions: [REGION],
      capabilities: ['discovery', 'service-logs', 'findings', 'log-groups'],
      templateOutdated: false,
      legacyBuckets: { cloudtrail: null, guardduty: null, waf: null },
      ...overrides,
    },
    fake.clients,
    { signal, now: NOW },
  );
  return { ...fake, result, balancers: result.sources.filter((source) => source.kind === 'elb_logs') };
}
const ON = { features: { webLogs: true } };
const byName = (sources: readonly DiscoveredSource[], name: string) => {
  const source = sources.find((candidate) => candidate.name === name);
  if (source === undefined) throw new Error(`esperava ${name}`);
  return source;
};

describe('balanceadores na descoberta: ataques web desligados (o padrão)', () => {
  const asBefore = (balancer: Balancer, details: Record<string, unknown>): DiscoveredSource => ({
    kind: 'elb_logs',
    region: REGION,
    resourceId: balancer.name,
    name: balancer.name,
    availability: 'available',
    loggingState: 'logging',
    notes: ['not_collected_yet'],
    details: { arn: arn(balancer.path), destinationType: 's3', bucket: 'acessos', ...details },
    permission: 'unknown',
    permissionDetail: null,
  });

  it('é a resposta de sempre: só os de log ligado, de qualquer tipo, sem sondagem e na ordem da AWS', async () => {
    const { balancers, result, calls } = await discover(accountWith(EVERY));
    expect(balancers).toEqual([
      asBefore(ALB_ON, { prefix: PREFIX }),
      asBefore(NLB_ON, { prefix: PREFIX }),
      asBefore(ALB_PREFIX, { prefix: `logs/alb/${PREFIX}`, customPrefix: 'logs/alb' }),
      asBefore(ALB_FACING, { prefix: PREFIX }),
    ]);
    // Um atributo não lido: a região não é dada como lida por inteiro, e nada some por isso.
    expect(result.covered).not.toContain(`elb_logs:${REGION}`);
    expect(result.errors).toContainEqual({ service: 'elb', region: REGION, code: 'AccessDeniedException' });
    expect(calls.filter((call) => call.service === 's3').map((call) => call.command)).toEqual([
      'ListBucketsCommand',
    ]);
    // `false` é o mesmo que não dizer nada: o resultado inteiro e as chamadas.
    const off = await discover(accountWith(EVERY), { features: { webLogs: false } });
    expect(off.result).toEqual(result);
    expect(off.calls).toEqual(calls);
    expect((await discover(accountWith([ALB_OFF, NLB_OFF, GWLB]))).balancers).toEqual([]);
  });

  it('a releitura de um que desligou o log: ausente, como sempre', async () => {
    const fake = fakeDiscovery(accountWith([ALB_OFF, NLB_ON]));
    const context: CatalogueContext = {
      accountId: ACCOUNT,
      legacyBuckets: { cloudtrail: null, guardduty: null, waf: null },
      capabilities: null,
    };
    const read = (name: string) =>
      readSource(
        { kind: 'elb_logs', region: REGION, resourceId: name, details: {} },
        context,
        fake.clients,
        signal,
      );
    expect(await read('semlog')).toEqual({ status: 'absent' });
    expect(await read('rede')).toMatchObject({
      status: 'found',
      source: { availability: 'available', notes: ['not_collected_yet'] },
    });
  });
});

describe('balanceadores na descoberta: ataques web ligados', () => {
  it('cada um no seu lugar, e os que aceitam conexão da internet primeiro', async () => {
    const { balancers, result } = await discover(accountWith(EVERY), ON);
    // O não lido continua fora; os outros, internet antes de interno, na ordem da AWS dentro de cada grupo.
    expect(balancers.map((source) => source.name)).toEqual([
      'rede',
      'prefixo',
      'semlog',
      'rede-semlog',
      'gateway',
      'loja',
      'interno',
      'semlog-interno',
    ]);
    expect(byName(balancers, 'loja')).toEqual({
      kind: 'elb_logs',
      region: REGION,
      resourceId: 'loja',
      name: 'loja',
      availability: 'available',
      loggingState: 'logging',
      notes: ['high_volume'],
      details: {
        arn: arn(ALB_FACING.path),
        internetFacing: true,
        destinationType: 's3',
        bucket: 'acessos',
        prefix: PREFIX,
      },
      permission: 'granted',
      permissionDetail: null,
    });
    expect(byName(balancers, 'interno')).toMatchObject({
      availability: 'available',
      permission: 'granted',
      details: { internetFacing: false },
    });
    // O prefixo antes de AWSLogs/: o papel do modelo 3 lista a pasta atrás dele, sondada como as outras.
    expect(byName(balancers, 'prefixo')).toMatchObject({
      availability: 'available',
      notes: ['high_volume'],
      permission: 'granted',
      permissionDetail: null,
      details: { customPrefix: 'logs/alb', prefix: `logs/alb/${PREFIX}` },
    });
    // Sem log: o aviso de custo, sem bucket e sem sondagem.
    for (const [name, internetFacing] of [
      ['semlog', true],
      ['semlog-interno', false],
    ] as const) {
      expect(byName(balancers, name)).toMatchObject({
        availability: 'no_destination',
        loggingState: 'disabled',
        notes: ['aws_cost_alb_logs'],
        permission: 'unknown',
        permissionDetail: null,
      });
      expect(byName(balancers, name).details).toEqual({
        arn: arn(`app/${name}/${name === 'semlog' ? '00000000000000a4' : '00000000000000a5'}`),
        internetFacing,
        destinationType: 'none',
      });
    }
    // NLB e GWLB, com ou sem log: não servem.
    for (const [name, loggingState] of [
      ['rede', 'logging'],
      ['rede-semlog', 'disabled'],
      ['gateway', 'disabled'],
    ] as const) {
      expect(byName(balancers, name)).toMatchObject({
        availability: 'unsupported_format',
        loggingState,
        notes: [],
        permission: 'unknown',
      });
      expect(byName(balancers, name).details).not.toHaveProperty('bucket');
    }
    expect(result.covered).not.toContain(`elb_logs:${REGION}`);
    for (const source of balancers) {
      expect(awsSourceDetailsSchema.safeParse(source.details).success, source.name).toBe(true);
    }
  });

  it('a sondagem é só a do papel de hoje: uma listagem da pasta dos balanceadores e 1 byte de um objeto', async () => {
    const both = await discover(accountWith([ALB_ON, ALB_FACING]), ON);
    expect(both.balancers.map((source) => source.permission)).toEqual(['granted', 'granted']);
    const { calls } = await discover(accountWith([ALB_FACING]), ON);
    const s3 = calls.filter((call) => call.service === 's3' && call.command !== 'ListBucketsCommand');
    expect(s3.map((call) => [call.command, call.input])).toEqual([
      ['ListObjectsV2Command', { Bucket: 'acessos', MaxKeys: 1, Prefix: `${PREFIX}2026/11/24/` }],
      [
        'GetObjectCommand',
        { Bucket: 'acessos', Key: `${PREFIX}2026/11/24/objeto.log.gz`, Range: 'bytes=0-0' },
      ],
    ]);
    const granted: Record<string, readonly string[]> = AWS_READER_CAPABILITY_ACTIONS;
    expect(granted['service-logs']).toEqual(expect.arrayContaining(['s3:ListBucket', 's3:GetObject']));
    expect(granted['discovery']).toEqual(
      expect.arrayContaining([
        'elasticloadbalancing:DescribeLoadBalancers',
        'elasticloadbalancing:DescribeLoadBalancerAttributes',
      ]),
    );
    // Nenhuma chamada a mais que a descoberta de sempre, fora a sondagem.
    const off = await discover(accountWith([ALB_FACING]));
    const others = (list: typeof calls) =>
      list
        .filter((call) => !['ListObjectsV2Command', 'GetObjectCommand'].includes(call.command))
        .map((call) => `${call.service}:${call.region}:${call.command}`)
        .sort();
    expect(others(calls)).toEqual(others(off.calls));
  });

  it('o bucket de outra conta que não deixa listar, o que sumiu, a capacidade desligada e o bucket do cadastro', async () => {
    const denied = await discover(
      accountWith([ALB_FACING], {
        ListObjectsV2Command: () => {
          throw awsError('AccessDenied', 403);
        },
      }),
      ON,
    );
    expect(denied.balancers[0]).toMatchObject({ permission: 'missing', permissionDetail: 'bucket_denied' });
    // Com prefixo, a recusa é a da pilha anterior ao modelo 3, que só lista AWSLogs/ na raiz: pede a pilha nova.
    const oldStack = await discover(
      accountWith([ALB_PREFIX], {
        ListObjectsV2Command: () => {
          throw awsError('AccessDenied', 403);
        },
      }),
      ON,
    );
    expect(oldStack.balancers[0]).toMatchObject({
      permission: 'missing',
      permissionDetail: 'outside_awslogs_prefix',
    });
    const gone = await discover(
      accountWith([ALB_FACING], {
        ListObjectsV2Command: () => {
          throw awsError('NoSuchBucket', 404);
        },
      }),
      ON,
    );
    expect(gone.balancers[0]).toMatchObject({ permission: 'missing', permissionDetail: 'bucket_missing' });
    const off = await discover(accountWith([ALB_FACING]), { ...ON, capabilities: ['discovery'] });
    expect(off.balancers[0]).toMatchObject({
      permission: 'missing',
      permissionDetail: 'capability_off',
      notes: ['high_volume', 'stack_update_required'],
    });
    // O bucket dos adicionais da pilha é lido inteiro: com o prefixo do cliente, sondado.
    const legacy = await discover(accountWith([ALB_PREFIX]), {
      ...ON,
      legacyBuckets: { cloudtrail: 'acessos', guardduty: null, waf: null },
    });
    expect(legacy.balancers[0]).toMatchObject({ notes: ['high_volume'], permission: 'granted' });
    expect(legacy.calls.find((call) => call.command === 'ListObjectsV2Command')?.input['Prefix']).toBe(
      `logs/alb/${PREFIX}2026/11/24/`,
    );
  });

  it('com a leitura completa, o escopo é dado como lido: o que sumiu pode sair da lista', async () => {
    const { result } = await discover(accountWith([ALB_FACING, ALB_OFF]), ON);
    expect(result.covered).toContain(`elb_logs:${REGION}`);
  });

  it('a releitura: o log desligado é sem destino, o não lido não responde, o NLB não serve', async () => {
    const context: CatalogueContext = {
      accountId: ACCOUNT,
      legacyBuckets: { cloudtrail: null, guardduty: null, waf: null },
      capabilities: ['discovery', 'service-logs'],
      ...ON,
    };
    const fake = fakeDiscovery(accountWith([ALB_FACING, ALB_OFF, NLB_ON]));
    const read = async (name: string) => {
      const reading = await readSource(
        { kind: 'elb_logs', region: REGION, resourceId: name, details: {} },
        context,
        fake.clients,
        signal,
      );
      if (reading.status !== 'found') return reading.status;
      await probeInto(reading.source, context, fake.clients, { signal, now: NOW, templateOutdated: false });
      return [reading.source.availability, reading.source.permission];
    };
    expect(await read('loja')).toEqual(['available', 'granted']);
    expect(await read('semlog')).toEqual(['no_destination', 'unknown']);
    expect(await read('rede')).toEqual(['unsupported_format', 'unknown']);
    expect(await read('apagado')).toBe('absent');
    const unread = fakeDiscovery(accountWith([ALB_UNREAD]));
    expect(
      await readSource(
        { kind: 'elb_logs', region: REGION, resourceId: 'naolido', details: {} },
        context,
        unread.clients,
        signal,
      ),
    ).toEqual({ status: 'unread' });
  });

  it('o ARN: só o de um balanceador com tipo, nome e ID', () => {
    expect(parseLoadBalancerArn(arn('app/loja/00000000000000a2'))).toEqual({
      type: 'app',
      loadBalancer: 'app/loja/00000000000000a2',
    });
    expect(parseLoadBalancerArn(arn('net/rede/00000000000000b1'))?.type).toBe('net');
    expect(parseLoadBalancerArn(arn('gwy/gateway/00000000000000c1'))?.type).toBe('gwy');
    expect(parseLoadBalancerArn(arn('novo/x/00000000000000c1'))?.type).toBeNull();
    for (const value of [null, undefined, '', 'loja', arn('loja'), arn('app/loja'), arn('app/loja/a/b')]) {
      expect(parseLoadBalancerArn(value)).toBeNull();
    }
    // Um tipo que não se conhece não é tratado como ALB.
    expect(
      loadBalancerSource(
        {
          name: 'novo',
          arn: arn('novo/x/00000000000000c1'),
          internetFacing: true,
          accessLogs: { bucket: 'acessos', prefix: null },
        },
        REGION,
        {
          accountId: ACCOUNT,
          legacyBuckets: { cloudtrail: null, guardduty: null, waf: null },
          capabilities: null,
          ...ON,
        },
      ),
    ).toMatchObject({ availability: 'unsupported_format' });
  });
});

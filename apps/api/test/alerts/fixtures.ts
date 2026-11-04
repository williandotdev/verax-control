import { randomUUID } from 'node:crypto';
import type { RegisteredAwsAccount } from '../../src/alerts/alert-owner.js';

/**
 * Alertas do Wazuh como ficam no indexer, no formato do módulo aws-s3 do Wazuh 4.14.9 (conferido no código do
 * wodle): evento original em `data.aws`, com `source`, `log_info.s3bucket` e, só no CloudTrail, `aws_account_id`.
 * Contas e clientes fictícios (IDs de exemplo da documentação da AWS). Cada chamada é um evento novo na AWS, com ID
 * próprio (`eventID`, `id` do achado, `requestId`); para o mesmo evento lido de novo, o teste passa o ID.
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
    /** Regra que casou; a padrão é a do login com falha (80254). */
    rule?: { id: string; description: string };
    /** `eventID` do evento; `null` tira o campo. */
    eventId?: string | null;
  } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  const eventId = options.eventId === undefined ? randomUUID() : options.eventId;
  return document(
    {
      id: options.rule?.id ?? '80254',
      level: options.level ?? 5,
      description:
        options.rule?.description ??
        'AWS Cloudtrail: signin.amazonaws.com - ConsoleLogin - User login failed.',
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
      ...(eventId === null ? {} : { eventID: eventId }),
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
    /** `id` do achado no GuardDuty; o achado atualizado volta com o mesmo. */
    findingId?: string;
    /** Quantas vezes o GuardDuty viu a atividade (sobe a cada atualização do achado). */
    count?: number;
    updatedAt?: string;
  } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  const arnAccount = options.arnAccount ?? account;
  const findingId = options.findingId ?? randomUUID().replace(/-/g, '');
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
      id: findingId,
      arn: `arn:aws:guardduty:sa-east-1:${arnAccount}:detector/0000/finding/${findingId}`,
      type: 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
      title: 'Credenciais usadas de fora da AWS',
      severity: options.severity ?? 8,
      createdAt: '2026-11-01T09:55:00.000Z',
      updatedAt: options.updatedAt ?? '2026-11-01T09:55:00.000Z',
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
        count: options.count ?? 1,
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
  options: {
    account?: string;
    bucket?: string;
    webaclId?: string | null;
    clientIp?: string;
    /** `httpRequest.requestId` (o do ALB na frente do WAF); `null` tira o campo. */
    requestId?: string | null;
  } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  const requestId =
    options.requestId === undefined
      ? `1-6720a0b0-${randomUUID().replace(/-/g, '').slice(0, 24)}`
      : options.requestId;
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
        ...(requestId === null ? {} : { requestId }),
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

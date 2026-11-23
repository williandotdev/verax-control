import { randomUUID } from 'node:crypto';
import type { RegisteredAwsAccount } from '../../src/alerts/alert-owner.js';

/**
 * Alertas do Wazuh como ficam no indexer, no formato do módulo aws-s3 do Wazuh 4.14.9 (conferido no código do
 * wodle): evento original em `data.aws`, com `source`, `log_info.s3bucket` e, no CloudTrail e nos flow logs da VPC,
 * `aws_account_id`. O evento de um grupo do CloudWatch Logs (`cloudWatchAlert`) é a linha de log crua: sem
 * `data.integration` nem `data.aws`, só com o `location` do módulo.
 * O `data.aws` passa por `asWazuhWrites`, que grava os valores como o analysisd grava (números e booleanos em texto).
 * Contas e clientes fictícios (IDs de exemplo da documentação da AWS). Cada chamada é um evento novo na AWS, com ID
 * próprio (`eventID`, `id` do achado, `requestId`); para o mesmo evento lido de novo, o teste passa o ID.
 * `withAws` não passa por `asWazuhWrites`: grava o valor como veio, para os casos fora do formato.
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

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

function isEmptyObject(value: unknown): boolean {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
  );
}

/**
 * Evento da AWS como o analysisd do Wazuh o grava em `data.aws` (conferido no wazuh-logtest do manager 4.14.9; ver
 * "formato que o Wazuh grava" em wazuh-alert.test.ts). O decoder JSON guarda cada campo como texto:
 * - o inteiro que cabe em 32 bits sai como o próprio número (`22` vira `"22"`); os outros números, com seis casas
 *   (`5.5` vira `"5.500000"`, e o horário do WAF, `"1793527200000.000000"`);
 * - booleano e null viram `"true"`, `"false"` e `"null"`;
 * - texto vazio e objeto vazio somem;
 * - lista volta como JSON, com os tipos de origem.
 */
export function asWazuhWrites(value: unknown): unknown {
  if (Array.isArray(value)) return value;
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX
      ? String(value)
      : value.toFixed(6);
  }
  if (typeof value === 'boolean' || value === null) return String(value);
  if (typeof value !== 'object') return value;
  const fields: [string, unknown][] = [];
  for (const [key, field] of Object.entries(value)) {
    const written = asWazuhWrites(field);
    if (written !== undefined && written !== '' && !isEmptyObject(written)) fields.push([key, written]);
  }
  return Object.fromEntries(fields);
}

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
    data: { integration: 'aws', aws: asWazuhWrites(aws) },
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
    /** Última atualização do achado; a atividade (`service.eventLastSeen`) é a mesma, salvo `eventLastSeen`. */
    updatedAt?: string;
    /** `service.eventLastSeen`; `null` tira o campo (o `updatedAt` fica como reserva). */
    eventLastSeen?: string | null;
    type?: string;
    /** `service.action`; o padrão é uma chamada de API de fora da AWS. */
    action?: Record<string, unknown>;
    /** Regra que casou; a padrão é a de severidade alta (80303). */
    rule?: { id: string; level: number; description: string };
  } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  const arnAccount = options.arnAccount ?? account;
  const findingId = options.findingId ?? randomUUID().replace(/-/g, '');
  const updatedAt = options.updatedAt ?? '2026-11-01T09:55:00.000Z';
  const eventLastSeen = options.eventLastSeen === undefined ? updatedAt : options.eventLastSeen;
  return document(
    {
      id: options.rule?.id ?? '80303',
      level: options.rule?.level ?? 10,
      description:
        options.rule?.description ?? 'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.',
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
      type: options.type ?? 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
      title: 'Credenciais usadas de fora da AWS',
      severity: options.severity ?? 8,
      createdAt: '2026-11-01T09:55:00.000Z',
      updatedAt,
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
        eventFirstSeen: '2026-11-01T09:55:00.000Z',
        ...(eventLastSeen === null ? {} : { eventLastSeen }),
        action: options.action ?? {
          actionType: 'AWS_API_CALL',
          awsApiCallAction: { api: 'ListBuckets', remoteIpDetails: { ipAddressV4: '198.51.100.7' } },
        },
      },
      source: 'guardduty',
    },
  );
}

/**
 * Achado de sondagem de porta do GuardDuty como o módulo aws-s3 do Wazuh o entrega: com mais de um item em
 * `portProbeDetails`, o wodle (`AWSGuardDutyBucket.reformat_msg`) gera um evento por item, todos com o mesmo `id`, e
 * cada um traz o próprio item como objeto. Devolve um alerta por item, na ordem.
 */
export function portProbeAlerts(
  probes: readonly { ip: string; port: number }[],
  options: Omit<NonNullable<Parameters<typeof guardDutyAlert>[0]>, 'action' | 'type'> & {
    instanceId?: string;
  } = {},
): Record<string, unknown>[] {
  const { instanceId = 'i-0abc1234def567890', findingId = randomUUID().replace(/-/g, ''), ...rest } = options;
  return probes.map(({ ip, port }) =>
    guardDutyAlert({
      severity: 5,
      // A descrição da regra do Wazuh cita o IP e a porta do item.
      rule: {
        id: '80305',
        level: 7,
        description: `AWS GuardDuty: PORT_PROBE - Unprotected port on EC2 instance ${instanceId} is being probed. [IP: ${ip}] [Port: ${port}]`,
      },
      resource: { resourceType: 'Instance', instanceDetails: { instanceId } },
      ...rest,
      findingId,
      type: 'Recon:EC2/PortProbeUnprotectedPort',
      action: {
        actionType: 'PORT_PROBE',
        portProbeAction: {
          blocked: false,
          portProbeDetails: {
            localPortDetails: { port, portName: port === 22 ? 'SSH' : 'Unknown' },
            localIpDetails: { ipAddressV4: '10.0.0.10' },
            remoteIpDetails: { ipAddressV4: ip, organization: { asnOrg: 'Exemplo' } },
          },
        },
      },
    }),
  );
}

export function wafAlert(
  options: {
    account?: string;
    bucket?: string;
    webaclId?: string | null;
    clientIp?: string;
    /**
     * `httpRequest.requestId`. Atrás do ALB é o trace ID (`1-<8 hex>-<24 hex>`), que o cliente HTTP pode escolher
     * pelo cabeçalho `X-Amzn-Trace-Id`; `null` tira o campo.
     */
    requestId?: string | null;
    /** `timestamp` do log do WAF, em milissegundos (o Wazuh grava `"<ms>.000000"`); `null` tira o campo. */
    loggedAt?: number | string | null;
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
      ...(options.loggedAt === null ? {} : { timestamp: options.loggedAt ?? 1793527200000 }),
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

/**
 * A regra de um alerta dos flow logs, como o wazuh-logtest do manager 4.14.9 a mostra: a do registro rejeitado (do
 * próprio Wazuh, de nível 4, abaixo do corte dos alertas do nó) e as duas correlações locais
 * (`infra/wazuh/config/manager/rules/verax_aws_flow_rules.xml`), a varredura e a insistência em porta de administração
 * remota.
 */
const VPC_FLOW_RULES = {
  record: {
    id: '80402',
    level: 4,
    description: 'AWS VPC Flow: [REJECT] - Interface: eni-0123456789abcdef0 - Protocol: 6.',
    groups: ['amazon', 'aws', 'aws_vpcflow'],
  },
  scan: {
    id: '100400',
    level: 8,
    description: 'Verax Control: Possível varredura de rede vinda do mesmo endereço (203.0.113.50).',
    groups: ['verax_aws_flow', 'aws_vpcflow'],
    frequency: 40,
    mitre: { id: ['T1046'], tactic: ['Discovery'], technique: ['Network Service Discovery'] },
  },
  insistence: {
    id: '100401',
    level: 10,
    description:
      'Verax Control: Insistência em porta de administração remota vinda do mesmo endereço (203.0.113.50 para 10.0.0.10, porta 22).',
    groups: ['verax_aws_flow', 'aws_vpcflow'],
    frequency: 15,
    mitre: { id: ['T1110'], tactic: ['Credential Access'], technique: ['Brute Force'] },
  },
} as const;

/**
 * Registro de um flow log da VPC como o tipo `vpcflow` do módulo o entrega (`source: vpc`): os 14 campos do formato
 * padrão, com o início e o fim em ISO 8601, e a conta da pasta lida em `aws_account_id`. `rule` diz que alerta é: o do
 * registro sozinho (`record`, o padrão; no nó ele não chega ao indexer, porque a regra fica abaixo do corte) ou o de
 * uma correlação (`scan` e `insistence`), em que o evento do alerta é o registro que fechou a contagem.
 */
export function vpcFlowAlert(
  options: {
    account?: string;
    bucket?: string;
    /** `account_id` do registro (o dono da interface); `null` tira o campo. */
    interfaceOwner?: string | null;
    interfaceId?: string;
    sourceIp?: string;
    sourcePort?: number;
    action?: string;
    start?: string;
    rule?: keyof typeof VPC_FLOW_RULES;
  } = {},
): Record<string, unknown> {
  const account = options.account ?? ALFA.accountId;
  const owner = options.interfaceOwner === undefined ? account : options.interfaceOwner;
  return document(
    { ...VPC_FLOW_RULES[options.rule ?? 'record'] },
    {
      log_info: {
        aws_account_alias: '',
        log_file: `AWSLogs/${account}/vpcflowlogs/sa-east-1/2026/11/01/${account}_vpcflowlogs_sa-east-1_fl-0123456789abcdef0_20261101T1000Z_a.log.gz`,
        s3bucket: options.bucket ?? 'fluxo-alfa',
      },
      version: '2',
      ...(owner === null ? {} : { account_id: owner }),
      interface_id: options.interfaceId ?? 'eni-0123456789abcdef0',
      srcaddr: options.sourceIp ?? '203.0.113.50',
      dstaddr: '10.0.0.10',
      srcport: options.sourcePort ?? 44321,
      dstport: 22,
      protocol: 6,
      packets: 1,
      bytes: 40,
      start: options.start ?? '2026-11-01T09:58:00Z',
      end: '2026-11-01T09:59:00Z',
      action: options.action ?? 'REJECT',
      log_status: 'OK',
      source: 'vpc',
      aws_account_id: account,
    },
  );
}

/**
 * Alerta de uma linha de um grupo do CloudWatch Logs, como o serviço `cloudwatchlogs` do módulo a entrega: a linha crua
 * vai ao analysisd com o `location` do módulo, e o alerta sai sem `data.integration`, sem conta e sem o nome do grupo.
 * Os campos de `data` são os que o decoder da linha leu (aqui, os do sshd).
 */
export function cloudWatchAlert(
  options: {
    level?: number;
    rule?: { id: string; description: string };
    data?: Record<string, unknown> | null;
    agentId?: string;
    location?: string;
  } = {},
): Record<string, unknown> {
  sequence += 1;
  const data = options.data === undefined ? { srcip: '203.0.113.50', srcuser: 'root' } : options.data;
  return {
    id: `1793527300.${String(sequence).padStart(6, '0')}`,
    timestamp: '2026-11-01T10:00:00.123+0000',
    rule: {
      id: options.rule?.id ?? '5712',
      level: options.level ?? 10,
      description: options.rule?.description ?? 'sshd: brute force trying to get access to the system.',
      groups: ['syslog', 'sshd', 'authentication_failures'],
      firedtimes: 1,
      mail: false,
      mitre: { id: ['T1110'], tactic: ['Credential Access'], technique: ['Brute Force'] },
    },
    agent: { id: options.agentId ?? '000', name: 'wazuh.manager' },
    manager: { name: 'wazuh.manager' },
    decoder: { name: 'sshd' },
    location: options.location ?? 'Wazuh-AWS',
    full_log:
      'Nov  1 10:00:00 ip-10-0-0-10 sshd[123]: Failed password for root from 203.0.113.50 port 44321 ssh2',
    ...(data === null ? {} : { data }),
  };
}

/** Cópia com alterações em `data.aws` (para montar casos inválidos). */
export function withAws(
  alert: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const data = alert['data'] as { aws: Record<string, unknown> };
  return { ...alert, data: { ...data, aws: { ...data.aws, ...changes } } };
}

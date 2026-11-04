import { describe, expect, it } from 'vitest';
import { normalizeTimestamp, parseWazuhAlert, type WazuhAwsAlert } from '../../src/alerts/wazuh-alert.js';
import {
  asWazuhWrites,
  cloudTrailAlert,
  guardDutyAlert,
  portProbeAlerts,
  wafAlert,
  withAws,
} from './fixtures.js';

function parsed(document: Record<string, unknown>): WazuhAwsAlert {
  const result = parseWazuhAlert(document);
  if (!result.ok) throw new Error(`esperado alerta válido, veio ${result.reason}`);
  return result.alert;
}

/**
 * Formato que o Wazuh grava: cada evento abaixo (`aws`, como o módulo aws-s3 o entrega ao analysisd, com dados
 * fictícios) passou pelo socket do wazuh-logtest do manager 4.14.9 (a imagem fixada em infra/wazuh/docker-compose.yml),
 * e `written` é o `data.aws` do alerta que saiu, sem mudança.
 */
const WAZUH_WRITTEN = {
  waf: {
    aws: {
      log_info: { aws_account_alias: '', log_file: 'waf/2026/11/01/w.gz', s3bucket: 'aws-waf-logs-alfa' },
      timestamp: 1793527200000,
      formatVersion: 1,
      webaclId: 'arn:aws:wafv2:sa-east-1:111122223333:regional/webacl/painel/0000',
      terminatingRuleId: 'AWS-AWSManagedRulesCommonRuleSet',
      terminatingRuleType: 'MANAGED_RULE_GROUP',
      action: 'BLOCK',
      nonTerminatingMatchingRules: [],
      requestHeadersInserted: null,
      responseCodeSent: null,
      httpSourceName: 'ALB',
      httpRequest: {
        clientIp: '203.0.113.50',
        country: 'BR',
        uri: '/login',
        args: '',
        httpVersion: 'HTTP/1.1',
        httpMethod: 'POST',
        requestId: '1-6720a0b0-0a1b2c3d4e5f6a7b8c9d0e1f',
      },
      source: 'waf',
    },
    written: {
      log_info: { log_file: 'waf/2026/11/01/w.gz', s3bucket: 'aws-waf-logs-alfa' },
      timestamp: '1793527200000.000000',
      formatVersion: '1',
      webaclId: 'arn:aws:wafv2:sa-east-1:111122223333:regional/webacl/painel/0000',
      terminatingRuleId: 'AWS-AWSManagedRulesCommonRuleSet',
      terminatingRuleType: 'MANAGED_RULE_GROUP',
      action: 'BLOCK',
      nonTerminatingMatchingRules: [],
      requestHeadersInserted: 'null',
      responseCodeSent: 'null',
      httpSourceName: 'ALB',
      httpRequest: {
        clientIp: '203.0.113.50',
        country: 'BR',
        uri: '/login',
        httpVersion: 'HTTP/1.1',
        httpMethod: 'POST',
        requestId: '1-6720a0b0-0a1b2c3d4e5f6a7b8c9d0e1f',
      },
      source: 'waf',
    },
  },
  portProbe: {
    aws: {
      log_info: {
        aws_account_alias: '',
        log_file: 'AWSLogs/111122223333/GuardDuty/sa-east-1/2026/11/01/f.jsonl.gz',
        s3bucket: 'guardduty-alfa',
      },
      schemaVersion: '2.0',
      accountId: '111122223333',
      region: 'sa-east-1',
      partition: 'aws',
      id: '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0',
      arn: 'arn:aws:guardduty:sa-east-1:111122223333:detector/0000/finding/5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0',
      type: 'Recon:EC2/PortProbeUnprotectedPort',
      resource: { resourceType: 'Instance', instanceDetails: { instanceId: 'i-0abc1234def567890' } },
      service: {
        serviceName: 'guardduty',
        count: 3,
        archived: false,
        action: {
          actionType: 'PORT_PROBE',
          portProbeAction: {
            blocked: false,
            portProbeDetails: {
              localPortDetails: { port: 22, portName: 'SSH' },
              remoteIpDetails: { ipAddressV4: '198.51.100.20' },
            },
          },
        },
      },
      severity: 5.5,
      createdAt: '2026-11-01T09:55:00.000Z',
      updatedAt: '2026-11-01T09:55:00.000Z',
      title: 'Porta desprotegida sendo sondada',
      source: 'guardduty',
    },
    written: {
      log_info: {
        log_file: 'AWSLogs/111122223333/GuardDuty/sa-east-1/2026/11/01/f.jsonl.gz',
        s3bucket: 'guardduty-alfa',
      },
      schemaVersion: '2.0',
      accountId: '111122223333',
      region: 'sa-east-1',
      partition: 'aws',
      id: '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0',
      arn: 'arn:aws:guardduty:sa-east-1:111122223333:detector/0000/finding/5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0',
      type: 'Recon:EC2/PortProbeUnprotectedPort',
      resource: { resourceType: 'Instance', instanceDetails: { instanceId: 'i-0abc1234def567890' } },
      service: {
        serviceName: 'guardduty',
        count: '3',
        archived: 'false',
        action: {
          actionType: 'PORT_PROBE',
          portProbeAction: {
            blocked: 'false',
            portProbeDetails: {
              localPortDetails: { port: '22', portName: 'SSH' },
              remoteIpDetails: { ipAddressV4: '198.51.100.20' },
            },
          },
        },
      },
      severity: '5.500000',
      createdAt: '2026-11-01T09:55:00.000Z',
      updatedAt: '2026-11-01T09:55:00.000Z',
      title: 'Porta desprotegida sendo sondada',
      source: 'guardduty',
    },
  },
} as const;

/** Alerta com o `data.aws` exatamente como o Wazuh gravou. */
function withWritten(alert: Record<string, unknown>, written: object): Record<string, unknown> {
  return { ...alert, data: { integration: 'aws', aws: structuredClone(written) } };
}

describe('alerta do Wazuh (T5.2 e T5.3)', () => {
  it('normaliza o horário do Wazuh (fuso sem dois-pontos) para UTC', () => {
    expect(normalizeTimestamp('2026-11-01T10:00:00.123+0000')).toBe('2026-11-01T10:00:00.123Z');
    expect(normalizeTimestamp('2026-11-01T07:00:00.123-0300')).toBe('2026-11-01T10:00:00.123Z');
    expect(normalizeTimestamp('2026-11-01T10:00:00Z')).toBe('2026-11-01T10:00:00.000Z');
    for (const invalid of ['ontem', '2026-11-01', '2026-13-01T10:00:00Z', '2026-11-01T10:00:00+99']) {
      expect(normalizeTimestamp(invalid)).toBeNull();
    }
  });

  it('CloudTrail: regra, conta da pasta, identidade, chave, IP e recurso', () => {
    const alert = parsed(
      cloudTrailAlert({ eventName: 'PutBucketPolicy', requestParameters: { bucketName: 'dados-alfa' } }),
    );
    expect(alert).toMatchObject({
      timestamp: '2026-11-01T10:00:00.123Z',
      rule: { id: '80254', level: 5, groups: ['amazon', 'aws', 'authentication_failed', 'aws_cloudtrail'] },
      source: 'cloudtrail',
      bucket: 'trilha-alfa',
      accounts: ['111122223333'],
      region: 'sa-east-1',
      eventName: 'PutBucketPolicy',
      actor: {
        user: 'arn:aws:iam::111122223333:user/ana',
        identityType: 'IAMUser',
        accessKeyId: 'AKIAEXEMPLO000000000',
        ip: '203.0.113.50',
      },
      resource: 's3:dados-alfa',
    });
  });

  it('CloudTrail: chamada feita por serviço da AWS não tem IP; identidade root', () => {
    const alert = parsed(
      cloudTrailAlert({
        sourceIp: 'ec2.amazonaws.com',
        identity: { type: 'Root', arn: 'arn:aws:iam::111122223333:root', accountId: '111122223333' },
      }),
    );
    expect(alert.actor).toEqual({ user: 'arn:aws:iam::111122223333:root', identityType: 'Root' });
  });

  it('GuardDuty: severidade da AWS, tipo, chave usada, IP remoto, instância e MITRE', () => {
    const alert = parsed(guardDutyAlert({ severity: 8.5 }));
    expect(alert).toMatchObject({
      source: 'guardduty',
      bucket: 'guardduty-alfa',
      accounts: ['111122223333'],
      awsSeverity: 8.5,
      eventName: 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
      actor: {
        user: 'papel-da-aplicacao',
        identityType: 'AssumedRole',
        accessKeyId: 'ASIAEXEMPLO000000000',
        ip: '198.51.100.7',
      },
      resource: 'ec2:i-0abc1234def567890',
    });
    expect(alert.rule.mitre).toEqual({
      ids: ['T1078'],
      tactics: ['Initial Access'],
      techniques: ['Valid Accounts'],
    });
  });

  it('GuardDuty: a severidade em texto, como o Wazuh grava, vale o mesmo que em número; fora da faixa, fica ausente', () => {
    const severityOf = (severity: unknown) => parsed(withAws(guardDutyAlert(), { severity })).awsSeverity;
    expect(severityOf('8')).toBe(8);
    expect(severityOf('5.500000')).toBe(5.5);
    expect(severityOf('10')).toBe(10);
    expect(severityOf('0')).toBe(0);
    expect(severityOf(8.5)).toBe(8.5);
    for (const invalid of [
      '11',
      '10.000001',
      '-1',
      'alta',
      '8.5.1',
      '',
      'NaN',
      'Infinity',
      ' 8',
      '8e0',
      true,
    ]) {
      expect(severityOf(invalid)).toBeUndefined();
    }
  });

  it('GuardDuty: lista de um item vira objeto no wodle, e as duas formas são lidas', () => {
    const bucket = { name: 'dados-alfa', arn: 'arn:aws:s3:::dados-alfa' };
    for (const s3BucketDetails of [bucket, [bucket]]) {
      const alert = parsed(guardDutyAlert({ resource: { resourceType: 'S3Bucket', s3BucketDetails } }));
      expect(alert.resource).toBe('s3:dados-alfa');
    }
  });

  it('WAF: IP do cliente, região e conta pelo ARN da Web ACL, ação e regra', () => {
    const alert = parsed(wafAlert());
    expect(alert).toMatchObject({
      source: 'waf',
      accounts: ['111122223333'],
      region: 'sa-east-1',
      eventName: 'BLOCK:AWS-AWSManagedRulesCommonRuleSet',
      actor: { ip: '203.0.113.50' },
      resource: 'waf:arn:aws:wafv2:sa-east-1:111122223333:regional/webacl/painel/0000',
    });
  });

  it('ID do evento na AWS de cada fonte: eventID, id do achado e, no WAF, horário, IP e requestId (fase 2, PR-W2)', () => {
    const eventId = '7a3c9e1f-0b2d-4c6e-8f10-2a4b6c8d0e1f';
    const findingId = '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0';
    const requestId = '1-6720a0b0-0a1b2c3d4e5f6a7b8c9d0e1f';
    expect(parsed(cloudTrailAlert({ eventId })).nativeId).toBe(eventId);
    expect(parsed(guardDutyAlert({ findingId })).nativeId).toBe(findingId);
    expect(parsed(wafAlert({ requestId })).nativeId).toBe(`1793527200000/203.0.113.50/${requestId}`);
    // ID de requisição do CloudFront, em base64, e IP do cliente em IPv6.
    const cloudFront = 'kWOMOnhtc0bYcI9eH1Q4ilGWHbACUtz3FrEdZ6uWoPHqDGMkMt1Wyg==';
    expect(parsed(wafAlert({ requestId: cloudFront, clientIp: '2001:db8::7' })).nativeId).toBe(
      `1793527200000/2001:db8::7/${cloudFront}`,
    );
    // O Wazuh grava o horário (13 dígitos, fora dos 32 bits) com seis casas; em número ou em texto sem casas, o id
    // é o mesmo.
    const waf = wafAlert({ requestId });
    expect((waf['data'] as { aws: Record<string, unknown> }).aws['timestamp']).toBe('1793527200000.000000');
    for (const timestamp of [1793527200000, '1793527200000', '1793527200000.0', '1793527200000.000000']) {
      expect(parsed(withAws(waf, { timestamp })).nativeId).toBe(`1793527200000/203.0.113.50/${requestId}`);
    }
    // O id do alerta muda a cada leitura; o da AWS, não.
    const again = { ...cloudTrailAlert({ eventId }), id: '1793600000.000099' };
    expect(parsed(again).nativeId).toBe(eventId);
  });

  it('WAF: o requestId repetido pelo cliente (trace ID do ALB) não junta requisições diferentes', () => {
    // Quem ataca manda sempre o mesmo `X-Amzn-Trace-Id: Root=...`, e o WAF atrás do ALB o grava como requestId.
    const root = '1-6720a0b0-000000000000000000000000';
    const first = parsed(wafAlert({ requestId: root, loggedAt: 1793527200000 })).nativeId;
    const later = parsed(wafAlert({ requestId: root, loggedAt: 1793527260123 })).nativeId;
    const otherIp = parsed(
      wafAlert({ requestId: root, loggedAt: 1793527200000, clientIp: '203.0.113.51' }),
    ).nativeId;
    expect(new Set([first, later, otherIp]).size).toBe(3);
    // A mesma requisição relida continua com o mesmo id.
    expect(parsed(wafAlert({ requestId: root, loggedAt: 1793527200000 })).nativeId).toBe(first);
  });

  it('formato que o Wazuh grava (wazuh-logtest 4.14.9): WAF e sondagem de porta com id nativo e severidade', () => {
    // As fixtures gravam como o Wazuh.
    expect(asWazuhWrites(WAZUH_WRITTEN.waf.aws)).toEqual(WAZUH_WRITTEN.waf.written);
    expect(asWazuhWrites(WAZUH_WRITTEN.portProbe.aws)).toEqual(WAZUH_WRITTEN.portProbe.written);

    const waf = withWritten(wafAlert(), WAZUH_WRITTEN.waf.written);
    expect(parsed(waf).nativeId).toBe('1793527200000/203.0.113.50/1-6720a0b0-0a1b2c3d4e5f6a7b8c9d0e1f');
    // Relido (`--reparse`, o wodle lendo o mesmo objeto do S3), ganha outro id de alerta e o mesmo id nativo.
    expect(parsed({ ...waf, id: '1793600000.000777' }).nativeId).toBe(parsed(waf).nativeId);

    expect(parsed(withWritten(guardDutyAlert(), WAZUH_WRITTEN.portProbe.written))).toMatchObject({
      nativeId: '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0/198.51.100.20:22',
      awsSeverity: 5.5,
      accounts: ['111122223333'],
      actor: { ip: '198.51.100.20' },
      resource: 'ec2:i-0abc1234def567890',
    });
  });

  it('GuardDuty: cada item da sondagem de porta, que o wodle separa com o mesmo id, tem id próprio', () => {
    const findingId = '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0';
    const alerts = portProbeAlerts(
      [
        { ip: '198.51.100.20', port: 22 },
        { ip: '198.51.100.21', port: 22 },
        { ip: '198.51.100.20', port: 3389 },
      ],
      { findingId },
    ).map(parsed);
    expect(alerts.map((alert) => alert.nativeId)).toEqual([
      `${findingId}/198.51.100.20:22`,
      `${findingId}/198.51.100.21:22`,
      `${findingId}/198.51.100.20:3389`,
    ]);
    expect(alerts.map((alert) => alert.actor.ip)).toEqual([
      '198.51.100.20',
      '198.51.100.21',
      '198.51.100.20',
    ]);
    // A porta como o Wazuh grava ("22") e em número dão o mesmo id.
    const remote = { ipAddressV4: '198.51.100.20' };
    const probe = (portProbeDetails: unknown) =>
      parsed(
        guardDutyAlert({
          findingId,
          action: { actionType: 'PORT_PROBE', portProbeAction: { blocked: false, portProbeDetails } },
        }),
      ).nativeId;
    const rawProbe = (port: unknown) =>
      parsed(
        withAws(guardDutyAlert({ findingId }), {
          service: {
            action: {
              actionType: 'PORT_PROBE',
              portProbeAction: { portProbeDetails: { localPortDetails: { port }, remoteIpDetails: remote } },
            },
          },
        }),
      ).nativeId;
    for (const port of [22, '22', '22.000000']) {
      expect(rawProbe(port)).toBe(`${findingId}/198.51.100.20:22`);
    }
    // Sem `portProbeDetails`, vale só o id do achado.
    expect(probe(undefined)).toBe(findingId);
  });

  it('sem ID da AWS, ou fora do formato, o alerta segue válido, sem id nativo', () => {
    expect(parsed(cloudTrailAlert({ eventId: null })).nativeId).toBeUndefined();
    expect(parsed(wafAlert({ requestId: null })).nativeId).toBeUndefined();
    for (const eventID of ['', 'com espaço', 'x'.repeat(129), 'quebra\nde linha', 42, { id: 'objeto' }]) {
      expect(parsed(withAws(cloudTrailAlert(), { eventID })).nativeId).toBeUndefined();
    }
    expect(parsed(withAws(guardDutyAlert(), { id: ['lista'] })).nativeId).toBeUndefined();
    // O id de outra fonte não vale: no CloudTrail, só o eventID.
    expect(parsed(withAws(cloudTrailAlert({ eventId: null }), { id: 'abc' })).nativeId).toBeUndefined();
    // WAF sem horário ou sem IP do cliente válido: o requestId sozinho não basta.
    for (const loggedAt of [null, -1, 1.5, '17935x', '']) {
      expect(parsed(wafAlert({ loggedAt })).nativeId).toBeUndefined();
    }
    // Horário com fração, casas demais, notação científica ou acima do maior inteiro exato, gravado como veio.
    for (const timestamp of [
      1.5,
      '1793527200000.5',
      '1793527200000.500000',
      '1793527200000.',
      '1793527200000.0000000',
      '.000000',
      '1.79352720000e12',
      ' 1793527200000',
      '9999999999999999',
    ]) {
      expect(parsed(withAws(wafAlert(), { timestamp })).nativeId).toBeUndefined();
    }
    for (const clientIp of ['fe80::1%eth0', 'não é ip', '999.1.1.1']) {
      expect(parsed(wafAlert({ clientIp })).nativeId).toBeUndefined();
    }
    // Sondagem de porta com item fora do formato (sem IPv4, porta inválida, lista): nunca junta dois IPs.
    const probe = (portProbeDetails: unknown) =>
      parsed(guardDutyAlert({ action: { actionType: 'PORT_PROBE', portProbeAction: { portProbeDetails } } }))
        .nativeId;
    const remote = { ipAddressV4: '198.51.100.20' };
    for (const portProbeDetails of [
      { localPortDetails: { port: 22 }, remoteIpDetails: { ipAddressV6: '2001:db8::1' } },
      { localPortDetails: { port: 70000 }, remoteIpDetails: remote },
      { remoteIpDetails: remote },
      [
        { localPortDetails: { port: 22 }, remoteIpDetails: remote },
        { localPortDetails: { port: 22 }, remoteIpDetails: { ipAddressV4: '198.51.100.21' } },
      ],
      'texto',
    ]) {
      expect(probe(portProbeDetails)).toBeUndefined();
    }
  });

  it('não guarda nada além do que usa: evento bruto, correlações anteriores e cabeçalhos ficam de fora', () => {
    const serialized = JSON.stringify([parsed(cloudTrailAlert()), parsed(wafAlert())]);
    for (const leaked of ['conteudo', 'evento anterior', 'token-do-usuario', 'ConsoleLogin":"Failure']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it('valor fora do formato vira ausente (controle, tamanho, IP inválido, chave inválida)', () => {
    const alert = parsed(
      cloudTrailAlert({
        sourceIp: '999.1.1.1',
        identity: { type: 'IAMUser', userName: 'ana\nFALSO', accessKeyId: 'chave-qualquer' },
        requestParameters: { bucketName: 'X'.repeat(300) },
      }),
    );
    expect(alert.actor).toEqual({ identityType: 'IAMUser' });
    expect(alert.resource).toBeUndefined();
  });

  it('alerta que não veio do módulo AWS é ignorado; envelope inválido é recusado com o id', () => {
    const notAws: Record<string, unknown> = { ...cloudTrailAlert(), data: { integration: 'syscheck' } };
    expect(parseWazuhAlert(notAws)).toEqual({ ok: false, reason: 'not_aws', id: notAws['id'] });

    const invalid = [
      { ...cloudTrailAlert(), rule: { id: '80254', level: 99, description: 'x' } },
      { ...cloudTrailAlert(), timestamp: 'ontem' },
      withAws(cloudTrailAlert(), { source: 'vpc' }),
      withAws(cloudTrailAlert(), { log_info: {} }),
    ];
    for (const document of invalid) {
      expect(parseWazuhAlert(document)).toEqual({ ok: false, reason: 'invalid_alert', id: document['id'] });
    }
    expect(parseWazuhAlert(null)).toEqual({ ok: false, reason: 'invalid_alert', id: null });
    expect(parseWazuhAlert({ id: '" OR 1=1' })).toEqual({ ok: false, reason: 'invalid_alert', id: null });
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeTimestamp, parseWazuhAlert, type WazuhAwsAlert } from '../../src/alerts/wazuh-alert.js';
import { cloudTrailAlert, guardDutyAlert, portProbeAlerts, wafAlert, withAws } from './fixtures.js';

function parsed(document: Record<string, unknown>): WazuhAwsAlert {
  const result = parseWazuhAlert(document);
  if (!result.ok) throw new Error(`esperado alerta válido, veio ${result.reason}`);
  return result.alert;
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
    // O horário em texto dá o mesmo id.
    expect(parsed(wafAlert({ requestId, loggedAt: '1793527200000' })).nativeId).toBe(
      parsed(wafAlert({ requestId })).nativeId,
    );
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
    // A porta em texto dá o mesmo id.
    const probe = (portProbeDetails: unknown) =>
      parsed(
        guardDutyAlert({
          findingId,
          action: { actionType: 'PORT_PROBE', portProbeAction: { blocked: false, portProbeDetails } },
        }),
      ).nativeId;
    expect(
      probe({ localPortDetails: { port: '22' }, remoteIpDetails: { ipAddressV4: '198.51.100.20' } }),
    ).toBe(`${findingId}/198.51.100.20:22`);
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

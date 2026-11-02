import { describe, expect, it } from 'vitest';
import { normalizeTimestamp, parseWazuhAlert, type WazuhAwsAlert } from '../../src/alerts/wazuh-alert.js';
import { cloudTrailAlert, guardDutyAlert, wafAlert, withAws } from './fixtures.js';

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

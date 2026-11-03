import { describe, expect, it } from 'vitest';
import { AccountDirectory, resolveAlertOwner } from '../../src/alerts/alert-owner.js';
import { findingSeverity, toFindingDraft } from '../../src/alerts/finding-draft.js';
import { sanitizeRawAlert } from '../../src/alerts/raw-alert.js';
import {
  DEFAULT_SYNC_SETTINGS,
  cursorFromSort,
  syncPage,
  syncWindowStart,
} from '../../src/alerts/sync-query.js';
import { parseWazuhAlert, type WazuhAwsAlert } from '../../src/alerts/wazuh-alert.js';
import { assertStructuredQuery } from '../../src/indexer/alert-queries.js';
import { ALFA, BETA, cloudTrailAlert, guardDutyAlert, wafAlert } from './fixtures.js';

const directory = AccountDirectory.from([ALFA, BETA]);

function alertOf(document: Record<string, unknown>): WazuhAwsAlert {
  const parsed = parseWazuhAlert(document);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.alert;
}

describe('de alerta a achado (T5.3)', () => {
  it('GuardDuty usa a severidade da AWS, nas faixas do GuardDuty', () => {
    const cases: [number, string][] = [
      [10, 'critical'],
      [9, 'critical'],
      [8.9, 'high'],
      [7, 'high'],
      [6.9, 'medium'],
      [4, 'medium'],
      [3.9, 'low'],
      [0, 'low'],
    ];
    for (const [severity, expected] of cases) {
      expect(findingSeverity(alertOf(guardDutyAlert({ severity })))).toBe(expected);
    }
  });

  it('as outras fontes usam o nível da regra do Wazuh', () => {
    const cases: [number, string][] = [
      [15, 'critical'],
      [12, 'critical'],
      [11, 'high'],
      [10, 'high'],
      [9, 'medium'],
      [7, 'medium'],
      [6, 'low'],
      [5, 'low'],
    ];
    for (const [level, expected] of cases) {
      expect(findingSeverity(alertOf(cloudTrailAlert({ level })))).toBe(expected);
    }
    // A rajada de bloqueios do WAF (80443) tem nível 10.
    expect(findingSeverity(alertOf(wafAlert()))).toBe('high');
  });

  it('o achado leva o cliente decidido pela T5.2 e o id do alerta como chave de idempotência', () => {
    const alert = alertOf(guardDutyAlert());
    const owner = resolveAlertOwner(alert, directory);
    if (!owner.owned) throw new Error(owner.reason);
    expect(toFindingDraft(alert, owner)).toEqual({
      tenantId: ALFA.tenantId,
      accountId: ALFA.accountId,
      source: 'wazuh',
      sourceEventId: alert.id,
      occurredAt: '2026-11-01T10:00:00.123Z',
      severity: 'high',
      ruleId: '80303',
      ruleLevel: 10,
      title: 'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.',
      logSource: 'guardduty',
      eventName: 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
      region: 'sa-east-1',
      resource: 'ec2:i-0abc1234def567890',
      actorUser: 'papel-da-aplicacao',
      actorType: 'AssumedRole',
      accessKeyId: 'ASIAEXEMPLO000000000',
      sourceIp: '198.51.100.7',
      mitreTactics: ['Initial Access'],
      mitreTechniques: ['T1078'],
    });
  });

  it('campos ausentes viram null, não somem', () => {
    const alert = alertOf(wafAlert());
    const draft = toFindingDraft(alert, { owned: true, tenantId: ALFA.tenantId, accountId: ALFA.accountId });
    expect(draft).toMatchObject({ actorUser: null, actorType: null, accessKeyId: null, mitreTactics: [] });
  });
});

describe('evento bruto saneado para o detalhe (T5.4)', () => {
  it('tira o log bruto e as correlações anteriores em qualquer nível', () => {
    const raw = { ...cloudTrailAlert(), nested: { previous_output: 'outra conta', keep: 1 } };
    const clean = JSON.stringify(sanitizeRawAlert(raw));
    expect(clean).not.toContain('full_log');
    expect(clean).not.toContain('previous_output');
    expect(clean).toContain('"keep":1');
    expect(clean).toContain('ConsoleLogin');
  });

  it('troca o valor dos cabeçalhos de credencial, sem diferenciar maiúsculas', () => {
    type WithHeaders = { data: { aws: { httpRequest: { headers: Record<string, string> } } } };
    const raw = wafAlert();
    const headers = (raw as WithHeaders).data.aws.httpRequest.headers;
    headers['Cookie'] = 'sessao=abc';
    headers['X-Api-Key'] = 'chave';
    const clean = sanitizeRawAlert(raw) as WithHeaders;
    expect(clean.data.aws.httpRequest.headers).toEqual({
      Host: 'app.exemplo',
      authorization: '[removido]',
      Cookie: '[removido]',
      'X-Api-Key': '[removido]',
    });
  });

  it('chave de protótipo vinda do documento não contamina objetos, e a profundidade é limitada', () => {
    const raw: unknown = JSON.parse('{"a":{"__proto__":{"poluido":true},"constructor":{"x":1},"b":2}}');
    const clean = sanitizeRawAlert(raw) as { a: Record<string, unknown> };
    expect(clean.a).toEqual({ b: 2 });
    expect(({} as Record<string, unknown>)['poluido']).toBeUndefined();

    let deep: unknown = 'fundo';
    for (let i = 0; i < 40; i++) deep = { nivel: deep };
    expect(JSON.stringify(sanitizeRawAlert(deep))).toContain('[truncado]');
  });
});

describe('leitura incremental (T5.3)', () => {
  const now = new Date('2026-11-01T12:00:00.000Z');

  it('relê uma sobreposição antes do último alerta; na primeira vez, olha 24 h para trás', () => {
    expect(syncWindowStart('2026-11-01T11:30:00.000Z', now, DEFAULT_SYNC_SETTINGS)).toBe(
      '2026-11-01T11:20:00.000Z',
    );
    expect(syncWindowStart(null, now, DEFAULT_SYNC_SETTINGS)).toBe('2026-10-31T12:00:00.000Z');
    expect(() => syncWindowStart('ontem', now, DEFAULT_SYNC_SETTINGS)).toThrow(RangeError);
  });

  it('página só com alertas da AWS, das fontes coletadas, a partir do nível mínimo, em DSL estruturado', () => {
    const page = syncPage('2026-11-01T11:20:00.000Z', null, DEFAULT_SYNC_SETTINGS);
    expect(page.body['query']).toEqual({
      bool: {
        filter: [
          { range: { timestamp: { gte: '2026-11-01T11:20:00.000Z' } } },
          { term: { 'data.integration': 'aws' } },
          { terms: { 'data.aws.source': ['cloudtrail', 'guardduty', 'waf'] } },
          { range: { 'rule.level': { gte: 5 } } },
        ],
      },
    });
    expect(page.body['size']).toBe(500);
    expect(() => assertStructuredQuery(page.body)).not.toThrow();
  });

  it('o cursor vem da ordenação devolvida pelo indexer (horário em ms e id)', () => {
    const cursor = cursorFromSort([1793527200123, '1793527200.000042']);
    expect(cursor).toEqual({ timestamp: '2026-11-01T10:00:00.123Z', id: '1793527200.000042' });
    const next = syncPage('2026-11-01T09:50:00.000Z', cursor, DEFAULT_SYNC_SETTINGS);
    expect(next.body['search_after']).toEqual(['2026-11-01T10:00:00.123Z', '1793527200.000042']);
    for (const invalid of [[], ['abc', 'x'], [1793527200123], [1.5, 'x'], [1793527200123, 7]]) {
      expect(() => cursorFromSort(invalid)).toThrow(RangeError);
    }
  });
});

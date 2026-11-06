import { describe, expect, it } from 'vitest';
import { AccountDirectory, resolveAlertOwner } from '../../src/alerts/alert-owner.js';
import { findingSeverity, toFindingDraft, wazuhFindingKey } from '../../src/alerts/finding-draft.js';
import { sanitizeRawAlert } from '../../src/alerts/raw-alert.js';
import {
  AGENT_MIN_LEVEL,
  agentSyncPage,
  DEFAULT_AGENT_SYNC_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  cursorFromSort,
  syncPage,
  syncWindowStart,
} from '../../src/alerts/sync-query.js';
import { parseWazuhAlert, type WazuhAwsAlert } from '../../src/alerts/wazuh-alert.js';
import { assertStructuredQuery } from '../../src/indexer/alert-queries.js';
import {
  ALFA,
  BETA,
  cloudTrailAlert,
  guardDutyAlert,
  portProbeAlerts,
  wafAlert,
  withAws,
} from './fixtures.js';

const directory = AccountDirectory.from([ALFA, BETA]);

function alertOf(document: Record<string, unknown>): WazuhAwsAlert {
  const parsed = parseWazuhAlert(document);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.alert;
}

describe('de alerta a achado (T5.3)', () => {
  it('GuardDuty usa a severidade da AWS, nas faixas do GuardDuty', () => {
    // A fixture grava a severidade em texto, como o Wazuh ("8.900000", "10"), e a regra padrão tem nível 10 (alta):
    // cada faixa diferente de alta só sai da severidade da AWS.
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

  it('o achado leva o cliente decidido pela T5.2, a chave do evento na AWS e o id do alerta para o evento bruto', () => {
    const alert = alertOf(guardDutyAlert({ findingId: '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0' }));
    const owner = resolveAlertOwner(alert, directory);
    if (!owner.owned) throw new Error(owner.reason);
    expect(toFindingDraft(alert, owner)).toEqual({
      tenantId: ALFA.tenantId,
      accountId: ALFA.accountId,
      source: 'wazuh',
      sourceEventId: 'wazuh/111122223333/guardduty:5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0:80303',
      rawEventId: alert.id,
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
      // Só o GuardDuty: a versão (o `updatedAt`), a chave do achado inteiro (a cadeia, aqui igual à base) e a chave
      // que a versão nova ganha se a cadeia já estiver triada.
      recurrence: {
        lastSeenAt: '2026-11-01T09:55:00.000Z',
        chainKey: 'wazuh/111122223333/guardduty:5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0:80303',
        sourceEventId:
          'wazuh/111122223333/guardduty:5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0:80303@2026-11-01T09:55:00.000Z',
      },
    });
  });

  it('campos ausentes viram null, não somem; sem versão ou sem id nativo, não há recorrência', () => {
    const owner = { owned: true, tenantId: ALFA.tenantId, accountId: ALFA.accountId } as const;
    const alert = alertOf(wafAlert());
    const draft = toFindingDraft(alert, owner);
    expect(draft).toMatchObject({ actorUser: null, actorType: null, accessKeyId: null, mitreTactics: [] });
    expect(draft).not.toHaveProperty('recurrence');
    // O `updatedAt` fora do formato deixa o achado sem versão, mesmo com o `eventLastSeen` em dia.
    const bare = alertOf(guardDutyAlert({ eventLastSeen: '2026-11-01T09:55:00.000Z', updatedAt: 'ontem' }));
    expect(bare.lastSeenAt).toBeUndefined();
    expect(toFindingDraft(bare, owner)).not.toHaveProperty('recurrence');
    // A sondagem com item fora do formato fica sem id nativo: a chave é a do alerta, que nunca repete.
    const unkeyed = alertOf(
      guardDutyAlert({
        action: { actionType: 'PORT_PROBE', portProbeAction: { portProbeDetails: 'texto' } },
      }),
    );
    expect(unkeyed).toMatchObject({ nativeId: undefined, lastSeenAt: '2026-11-01T09:55:00.000Z' });
    expect(toFindingDraft(unkeyed, owner)).not.toHaveProperty('recurrence');
  });

  it('a regra com título fixo dá o título em português, sem os campos que a descrição cita (PR-V7)', () => {
    const owner = { owned: true, tenantId: ALFA.tenantId, accountId: ALFA.accountId } as const;
    const critical = alertOf(
      cloudTrailAlert({
        eventName: 'StopLogging',
        level: 12,
        rule: { id: '100310', description: 'Verax Control: CloudTrail parado ou apagado (StopLogging).' },
      }),
    );
    expect(toFindingDraft(critical, owner)).toMatchObject({
      ruleId: '100310',
      severity: 'critical',
      title: 'CloudTrail parado ou apagado',
      eventName: 'StopLogging',
    });
    // O login com falha (a regra padrão da fixture) também tem título; o GuardDuty segue com a descrição.
    expect(toFindingDraft(alertOf(cloudTrailAlert()), owner).title).toBe('Login no console com falha');
    expect(toFindingDraft(alertOf(guardDutyAlert()), owner).title).toBe(
      'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.',
    );
  });
});

describe('chave estável do achado (fase 2, PR-W2)', () => {
  const eventId = '7a3c9e1f-0b2d-4c6e-8f10-2a4b6c8d0e1f';

  it('cada fonte pelo próprio ID na AWS, com a conta e a regra', () => {
    expect(wazuhFindingKey(alertOf(cloudTrailAlert({ eventId })), ALFA.accountId)).toBe(
      `wazuh/111122223333/cloudtrail:${eventId}:80254`,
    );
    expect(
      wazuhFindingKey(
        alertOf(guardDutyAlert({ findingId: '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0' })),
        ALFA.accountId,
      ),
    ).toBe('wazuh/111122223333/guardduty:5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0:80303');
    expect(
      wazuhFindingKey(
        alertOf(wafAlert({ requestId: '1-6720a0b0-0a1b2c3d4e5f6a7b8c9d0e1f' })),
        ALFA.accountId,
      ),
    ).toBe('wazuh/111122223333/waf:1793527200000/203.0.113.50/1-6720a0b0-0a1b2c3d4e5f6a7b8c9d0e1f:80443');
    const [probe] = portProbeAlerts([{ ip: '198.51.100.20', port: 22 }], {
      findingId: '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0',
    });
    expect(wazuhFindingKey(alertOf(probe!), ALFA.accountId)).toBe(
      'wazuh/111122223333/guardduty:5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0/198.51.100.20:22:80305',
    );
  });

  it('o que a AWS repete em eventos diferentes não junta achados: sondagem de cada IP, requisição do WAF', () => {
    const probes = portProbeAlerts([
      { ip: '198.51.100.20', port: 22 },
      { ip: '198.51.100.21', port: 22 },
    ]).map(alertOf);
    expect(new Set(probes.map((alert) => wazuhFindingKey(alert, ALFA.accountId))).size).toBe(2);
    // Trace ID fixo no ALB: cada rajada nova, em outro horário, tem chave própria.
    const root = '1-6720a0b0-000000000000000000000000';
    const bursts = [1793527200000, 1793613600000].map((loggedAt) =>
      alertOf(wafAlert({ requestId: root, loggedAt })),
    );
    expect(new Set(bursts.map((alert) => wazuhFindingKey(alert, ALFA.accountId))).size).toBe(2);
  });

  it('o mesmo evento lido de novo, com outro id de alerta, cai na mesma chave', () => {
    const first = alertOf(cloudTrailAlert({ eventId }));
    const reparsed = alertOf({ ...cloudTrailAlert({ eventId }), id: '1793600000.000123' });
    expect(reparsed.id).not.toBe(first.id);
    expect(wazuhFindingKey(reparsed, ALFA.accountId)).toBe(wazuhFindingKey(first, ALFA.accountId));
    // O GuardDuty atualiza o achado (contagem e hora) com o mesmo id: a chave não muda.
    const findingId = '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0';
    const updated = alertOf(guardDutyAlert({ findingId, count: 7, updatedAt: '2026-11-02T08:00:00.000Z' }));
    expect(wazuhFindingKey(updated, ALFA.accountId)).toBe(
      wazuhFindingKey(alertOf(guardDutyAlert({ findingId })), ALFA.accountId),
    );
  });

  it('a recorrência do GuardDuty leva a chave do achado inteiro mais o horário da versão (fix da reincidência)', () => {
    const findingId = '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0';
    const at = '2026-11-02T08:00:00.000Z';
    const updated = alertOf(guardDutyAlert({ findingId, count: 7, updatedAt: at }));
    const base = wazuhFindingKey(updated, ALFA.accountId);
    expect(base).toBe(`wazuh/111122223333/guardduty:${findingId}:80303`);
    expect(wazuhFindingKey(updated, ALFA.accountId, at)).toBe(`${base}@${at}`);
    // A mesma versão relida (outro id de alerta) dá a mesma chave; outra versão, outra chave.
    const reread = alertOf({
      ...guardDutyAlert({ findingId, count: 7, updatedAt: at }),
      id: '1793600000.000123',
    });
    expect(wazuhFindingKey(reread, ALFA.accountId, reread.lastSeenAt)).toBe(`${base}@${at}`);
    expect(wazuhFindingKey(updated, ALFA.accountId, '2026-11-03T08:00:00.000Z')).toBe(
      `${base}@2026-11-03T08:00:00.000Z`,
    );
    // O rascunho leva as três chaves: a base, que é tentada primeiro, a da cadeia e a da recorrência.
    const owner = resolveAlertOwner(updated, directory);
    if (!owner.owned) throw new Error(owner.reason);
    expect(toFindingDraft(updated, owner)).toMatchObject({
      sourceEventId: base,
      recurrence: { lastSeenAt: at, chainKey: base, sourceEventId: `${base}@${at}` },
    });
    // Na sondagem de porta, a chave base leva o IP e a porta do item; a cadeia e a recorrência levam só o achado
    // inteiro, iguais em todos os itens da versão: a versão nova é uma por achado, não uma por IP.
    const probes = portProbeAlerts(
      [
        { ip: '198.51.100.20', port: 22 },
        { ip: '198.51.100.21', port: 3389 },
      ],
      { findingId, updatedAt: at },
    ).map((probe) => toFindingDraft(alertOf(probe), owner));
    expect(probes.map((draft) => draft.sourceEventId)).toEqual([
      `wazuh/111122223333/guardduty:${findingId}/198.51.100.20:22:80305`,
      `wazuh/111122223333/guardduty:${findingId}/198.51.100.21:3389:80305`,
    ]);
    const chain = `wazuh/111122223333/guardduty:${findingId}:80305`;
    for (const draft of probes) {
      expect(draft.recurrence).toEqual({ lastSeenAt: at, chainKey: chain, sourceEventId: `${chain}@${at}` });
    }
    // Um id que cabe na coluna sozinho, mas não com o horário: a recorrência entra pelo resumo, e a chave cabe.
    const longId = 'f'.repeat(80);
    const long = toFindingDraft(alertOf(guardDutyAlert({ findingId: longId, updatedAt: at })), owner);
    expect(long.sourceEventId).toBe(`wazuh/111122223333/guardduty:${longId}:80303`);
    expect(long.recurrence?.chainKey).toBe(long.sourceEventId);
    expect(long.recurrence?.sourceEventId).toMatch(
      /^wazuh\/111122223333\/guardduty:sha256-[0-9a-f]{40}:80303@2026-11-02T08:00:00\.000Z$/,
    );
    expect(long.recurrence?.sourceEventId.length).toBeLessThanOrEqual(128);
  });

  it('a correlação tem chave própria, mesmo terminando no mesmo evento', () => {
    const single = alertOf(cloudTrailAlert({ eventId }));
    const burst = alertOf(
      cloudTrailAlert({
        eventId,
        level: 10,
        rule: {
          id: '80255',
          description: 'AWS Cloudtrail: Possible breakin attempt (high number of login attempts).',
        },
      }),
    );
    expect(wazuhFindingKey(burst, ALFA.accountId)).toBe(`wazuh/111122223333/cloudtrail:${eventId}:80255`);
    expect(wazuhFindingKey(burst, ALFA.accountId)).not.toBe(wazuhFindingKey(single, ALFA.accountId));
  });

  it('o mesmo ID em contas diferentes não se encontra', () => {
    const alert = alertOf(cloudTrailAlert({ eventId }));
    expect(wazuhFindingKey(alert, ALFA.accountId)).not.toBe(wazuhFindingKey(alert, BETA.accountId));
  });

  it('sem ID da AWS, vale o id do alerta, com o tipo alert', () => {
    const alert = alertOf(wafAlert({ requestId: null }));
    expect(wazuhFindingKey(alert, ALFA.accountId)).toBe(`wazuh/111122223333/alert:${alert.id}:80443`);
    const invalid = alertOf(withAws(cloudTrailAlert(), { eventID: 'com espaço' }));
    expect(wazuhFindingKey(invalid, ALFA.accountId)).toBe(`wazuh/111122223333/alert:${invalid.id}:80254`);
  });

  it('a chave cabe na coluna (128): ID longo entra pelo resumo, sempre o mesmo', () => {
    const longId = `${'a'.repeat(100)}-${'b'.repeat(27)}`;
    const alert = alertOf(wafAlert({ requestId: longId }));
    expect(alert.nativeId).toBe(`1793527200000/203.0.113.50/${longId}`);
    const key = wazuhFindingKey(alert, ALFA.accountId);
    expect(key).toMatch(/^wazuh\/111122223333\/waf:sha256-[0-9a-f]{40}:80443$/);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(wazuhFindingKey(alertOf(wafAlert({ requestId: longId })), ALFA.accountId)).toBe(key);
    // Id de alerta no limite do formato também cabe.
    const longAlertId = alertOf({ ...wafAlert({ requestId: null }), id: '9'.repeat(128) });
    expect(wazuhFindingKey(longAlertId, ALFA.accountId).length).toBeLessThanOrEqual(128);
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
          // Só os do manager, onde o módulo aws-s3 roda: um agente com log de cara da AWS fica de fora.
          { term: { 'agent.id': '000' } },
        ],
      },
    });
    expect(page.body['size']).toBe(500);
    expect(() => assertStructuredQuery(page.body)).not.toThrow();
  });

  it('página dos agentes: tudo o que não veio do manager, do nível 7 para cima; nunca o mesmo alerta da AWS', () => {
    const page = agentSyncPage('2026-11-01T11:20:00.000Z', null, DEFAULT_AGENT_SYNC_SETTINGS);
    expect(page.body['query']).toEqual({
      bool: {
        filter: [
          { range: { timestamp: { gte: '2026-11-01T11:20:00.000Z' } } },
          { range: { 'rule.level': { gte: 7 } } },
        ],
        must_not: [{ term: { 'agent.id': '000' } }],
      },
    });
    expect(page.body['sort']).toEqual([{ timestamp: 'asc' }, { id: 'asc' }]);
    expect(() => assertStructuredQuery(page.body)).not.toThrow();
  });

  it('nível mínimo próprio dos agentes (7); o da AWS continua 5, e o resto das regras de leitura é o mesmo', () => {
    expect(AGENT_MIN_LEVEL).toBe(7);
    expect(DEFAULT_SYNC_SETTINGS.minLevel).toBe(5);
    expect(DEFAULT_AGENT_SYNC_SETTINGS).toEqual({ ...DEFAULT_SYNC_SETTINGS, minLevel: AGENT_MIN_LEVEL });
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

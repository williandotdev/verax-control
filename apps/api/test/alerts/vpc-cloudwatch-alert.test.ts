import { describe, expect, it } from 'vitest';
import {
  AccountDirectory,
  resolveAlertOwner,
  type RegisteredAwsAccount,
} from '../../src/alerts/alert-owner.js';
import {
  isCloudWatchAlert,
  parseCloudWatchAlert,
  resolveCloudWatchOwner,
} from '../../src/alerts/cloudwatch-alert.js';
import { toCloudWatchFindingDraft, toFindingDraft, wazuhFindingKey } from '../../src/alerts/finding-draft.js';
import {
  AGENT_MIN_LEVEL,
  agentSyncPage,
  cloudWatchSyncPage,
  DEFAULT_AGENT_SYNC_SETTINGS,
  DEFAULT_CLOUDWATCH_SYNC_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  syncPage,
} from '../../src/alerts/sync-query.js';
import {
  parseWazuhAlert,
  VPC_FLOW_CORRELATION_RULES,
  type WazuhAwsAlert,
} from '../../src/alerts/wazuh-alert.js';
import { assertStructuredQuery } from '../../src/indexer/alert-queries.js';
import { ALFA, BETA, cloudTrailAlert, cloudWatchAlert, vpcFlowAlert, withAws } from './fixtures.js';

/** As contas com o bucket dos flow logs que cada uma autorizou no onboarding self-service. */
const FLOW_ALFA: RegisteredAwsAccount = { ...ALFA, buckets: { vpc: 'fluxo-alfa' } };
const FLOW_BETA: RegisteredAwsAccount = { ...BETA, buckets: { vpc: 'fluxo-beta' } };
const directory = AccountDirectory.from([ALFA, BETA, FLOW_ALFA, FLOW_BETA]);

function flowOf(document: Record<string, unknown>): WazuhAwsAlert {
  const parsed = parseWazuhAlert(document);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.alert;
}

describe('alerta de flow log da VPC (onboarding self-service da AWS)', () => {
  it('a fonte, a conta da pasta lida, a região da pasta, a ação, a origem e a interface', () => {
    expect(flowOf(vpcFlowAlert())).toMatchObject({
      source: 'vpc',
      bucket: 'fluxo-alfa',
      accounts: [ALFA.accountId],
      region: 'sa-east-1',
      eventName: 'REJECT',
      actor: { ip: '203.0.113.50' },
      resource: 'eni:eni-0123456789abcdef0',
      rule: { id: '80402', level: 4 },
    });
  });

  it('a conta é a da pasta lida: o dono da interface (outra conta, ou unknown) não decide nem invalida', () => {
    for (const interfaceOwner of [BETA.accountId, 'unknown', null]) {
      const alert = flowOf(vpcFlowAlert({ interfaceOwner }));
      expect(alert.accounts).toEqual([ALFA.accountId]);
      expect(resolveAlertOwner(alert, directory)).toEqual({
        owned: true,
        tenantId: ALFA.tenantId,
        accountId: ALFA.accountId,
      });
    }
    // A conta da pasta fora do formato invalida, como nas outras fontes.
    const invalid = flowOf(withAws(vpcFlowAlert(), { aws_account_id: 'conta' }));
    expect(invalid.accounts).toBeNull();
    expect(resolveAlertOwner(invalid, directory)).toMatchObject({ owned: false, reason: 'invalid_alert' });
  });

  it('o dono: o bucket autorizado e a conta da pasta do mesmo cliente; fora disso, a fila sem dono', () => {
    const ownerOf = (document: Record<string, unknown>, accounts = directory) =>
      resolveAlertOwner(flowOf(document), accounts);
    expect(ownerOf(vpcFlowAlert({ account: BETA.accountId, bucket: 'fluxo-beta' }))).toEqual({
      owned: true,
      tenantId: BETA.tenantId,
      accountId: BETA.accountId,
    });
    // O bucket que ninguém autorizou para os flow logs (nem o da trilha da mesma conta vale).
    for (const bucket of ['fluxo-desconhecido', 'trilha-alfa']) {
      expect(ownerOf(vpcFlowAlert({ bucket }))).toMatchObject({ owned: false, reason: 'unknown_source' });
    }
    // A pasta de uma conta no bucket que outro cliente autorizou.
    expect(ownerOf(vpcFlowAlert({ account: BETA.accountId, bucket: 'fluxo-alfa' }))).toEqual({
      owned: false,
      reason: 'source_mismatch',
      accounts: [BETA.accountId],
    });
    // A pasta de outra conta do mesmo cliente que não autorizou aquele bucket: como no CloudTrail, sinal de problema.
    const sibling: RegisteredAwsAccount = { tenantId: ALFA.tenantId, accountId: '777788889999', buckets: {} };
    expect(
      ownerOf(vpcFlowAlert({ account: sibling.accountId }), AccountDirectory.from([FLOW_ALFA, sibling])),
    ).toMatchObject({ owned: false, reason: 'source_mismatch' });
    // O mesmo bucket autorizado por dois clientes não vale para nenhum.
    expect(
      ownerOf(
        vpcFlowAlert(),
        AccountDirectory.from([FLOW_ALFA, { ...BETA, buckets: { vpc: 'fluxo-alfa' } }]),
      ),
    ).toMatchObject({ owned: false, reason: 'ambiguous_source' });
  });

  it('a identidade do registro: a interface, a janela, a origem, o destino, o protocolo e a ação', () => {
    const alert = flowOf(vpcFlowAlert());
    expect(alert.nativeId).toBe(
      'eni-0123456789abcdef0/2026-11-01T09:58:00Z/203.0.113.50-44321/10.0.0.10-22/6/REJECT',
    );
    // O mesmo registro lido de novo (outro id de alerta) tem a mesma identidade; outro fluxo, outra.
    expect(flowOf(vpcFlowAlert()).nativeId).toBe(alert.nativeId);
    const others = [
      vpcFlowAlert({ sourcePort: 44322 }),
      vpcFlowAlert({ sourceIp: '203.0.113.51' }),
      vpcFlowAlert({ start: '2026-11-01T09:59:00Z' }),
      vpcFlowAlert({ interfaceId: 'eni-0fedcba9876543210' }),
      vpcFlowAlert({ action: 'ACCEPT' }),
    ].map((document) => flowOf(document).nativeId);
    expect(new Set([alert.nativeId, ...others]).size).toBe(6);
    // O registro sem tráfego (traços no lugar dos endereços) fica sem id nativo, e o alerta segue válido.
    const empty = flowOf(withAws(vpcFlowAlert(), { srcaddr: '-', dstaddr: '-', srcport: '-', dstport: '-' }));
    expect(empty.nativeId).toBeUndefined();
    expect(empty.actor.ip).toBeUndefined();
  });

  it('o achado: a fonte de log dos flow logs, a chave pelo registro e a mesma chave na releitura', () => {
    const owner = { owned: true as const, tenantId: ALFA.tenantId, accountId: ALFA.accountId };
    const first = toFindingDraft(flowOf(vpcFlowAlert()), owner);
    const again = toFindingDraft(flowOf(vpcFlowAlert()), owner);
    expect(first).toMatchObject({
      tenantId: ALFA.tenantId,
      accountId: ALFA.accountId,
      source: 'wazuh',
      logSource: 'vpc_flow',
      severity: 'low',
      eventName: 'REJECT',
      region: 'sa-east-1',
      resource: 'eni:eni-0123456789abcdef0',
      sourceIp: '203.0.113.50',
    });
    // A conta, o tipo da fonte, a identidade do registro e a regra.
    expect(first.sourceEventId).toBe(
      'wazuh/111122223333/vpc:eni-0123456789abcdef0/2026-11-01T09:58:00Z/203.0.113.50-44321/10.0.0.10-22/6/REJECT:80402',
    );
    // Com endereços IPv6, a identidade passa do tamanho da chave: entra pelo resumo, sempre o mesmo.
    const addresses = {
      srcaddr: '2001:db8:85a3:8d3:1319:8a2e:370:7348',
      dstaddr: '2001:db8:85a3:8d3:1319:8a2e:370:7349',
    };
    const long = toFindingDraft(flowOf(withAws(vpcFlowAlert(), addresses)), owner);
    expect(long.sourceEventId).toMatch(/^wazuh\/111122223333\/vpc:sha256-[0-9a-f]{40}:80402$/);
    expect(toFindingDraft(flowOf(withAws(vpcFlowAlert(), addresses)), owner).sourceEventId).toBe(
      long.sourceEventId,
    );
    expect(long.sourceIp).toBe(addresses.srcaddr);
    expect(again.sourceEventId).toBe(first.sourceEventId);
    expect(again.rawEventId).not.toBe(first.rawEventId);
    expect(first.recurrence).toBeUndefined();
    // Outro registro, outra chave; a mesma identidade noutra conta não se encontra.
    expect(toFindingDraft(flowOf(vpcFlowAlert({ sourcePort: 44322 })), owner).sourceEventId).not.toBe(
      first.sourceEventId,
    );
    const alert = flowOf(vpcFlowAlert());
    expect(wazuhFindingKey(alert, BETA.accountId)).not.toBe(wazuhFindingKey(alert, ALFA.accountId));
  });

  it('a correlação (100400 e 100401): a identidade é o endereço de origem, e a versão é a hora da rajada', () => {
    expect([...VPC_FLOW_CORRELATION_RULES]).toEqual(['100400', '100401']);
    const scan = flowOf(vpcFlowAlert({ rule: 'scan' }));
    expect(scan).toMatchObject({
      source: 'vpc',
      nativeId: '203.0.113.50',
      findingId: '203.0.113.50',
      // A hora cheia do início da janela do registro que fechou a contagem (09:58).
      lastSeenAt: '2026-11-01T09:00:00.000Z',
      eventName: 'REJECT',
      actor: { ip: '203.0.113.50' },
      rule: { id: '100400', level: 8, mitre: { ids: ['T1046'], tactics: ['Discovery'] } },
    });
    // A mesma rajada fechada noutro registro (outra conexão, outra interface, outro minuto da mesma hora).
    const sameBurst = [
      vpcFlowAlert({ rule: 'scan', sourcePort: 50_000 }),
      vpcFlowAlert({ rule: 'scan', interfaceId: 'eni-0fedcba9876543210' }),
      vpcFlowAlert({ rule: 'scan', start: '2026-11-01T09:01:00Z' }),
    ];
    for (const document of sameBurst) {
      expect(flowOf(document)).toMatchObject({ nativeId: scan.nativeId, lastSeenAt: scan.lastSeenAt });
    }
    // Outra hora: o mesmo achado, outra versão. Outro endereço: outro achado.
    expect(flowOf(vpcFlowAlert({ rule: 'scan', start: '2026-11-01T10:00:00Z' }))).toMatchObject({
      nativeId: '203.0.113.50',
      lastSeenAt: '2026-11-01T10:00:00.000Z',
    });
    expect(flowOf(vpcFlowAlert({ rule: 'scan', sourceIp: '203.0.113.51' })).nativeId).toBe('203.0.113.51');
    // A insistência tem a mesma identidade (a regra é que separa os dois achados, na chave).
    expect(flowOf(vpcFlowAlert({ rule: 'insistence' }))).toMatchObject({
      nativeId: '203.0.113.50',
      lastSeenAt: '2026-11-01T09:00:00.000Z',
      rule: { id: '100401', level: 10, mitre: { ids: ['T1110'], tactics: ['Credential Access'] } },
    });
    // Sem o endereço ou sem o horário no formato: sem id nativo e sem versão, e o alerta segue válido.
    for (const broken of [{ srcaddr: '-' }, { start: 'ontem' }, { start: '2026-13-01T09:58:00Z' }]) {
      const alert = flowOf(withAws(vpcFlowAlert({ rule: 'scan' }), broken));
      expect(alert.nativeId).toBeUndefined();
      expect(alert.findingId).toBeUndefined();
      expect(alert.lastSeenAt).toBeUndefined();
    }
    // O alerta do registro sozinho não tem versão.
    expect(flowOf(vpcFlowAlert()).lastSeenAt).toBeUndefined();
    expect(flowOf(vpcFlowAlert()).findingId).toBeUndefined();
  });

  it('o achado da correlação: a chave é a conta, o endereço e a regra; a hora entra na chave da reincidência', () => {
    const owner = { owned: true as const, tenantId: ALFA.tenantId, accountId: ALFA.accountId };
    const key = 'wazuh/111122223333/vpc:203.0.113.50:100400';
    const scan = toFindingDraft(flowOf(vpcFlowAlert({ rule: 'scan' })), owner);
    expect(scan).toMatchObject({
      tenantId: ALFA.tenantId,
      accountId: ALFA.accountId,
      source: 'wazuh',
      logSource: 'vpc_flow',
      severity: 'medium',
      ruleId: '100400',
      ruleLevel: 8,
      title: 'Possível varredura de rede vinda do mesmo endereço',
      eventName: 'REJECT',
      region: 'sa-east-1',
      sourceIp: '203.0.113.50',
      mitreTactics: ['Discovery'],
      mitreTechniques: ['T1046'],
      sourceEventId: key,
      recurrence: {
        lastSeenAt: '2026-11-01T09:00:00.000Z',
        chainKey: key,
        sourceEventId: `${key}@2026-11-01T09:00:00.000Z`,
      },
    });
    // A mesma rajada fechada noutro registro: a mesma chave, a mesma versão.
    const again = toFindingDraft(flowOf(vpcFlowAlert({ rule: 'scan', sourcePort: 50_000 })), owner);
    expect(again.sourceEventId).toBe(key);
    expect(again.recurrence).toEqual(scan.recurrence);
    expect(again.rawEventId).not.toBe(scan.rawEventId);
    // A insistência do mesmo endereço é outro achado, de severidade alta.
    expect(toFindingDraft(flowOf(vpcFlowAlert({ rule: 'insistence' })), owner)).toMatchObject({
      severity: 'high',
      ruleId: '100401',
      ruleLevel: 10,
      title: 'Insistência em porta de administração remota vinda do mesmo endereço',
      mitreTactics: ['Credential Access'],
      mitreTechniques: ['T1110'],
      sourceEventId: 'wazuh/111122223333/vpc:203.0.113.50:100401',
    });
    // O mesmo endereço noutra conta é outro achado.
    expect(wazuhFindingKey(flowOf(vpcFlowAlert({ rule: 'scan' })), BETA.accountId)).toBe(
      'wazuh/444455556666/vpc:203.0.113.50:100400',
    );
    // O endereço IPv6 mais longo cabe na chave, com a hora da reincidência.
    const address = '2001:db8:85a3:8d3:1319:8a2e:370:7348';
    const v6 = toFindingDraft(flowOf(withAws(vpcFlowAlert({ rule: 'scan' }), { srcaddr: address })), owner);
    expect(v6.sourceEventId).toBe(`wazuh/111122223333/vpc:${address}:100400`);
    expect(v6.recurrence?.sourceEventId).toBe(`${v6.sourceEventId}@2026-11-01T09:00:00.000Z`);
    expect(v6.recurrence?.sourceEventId.length).toBeLessThanOrEqual(128);
    // Sem o endereço no formato, a chave fica no id do alerta, sem reincidência.
    const broken = flowOf(withAws(vpcFlowAlert({ rule: 'scan' }), { srcaddr: '-' }));
    const draft = toFindingDraft(broken, owner);
    expect(draft.sourceEventId).toBe(`wazuh/111122223333/alert:${broken.id}:100400`);
    expect(draft.recurrence).toBeUndefined();
  });

  it('a página do sync da AWS lê também os flow logs, e só os eventos de bucket', () => {
    const page = syncPage('2026-11-01T11:20:00.000Z', null, DEFAULT_SYNC_SETTINGS);
    expect(page.body['query']).toEqual({
      bool: {
        filter: [
          { range: { timestamp: { gte: '2026-11-01T11:20:00.000Z' } } },
          { term: { 'data.integration': 'aws' } },
          { terms: { 'data.aws.source': ['cloudtrail', 'guardduty', 'waf', 'vpc'] } },
          { range: { 'rule.level': { gte: 5 } } },
          { term: { 'agent.id': '000' } },
        ],
      },
    });
  });
});

describe('alerta do CloudWatch Logs (onboarding self-service da AWS)', () => {
  it('reconhecido só pelo manager, pelo location do módulo e por não ser evento de bucket', () => {
    expect(isCloudWatchAlert(cloudWatchAlert())).toBe(true);
    expect(isCloudWatchAlert(cloudWatchAlert({ data: null }))).toBe(true);
    // O evento de bucket é do sync da AWS; o de um agente, do dos agentes; outro location, de ninguém daqui.
    expect(isCloudWatchAlert(cloudTrailAlert())).toBe(false);
    expect(isCloudWatchAlert(cloudWatchAlert({ agentId: '001' }))).toBe(false);
    expect(isCloudWatchAlert(cloudWatchAlert({ location: '/var/log/auth.log' }))).toBe(false);
    // A linha de log que se diz evento do módulo não passa por aqui (e o gerador a descarta antes do analysisd).
    expect(
      isCloudWatchAlert(cloudWatchAlert({ data: { integration: 'aws', aws: { source: 'cloudtrail' } } })),
    ).toBe(false);
  });

  it('do alerta, a regra e o que o decoder leu da linha; nada do log bruto', () => {
    const parsed = parseCloudWatchAlert(cloudWatchAlert());
    expect(parsed).toEqual({
      ok: true,
      alert: {
        id: expect.stringMatching(/^1793527300\.\d{6}$/) as string,
        timestamp: '2026-11-01T10:00:00.123Z',
        rule: {
          id: '5712',
          level: 10,
          description: 'sshd: brute force trying to get access to the system.',
          groups: ['syslog', 'sshd', 'authentication_failures'],
          mitre: { ids: ['T1110'], tactics: ['Credential Access'], techniques: ['Brute Force'] },
        },
        decoder: 'sshd',
        sourceIp: '203.0.113.50',
        user: 'root',
      },
    });
    expect(JSON.stringify(parsed)).not.toContain('Failed password');
    // O que a linha traz fora do formato vira ausente.
    const odd = parseCloudWatchAlert(cloudWatchAlert({ data: { srcip: 'nao-e-ip', srcuser: 'a\u0000b' } }));
    expect(odd.ok && odd.alert).toMatchObject({ decoder: 'sshd' });
    expect(odd.ok && (odd.alert.sourceIp ?? odd.alert.user)).toBeUndefined();
  });

  it('o que não é do CloudWatch Logs é pulado, e o envelope inválido é recusado com o id', () => {
    expect(parseCloudWatchAlert(cloudTrailAlert())).toMatchObject({ ok: false, reason: 'not_cloudwatch' });
    expect(parseCloudWatchAlert(cloudWatchAlert({ agentId: '001' }))).toMatchObject({
      ok: false,
      reason: 'not_cloudwatch',
    });
    const broken: Record<string, unknown> = { ...cloudWatchAlert(), rule: { id: 'x' } };
    expect(parseCloudWatchAlert(broken)).toEqual({ ok: false, reason: 'invalid_alert', id: broken['id'] });
    expect(parseCloudWatchAlert({ ...cloudWatchAlert(), timestamp: 'ontem' })).toMatchObject({
      ok: false,
      reason: 'invalid_alert',
    });
  });

  it('o dono: só quando um único cliente tem grupo autorizado no nó, numa única conta', () => {
    const alfa = { tenantId: ALFA.tenantId, accountId: ALFA.accountId };
    const beta = { tenantId: BETA.tenantId, accountId: BETA.accountId };
    expect(resolveCloudWatchOwner([alfa, alfa])).toEqual({ owned: true, ...alfa });
    // Ninguém com grupo autorizado (a autorização saiu com o alerta a caminho).
    expect(resolveCloudWatchOwner([])).toEqual({ owned: false, reason: 'unknown_source', accounts: [] });
    // Dois clientes: o evento não diz de quem é, e as contas nem vão para a fila.
    expect(resolveCloudWatchOwner([alfa, beta])).toEqual({
      owned: false,
      reason: 'ambiguous_source',
      accounts: [],
    });
    // Um cliente com grupos em duas contas: é dele, mas não há como dizer de que conta.
    expect(resolveCloudWatchOwner([alfa, { ...alfa, accountId: '777788889999' }])).toEqual({
      owned: false,
      reason: 'no_account',
      accounts: [ALFA.accountId, '777788889999'],
    });
  });

  it('o achado: a fonte de log do CloudWatch Logs, a severidade pelo nível e a chave pelo id do alerta', () => {
    const document = cloudWatchAlert();
    const parsed = parseCloudWatchAlert(document);
    if (!parsed.ok) throw new Error(parsed.reason);
    const owner = { owned: true as const, tenantId: ALFA.tenantId, accountId: ALFA.accountId };
    expect(toCloudWatchFindingDraft(parsed.alert, owner)).toEqual({
      tenantId: ALFA.tenantId,
      accountId: ALFA.accountId,
      source: 'wazuh',
      sourceEventId: `wazuh/${ALFA.accountId}/alert:${parsed.alert.id}:5712`,
      rawEventId: parsed.alert.id,
      occurredAt: '2026-11-01T10:00:00.123Z',
      severity: 'high',
      ruleId: '5712',
      ruleLevel: 10,
      title: 'sshd: brute force trying to get access to the system.',
      logSource: 'cloudwatch_logs',
      eventName: 'sshd',
      region: null,
      resource: null,
      actorUser: 'root',
      actorType: null,
      accessKeyId: null,
      sourceIp: '203.0.113.50',
      mitreTactics: ['Credential Access'],
      mitreTechniques: ['T1110'],
    });
  });

  it('a página: só os do manager, com o location do módulo, que não são de bucket, do nível 7 para cima', () => {
    const page = cloudWatchSyncPage('2026-11-01T11:20:00.000Z', null, DEFAULT_CLOUDWATCH_SYNC_SETTINGS);
    expect(page.body['query']).toEqual({
      bool: {
        filter: [
          { range: { timestamp: { gte: '2026-11-01T11:20:00.000Z' } } },
          { term: { 'agent.id': '000' } },
          { term: { location: 'Wazuh-AWS' } },
          { range: { 'rule.level': { gte: 7 } } },
        ],
        // Os eventos de bucket (`data.integration = aws`) são do sync da AWS: nunca o mesmo alerta nas duas páginas.
        must_not: [{ term: { 'data.integration': 'aws' } }],
      },
    });
    expect(page.body['sort']).toEqual([{ timestamp: 'asc' }, { id: 'asc' }]);
    expect(() => assertStructuredQuery(page.body)).not.toThrow();
    expect(DEFAULT_CLOUDWATCH_SYNC_SETTINGS).toEqual({ ...DEFAULT_SYNC_SETTINGS, minLevel: AGENT_MIN_LEVEL });
    // A dos agentes só lê o que não veio do manager: também nunca o mesmo alerta.
    const agents = agentSyncPage('2026-11-01T11:20:00.000Z', null, DEFAULT_AGENT_SYNC_SETTINGS);
    expect(agents.body['query']).toMatchObject({ bool: { must_not: [{ term: { 'agent.id': '000' } }] } });
  });
});

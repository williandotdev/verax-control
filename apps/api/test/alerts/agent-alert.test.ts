import { findingSchema, UNOWNED_REASONS } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { isAgentAlert, parseAgentAlert, type WazuhAgentAlert } from '../../src/alerts/agent-alert.js';
import {
  AGENT_LIST_GRACE_MS,
  type AgentAlertOwner,
  AgentDirectory,
  resolveAgentAlertOwner,
} from '../../src/alerts/agent-owner.js';
import { agentFindingKey, toAgentFindingDraft } from '../../src/alerts/finding-draft.js';
import { DEFAULT_SYNC_SETTINGS } from '../../src/alerts/sync-query.js';
import { UnownedReason } from '../../src/generated/prisma/enums.js';
import { agentAlert, fimAlert } from './agent-fixtures.js';
import { ALFA, BETA, cloudTrailAlert, UNREGISTERED_ACCOUNT } from './fixtures.js';

const NODE_TENANT = ALFA.tenantId;
/** Hora do alerta das fixtures (`2026-11-01T10:00:00.123+0000`). */
const ALERT_AT = new Date('2026-11-01T10:00:00.123Z');
/** Bem depois do alerta: nada de espera pela lista. */
const LATER = new Date(ALERT_AT.getTime() + 60 * 60_000);

function parsed(document: Record<string, unknown>): WazuhAgentAlert {
  const result = parseAgentAlert(document);
  if (!result.ok) throw new Error('fixture inválida');
  return result.alert;
}

function directory(overrides: Partial<Parameters<typeof AgentDirectory.from>[0]> = {}): AgentDirectory {
  return AgentDirectory.from({
    tenantId: NODE_TENANT,
    agents: [
      { agentId: '001', name: 'web-01' },
      { agentId: '002', name: 'db-01' },
    ],
    awsAccounts: [ALFA, BETA].map(({ tenantId, accountId }) => ({ tenantId, accountId })),
    listedAt: LATER,
    ...overrides,
  });
}

const ownerOf = (document: Record<string, unknown>, dir = directory(), now = LATER): AgentAlertOwner =>
  resolveAgentAlertOwner(parsed(document), dir, now);

describe('alerta de agente: quem gerou', () => {
  it('o 000 é o manager (sync da AWS); sem agent.id também; qualquer outro valor é de agente', () => {
    expect(isAgentAlert(cloudTrailAlert())).toBe(false);
    expect(isAgentAlert({ id: '1.2', rule: {} })).toBe(false);
    expect(isAgentAlert(agentAlert())).toBe(true);
    for (const id of [null, 1, '1', 'x', '0000']) {
      expect(isAgentAlert({ agent: { id } })).toBe(true);
    }
  });
});

describe('alerta de agente: leitura do documento', () => {
  it('extrai a regra, o agente, o decoder, o IP e o usuário do log, com o horário em UTC', () => {
    const alert = parsed(agentAlert({ id: '1793527300.000777' }));
    expect(alert).toEqual({
      id: '1793527300.000777',
      timestamp: '2026-11-01T10:00:00.123Z',
      rule: {
        id: '5712',
        level: 10,
        description: 'sshd: brute force trying to get access to the system. Non existent user.',
        groups: ['syslog', 'sshd', 'authentication_failures'],
        mitre: { ids: ['T1110'], tactics: ['Credential Access'], techniques: ['Brute Force'] },
      },
      agent: { id: '001', name: 'web-01' },
      decoder: 'sshd',
      sourceIp: '203.0.113.9',
      user: 'admin',
      awsAccounts: [],
    });
    // O log bruto e as correlações não saem do parser.
    expect(JSON.stringify(alert)).not.toContain('Invalid user');
  });

  it('FIM sem IP nem usuário; Windows lê o usuário do evento; IP e usuário fora do formato ficam ausentes', () => {
    expect(parsed(fimAlert())).toMatchObject({ decoder: 'syscheck_integrity_changed', rule: { id: '550' } });
    expect(parsed(fimAlert()).sourceIp).toBeUndefined();
    const windows = parsed(
      agentAlert({
        decoder: 'windows_eventchannel',
        data: { win: { eventdata: { targetUserName: 'Administrador' } } },
      }),
    );
    expect(windows.user).toBe('Administrador');
    const odd = parsed(agentAlert({ data: { srcip: '203.0.113.9; rm -rf /', srcuser: 'ad\u001bmin' } }));
    expect(odd.sourceIp).toBeUndefined();
    expect(odd.user).toBeUndefined();
  });

  it('contas AWS citadas no log (data.aws), pelos campos do sync da AWS; campo fora do formato invalida a lista', () => {
    const cited = parsed(
      agentAlert({ data: { aws: { aws_account_id: BETA.accountId, recipientAccountId: ALFA.accountId } } }),
    );
    expect(cited.awsAccounts).toEqual([ALFA.accountId, BETA.accountId].sort());
    expect(parsed(agentAlert({ data: { aws: { accountId: '12345' } } })).awsAccounts).toBeNull();
    expect(parsed(agentAlert({ data: { aws: 'texto' } })).awsAccounts).toBeNull();
    expect(
      parsed(agentAlert({ data: { aws: { arn: 'arn:aws:iam::111122223333:root' } } })).awsAccounts,
    ).toBeNull();
  });

  it('fora do formato: inválido, com o id do alerta e o do agente quando legíveis', () => {
    const cases: [Record<string, unknown>, string | null][] = [
      // Regra além das 6 posições que o achado e a fila guardam.
      [agentAlert({ rule: { id: '1234567', level: 10, description: 'x' } }), '001'],
      [agentAlert({ agentId: '000' }), null],
      [agentAlert({ agentId: '1' }), null],
      [agentAlert({ agentName: 'web\u001b[31m' }), '001'],
      [agentAlert({ agentName: 'x'.repeat(129) }), '001'],
      [agentAlert({ timestamp: 'ontem' }), '001'],
    ];
    for (const [document, agentId] of cases) {
      expect(parseAgentAlert(document)).toEqual({
        ok: false,
        reason: 'invalid_alert',
        id: document['id'],
        agentId,
      });
    }
    expect(parseAgentAlert({ rule: 'x' })).toEqual({
      ok: false,
      reason: 'invalid_alert',
      id: null,
      agentId: null,
    });
  });
});

describe('alerta de agente: dono (na dúvida, de ninguém)', () => {
  it('agente da lista do cliente do nó, com o mesmo nome: do cliente do nó', () => {
    expect(ownerOf(agentAlert())).toEqual({
      status: 'owned',
      tenantId: NODE_TENANT,
      agentId: '001',
      agentName: 'web-01',
    });
  });

  it('agentes desligados no worker (sem o cliente do nó): fila, com o agente', () => {
    expect(ownerOf(agentAlert(), directory({ tenantId: null }))).toEqual({
      status: 'unowned',
      reason: 'agents_disabled',
      accounts: ['agent:001'],
    });
  });

  it('agente fora da lista, ou na lista com outro nome: fila; o nome sozinho nunca decide', () => {
    expect(ownerOf(agentAlert({ agentId: '009' }))).toEqual({
      status: 'unowned',
      reason: 'unknown_agent',
      accounts: ['agent:009'],
    });
    // O nome de um agente da lista, com o id de outro.
    expect(ownerOf(agentAlert({ agentId: '009', agentName: 'web-01' }))).toMatchObject({
      reason: 'unknown_agent',
    });
    expect(ownerOf(agentAlert({ agentId: '002', agentName: 'web-01' }))).toEqual({
      status: 'unowned',
      reason: 'agent_name_mismatch',
      accounts: ['agent:002'],
    });
    // A lista de outro cliente não vale para o cliente do nó.
    const otherList = directory({ agents: [] });
    expect(ownerOf(agentAlert(), otherList)).toMatchObject({ reason: 'unknown_agent' });
  });

  it('conta AWS de outro cliente citada no log: conflito; a do próprio cliente ou de ninguém não muda nada', () => {
    const withAccount = (accountId: string) => agentAlert({ data: { aws: { aws_account_id: accountId } } });
    expect(ownerOf(withAccount(BETA.accountId))).toEqual({
      status: 'unowned',
      reason: 'agent_account_conflict',
      accounts: ['agent:001', BETA.accountId],
    });
    expect(ownerOf(withAccount(ALFA.accountId))).toMatchObject({ status: 'owned', tenantId: NODE_TENANT });
    expect(ownerOf(withAccount(UNREGISTERED_ACCOUNT))).toMatchObject({ status: 'owned' });
    // A conta cadastrada nos dois clientes também é de outro.
    const shared = directory({
      awsAccounts: [
        { tenantId: NODE_TENANT, accountId: ALFA.accountId },
        { tenantId: BETA.tenantId, accountId: ALFA.accountId },
      ],
    });
    expect(ownerOf(withAccount(ALFA.accountId), shared)).toMatchObject({ reason: 'agent_account_conflict' });
    // Campo de conta fora do formato: na dúvida, ninguém.
    expect(ownerOf(agentAlert({ data: { aws: { accountId: 'x' } } }))).toEqual({
      status: 'unowned',
      reason: 'invalid_alert',
      accounts: ['agent:001'],
    });
  });

  it('agente que a lista ainda não conhece: o alerta recente espera a lista; passada a espera, fila', () => {
    const behind = directory({ listedAt: new Date(ALERT_AT.getTime() - 30_000) });
    const soon = new Date(ALERT_AT.getTime() + 60_000);
    expect(ownerOf(agentAlert({ agentId: '009' }), behind, soon)).toEqual({ status: 'deferred' });
    expect(ownerOf(agentAlert({ agentId: '002', agentName: 'novo' }), behind, soon)).toEqual({
      status: 'deferred',
    });
    // Antes da primeira lista, também espera.
    expect(ownerOf(agentAlert({ agentId: '009' }), directory({ listedAt: null }), soon)).toEqual({
      status: 'deferred',
    });
    // Passada a espera, ou com a lista mais nova que o alerta, vai para a fila.
    const late = new Date(ALERT_AT.getTime() + AGENT_LIST_GRACE_MS);
    expect(ownerOf(agentAlert({ agentId: '009' }), behind, late)).toMatchObject({ reason: 'unknown_agent' });
    const fresh = directory({ listedAt: new Date(ALERT_AT.getTime() + 1) });
    expect(ownerOf(agentAlert({ agentId: '009' }), fresh, soon)).toMatchObject({ reason: 'unknown_agent' });
    // A espera cabe na sobreposição da leitura: o alerta é relido antes de sair da janela.
    expect(AGENT_LIST_GRACE_MS).toBeLessThan(DEFAULT_SYNC_SETTINGS.overlapMs);
  });

  it('os motivos novos existem no banco e no contrato do painel', () => {
    for (const reason of [
      'agents_disabled',
      'unknown_agent',
      'agent_name_mismatch',
      'agent_account_conflict',
    ]) {
      expect(UNOWNED_REASONS).toContain(reason);
    }
    expect([...UNOWNED_REASONS].sort()).toEqual(Object.values(UnownedReason).sort());
  });
});

describe('alerta de agente: achado', () => {
  const owner = { status: 'owned', tenantId: NODE_TENANT, agentId: '001', agentName: 'web-01' } as const;

  it('origem no agente, recurso na instância, severidade pelo nível da regra e MITRE da regra', () => {
    const alert = parsed(agentAlert({ id: '1793527300.000042' }));
    const draft = toAgentFindingDraft(alert, owner);
    expect(draft).toEqual({
      tenantId: NODE_TENANT,
      accountId: 'agent:001',
      source: 'wazuh',
      sourceEventId: 'wazuh/agent:001/alert:1793527300.000042:5712',
      rawEventId: '1793527300.000042',
      occurredAt: '2026-11-01T10:00:00.123Z',
      severity: 'high',
      ruleId: '5712',
      ruleLevel: 10,
      title: 'sshd: brute force trying to get access to the system. Non existent user.',
      logSource: 'wazuh_agent',
      eventName: 'sshd',
      region: null,
      resource: 'host:web-01',
      actorUser: 'admin',
      actorType: null,
      accessKeyId: null,
      sourceIp: '203.0.113.9',
      mitreTactics: ['Credential Access'],
      mitreTechniques: ['T1110'],
    });
    expect(toAgentFindingDraft(parsed(fimAlert()), owner)).toMatchObject({
      severity: 'medium',
      sourceIp: null,
      actorUser: null,
      resource: 'host:web-01',
    });
    // A origem do achado passa no contrato do painel.
    expect(findingSchema.shape.accountId.safeParse(draft.accountId).success).toBe(true);
  });

  it('chave estável: o mesmo alerta relido dá a mesma chave; id longo entra pelo resumo, dentro de 128', () => {
    const document = agentAlert();
    expect(agentFindingKey(parsed(document))).toBe(agentFindingKey(parsed(structuredClone(document))));
    const long = parsed(agentAlert({ id: `1793527300.${'9'.repeat(117)}` }));
    const key = agentFindingKey(long);
    expect(key).toMatch(/^wazuh\/agent:001\/alert:sha256-[0-9a-f]{40}:5712$/);
    expect(key.length).toBeLessThanOrEqual(128);
    // Outra regra no mesmo alerta, outro achado; outro agente, outra chave.
    expect(agentFindingKey({ ...long, rule: { ...long.rule, id: '5710' } })).not.toBe(key);
    expect(agentFindingKey({ ...long, agent: { id: '002', name: 'db-01' } })).not.toBe(key);
  });
});

import { describe, expect, it } from 'vitest';
import { toFindingDraft } from '../../../src/alerts/finding-draft.js';
import { parseWazuhAlert } from '../../../src/alerts/wazuh-alert.js';
import { isPublicAccess, parseAccessAnalyzerFinding } from '../../../src/aws/findings/access-analyzer.js';
import { MAX_FINDING_RECORD_BYTES, resourceRef } from '../../../src/aws/findings/finding-fields.js';
import type { ParsedFinding, ParseOutcome } from '../../../src/aws/findings/finding-records.js';
import { parseGuardDutyFinding } from '../../../src/aws/findings/guardduty.js';
import { parseInspectorFinding } from '../../../src/aws/findings/inspector.js';
import { coveredByOwnCollector, parseSecurityHubFinding } from '../../../src/aws/findings/security-hub.js';
import { guardDutyAlert, portProbeAlerts } from '../../alerts/fixtures.js';
import {
  analyzerFinding,
  externalAccessDetail,
  guardDutyFinding,
  inspectorFinding,
  portProbeAction,
  securityHubFinding,
} from './fake-findings.js';

const NOW = new Date('2026-11-23T12:00:00.000Z');
const ACCOUNT = '111111111111';
const TENANT = '018f2c1e-0000-7000-8000-00000000a1fa';
const OWNER = { tenantId: TENANT, accountId: ACCOUNT };

function parsed(outcome: ParseOutcome): ParsedFinding {
  if (!outcome.ok) throw new Error(`registro recusado: ${outcome.reason}`);
  return outcome.finding;
}

/** O rascunho que o caminho do bucket (o alerta do Wazuh) dá ao mesmo achado. */
function wazuhDraft(document: Record<string, unknown>) {
  const alert = parseWazuhAlert(document);
  if (!alert.ok) throw new Error(alert.reason);
  return toFindingDraft(alert.alert, { owned: true, ...OWNER });
}

describe('GuardDuty pela API: o mesmo achado do caminho do bucket', () => {
  const id = '5ab9d8a0c4e6f1b2a3c4d5e6f7a8b9c0';

  it('a mesma origem, a mesma chave e os mesmos campos do alerta do Wazuh', () => {
    const updatedAt = '2026-11-22T09:55:00.000Z';
    const viaApi = parsed(
      parseGuardDutyFinding(guardDutyFinding({ account: ACCOUNT, id, severity: 8, updatedAt })),
    ).drafts(OWNER);
    const viaBucket = wazuhDraft(
      guardDutyAlert({
        account: ACCOUNT,
        findingId: id,
        severity: 8,
        updatedAt,
        // A regra de fábrica do Wazuh para a severidade 8, e a descrição que ela monta.
        rule: {
          id: '80303',
          level: 10,
          description: 'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.',
        },
      }),
    );
    expect(viaApi).toHaveLength(1);
    const [draft] = viaApi;
    expect(draft).toMatchObject({
      tenantId: TENANT,
      accountId: ACCOUNT,
      source: 'wazuh',
      sourceEventId: `wazuh/${ACCOUNT}/guardduty:${id}:80303`,
      logSource: 'guardduty',
      severity: 'high',
      ruleId: '80303',
      ruleLevel: 10,
      title: 'AWS GuardDuty: AWS_API_CALL - Credenciais usadas de fora da AWS.',
      eventName: 'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
      region: 'sa-east-1',
      resource: 'ec2:i-0abc1234def567890',
      actorUser: 'papel-da-aplicacao',
      actorType: 'AssumedRole',
      accessKeyId: 'ASIAEXEMPLO000000000',
      sourceIp: '198.51.100.7',
      occurredAt: updatedAt,
      recurrence: {
        lastSeenAt: updatedAt,
        chainKey: `wazuh/${ACCOUNT}/guardduty:${id}:80303`,
        sourceEventId: `wazuh/${ACCOUNT}/guardduty:${id}:80303@${updatedAt}`,
      },
    });
    // O achado lido pela API não tem evento bruto no indexer.
    expect(draft).not.toHaveProperty('rawEventId');
    // Campo a campo, o que o caminho do bucket grava (menos o horário do alerta do Wazuh e o evento bruto). O MITRE do
    // alerta de exemplo, que a regra de fábrica não tem, não conta: nos dois caminhos, ele sai do tipo do achado.
    for (const field of [
      'source',
      'sourceEventId',
      'logSource',
      'severity',
      'ruleId',
      'ruleLevel',
      'title',
      'eventName',
      'region',
      'resource',
      'actorUser',
      'actorType',
      'accessKeyId',
      'sourceIp',
      'mitreTactics',
      'mitreTechniques',
      'recurrence',
    ] as const) {
      expect(draft?.[field], field).toEqual(viaBucket[field]);
    }
  });

  it.each([
    ['UnauthorizedAccess:IAMUser/MaliciousIPCaller', ['Initial Access'], ['T1078.004']],
    ['CryptoCurrency:EC2/BitcoinTool.B!DNS', ['Impact'], ['T1496']],
    ['Backdoor:EC2/DenialOfService.Dns', ['Command and Control', 'Impact'], ['T1498']],
    ['Exfiltration:S3/AnomalousBehavior', ['Exfiltration'], []],
    ['Policy:IAMUser/RootCredentialUsage', [], []],
  ])('o MITRE ATT&CK é o mesmo nos dois caminhos: %s', (type, tactics, techniques) => {
    const [viaApi] = parsed(
      parseGuardDutyFinding(guardDutyFinding({ account: ACCOUNT, id, severity: 8, type })),
    ).drafts(OWNER);
    const viaBucket = wazuhDraft(guardDutyAlert({ account: ACCOUNT, findingId: id, severity: 8, type }));
    expect(viaApi).toMatchObject({ mitreTactics: tactics, mitreTechniques: techniques });
    expect(viaBucket).toMatchObject({ mitreTactics: tactics, mitreTechniques: techniques });
  });

  it('a severidade crítica (9 ou mais) vem das faixas da AWS, com a regra que o Wazuh daria', () => {
    const nine = parsed(
      parseGuardDutyFinding(guardDutyFinding({ account: ACCOUNT, id, severity: 9 })),
    ).drafts(OWNER);
    expect(nine[0]).toMatchObject({ severity: 'critical', ruleId: '80303', ruleLevel: 10 });
    // O 10 cai na regra das baixas do Wazuh (comparação por trecho), e segue crítico pela faixa da AWS.
    const ten = parsed(
      parseGuardDutyFinding(guardDutyFinding({ account: ACCOUNT, id, severity: 10 })),
    ).drafts(OWNER);
    expect(ten[0]).toMatchObject({
      severity: 'critical',
      ruleId: '80301',
      sourceEventId: `wazuh/${ACCOUNT}/guardduty:${id}:80301`,
    });
    const low = parsed(parseGuardDutyFinding(guardDutyFinding({ account: ACCOUNT, id, severity: 2 }))).drafts(
      OWNER,
    );
    expect(low[0]).toMatchObject({ severity: 'low', ruleId: '80301', ruleLevel: 3 });
  });

  it('a sondagem de porta vira um rascunho por IP e porta, com as chaves do caminho do bucket', () => {
    const probes = [
      { ip: '198.51.100.20', port: 22 },
      { ip: '198.51.100.21', port: 3389 },
    ];
    const updatedAt = '2026-11-22T10:10:00.000Z';
    const finding = parsed(
      parseGuardDutyFinding(
        guardDutyFinding({
          account: ACCOUNT,
          id,
          severity: 5,
          updatedAt,
          type: 'Recon:EC2/PortProbeUnprotectedPort',
          title: 'Porta desprotegida sondada',
          action: portProbeAction(probes),
          resource: { ResourceType: 'Instance', InstanceDetails: { InstanceId: 'i-0abc1234def567890' } },
        }),
      ),
    );
    const drafts = finding.drafts(OWNER);
    const viaBucket = portProbeAlerts(probes, {
      account: ACCOUNT,
      findingId: id,
      updatedAt,
      // A regra de fábrica da sondagem de porta com severidade 5.
      rule: { id: '80306', level: 6, description: 'x' },
    }).map(wazuhDraft);
    expect(drafts.map((draft) => draft.sourceEventId)).toEqual([
      `wazuh/${ACCOUNT}/guardduty:${id}/198.51.100.20:22:80306`,
      `wazuh/${ACCOUNT}/guardduty:${id}/198.51.100.21:3389:80306`,
    ]);
    expect(drafts.map((draft) => draft.sourceEventId)).toEqual(viaBucket.map((draft) => draft.sourceEventId));
    // A reincidência é do achado inteiro, uma só, nos dois caminhos.
    expect(drafts.map((draft) => draft.recurrence)).toEqual(viaBucket.map((draft) => draft.recurrence));
    // A sondagem vinda de fora é reconhecimento, em cada item, nos dois caminhos.
    for (const draft of [...drafts, ...viaBucket]) expect(draft.mitreTactics).toEqual(['Reconnaissance']);
    expect(drafts[0]).toMatchObject({
      severity: 'medium',
      sourceIp: '198.51.100.20',
      title: 'AWS GuardDuty: PORT_PROBE - Porta desprotegida sondada [IP: 198.51.100.20] [Port: 22].',
      recurrence: { chainKey: `wazuh/${ACCOUNT}/guardduty:${id}:80306` },
    });
    expect(drafts[1]).toMatchObject({ sourceIp: '198.51.100.21' });
    // Um item só: a mesma chave por IP e porta (o módulo do Wazuh entrega a lista de um item como o próprio item).
    const single = parsed(
      parseGuardDutyFinding(
        guardDutyFinding({ account: ACCOUNT, id, severity: 5, action: portProbeAction(probes.slice(0, 1)) }),
      ),
    ).drafts(OWNER);
    expect(single.map((draft) => draft.sourceEventId)).toEqual([
      `wazuh/${ACCOUNT}/guardduty:${id}/198.51.100.20:22:80306`,
    ]);
  });

  it('o arquivado fica de fora, e o registro fora do formato é recusado', () => {
    expect(parseGuardDutyFinding(guardDutyFinding({ account: ACCOUNT, archived: true }))).toEqual({
      ok: false,
      reason: 'inactive',
    });
    const invalid = { ok: false, reason: 'invalid' };
    expect(parseGuardDutyFinding(null)).toEqual(invalid);
    expect(parseGuardDutyFinding('texto')).toEqual(invalid);
    expect(parseGuardDutyFinding({ ...guardDutyFinding({ account: ACCOUNT }), Id: 'com espaço' })).toEqual(
      invalid,
    );
    expect(parseGuardDutyFinding({ ...guardDutyFinding({ account: ACCOUNT }), Severity: 'alta' })).toEqual(
      invalid,
    );
    expect(parseGuardDutyFinding({ ...guardDutyFinding({ account: ACCOUNT }), UpdatedAt: 'ontem' })).toEqual(
      invalid,
    );
    // Um registro maior que o teto nem é lido.
    expect(
      parseGuardDutyFinding({
        ...guardDutyFinding({ account: ACCOUNT }),
        Description: 'x'.repeat(MAX_FINDING_RECORD_BYTES),
      }),
    ).toEqual(invalid);
  });

  it('as contas citadas saem do achado: a conta e a do ARN; um campo fora do formato invalida a lista', () => {
    const finding = guardDutyFinding({ account: ACCOUNT, id });
    expect(parsed(parseGuardDutyFinding(finding)).accounts).toEqual([ACCOUNT]);
    expect(
      parsed(
        parseGuardDutyFinding({
          ...finding,
          Arn: `arn:aws:guardduty:sa-east-1:222222222222:detector/0/finding/${id}`,
        }),
      ).accounts,
    ).toEqual([ACCOUNT, '222222222222']);
    expect(parsed(parseGuardDutyFinding({ ...finding, AccountId: 'conta' })).accounts).toBeNull();
  });

  it('um campo hostil no registro não muda o protótipo de nada', () => {
    const hostile = JSON.parse(
      JSON.stringify(guardDutyFinding({ account: ACCOUNT, id })).replace(
        '"Partition":"aws"',
        '"Partition":"aws","__proto__":{"polluted":true}',
      ),
    ) as Record<string, unknown>;
    expect(parsed(parseGuardDutyFinding(hostile)).nativeId).toBe(id);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

describe('Security Hub: do achado (ASFF) ao rascunho', () => {
  it('o controle reprovado vira achado, com a chave pelo produto e pelo ID e a versão que só atualiza', () => {
    const raw = securityHubFinding({
      account: ACCOUNT,
      label: 'CRITICAL',
      updatedAt: '2026-11-22T09:55:00.000Z',
    });
    const finding = parsed(parseSecurityHubFinding(raw, NOW));
    const [draft] = finding.drafts(OWNER);
    expect(draft).toMatchObject({
      tenantId: TENANT,
      accountId: ACCOUNT,
      source: 'aws',
      logSource: 'security_hub',
      severity: 'critical',
      ruleId: '990501',
      ruleLevel: 12,
      title: 'Controle de segurança reprovado (S3.8): S3 general purpose buckets should block public access',
      eventName: 'S3.8',
      region: 'sa-east-1',
      resource: 's3:bucket-de-exemplo',
      occurredAt: '2026-11-22T09:55:00.000Z',
      revision: { lastSeenAt: '2026-11-22T09:55:00.000Z' },
      mitreTactics: [],
    });
    expect(draft?.sourceEventId).toMatch(/^aws\/111111111111\/securityhub:sha256-[0-9a-f]{40}$/);
    expect(draft).not.toHaveProperty('recurrence');
    expect(finding.accounts).toEqual([ACCOUNT]);
    expect(finding.product).toBeUndefined();
    expect(finding.bytes).toBe(Buffer.byteLength(JSON.stringify(raw), 'utf8'));
    // A chave não depende da região lida nem do conteúdo: é a mesma a cada leitura.
    expect(
      parsed(parseSecurityHubFinding({ ...raw, Title: 'Outro título' }, NOW)).drafts(OWNER)[0]?.sourceEventId,
    ).toBe(draft?.sourceEventId);
    // O mesmo ID em outro produto é outro achado.
    expect(
      parsed(
        parseSecurityHubFinding(
          { ...raw, ProductArn: 'arn:aws:securityhub:sa-east-1::product/aws/macie' },
          NOW,
        ),
      ).drafts(OWNER)[0]?.sourceEventId,
    ).not.toBe(draft?.sourceEventId);
  });

  it('o achado de um produto integrado leva a outra regra, o produto no título e as táticas dos tipos', () => {
    const finding = parsed(
      parseSecurityHubFinding(
        securityHubFinding({
          account: ACCOUNT,
          product: 'macie',
          label: 'MEDIUM',
          title: 'Sensitive data in bucket',
          types: ['TTPs/Exfiltration/DataExposure', 'TTPs/Discovery', 'Sensitive Data Identifications/PII'],
        }),
        NOW,
      ),
    );
    expect(finding.drafts(OWNER)[0]).toMatchObject({
      ruleId: '990502',
      severity: 'medium',
      ruleLevel: 7,
      title: 'Achado do Security Hub (Macie): Sensitive data in bucket',
      eventName: 'TTPs/Exfiltration/DataExposure',
      mitreTactics: ['Discovery', 'Exfiltration'],
    });
  });

  it('reconhece os achados do GuardDuty e do Inspector, para a tarefa não duplicar', () => {
    expect(
      parsed(parseSecurityHubFinding(securityHubFinding({ account: ACCOUNT, product: 'guardduty' }), NOW))
        .product,
    ).toEqual({ kind: 'guardduty', region: 'sa-east-1' });
    expect(
      parsed(
        parseSecurityHubFinding(
          securityHubFinding({ account: ACCOUNT, product: 'inspector', region: 'us-east-1' }),
          NOW,
        ),
      ).product,
    ).toEqual({ kind: 'inspector', region: 'us-east-1' });
    // Pelo nome do produto, quando o ARN é de outro formato.
    expect(
      parsed(
        parseSecurityHubFinding(
          {
            ...securityHubFinding({ account: ACCOUNT }),
            ProductArn: 'arn:aws:outro',
            ProductName: 'GuardDuty',
          },
          NOW,
        ),
      ).product?.kind,
    ).toBe('guardduty');
  });

  it('só o ativo e em aberto entra: o suprimido, o resolvido e o arquivado ficam de fora', () => {
    const inactive = { ok: false, reason: 'inactive' };
    expect(
      parseSecurityHubFinding(securityHubFinding({ account: ACCOUNT, workflow: 'SUPPRESSED' }), NOW),
    ).toEqual(inactive);
    expect(
      parseSecurityHubFinding(securityHubFinding({ account: ACCOUNT, workflow: 'RESOLVED' }), NOW),
    ).toEqual(inactive);
    expect(
      parseSecurityHubFinding(securityHubFinding({ account: ACCOUNT, recordState: 'ARCHIVED' }), NOW),
    ).toEqual(inactive);
    expect(
      parseSecurityHubFinding(securityHubFinding({ account: ACCOUNT, workflow: 'NOTIFIED' }), NOW).ok,
    ).toBe(true);
  });

  it('sem ID, produto ou horário da versão, o registro é recusado; a conta fora do formato invalida as contas', () => {
    const raw = securityHubFinding({ account: ACCOUNT });
    const invalid = { ok: false, reason: 'invalid' };
    expect(parseSecurityHubFinding({ ...raw, Id: undefined }, NOW)).toEqual(invalid);
    expect(parseSecurityHubFinding({ ...raw, ProductArn: 42 }, NOW)).toEqual(invalid);
    expect(parseSecurityHubFinding({ ...raw, UpdatedAt: 'ontem' }, NOW)).toEqual(invalid);
    // Um horário um século à frente não é horário de achado.
    expect(parseSecurityHubFinding({ ...raw, UpdatedAt: '2126-01-01T00:00:00.000Z' }, NOW)).toEqual(invalid);
    expect(parsed(parseSecurityHubFinding({ ...raw, AwsAccountId: 'x' }, NOW)).accounts).toBeNull();
    // Um título com quebra de linha e maior que a coluna não quebra o registro.
    const [draft] = parsed(
      parseSecurityHubFinding({ ...raw, Title: `linha um\nlinha dois ${'x'.repeat(2000)}` }, NOW),
    ).drafts(OWNER);
    expect(draft?.title).toMatch(/^Controle de segurança reprovado \(S3\.8\): linha um linha dois x+$/);
    expect(draft?.title.length).toBeLessThanOrEqual(500);
  });
});

describe('Inspector: do achado ao rascunho', () => {
  it('a vulnerabilidade de pacote crítica vira achado crítico, com a CVE e a instância', () => {
    const raw = inspectorFinding({ account: ACCOUNT, id: '0a1b2c3d4e5f60718293a4b5c6d7e8f9' });
    const finding = parsed(parseInspectorFinding(raw, NOW));
    expect(finding.drafts(OWNER)[0]).toMatchObject({
      source: 'aws',
      sourceEventId:
        'aws/111111111111/inspector:arn:aws:inspector2:sa-east-1:111111111111:finding/0a1b2c3d4e5f60718293a4b5c6d7e8f9',
      logSource: 'inspector',
      severity: 'critical',
      ruleId: '990511',
      ruleLevel: 12,
      title: 'Vulnerabilidade em pacote: CVE-2026-0001 - openssl',
      eventName: 'CVE-2026-0001',
      region: 'sa-east-1',
      resource: 'ec2:i-0abc1234def567890',
      occurredAt: '2026-11-22T09:55:00.000Z',
      revision: { lastSeenAt: '2026-11-22T09:55:00.000Z' },
      // Vulnerabilidade é fraqueza, e não ação de um atacante: sem tática inventada.
      mitreTactics: [],
      mitreTechniques: [],
    });
    expect(finding.accounts).toEqual([ACCOUNT]);
  });

  it('a porta alcançável e a vulnerabilidade no código têm a própria regra', () => {
    const network = parsed(
      parseInspectorFinding(
        inspectorFinding({
          account: ACCOUNT,
          type: 'NETWORK_REACHABILITY',
          severity: 'MEDIUM',
          title: 'Port 22 is reachable from an Internet Gateway',
        }),
        NOW,
      ),
    ).drafts(OWNER)[0];
    expect(network).toMatchObject({
      ruleId: '990512',
      severity: 'medium',
      eventName: 'TCP/22',
      title: 'Porta alcançável de fora da rede: Port 22 is reachable from an Internet Gateway',
    });
    const code = parsed(
      parseInspectorFinding(
        inspectorFinding({ account: ACCOUNT, type: 'CODE_VULNERABILITY', severity: 'UNTRIAGED' }),
        NOW,
      ),
    ).drafts(OWNER)[0];
    expect(code).toMatchObject({ ruleId: '990513', severity: 'medium', eventName: 'CODE_VULNERABILITY' });
  });

  it('o fechado e o suprimido ficam de fora; sem o ARN do achado ou o horário, o registro é recusado', () => {
    expect(parseInspectorFinding(inspectorFinding({ account: ACCOUNT, status: 'CLOSED' }), NOW)).toEqual({
      ok: false,
      reason: 'inactive',
    });
    expect(parseInspectorFinding(inspectorFinding({ account: ACCOUNT, status: 'SUPPRESSED' }), NOW)).toEqual({
      ok: false,
      reason: 'inactive',
    });
    const raw = inspectorFinding({ account: ACCOUNT });
    const invalid = { ok: false, reason: 'invalid' };
    expect(parseInspectorFinding({ ...raw, findingArn: 'arn:aws:s3:::bucket' }, NOW)).toEqual(invalid);
    expect(parseInspectorFinding({ ...raw, updatedAt: undefined, lastObservedAt: undefined }, NOW)).toEqual(
      invalid,
    );
    expect(
      parseInspectorFinding({ ...raw, updatedAt: new Date(Number.NaN), lastObservedAt: 'x' }, NOW),
    ).toEqual(invalid);
  });
});

describe('Access Analyzer: do achado ao rascunho', () => {
  const target = {
    region: 'sa-east-1',
    analyzerName: 'conta',
    analyzerArn: 'arn:aws:access-analyzer:sa-east-1:111111111111:analyzer/conta',
  };
  const id = '11111111-2222-3333-4444-555555555555';

  it('o acesso externo pede o detalhe: público é alto, de outra conta é médio', () => {
    const finding = parsed(
      parseAccessAnalyzerFinding(analyzerFinding({ account: ACCOUNT, id }), target, NOW),
    );
    expect(finding.needsDetail).toBe(true);
    expect(finding.nativeId).toBe(`sa-east-1/conta/${id}`);
    const open = finding.drafts(OWNER, externalAccessDetail(true))[0];
    expect(open).toMatchObject({
      source: 'aws',
      sourceEventId: `aws/111111111111/access-analyzer:sa-east-1/conta/${id}`,
      logSource: 'access_analyzer',
      severity: 'high',
      ruleId: '990521',
      ruleLevel: 10,
      title: 'Recurso aberto ao público: bucket S3',
      eventName: 'ExternalAccess',
      // O bucket não tem região no ARN: vale a do analisador.
      region: 'sa-east-1',
      resource: 's3:bucket-de-exemplo',
      revision: { lastSeenAt: '2026-11-22T09:55:00.000Z' },
    });
    const shared = finding.drafts(OWNER, externalAccessDetail(false))[0];
    expect(shared).toMatchObject({
      severity: 'medium',
      ruleId: '990522',
      ruleLevel: 7,
      title: 'Recurso acessível por outra conta ou identidade: bucket S3',
    });
    // A chave é a mesma com e sem o detalhe: é ela que a tarefa compara antes de pedir o detalhe.
    expect(finding.drafts(OWNER)[0]?.sourceEventId).toBe(open?.sourceEventId);
    expect(isPublicAccess(externalAccessDetail(true))).toBe(true);
    expect(isPublicAccess(externalAccessDetail(false))).toBe(false);
    expect(isPublicAccess(undefined)).toBe(false);
    expect(isPublicAccess({ findingDetails: 'x' })).toBe(false);
  });

  it('o acesso sem uso é baixo e não pede detalhe', () => {
    const finding = parsed(
      parseAccessAnalyzerFinding(
        analyzerFinding({
          account: ACCOUNT,
          id,
          findingType: 'UnusedIAMRole',
          resource: 'arn:aws:iam::111111111111:role/servico/papel-antigo',
          resourceType: 'AWS::IAM::Role',
        }),
        target,
        NOW,
      ),
    );
    expect(finding.needsDetail).toBe(false);
    expect(finding.drafts(OWNER, externalAccessDetail(true))[0]).toMatchObject({
      severity: 'low',
      ruleId: '990523',
      ruleLevel: 3,
      title: 'Acesso sem uso: papel IAM',
      eventName: 'UnusedIAMRole',
      resource: 'iam-role:papel-antigo',
    });
  });

  it('o arquivado e o resolvido ficam de fora; sem ID ou horário, o registro é recusado', () => {
    const inactive = { ok: false, reason: 'inactive' };
    expect(
      parseAccessAnalyzerFinding(analyzerFinding({ account: ACCOUNT, status: 'ARCHIVED' }), target, NOW),
    ).toEqual(inactive);
    expect(
      parseAccessAnalyzerFinding(analyzerFinding({ account: ACCOUNT, status: 'RESOLVED' }), target, NOW),
    ).toEqual(inactive);
    const raw = analyzerFinding({ account: ACCOUNT });
    expect(parseAccessAnalyzerFinding({ ...raw, id: undefined }, target, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(parseAccessAnalyzerFinding({ ...raw, updatedAt: 'x' }, target, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(
      parsed(parseAccessAnalyzerFinding({ ...raw, resourceOwnerAccount: 'x' }, target, NOW)).accounts,
    ).toBeNull();
  });
});

describe('o registro do Security Hub de um serviço com fonte própria (GuardDuty, Inspector)', () => {
  const OVERLAP = 10 * 60_000;
  /** `minutes` minutos antes do fim da janela do Security Hub. */
  const before = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);
  const collecting = { floor: before(48 * 60), position: before(5) };
  const covered = (coverage: Parameters<typeof coveredByOwnCollector>[0], minutes: number) =>
    coveredByOwnCollector(coverage, before(minutes), NOW, OVERLAP);

  it('sem a fonte própria de fato coletando, nada é pulado: nem o que é recente', () => {
    expect(covered(undefined, 30)).toBe(false);
    expect(covered(undefined, 1)).toBe(false);
    expect(covered(undefined, 0)).toBe(false);
  });

  it('com ela coletando, é pulado o que ela já leu (do começo do que lê até a posição dela) e o que é recente', () => {
    expect(covered(collecting, 30)).toBe(true);
    // A posição e o começo entram.
    expect(covered(collecting, 5)).toBe(true);
    expect(covered(collecting, 48 * 60)).toBe(true);
    // Depois da posição, mas dentro da sobreposição: a janela seguinte do Security Hub o relê.
    expect(covered(collecting, 2)).toBe(true);
    expect(covered(collecting, 0)).toBe(true);
  });

  it('o que ela não alcança entra pelo Security Hub: antes do que ela lê, ou depois de onde parou e fora da sobreposição', () => {
    // Mais antigo do que a fonte própria lê (ela foi autorizada depois).
    expect(covered(collecting, 48 * 60 + 1)).toBe(false);
    // Ela parou há uma hora: o que veio depois só é pulado enquanto está nos últimos 10 min.
    const stale = { ...collecting, position: before(60) };
    expect(covered(stale, 60)).toBe(true);
    expect(covered(stale, 30)).toBe(false);
    expect(covered(stale, 11)).toBe(false);
    expect(covered(stale, 10)).toBe(true);
    // Coletando, mas ainda sem uma janela inteira lida (parou no teto de páginas): só o recente espera por ela.
    const unconfirmed = { ...collecting, position: null };
    expect(covered(unconfirmed, 30)).toBe(false);
    expect(covered(unconfirmed, 3)).toBe(true);
  });
});

describe('o recurso do achado no formato dos outros achados', () => {
  it('os recursos conhecidos ficam como `tipo:identificador`; o resto, com o ARN como veio', () => {
    expect(resourceRef('arn:aws:s3:::meu-bucket')).toBe('s3:meu-bucket');
    expect(resourceRef('i-0abc1234def567890')).toBe('ec2:i-0abc1234def567890');
    expect(resourceRef('arn:aws:ec2:sa-east-1:111111111111:instance/i-0abc1234def567890')).toBe(
      'ec2:i-0abc1234def567890',
    );
    expect(resourceRef('arn:aws:ec2:sa-east-1:111111111111:security-group/sg-0abc1234')).toBe(
      'sg:sg-0abc1234',
    );
    expect(resourceRef('arn:aws:iam::111111111111:user/ana')).toBe('iam-user:ana');
    expect(resourceRef('arn:aws:iam::111111111111:role/servico/papel')).toBe('iam-role:papel');
    expect(resourceRef('arn:aws:lambda:sa-east-1:111111111111:function:app')).toBe(
      'arn:aws:lambda:sa-east-1:111111111111:function:app',
    );
    // O objeto de um bucket não é o bucket.
    expect(resourceRef('arn:aws:s3:::meu-bucket/chave')).toBe('arn:aws:s3:::meu-bucket/chave');
    expect(resourceRef(undefined)).toBeUndefined();
    expect(resourceRef(42)).toBeUndefined();
    expect(resourceRef('')).toBeUndefined();
  });
});

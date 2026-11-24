import { MITRE_TACTIC_NAMES, MITRE_TECHNIQUE_PATTERN } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import { awsAlertMitre, guardDutyMitre } from '../../src/alerts/aws-mitre.js';
import { toFindingDraft } from '../../src/alerts/finding-draft.js';
import { parseWazuhAlert, type WazuhAwsAlert } from '../../src/alerts/wazuh-alert.js';
import { ALFA, cloudTrailAlert, guardDutyAlert, vpcFlowAlert, wafAlert } from './fixtures.js';

const OWNER = { owned: true, tenantId: ALFA.tenantId, accountId: ALFA.accountId } as const;

function alertOf(document: Record<string, unknown>): WazuhAwsAlert {
  const parsed = parseWazuhAlert(document);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.alert;
}

const mitreOf = (alert: WazuhAwsAlert) => {
  const { mitreTactics, mitreTechniques } = toFindingDraft(alert, OWNER);
  return { mitreTactics, mitreTechniques };
};

describe('MITRE ATT&CK do GuardDuty, pelo tipo do achado', () => {
  /** Tipos documentados pela AWS, um por finalidade e um por família que muda a leitura. */
  const TYPES: readonly [type: string, tactics: string[], techniques: string[]][] = [
    // A finalidade com o nome da própria tática.
    ['InitialAccess:IAMUser/AnomalousBehavior', ['Initial Access'], []],
    ['Execution:EC2/SuspiciousFile', ['Execution'], []],
    ['Persistence:IAMUser/AnomalousBehavior', ['Persistence'], []],
    ['PrivilegeEscalation:IAMUser/AnomalousBehavior', ['Privilege Escalation'], []],
    ['DefenseEvasion:IAMUser/AnomalousBehavior', ['Defense Evasion'], []],
    ['CredentialAccess:IAMUser/AnomalousBehavior', ['Credential Access'], []],
    ['CredentialAccess:Kubernetes/TorIPCaller', ['Credential Access'], []],
    ['Discovery:S3/MaliciousIPCaller', ['Discovery'], []],
    ['Exfiltration:S3/MaliciousIPCaller', ['Exfiltration'], []],
    ['Impact:IAMUser/AnomalousBehavior', ['Impact'], []],
    // A finalidade com outro nome, pelo significado documentado.
    ['Backdoor:EC2/C&CActivity.B!DNS', ['Command and Control'], []],
    ['CryptoCurrency:EC2/BitcoinTool.B!DNS', ['Impact'], ['T1496']],
    ['Recon:EC2/PortProbeUnprotectedPort', ['Reconnaissance'], []],
    ['Stealth:IAMUser/PasswordPolicyChange', ['Defense Evasion'], []],
    // As famílias que dizem mais que a finalidade.
    ['Backdoor:EC2/DenialOfService.Dns', ['Command and Control', 'Impact'], ['T1498']],
    ['CredentialAccess:RDS/AnomalousBehavior.SuccessfulBruteForce', ['Credential Access'], ['T1110']],
    ['Impact:EC2/BitcoinDomainRequest.Reputation', ['Impact'], ['T1496']],
    ['Impact:Runtime/CryptoMinerExecuted', ['Impact'], ['T1496']],
    ['Recon:EC2/Portscan', ['Discovery'], ['T1046']],
    ['Recon:IAMUser/MaliciousIPCaller.Custom', ['Discovery'], []],
    ['Stealth:IAMUser/CloudTrailLoggingDisabled', ['Defense Evasion'], ['T1562.008']],
    ['Stealth:S3/ServerAccessLoggingDisabled', ['Defense Evasion'], ['T1562.008']],
    ['Trojan:EC2/DGADomainRequest.C!DNS', ['Command and Control'], ['T1568.002']],
    ['Trojan:EC2/DNSDataExfiltration', ['Exfiltration'], ['T1048']],
    ['Trojan:EC2/DriveBySourceTraffic!DNS', ['Initial Access'], ['T1189']],
    ['UnauthorizedAccess:EC2/SSHBruteForce', ['Credential Access'], ['T1110']],
    ['UnauthorizedAccess:EC2/RDPBruteForce', ['Credential Access'], ['T1110']],
    ['UnauthorizedAccess:EC2/MetadataDNSRebind', ['Credential Access'], ['T1552.005']],
    ['UnauthorizedAccess:Runtime/TorClient', ['Command and Control'], ['T1090.003']],
    ['UnauthorizedAccess:EC2/TorRelay', ['Impact'], []],
    ['UnauthorizedAccess:IAMUser/ConsoleLoginSuccess.B', ['Initial Access'], ['T1078.004']],
    [
      'UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS',
      ['Initial Access'],
      ['T1078.004'],
    ],
    ['UnauthorizedAccess:S3/TorIPCaller', ['Initial Access'], []],
  ];

  it.each(TYPES)('%s', (type, tactics, techniques) => {
    expect(guardDutyMitre(type)).toEqual({ tactics, techniques });
    // Só nomes que o filtro e a matriz conhecem, e técnicas no formato do contrato.
    for (const tactic of tactics) expect(MITRE_TACTIC_NAMES).toContain(tactic);
    for (const technique of techniques) expect(technique).toMatch(MITRE_TECHNIQUE_PATTERN);
    // E é o que o achado leva, seja qual for o MITRE que a regra trouxesse (o do alerta de exemplo é inventado).
    expect(mitreOf(alertOf(guardDutyAlert({ type })))).toEqual({
      mitreTactics: tactics,
      mitreTechniques: techniques,
    });
  });

  it.each([
    // Postura, comportamento fora do comum, ferramenta de teste, arquivo parado e sequência de fases: sem tática única.
    'Policy:IAMUser/RootCredentialUsage',
    'Policy:S3/BucketAnonymousAccessGranted',
    'Behavior:EC2/NetworkPortUnusual',
    'PenTest:IAMUser/KaliLinux',
    'Object:S3/MaliciousFile',
    'AttackSequence:IAM/CompromisedCredentials',
    // A finalidade não diz a tática, e a família também não.
    'Trojan:EC2/DropPoint',
    'UnauthorizedAccess:EC2/MaliciousIPCaller.Custom',
    // Finalidade nova, formato estranho ou hostil: nada inventado.
    'NovaFinalidade:EC2/Algo',
    'impact:EC2/Algo',
    'Impact',
    'Impact:EC2',
    'Impact:EC2/',
    'Impact:EC2/Algo com espaço',
    'constructor:EC2/Algo',
    '__proto__:EC2/Algo',
    `Impact:EC2/${'x'.repeat(400)}`,
    '',
  ])('sem tática nem técnica: %s', (type) => {
    expect(guardDutyMitre(type)).toEqual({ tactics: [], techniques: [] });
  });

  it('sem tipo, sem tática', () => {
    expect(guardDutyMitre(undefined)).toEqual({ tactics: [], techniques: [] });
    expect(guardDutyMitre(null)).toEqual({ tactics: [], techniques: [] });
  });
});

describe('MITRE ATT&CK das outras fontes da AWS no Wazuh', () => {
  it('a rajada de bloqueios do WAF (80443), que a regra de fábrica deixa sem MITRE: varredura ativa', () => {
    expect(mitreOf(alertOf(wafAlert()))).toEqual({
      mitreTactics: ['Reconnaissance'],
      mitreTechniques: ['T1595'],
    });
  });

  it('o bloqueio isolado e a requisição liberada do WAF não dizem intenção nenhuma', () => {
    const alert = alertOf(wafAlert());
    for (const id of ['80440', '80441', '80442']) {
      expect(awsAlertMitre({ ...alert, rule: { ...alert.rule, id } })).toEqual({
        tactics: [],
        techniques: [],
      });
    }
  });

  it('o MITRE da própria regra vale sobre o dicionário', () => {
    const alert = alertOf(wafAlert());
    const mitre = { ids: ['T1190'], tactics: ['Initial Access'], techniques: [] };
    expect(awsAlertMitre({ ...alert, rule: { ...alert.rule, mitre } })).toEqual({
      tactics: ['Initial Access'],
      techniques: ['T1190'],
    });
  });

  it('as correlações dos flow logs da VPC levam o MITRE das regras do nó', () => {
    expect(mitreOf(alertOf(vpcFlowAlert({ rule: 'scan' })))).toEqual({
      mitreTactics: ['Discovery'],
      mitreTechniques: ['T1046'],
    });
    expect(mitreOf(alertOf(vpcFlowAlert({ rule: 'insistence' })))).toEqual({
      mitreTactics: ['Credential Access'],
      mitreTechniques: ['T1110'],
    });
  });

  it('o login com falha e a chamada negada, isolados no CloudTrail, ficam sem tática', () => {
    expect(mitreOf(alertOf(cloudTrailAlert()))).toEqual({ mitreTactics: [], mitreTechniques: [] });
    const denied = cloudTrailAlert({ rule: { id: '80250', description: 'AWS Cloudtrail: AccessDenied.' } });
    expect(mitreOf(alertOf(denied))).toEqual({ mitreTactics: [], mitreTechniques: [] });
  });
});

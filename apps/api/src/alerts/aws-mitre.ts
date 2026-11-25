import type { MitreTacticName } from '@verax/shared';
import type { WazuhAwsAlert } from './wazuh-alert.js';

/**
 * Táticas e técnicas do MITRE ATT&CK dos alertas da AWS que a regra de fábrica do Wazuh deixa sem elas (conferido no
 * `0350-amazon_rules.xml` do 4.14.9: nenhuma regra do GuardDuty, 80300 a 80307, nem do WAF, 80440 a 80443, tem
 * `<mitre>`). As regras do nó (`infra/wazuh/config/manager/rules`, inclusive as dos flow logs da VPC, 100400 e 100401)
 * já trazem o delas, e o alerta as leva.
 *
 * Só o que está documentado, e nada inventado: na dúvida, o alerta fica sem tática, e a técnica só sai quando o tipo não
 * deixa outra leitura. Ficam sem nada, de propósito:
 * - vulnerabilidade, porta alcançável e código (Inspector), controle reprovado (Security Hub sem `TTPs/`) e acesso
 *   aberto ou sem uso (Access Analyzer): são fraquezas, e o ATT&CK classifica ações de um atacante;
 * - a chamada negada (80250) e o login com falha isolado (80254) do CloudTrail: um evento só não diz a intenção. A
 *   repetição diz (80255, força bruta, com o MITRE da própria regra);
 * - no WAF, a requisição liberada (80441) e o bloqueio isolado (80442), que nem viram achado (níveis 0 e 3).
 */
export interface AlertMitre {
  tactics: readonly MitreTacticName[];
  techniques: readonly string[];
}

const NONE: AlertMitre = { tactics: [], techniques: [] };

const mitre = (tactics: readonly MitreTacticName[], techniques: readonly string[] = []): AlertMitre => ({
  tactics,
  techniques,
});

/**
 * A finalidade da ameaça (`ThreatPurpose`), o começo do tipo do achado do GuardDuty, pelo que a AWS documenta ("GuardDuty
 * finding format"). Nove delas levam o nome da própria tática do ATT&CK. As outras, pelo significado documentado:
 * `Backdoor` (o recurso alterado fala com o comando e controle), `CryptoCurrency` (mineração: o recurso usado por
 * outro), `Recon` (reconhecimento) e `Stealth` (esconder os rastros).
 *
 * Sem tática, por não dizerem qual: `Behavior` (fora do comum), `Policy` (prática não recomendada: postura), `PenTest`
 * (ferramenta de teste de invasão), `Object` (arquivo malicioso parado num bucket), `AttackSequence` (várias fases numa
 * só), e `Trojan` e `UnauthorizedAccess` fora das famílias de `GUARDDUTY_FAMILIES`.
 */
const GUARDDUTY_PURPOSES: ReadonlyMap<string, AlertMitre> = new Map([
  ['InitialAccess', mitre(['Initial Access'])],
  ['Execution', mitre(['Execution'])],
  ['Persistence', mitre(['Persistence'])],
  ['PrivilegeEscalation', mitre(['Privilege Escalation'])],
  ['DefenseEvasion', mitre(['Defense Evasion'])],
  ['CredentialAccess', mitre(['Credential Access'])],
  ['Discovery', mitre(['Discovery'])],
  ['Exfiltration', mitre(['Exfiltration'])],
  ['Impact', mitre(['Impact'])],
  ['Backdoor', mitre(['Command and Control'])],
  // Resource Hijacking: o ATT&CK descreve a mineração com os recursos da vítima.
  ['CryptoCurrency', mitre(['Impact'], ['T1496'])],
  ['Recon', mitre(['Reconnaissance'])],
  ['Stealth', mitre(['Defense Evasion'])],
]);

interface GuardDutyFamily {
  purpose: string;
  /** O recurso afetado (`IAMUser`, `S3`); sem informar, qualquer um. */
  resource?: string;
  /** O começo do nome da família (`DenialOfService` vale para `DenialOfService.Dns`); sem informar, qualquer uma. */
  family?: string;
  mitre: AlertMitre;
}

/** As famílias que dizem mais que a finalidade, ou outra coisa. A primeira que casa vale no lugar da finalidade. */
const GUARDDUTY_FAMILIES: readonly GuardDutyFamily[] = [
  // O recurso ataca terceiros: além do comando e controle da finalidade, o impacto (Network Denial of Service).
  {
    purpose: 'Backdoor',
    family: 'DenialOfService',
    mitre: mitre(['Command and Control', 'Impact'], ['T1498']),
  },
  // O acerto depois de uma força bruta no banco (`CredentialAccess:RDS/AnomalousBehavior.SuccessfulBruteForce`).
  {
    purpose: 'CredentialAccess',
    family: 'AnomalousBehavior.SuccessfulBruteForce',
    mitre: mitre(['Credential Access'], ['T1110']),
  },
  { purpose: 'Impact', family: 'BitcoinDomainRequest', mitre: mitre(['Impact'], ['T1496']) },
  { purpose: 'Impact', family: 'CryptoMinerExecuted', mitre: mitre(['Impact'], ['T1496']) },
  // A instância do cliente varre portas de outra máquina: já é depois do acesso (Network Service Discovery). A sondagem
  // que vem de fora (`PortProbe…`) fica com a finalidade, reconhecimento.
  { purpose: 'Recon', family: 'Portscan', mitre: mitre(['Discovery'], ['T1046']) },
  // As chamadas de listagem da conta com uma credencial dela: também é depois do acesso.
  { purpose: 'Recon', resource: 'IAMUser', mitre: mitre(['Discovery']) },
  {
    purpose: 'Stealth',
    family: 'CloudTrailLoggingDisabled',
    mitre: mitre(['Defense Evasion'], ['T1562.008']),
  },
  {
    purpose: 'Stealth',
    family: 'ServerAccessLoggingDisabled',
    mitre: mitre(['Defense Evasion'], ['T1562.008']),
  },
  { purpose: 'Trojan', family: 'DGADomainRequest', mitre: mitre(['Command and Control'], ['T1568.002']) },
  { purpose: 'Trojan', family: 'DNSDataExfiltration', mitre: mitre(['Exfiltration'], ['T1048']) },
  { purpose: 'Trojan', family: 'DriveBySourceTraffic', mitre: mitre(['Initial Access'], ['T1189']) },
  { purpose: 'UnauthorizedAccess', family: 'SSHBruteForce', mitre: mitre(['Credential Access'], ['T1110']) },
  { purpose: 'UnauthorizedAccess', family: 'RDPBruteForce', mitre: mitre(['Credential Access'], ['T1110']) },
  // A consulta que leva ao serviço de metadados da instância, de onde saem as credenciais do papel dela.
  {
    purpose: 'UnauthorizedAccess',
    family: 'MetadataDNSRebind',
    mitre: mitre(['Credential Access'], ['T1552.005']),
  },
  // O Tor é o exemplo do próprio ATT&CK para o proxy de vários saltos.
  {
    purpose: 'UnauthorizedAccess',
    family: 'TorClient',
    mitre: mitre(['Command and Control'], ['T1090.003']),
  },
  // A instância repassa o tráfego de outros: o recurso usado por terceiros. Sem técnica: o tipo não diz qual.
  { purpose: 'UnauthorizedAccess', family: 'TorRelay', mitre: mitre(['Impact']) },
  // A credencial da conta usada por quem não devia (login de dois lugares, fora da AWS, IP malicioso, Tor): conta
  // válida da nuvem.
  { purpose: 'UnauthorizedAccess', resource: 'IAMUser', mitre: mitre(['Initial Access'], ['T1078.004']) },
  { purpose: 'UnauthorizedAccess', resource: 'S3', mitre: mitre(['Initial Access']) },
];

/**
 * O tipo de um achado do GuardDuty: `Finalidade:Recurso/Família.Detecção!Artefato`. Linear: ancorado, com classes
 * limitadas e sem aninhamento, num texto que já chega com no máximo 256 caracteres.
 */
const GUARDDUTY_TYPE = /^([A-Za-z]{1,40}):([A-Za-z0-9]{1,40})\/([A-Za-z0-9.!&_-]{1,170})$/;

/**
 * Táticas e técnicas de um achado do GuardDuty, só pelo tipo dele (o `eventName` do achado). Depender só do tipo é o que
 * deixa igual o mesmo achado lido pela API e pelo bucket (o export para o S3, pelo Wazuh).
 */
export function guardDutyMitre(type: string | null | undefined): AlertMitre {
  const match = GUARDDUTY_TYPE.exec(type ?? '');
  if (match === null) return NONE;
  const [, purpose = '', resource = '', family = ''] = match;
  const known = GUARDDUTY_FAMILIES.find(
    (item) =>
      item.purpose === purpose &&
      (item.resource === undefined || item.resource === resource) &&
      (item.family === undefined || family.startsWith(item.family)),
  );
  return known?.mitre ?? GUARDDUTY_PURPOSES.get(purpose) ?? NONE;
}

/**
 * As regras do Wazuh sem `<mitre>` cujo significado é de um atacante. A rajada de bloqueios do WAF vinda do mesmo IP
 * (80443) é a mesma detecção da rajada do Cloudflare (990330), com a mesma leitura: varredura ativa, antes do acesso. O
 * bloqueio impede o acesso, e a regra não diz o que cada requisição tentava: nada além disso.
 */
const RULE_MITRE: ReadonlyMap<string, AlertMitre> = new Map([
  ['80443', mitre(['Reconnaissance'], ['T1595'])],
]);

/**
 * Táticas e técnicas de um alerta da AWS. No GuardDuty, só pelo tipo do achado, mesmo que um dia a regra do Wazuh traga
 * o dela: o achado lido pela API não passa por regra nenhuma, e os dois caminhos têm de dar o mesmo resultado. Nas
 * outras fontes, as da regra e, se ela não tem nenhuma, as de `RULE_MITRE`.
 */
export function awsAlertMitre(alert: Pick<WazuhAwsAlert, 'source' | 'eventName' | 'rule'>): {
  tactics: readonly string[];
  techniques: readonly string[];
} {
  if (alert.source === 'guardduty') return guardDutyMitre(alert.eventName);
  const { tactics, ids } = alert.rule.mitre;
  if (tactics.length > 0 || ids.length > 0) return { tactics, techniques: ids };
  return RULE_MITRE.get(alert.rule.id) ?? NONE;
}

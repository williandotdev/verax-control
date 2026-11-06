import { createHash } from 'node:crypto';
import { type FindingDraft, severityOfLevel } from '../alerts/finding-draft.js';
import {
  type AuditLog,
  callerIp,
  isGoogleServiceAgent,
  type LogEntry,
  serviceAccountKeyId,
} from './gcp-log-entry.js';

/**
 * Regras de detecção da auditoria da GCP (nó da Verax, sem Wazuh). Cada uma olha um tipo de operação do Cloud Audit
 * Logs e diz o nível (a mesma escala do Wazuh: 12 ou mais é crítica, 10 alta, 7 média, abaixo baixa), o título em
 * português e as táticas e técnicas do MITRE ATT&CK. Os IDs ficam na faixa 9901xx, longe das regras do Wazuh.
 */
export interface GcpRule {
  id: string;
  level: number;
  title: string;
  tactics: readonly string[];
  techniques: readonly string[];
  matches(log: AuditLog): boolean;
}

const method = (log: AuditLog) => log.methodName ?? '';
/** Status 0 (ou ausente) é sucesso; as regras de mudança só contam o que de fato aconteceu. */
const succeeded = (log: AuditLog) => !log.status?.code;
const endsWith = (log: AuditLog, ...suffixes: string[]) =>
  suffixes.some((suffix) => method(log).endsWith(suffix));

/** Campo de um objeto vindo do evento (JSON livre), sem supor o formato. */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * O serviço registrou o que mudou na política (`serviceData`). Nesse caso só o delta vale: sem `bindingDeltas`, nada
 * foi concedido (o JSON omite a lista vazia, e reenviar a mesma política, como faz cada deploy do Cloud Run com
 * `--allow-unauthenticated`, não é uma concessão nova).
 */
export function hasPolicyDelta(log: AuditLog): boolean {
  return log.serviceData !== undefined;
}

/**
 * Vínculos de IAM adicionados: pelo delta da política (o normal) ou, só para serviço que não registra o delta, pela
 * política enviada inteira. Nesse último caso, o achado ganha um ID estável (ver `gcpEventIdFor`), para a mesma
 * política reenviada não virar outro achado.
 */
function addedBindings(log: AuditLog): { role: string; member: string }[] {
  if (hasPolicyDelta(log)) {
    return (log.serviceData?.policyDelta?.bindingDeltas ?? []).flatMap((delta) =>
      delta.action === 'ADD' && delta.role && delta.member
        ? [{ role: delta.role, member: delta.member }]
        : [],
    );
  }
  if (!/setiampolicy|setiampermissions/i.test(method(log))) return [];
  const bindings = field(field(log.request, 'policy'), 'bindings');
  return (Array.isArray(bindings) ? bindings : []).flatMap((binding: unknown) => {
    const role = field(binding, 'role');
    const members = field(binding, 'members');
    if (typeof role !== 'string' || !Array.isArray(members)) return [];
    return members
      .filter((member): member is string => typeof member === 'string')
      .map((member) => ({ role, member }));
  });
}

const PUBLIC_MEMBERS = new Set(['allUsers', 'allAuthenticatedUsers']);

/** Papéis que dão controle do projeto ou permitem agir como outra identidade. */
const PRIVILEGED_ROLES = new Set([
  'roles/editor',
  'roles/iam.securityAdmin',
  'roles/iam.roleAdmin',
  'roles/resourcemanager.projectIamAdmin',
  'roles/resourcemanager.organizationAdmin',
  'roles/iam.serviceAccountAdmin',
  'roles/iam.serviceAccountKeyAdmin',
  'roles/iam.serviceAccountTokenCreator',
  'roles/iam.serviceAccountUser',
  'roles/iam.workloadIdentityUser',
]);

const OPEN_TO_INTERNET = new Set(['0.0.0.0/0', '::/0']);
const ADMIN_PORTS = new Set(['22', '3389']);

interface FirewallRequest {
  direction?: unknown;
  sourceRanges?: unknown;
  alloweds?: unknown;
  allowed?: unknown;
  denieds?: unknown;
  denied?: unknown;
  disabled?: unknown;
}

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0;

function firewallRequest(log: AuditLog): FirewallRequest {
  return log.request ?? {};
}

/** Regra de firewall de entrada que aceita qualquer origem da internet. */
function opensToInternet(log: AuditLog): boolean {
  if (!succeeded(log) || !/compute\.firewalls\.(insert|patch|update)$/.test(method(log))) return false;
  const request = firewallRequest(log);
  if (request.direction === 'EGRESS' || request.disabled === true) return false;
  // Só regra de liberação expõe: uma de bloqueio (DENY) com origem 0.0.0.0/0 protege. Numa alteração (patch) que
  // só troca a origem, a lista de liberação não vem no request, e a regra conta enquanto não for de bloqueio.
  const allows = nonEmpty(request.alloweds ?? request.allowed);
  const denies = nonEmpty(request.denieds ?? request.denied);
  if (denies || (!allows && method(log).endsWith('.insert'))) return false;
  const ranges = Array.isArray(request.sourceRanges) ? request.sourceRanges : [];
  return ranges.some((range) => typeof range === 'string' && OPEN_TO_INTERNET.has(range));
}

/** A regra aberta libera tudo, ou SSH ou RDP (portas de administração). */
function opensAdminPorts(log: AuditLog): boolean {
  const request = firewallRequest(log);
  const allowed = request.alloweds ?? request.allowed;
  const rules = Array.isArray(allowed) ? (allowed as { IPProtocol?: unknown; ports?: unknown }[]) : [];
  return rules.some((rule) => {
    if (rule.IPProtocol === 'all') return true;
    const ports = Array.isArray(rule.ports) ? rule.ports : [];
    if (ports.length === 0) return true;
    return ports.some((port) => {
      if (typeof port !== 'string') return false;
      if (ADMIN_PORTS.has(port)) return true;
      const [from, to] = port.split('-').map(Number);
      return (
        to !== undefined && from !== undefined && [22, 3389].some((admin) => admin >= from && admin <= to)
      );
    });
  });
}

/** Chaves de metadados que dão acesso SSH ou o protegem. */
const SSH_KEYS = new Set(['ssh-keys', 'sshKeys']);
const SSH_GUARDS = new Set(['enable-oslogin', 'block-project-ssh-keys']);

/**
 * Chave SSH incluída ou alterada, ou proteção de SSH (OS Login, bloqueio das chaves do projeto) alterada ou apagada,
 * pelos nomes das chaves no delta de metadados (o Compute redige os valores no `request`).
 */
function changesSshAccess(log: AuditLog): boolean {
  const deltas = [log.metadata?.instanceMetadataDelta, log.metadata?.projectMetadataDelta];
  return deltas.some(
    (delta) =>
      [...(delta?.addedMetadataKeys ?? []), ...(delta?.modifiedMetadataKeys ?? [])].some((key) =>
        SSH_KEYS.has(key),
      ) ||
      // A proteção conta em qualquer mudança, inclusive incluída: `enable-oslogin=FALSE` posto numa VM desliga o OS
      // Login dela mesmo com o projeto ligado, e o valor vem redigido (não dá para saber se é TRUE ou FALSE).
      [
        ...(delta?.addedMetadataKeys ?? []),
        ...(delta?.modifiedMetadataKeys ?? []),
        ...(delta?.deletedMetadataKeys ?? []),
      ].some((key) => SSH_GUARDS.has(key)),
  );
}

const requestMentions = (log: AuditLog, ...needles: string[]) => {
  const request = JSON.stringify(log.request ?? {});
  return needles.some((needle) => request.includes(needle));
};

export const GCP_RULES: readonly GcpRule[] = [
  {
    id: '990101',
    level: 12,
    title: 'Logs de auditoria desviados ou apagados: sink, exclusão, bucket ou log do Cloud Logging alterado',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.008'],
    matches: (log) =>
      succeeded(log) &&
      (/ConfigServiceV2\.(DeleteSink|UpdateSink|CreateExclusion|UpdateExclusion|DeleteBucket|UpdateBucket|UpdateSettings|UpdateCmekSettings)$/.test(
        method(log),
      ) ||
        endsWith(log, 'LoggingServiceV2.DeleteLog')),
  },
  {
    id: '990102',
    level: 12,
    title: 'Auditoria de acesso a dados desligada ou reduzida na política de IAM',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.008'],
    matches: (log) =>
      succeeded(log) &&
      (log.serviceData?.policyDelta?.auditConfigDeltas ?? []).some((delta) => delta.action === 'REMOVE'),
  },
  {
    id: '990103',
    level: 12,
    title: 'Acesso público concedido: allUsers ou allAuthenticatedUsers numa política de IAM',
    tactics: ['Collection', 'Exfiltration'],
    techniques: ['T1530', 'T1537'],
    matches: (log) =>
      succeeded(log) && addedBindings(log).some((binding) => PUBLIC_MEMBERS.has(binding.member)),
  },
  {
    id: '990104',
    level: 12,
    title: 'Papel de dono (roles/owner) concedido',
    tactics: ['Persistence', 'Privilege Escalation'],
    techniques: ['T1098.003'],
    matches: (log) => succeeded(log) && addedBindings(log).some((binding) => binding.role === 'roles/owner'),
  },
  {
    id: '990105',
    level: 10,
    title: 'Papel privilegiado concedido (editor, administração de IAM ou agir como conta de serviço)',
    tactics: ['Persistence', 'Privilege Escalation'],
    techniques: ['T1098.003'],
    matches: (log) =>
      succeeded(log) && addedBindings(log).some((binding) => PRIVILEGED_ROLES.has(binding.role)),
  },
  {
    id: '990106',
    level: 10,
    title: 'Chave de conta de serviço criada',
    tactics: ['Persistence', 'Credential Access'],
    techniques: ['T1098.001'],
    matches: (log) => succeeded(log) && endsWith(log, 'google.iam.admin.v1.CreateServiceAccountKey'),
  },
  {
    id: '990107',
    level: 7,
    title: 'Conta de serviço criada',
    tactics: ['Persistence'],
    techniques: ['T1136.003'],
    matches: (log) => succeeded(log) && endsWith(log, 'google.iam.admin.v1.CreateServiceAccount'),
  },
  {
    id: '990108',
    level: 12,
    title: 'Firewall aberto para a internet com todas as portas, SSH ou RDP',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007'],
    matches: (log) => opensToInternet(log) && opensAdminPorts(log),
  },
  {
    id: '990109',
    level: 10,
    title: 'Firewall aberto para a internet (origem 0.0.0.0/0)',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007'],
    matches: opensToInternet,
  },
  {
    id: '990110',
    level: 7,
    title: 'Regra de firewall apagada',
    tactics: ['Defense Evasion'],
    techniques: ['T1562.007'],
    matches: (log) => succeeded(log) && /compute\.firewalls\.delete$/.test(method(log)),
  },
  {
    id: '990111',
    level: 10,
    title: 'Chave SSH incluída nos metadados, ou proteção de SSH (OS Login) alterada',
    tactics: ['Persistence'],
    techniques: ['T1098.004'],
    matches: (log) =>
      succeeded(log) &&
      /compute\.(projects\.setCommonInstanceMetadata|instances\.setMetadata)$/.test(method(log)) &&
      changesSshAccess(log),
  },
  {
    id: '990112',
    level: 10,
    title: 'Versão de chave de criptografia (KMS) destruída ou desativada',
    tactics: ['Impact'],
    techniques: ['T1485'],
    matches: (log) =>
      succeeded(log) &&
      (endsWith(log, 'DestroyCryptoKeyVersion') ||
        (endsWith(log, 'UpdateCryptoKeyVersion') && requestMentions(log, '"DISABLED"'))),
  },
  {
    id: '990113',
    level: 12,
    title: 'Projeto apagado',
    tactics: ['Impact'],
    techniques: ['T1485'],
    matches: (log) => succeeded(log) && /Projects\.DeleteProject$|DeleteProject$/.test(method(log)),
  },
  {
    id: '990114',
    level: 7,
    title: 'API do Google desativada no projeto',
    tactics: ['Defense Evasion'],
    techniques: ['T1562'],
    matches: (log) => succeeded(log) && endsWith(log, 'ServiceUsage.DisableService'),
  },
  {
    id: '990115',
    level: 7,
    title: 'Bucket do Cloud Storage apagado',
    tactics: ['Impact'],
    techniques: ['T1485'],
    matches: (log) => succeeded(log) && method(log) === 'storage.buckets.delete',
  },
  {
    id: '990116',
    level: 7,
    title: 'Política da organização alterada',
    tactics: ['Defense Evasion', 'Privilege Escalation'],
    techniques: ['T1484'],
    matches: (log) =>
      succeeded(log) &&
      /(SetOrgPolicy|ClearOrgPolicy|OrgPolicy\.(CreatePolicy|UpdatePolicy|DeletePolicy))$/.test(method(log)),
  },
  {
    id: '990117',
    level: 7,
    title: 'Federação de identidade criada ou alterada (Workload Identity)',
    tactics: ['Persistence'],
    techniques: ['T1098'],
    matches: (log) =>
      succeeded(log) &&
      /WorkloadIdentityPools\.(CreateWorkloadIdentityPool|UpdateWorkloadIdentityPool|CreateWorkloadIdentityPoolProvider|UpdateWorkloadIdentityPoolProvider)$/.test(
        method(log),
      ),
  },
  {
    id: '990118',
    level: 4,
    title: 'Máquina virtual criada',
    tactics: ['Defense Evasion'],
    techniques: ['T1578.002'],
    matches: (log) => succeeded(log) && /compute\.instances\.insert$/.test(method(log)),
  },
  {
    id: '990119',
    level: 4,
    title: 'Acesso negado a uma API do Google (permissão insuficiente)',
    tactics: ['Discovery'],
    techniques: ['T1526'],
    matches: (log) => {
      // Código 7: PERMISSION_DENIED. Os próprios agentes do Google ficam de fora (tentam e recebem negação como parte
      // do funcionamento normal dos serviços).
      const principal = log.authenticationInfo?.principalEmail;
      return log.status?.code === 7 && (principal === undefined || !isGoogleServiceAgent(principal));
    },
  },
];

/** A regra que vale para a operação: a de nível mais alto entre as que casam (a primeira, no empate). */
export function detect(log: AuditLog | undefined, rules: readonly GcpRule[] = GCP_RULES): GcpRule | null {
  if (!log) return null;
  let best: GcpRule | null = null;
  for (const rule of rules) {
    if ((best === null || rule.level > best.level) && rule.matches(log)) best = rule;
  }
  return best;
}

export { severityOfLevel };

/** Região, quando o recurso diz (localização, região ou zona). */
function regionOf(entry: LogEntry): string | null {
  const labels = entry.resource?.labels ?? {};
  return labels['location'] ?? labels['region'] ?? labels['zone'] ?? null;
}

/** Até onde cabe na chave única do achado (`sourceEventId`, 128). */
const MAX_EVENT_ID = 128;

/** O ID do evento na fila e no achado: o projeto e o `insertId`, único por projeto no Cloud Logging. */
export function gcpEventId(project: string | null, insertId: string): string {
  return `${project ?? '-'}/${insertId}`.slice(0, MAX_EVENT_ID);
}

/** Regras que leem a política de IAM (acesso público, dono, papel privilegiado). */
const POLICY_RULES = new Set(['990103', '990104', '990105']);

/**
 * O ID do achado. Em geral, o do evento. Duas exceções, para um acontecimento virar um achado só:
 * - operação longa (o Compute grava o início e o fim): o ID da operação;
 * - política de IAM de serviço que não registra o delta: o recurso e os vínculos que contaram. A mesma política
 *   reenviada (cada deploy que reaplica o mesmo acesso público, por exemplo) cai na mesma chave e não duplica.
 */
export function gcpEventIdFor(entry: LogEntry, project: string, rule: GcpRule): string {
  const log = entry.protoPayload;
  if (log && POLICY_RULES.has(rule.id) && !hasPolicyDelta(log)) {
    const granted = addedBindings(log)
      .filter(
        (binding) =>
          PUBLIC_MEMBERS.has(binding.member) ||
          binding.role === 'roles/owner' ||
          PRIVILEGED_ROLES.has(binding.role),
      )
      .map((binding) => `${binding.role}=${binding.member}`)
      .sort()
      .join(',');
    // O dia (UTC) entra na chave: reenviar a mesma política no mesmo dia não duplica, mas a mesma concessão feita de
    // novo depois de revogada, em outro dia, volta a ser um achado.
    const day = new Date(entry.timestamp).toISOString().slice(0, 10);
    const digest = createHash('sha256')
      .update(`${rule.id}|${log.resourceName ?? ''}|${granted}|${day}`)
      .digest('hex');
    return `${project}/politica:${digest.slice(0, 40)}`;
  }
  const operation = entry.operation?.id;
  if (operation) {
    // Só ID e produtor juntos são únicos; a regra entra para início e fim que casem regras diferentes não se anularem.
    const digest = createHash('sha256')
      .update(`${entry.operation?.producer ?? ''}|${operation}|${rule.id}`)
      .digest('hex');
    return `${project}/operacao:${digest.slice(0, 40)}`;
  }
  return gcpEventId(project, entry.insertId);
}

/** De entrada da auditoria da GCP a achado, já com o cliente decidido pela assinatura e conferido pelo projeto. */
export function toGcpFindingDraft(
  entry: LogEntry,
  owner: { tenantId: string; project: string },
  rule: GcpRule,
): FindingDraft {
  const log = entry.protoPayload;
  const principal = log?.authenticationInfo?.principalEmail ?? null;
  return {
    tenantId: owner.tenantId,
    accountId: owner.project,
    source: 'gcp',
    sourceEventId: gcpEventIdFor(entry, owner.project, rule),
    occurredAt: new Date(entry.timestamp).toISOString(),
    severity: severityOfLevel(rule.level),
    ruleId: rule.id,
    ruleLevel: rule.level,
    title: rule.title,
    logSource: 'gcp_audit',
    eventName: log?.methodName ?? null,
    region: regionOf(entry),
    resource: log?.resourceName ?? null,
    actorUser: principal,
    actorType:
      principal === null ? null : principal.endsWith('.gserviceaccount.com') ? 'service_account' : 'user',
    accessKeyId: serviceAccountKeyId(log),
    sourceIp: callerIp(log),
    mitreTactics: [...new Set(rule.tactics)].sort(),
    mitreTechniques: [...new Set(rule.techniques)].sort(),
  };
}

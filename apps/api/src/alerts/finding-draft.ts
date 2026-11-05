import { createHash } from 'node:crypto';
import { type FindingSeverity, wazuhAgentRef } from '@verax/shared';
import type { WazuhAgentAlert } from './agent-alert.js';
import type { AgentAlertOwner } from './agent-owner.js';
import type { AlertOwner } from './alert-owner.js';
import type { AwsSource, WazuhAwsAlert } from './wazuh-alert.js';

/**
 * De alerta do Wazuh a achado (T5.3): o que é gravado como `Finding`, já com o cliente decidido pela T5.2.
 * A gravação usa `(source, sourceEventId)` como chave única, então ler o mesmo evento de novo não duplica.
 */

// Severidades do contrato compartilhado com o painel.
export { FINDING_SEVERITIES, type FindingSeverity } from '@verax/shared';

export interface FindingDraft {
  tenantId: string;
  /** A conta de onde veio o evento ou, nos alertas das instâncias, o agente (`agent:<id>`). */
  accountId: string;
  /**
   * Sistema de origem: o Wazuh (contas AWS e agentes nas instâncias do cliente) ou a própria leitura dos logs da GCP e
   * do Cloudflare.
   */
  source: 'wazuh' | 'gcp' | 'cloudflare';
  /** Chave do achado na origem: a mesma a cada releitura do mesmo evento (`wazuhFindingKey`, `gcpEventIdFor`). */
  sourceEventId: string;
  /** Só no Wazuh: o ID do alerta, por onde o detalhe busca o evento bruto no indexer. A GCP não guarda o evento. */
  rawEventId?: string;
  occurredAt: string;
  severity: FindingSeverity;
  ruleId: string;
  ruleLevel: number;
  /** Descrição da regra (o resumo em português vem do dicionário da T7.9). */
  title: string;
  /** Fonte de log: `cloudtrail`, `guardduty`, `waf`, `gcp_audit`, `cloudflare_audit`, `cloudflare_waf` ou `wazuh_agent`. */
  logSource: AwsSource | 'gcp_audit' | 'cloudflare_audit' | 'cloudflare_waf' | 'wazuh_agent';
  eventName: string | null;
  region: string | null;
  resource: string | null;
  actorUser: string | null;
  actorType: string | null;
  accessKeyId: string | null;
  sourceIp: string | null;
  mitreTactics: string[];
  mitreTechniques: string[];
  /**
   * Só no GuardDuty, com id nativo: a versão do achado na origem (`updatedAt`), a chave do achado inteiro
   * (`chainKey`: a mesma no original, nas recorrências e, na sondagem de porta, no achado de cada IP) e a chave que a
   * versão nova ganha se a cadeia já estiver triada (a chave do achado inteiro mais o horário). A gravação decide a
   * reincidência por aqui.
   */
  recurrence?: { lastSeenAt: string; chainKey: string; sourceEventId: string };
}

/**
 * Severidade do achado.
 * - GuardDuty: a da própria AWS, de 0 a 10, nas faixas do GuardDuty (9 ou mais é crítica, 7 alta, 4 média). As
 *   regras do Wazuh juntam tudo de 7 a 9 num nível só.
 * - Demais fontes: pelo nível da regra do Wazuh. 12 ou mais é crítica, 10 alta, 7 média e abaixo disso baixa. As
 *   correlações da AWS (força bruta no console, rajada de bloqueios no WAF) têm nível 10 e ficam altas; um login
 *   com falha isolado (5) fica baixo.
 */
export function findingSeverity(
  alert: Pick<WazuhAwsAlert, 'source' | 'awsSeverity' | 'rule'>,
): FindingSeverity {
  if (alert.source === 'guardduty' && alert.awsSeverity !== undefined) {
    if (alert.awsSeverity >= 9) return 'critical';
    if (alert.awsSeverity >= 7) return 'high';
    if (alert.awsSeverity >= 4) return 'medium';
    return 'low';
  }
  return severityOfLevel(alert.rule.level);
}

/**
 * Severidade pelo nível da regra (a escala do Wazuh, usada também pelas regras próprias da GCP e do Cloudflare): 12 ou
 * mais é crítica, 10 alta, 7 média e abaixo disso baixa.
 */
export function severityOfLevel(level: number): FindingSeverity {
  if (level >= 12) return 'critical';
  if (level >= 10) return 'high';
  if (level >= 7) return 'medium';
  return 'low';
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** Até onde cabe na chave única do achado (`sourceEventId`, 128). */
const MAX_EVENT_ID = 128;

/**
 * Chave do achado do Wazuh (fase 2, PR-W2): `wazuh/<conta>/<tipo>:<id>:<regra>`.
 * - O id é o do evento na própria AWS (`nativeId`), com o tipo da fonte (`cloudtrail`, `guardduty`, `waf`). O mesmo
 *   evento lido de novo (snapshot restaurado, `--reparse`, achado do GuardDuty atualizado) ganha outro `id` de alerta,
 *   mas cai na mesma chave e não duplica. Sem id nativo, vale o `id` do alerta, com o tipo `alert`.
 *   O `nativeId` já separa o que a AWS repete em eventos diferentes: cada IP da sondagem de porta do GuardDuty e
 *   cada requisição do WAF (horário e IP, e não só o `requestId`, que atrás de um ALB o cliente escolhe).
 * - O achado do GuardDuty atualizado (mesmo `id`, atividade nova) cai nessa mesma chave. Se o primeiro ainda não foi
 *   triado, a versão nova é duplicada; se já foi (decisão de 2026-11-04), ela vira outro achado, com a chave do achado
 *   inteiro mais o horário da versão (`recurrenceAt`, o `updatedAt` do GuardDuty): `...:<regra>@<ISO>`. Reler essa
 *   versão cai na mesma chave e não duplica de novo. Na sondagem de porta, a chave da recorrência leva só o `id` do
 *   achado, sem o IP e a porta do item: a versão nova é uma por achado, não uma por IP. Quem decide é a gravação
 *   (`FindingStore`); a chave só a torna estável.
 * - A conta é a do cadastro, decidida pela T5.2, e cada conta é de um cliente só. A chave é única no banco inteiro:
 *   sem a conta, um id repetido de propósito no bucket de um cliente apagaria, como duplicado, o achado de outro.
 * - A regra separa a correlação (rajada de logins com falha, de bloqueios no WAF) do evento simples: o evento que
 *   fecha uma correlação, relido sem os anteriores, casa só com a regra simples, e cada regra vira o próprio achado.
 * Um id que passaria do tamanho da chave entra pelo resumo SHA-256 (com o horário da recorrência, 111 no máximo).
 */
export function wazuhFindingKey(
  alert: Pick<WazuhAwsAlert, 'id' | 'nativeId' | 'source' | 'rule'>,
  accountId: string,
  recurrenceAt?: string,
): string {
  const [type, id] = alert.nativeId === undefined ? ['alert', alert.id] : [alert.source, alert.nativeId];
  const suffix = recurrenceAt === undefined ? '' : `@${recurrenceAt}`;
  const key = `wazuh/${accountId}/${type}:${id}:${alert.rule.id}${suffix}`;
  if (key.length <= MAX_EVENT_ID) return key;
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 40);
  return `wazuh/${accountId}/${type}:sha256-${digest}:${alert.rule.id}${suffix}`;
}

/**
 * A reincidência do GuardDuty, pelo achado inteiro: na sondagem de porta, a chave base leva o IP e a porta do item,
 * e a cadeia e a recorrência levam só o `id` do achado, para a versão nova ser uma por achado.
 */
function recurrenceOf(alert: WazuhAwsAlert, accountId: string): FindingDraft['recurrence'] {
  if (alert.lastSeenAt === undefined || alert.findingId === undefined) return undefined;
  const whole = { ...alert, nativeId: alert.findingId };
  return {
    lastSeenAt: alert.lastSeenAt,
    chainKey: wazuhFindingKey(whole, accountId),
    sourceEventId: wazuhFindingKey(whole, accountId, alert.lastSeenAt),
  };
}

export function toFindingDraft(
  alert: WazuhAwsAlert,
  owner: Extract<AlertOwner, { owned: true }>,
): FindingDraft {
  const recurrence = recurrenceOf(alert, owner.accountId);
  return {
    tenantId: owner.tenantId,
    accountId: owner.accountId,
    source: 'wazuh',
    sourceEventId: wazuhFindingKey(alert, owner.accountId),
    rawEventId: alert.id,
    occurredAt: alert.timestamp,
    severity: findingSeverity(alert),
    ruleId: alert.rule.id,
    ruleLevel: alert.rule.level,
    title: alert.rule.description,
    logSource: alert.source,
    eventName: alert.eventName ?? null,
    region: alert.region ?? null,
    resource: alert.resource ?? null,
    actorUser: alert.actor.user ?? null,
    actorType: alert.actor.identityType ?? null,
    accessKeyId: alert.actor.accessKeyId ?? null,
    sourceIp: alert.actor.ip ?? null,
    mitreTactics: unique(alert.rule.mitre.tactics),
    mitreTechniques: unique(alert.rule.mitre.ids),
    ...(recurrence && { recurrence }),
  };
}

/**
 * Chave do achado de um agente do Wazuh: `wazuh/agent:<id>/alert:<id do alerta>:<regra>`. O log da instância não traz
 * um id próprio em todas as fontes (FIM, SCA, syslog, Windows), então vale o id do alerta, que é o mesmo a cada
 * releitura do documento no indexer (a sobreposição da leitura não duplica). A origem `agent:` nunca se confunde com
 * uma conta (os dois-pontos), e o agente é do cliente do nó: a chave de um agente nunca cai na de outro cliente. Um id
 * que passaria do tamanho da chave entra pelo resumo SHA-256, como na chave das contas.
 */
export function agentFindingKey(alert: Pick<WazuhAgentAlert, 'id' | 'agent' | 'rule'>): string {
  const origin = wazuhAgentRef(alert.agent.id);
  const key = `wazuh/${origin}/alert:${alert.id}:${alert.rule.id}`;
  if (key.length <= MAX_EVENT_ID) return key;
  const digest = createHash('sha256').update(alert.id).digest('hex').slice(0, 40);
  return `wazuh/${origin}/alert:sha256-${digest}:${alert.rule.id}`;
}

/**
 * Achado de um alerta de agente, com o dono decidido por `resolveAgentAlertOwner`. A origem é o agente
 * (`agent:<id>`), e o recurso é a instância (`host:<nome do agente na lista>`): é por ele que os achados da mesma
 * instância se agrupam num incidente. A severidade vem do nível da regra, como nas demais fontes; o MITRE, da regra.
 * O IP e o usuário vêm do log da instância, só para mostrar e agrupar.
 */
export function toAgentFindingDraft(
  alert: WazuhAgentAlert,
  owner: Extract<AgentAlertOwner, { status: 'owned' }>,
): FindingDraft {
  return {
    tenantId: owner.tenantId,
    accountId: wazuhAgentRef(owner.agentId),
    source: 'wazuh',
    sourceEventId: agentFindingKey(alert),
    rawEventId: alert.id,
    occurredAt: alert.timestamp,
    severity: severityOfLevel(alert.rule.level),
    ruleId: alert.rule.id,
    ruleLevel: alert.rule.level,
    title: alert.rule.description,
    logSource: 'wazuh_agent',
    eventName: alert.decoder ?? null,
    region: null,
    resource: `host:${owner.agentName}`,
    actorUser: alert.user ?? null,
    actorType: null,
    accessKeyId: null,
    sourceIp: alert.sourceIp ?? null,
    mitreTactics: unique(alert.rule.mitre.tactics),
    mitreTechniques: unique(alert.rule.mitre.ids),
  };
}

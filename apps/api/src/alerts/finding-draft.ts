import type { FindingSeverity } from '@verax/shared';
import type { AlertOwner } from './alert-owner.js';
import type { AwsSource, WazuhAwsAlert } from './wazuh-alert.js';

/**
 * De alerta do Wazuh a achado (T5.3): o que é gravado como `Finding`, já com o cliente decidido pela T5.2.
 * A gravação usa `(source, sourceEventId)` como chave única, então ler o mesmo alerta de novo não duplica.
 */

// Severidades do contrato compartilhado com o painel.
export { FINDING_SEVERITIES, type FindingSeverity } from '@verax/shared';

export interface FindingDraft {
  tenantId: string;
  accountId: string;
  source: 'wazuh';
  /** ID do alerta no Wazuh. */
  sourceEventId: string;
  occurredAt: string;
  severity: FindingSeverity;
  ruleId: string;
  ruleLevel: number;
  /** Descrição da regra do Wazuh (o resumo em português vem do dicionário da T7.9). */
  title: string;
  awsSource: AwsSource;
  eventName: string | null;
  region: string | null;
  resource: string | null;
  actorUser: string | null;
  actorType: string | null;
  accessKeyId: string | null;
  sourceIp: string | null;
  mitreTactics: string[];
  mitreTechniques: string[];
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
  const level = alert.rule.level;
  if (level >= 12) return 'critical';
  if (level >= 10) return 'high';
  if (level >= 7) return 'medium';
  return 'low';
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export function toFindingDraft(
  alert: WazuhAwsAlert,
  owner: Extract<AlertOwner, { owned: true }>,
): FindingDraft {
  return {
    tenantId: owner.tenantId,
    accountId: owner.accountId,
    source: 'wazuh',
    sourceEventId: alert.id,
    occurredAt: alert.timestamp,
    severity: findingSeverity(alert),
    ruleId: alert.rule.id,
    ruleLevel: alert.rule.level,
    title: alert.rule.description,
    awsSource: alert.source,
    eventName: alert.eventName ?? null,
    region: alert.region ?? null,
    resource: alert.resource ?? null,
    actorUser: alert.actor.user ?? null,
    actorType: alert.actor.identityType ?? null,
    accessKeyId: alert.actor.accessKeyId ?? null,
    sourceIp: alert.actor.ip ?? null,
    mitreTactics: unique(alert.rule.mitre.tactics),
    mitreTechniques: unique(alert.rule.mitre.ids),
  };
}

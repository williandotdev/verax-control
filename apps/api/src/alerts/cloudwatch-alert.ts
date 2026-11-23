import { z } from 'zod';
import { MANAGER_AGENT_ID } from './agent-alert.js';
import {
  ALERT_ID,
  alertRuleSchema,
  at,
  firstOf,
  ip,
  matching,
  normalizeTimestamp,
  text,
} from './wazuh-alert.js';

/**
 * Alerta de um evento do CloudWatch Logs lido pelo Wazuh do nó (onboarding self-service da AWS), como a API o lê do
 * indexer.
 *
 * O serviço `cloudwatchlogs` do módulo aws-s3 entrega ao analysisd a linha de log crua de cada grupo autorizado
 * (conferido no código do Wazuh 4.14.9): o evento não ganha `integration: aws`, nem `aws.source`, nem a conta, nem o
 * nome do grupo. Só o `location` (`Wazuh-AWS`, o cabeçalho com que o módulo manda tudo o que lê) e o `agent.id` do
 * próprio manager (`000`) dizem de onde ele veio. O sync da AWS (`alert-sync.ts`) só lê os eventos com
 * `data.integration = aws` (os de bucket), e o dos agentes só os que não vieram do manager: este é o terceiro caminho, e
 * os três nunca leem o mesmo alerta.
 *
 * Do log (`data.*`) só saem campos para mostrar e agrupar (o decoder, o IP de origem, o usuário), conferidos no formato:
 * a linha é de quem escreve no grupo, e nunca decide o dono.
 *
 * Quem decide o dono (`resolveCloudWatchOwner`) é só o cadastro: como o evento não diz de que conta nem de que grupo
 * veio, ele só é atribuído quando a origem não tem como ser outra, isto é, quando **um só cliente** do nó tem grupo de
 * logs autorizado, em **uma só conta**. Fora disso vai para a fila sem dono, com o motivo:
 * - nenhum cliente com grupo autorizado (a autorização saiu com o alerta a caminho): `unknown_source`;
 * - mais de um cliente com grupo autorizado: `ambiguous_source`;
 * - um cliente só, com grupos autorizados em mais de uma conta: `no_account` (o alerta é dele, mas não há como dizer de
 *   que conta, e o achado precisa de uma).
 */

/** O `location` com que o módulo aws-s3 entrega ao analysisd tudo o que lê. */
export const WAZUH_AWS_LOCATION = 'Wazuh-AWS';

export interface WazuhCloudWatchAlert {
  /** ID do alerta no Wazuh: o mesmo a cada releitura do documento no indexer; o detalhe do achado busca por ele. */
  id: string;
  /** ISO 8601 em UTC. */
  timestamp: string;
  rule: {
    id: string;
    level: number;
    description: string;
    groups: string[];
    mitre: { ids: string[]; tactics: string[]; techniques: string[] };
  };
  /** Decoder que leu a linha (`json`, `sshd`, `web-accesslog`...). */
  decoder?: string;
  /** IP de origem que o decoder leu na linha (`data.srcip`). */
  sourceIp?: string;
  /** Usuário que o decoder leu na linha (`data.srcuser` ou `data.dstuser`). */
  user?: string;
}

export type ParsedCloudWatchAlert =
  | { ok: true; alert: WazuhCloudWatchAlert }
  /** `not_cloudwatch`: não é um evento do CloudWatch Logs (outro `location`, um agente, um evento de bucket). */
  | { ok: false; reason: 'invalid_alert' | 'not_cloudwatch'; id: string | null };

const DECODER = /^[\w.-]{1,64}$/;

const envelopeSchema = z.object({
  id: z.string().regex(ALERT_ID),
  timestamp: z.string().max(64),
  // O achado e a fila guardam o id da regra em 6 caracteres; o Wazuh numera as regras até 999999.
  rule: alertRuleSchema.extend({ id: z.string().regex(/^\d{1,6}$/) }),
});

/**
 * O documento é de um evento do CloudWatch Logs: veio do manager, pelo módulo da AWS, e não é um evento de bucket (os
 * de bucket levam `data.integration = aws`). Sem `agent.id`, vale como do manager, como no sync da AWS.
 */
export function isCloudWatchAlert(document: unknown): boolean {
  const agentId = at(document, 'agent', 'id');
  if (agentId !== undefined && agentId !== MANAGER_AGENT_ID) return false;
  return at(document, 'location') === WAZUH_AWS_LOCATION && at(document, 'data', 'integration') !== 'aws';
}

/** Valida o documento do indexer e extrai o que a API usa. Nunca lança: o que não serve vira um motivo. */
export function parseCloudWatchAlert(document: unknown): ParsedCloudWatchAlert {
  const id = matching(at(document, 'id'), ALERT_ID, 128) ?? null;
  if (!isCloudWatchAlert(document)) return { ok: false, reason: 'not_cloudwatch', id };
  const envelope = envelopeSchema.safeParse(document);
  const timestamp = envelope.success ? normalizeTimestamp(envelope.data.timestamp) : null;
  if (!envelope.success || timestamp === null) return { ok: false, reason: 'invalid_alert', id };
  const { rule } = envelope.data;
  return {
    ok: true,
    alert: {
      id: envelope.data.id,
      timestamp,
      rule: {
        id: rule.id,
        level: rule.level,
        description: rule.description,
        groups: rule.groups,
        mitre: {
          ids: rule.mitre?.id ?? [],
          tactics: rule.mitre?.tactic ?? [],
          techniques: rule.mitre?.technique ?? [],
        },
      },
      decoder: matching(at(document, 'decoder', 'name'), DECODER, 64),
      sourceIp: ip(at(document, 'data', 'srcip')),
      user: firstOf(text(at(document, 'data', 'srcuser'), 128), text(at(document, 'data', 'dstuser'), 128)),
    },
  };
}

/** Uma conta com grupo do CloudWatch Logs autorizado (a autorização valendo), de uma conta AWS ativa. */
export interface CloudWatchSourceOwner {
  tenantId: string;
  accountId: string;
}

export type CloudWatchUnownedReason = 'unknown_source' | 'ambiguous_source' | 'no_account';

export type CloudWatchAlertOwner =
  | { owned: true; tenantId: string; accountId: string }
  | { owned: false; reason: CloudWatchUnownedReason; accounts: string[] };

/**
 * De quem são os alertas do CloudWatch Logs deste nó, pelas contas com grupo autorizado. A mesma resposta vale para
 * todo alerta da execução: o evento não traz nada que separe um do outro.
 */
export function resolveCloudWatchOwner(sources: readonly CloudWatchSourceOwner[]): CloudWatchAlertOwner {
  const tenants = new Set(sources.map((source) => source.tenantId));
  const accounts = [...new Set(sources.map((source) => source.accountId))].sort();
  if (tenants.size === 0) return { owned: false, reason: 'unknown_source', accounts: [] };
  // De mais de um cliente, as contas não vão para a fila: a fila é da equipe da Verax, e o motivo já diz o que houve.
  if (tenants.size > 1) return { owned: false, reason: 'ambiguous_source', accounts: [] };
  const [tenantId = ''] = tenants;
  const [accountId = ''] = accounts;
  if (accounts.length > 1) return { owned: false, reason: 'no_account', accounts };
  return { owned: true, tenantId, accountId };
}

import { WAZUH_AGENT_ID_PATTERN } from '@verax/shared';
import { z } from 'zod';
import {
  accountsOf,
  ALERT_ID,
  alertRuleSchema,
  at,
  AWS_SOURCES,
  firstOf,
  ip,
  matching,
  normalizeTimestamp,
  text,
} from './wazuh-alert.js';

/**
 * Alerta de um agente do Wazuh numa instância do cliente (VM ou EC2 dele), como a API o lê do indexer.
 *
 * Quem gerou o alerta é o `agent.id`, que o manager grava pela conexão de cada agente (a chave dele), e não pelo
 * conteúdo do log: `000` é o próprio manager (o módulo aws-s3, que lê as contas AWS); qualquer outro id é um agente. O
 * sync da AWS (`alert-sync.ts`) só trata os alertas do manager, e o dos agentes (`agent-alert-sync.ts`) só os outros:
 * um alerta nunca passa pelos dois, e nunca é atribuído pelos dois caminhos.
 *
 * Do log da instância (`data.*`) só saem campos para mostrar e agrupar (IP de origem, usuário), conferidos no formato:
 * o log é de quem usa a instância e nunca decide o dono. As contas AWS que ele citar (`data.aws`) só servem para
 * recusar: citando a conta de outro cliente, o alerta vai para a fila sem dono (`agent-owner.ts`).
 */

/** O id do próprio manager nos alertas (as fontes de nuvem lidas por ele). */
export const MANAGER_AGENT_ID = '000';

/**
 * O alerta veio de um agente, e não do manager? Decide qual sync o trata. Sem `agent.id`, o alerta fica com o sync da
 * AWS, como sempre foi (todo alerta do Wazuh tem o campo; o do manager vem com `000`). Com qualquer outro valor, mesmo
 * fora do formato, é do sync dos agentes, que o põe na fila sem dono se não servir.
 */
export function isAgentAlert(document: unknown): boolean {
  const id = at(document, 'agent', 'id');
  return id !== undefined && id !== MANAGER_AGENT_ID;
}

export interface WazuhAgentAlert {
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
  /** O agente, como o manager o grava no alerta (o id e o nome do registro). */
  agent: { id: string; name: string };
  /** Decoder que leu o log (`sshd`, `syscheck_integrity_changed`, `windows_eventchannel`...). */
  decoder?: string;
  /** IP de origem que o decoder leu no log (`data.srcip`). */
  sourceIp?: string;
  /** Usuário que o decoder leu no log (`data.srcuser`, `data.dstuser` ou, no Windows, `targetUserName`). */
  user?: string;
  /** Contas AWS citadas em `data.aws`, sem repetição. `null` quando algum campo de conta está fora do formato. */
  awsAccounts: string[] | null;
}

export type ParsedAgentAlert =
  | { ok: true; alert: WazuhAgentAlert }
  | { ok: false; reason: 'invalid_alert'; id: string | null; agentId: string | null };

const DECODER = /^[\w.-]{1,64}$/;

const agentEnvelopeSchema = z.object({
  id: z.string().regex(ALERT_ID),
  timestamp: z.string().max(64),
  // O achado e a fila guardam o id da regra em 6 caracteres; o Wazuh numera as regras até 999999.
  rule: alertRuleSchema.extend({ id: z.string().regex(/^\d{1,6}$/) }),
  agent: z.object({
    id: z
      .string()
      .regex(WAZUH_AGENT_ID_PATTERN)
      .refine((id) => id !== MANAGER_AGENT_ID),
    // O mesmo formato da lista dos agentes (agents-sync.ts): o nome é comparado com o dela.
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[^\p{Cc}]+$/u),
  }),
});

/**
 * Contas AWS citadas em `data.aws`, pelos mesmos campos e com as mesmas conferências do sync da AWS, de todas as
 * fontes. Um campo presente fora do formato invalida a lista (`null`), como lá: na dúvida, o alerta não é de ninguém.
 */
function awsAccountsOf(document: unknown): string[] | null {
  const aws = at(document, 'data', 'aws');
  if (aws === undefined) return [];
  if (aws === null || typeof aws !== 'object' || Array.isArray(aws)) return null;
  const accounts = new Set<string>();
  for (const source of AWS_SOURCES) {
    const found = accountsOf(source, aws as Record<string, unknown>);
    if (found === null) return null;
    for (const account of found) accounts.add(account);
  }
  return [...accounts].sort();
}

/** Valida o documento do indexer e extrai o que a API usa. Nunca lança: o que não serve vira `invalid_alert`. */
export function parseAgentAlert(document: unknown): ParsedAgentAlert {
  const envelope = agentEnvelopeSchema.safeParse(document);
  const timestamp = envelope.success ? normalizeTimestamp(envelope.data.timestamp) : null;
  if (!envelope.success || timestamp === null) {
    const agentId = matching(at(document, 'agent', 'id'), WAZUH_AGENT_ID_PATTERN, 6);
    return {
      ok: false,
      reason: 'invalid_alert',
      id: matching(at(document, 'id'), ALERT_ID, 128) ?? null,
      agentId: agentId === undefined || agentId === MANAGER_AGENT_ID ? null : agentId,
    };
  }
  const { id, rule, agent } = envelope.data;
  return {
    ok: true,
    alert: {
      id,
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
      agent: { id: agent.id, name: agent.name },
      decoder: matching(at(document, 'decoder', 'name'), DECODER, 64),
      sourceIp: ip(at(document, 'data', 'srcip')),
      user: firstOf(
        text(at(document, 'data', 'srcuser'), 128),
        text(at(document, 'data', 'dstuser'), 128),
        text(at(document, 'data', 'win', 'eventdata', 'targetUserName'), 128),
      ),
      awsAccounts: awsAccountsOf(document),
    },
  };
}

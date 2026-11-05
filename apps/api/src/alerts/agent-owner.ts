import { wazuhAgentRef } from '@verax/shared';
import type { WazuhAgentAlert } from './agent-alert.js';

/**
 * Dono de um alerta de agente do Wazuh (instância do cliente). Um nó atende um só cliente, e quem registra agente no
 * manager dele é esse cliente (a senha de registro só sai para ele): os agentes são do cliente do nó
 * (`WAZUH_AGENTS_TENANT`). Esta é a única função que decide de quem é um alerta de agente.
 *
 * Regra: o alerta é do cliente do nó só quando, ao mesmo tempo,
 * 1. os agentes estão ligados no worker do nó (o arquivo da lista e o cliente, `WAZUH_AGENTS_FILE` e
 *    `WAZUH_AGENTS_TENANT`, que andam juntos);
 * 2. o id do agente (`agent.id`, gravado pelo manager pela conexão do agente, e não pelo log) está na lista do cliente
 *    do nó (`WazuhAgent`, que o worker grava a partir da API do manager), com o mesmo nome. O nome sozinho nunca
 *    decide: quem registra o agente escolhe o nome;
 * 3. nenhuma conta AWS citada no alerta (`data.aws`) está cadastrada em outro cliente (ativa ou não). Conta que não
 *    está em cliente nenhum, ou que é do próprio cliente do nó, não muda nada: o alerta é da instância, não da conta.
 *
 * Na dúvida, o alerta não é de ninguém: vai para a fila sem dono, que só `admin_verax` vê, com o motivo e o agente
 * (`agent:<id>`) junto das contas.
 *
 * A lista dos agentes chega ao banco com atraso (o host a exporta da API do manager a cada minuto, e o worker a grava a
 * cada minuto): o primeiro alerta de um agente recém-registrado chega antes dele. O alerta recente de um agente que a
 * lista ainda não conhece (ou conhece com outro nome), com a lista mais antiga que o alerta, espera a próxima
 * execução, em vez de cair na fila: a sobreposição da leitura (10 min) o relê. Passada a espera, vai para a fila.
 */

/** Quanto um alerta recente espera pela lista dos agentes. Menor que a sobreposição da leitura (`sync-query.ts`). */
export const AGENT_LIST_GRACE_MS = 3 * 60 * 1000;

export type AgentUnownedReason =
  /** Fora do formato esperado (inclusive um campo de conta AWS inválido). */
  | 'invalid_alert'
  /** Os agentes não estão ligados no worker do nó. */
  | 'agents_disabled'
  /** O id do agente não está na lista do cliente do nó. */
  | 'unknown_agent'
  /** O id do agente está na lista, com outro nome. */
  | 'agent_name_mismatch'
  /** O alerta cita uma conta AWS cadastrada em outro cliente. */
  | 'agent_account_conflict';

export type AgentAlertOwner =
  | { status: 'owned'; tenantId: string; agentId: string; agentName: string }
  | { status: 'unowned'; reason: AgentUnownedReason; accounts: string[] }
  /** A lista dos agentes pode ainda não ter este agente: a próxima execução relê o alerta. */
  | { status: 'deferred' };

export interface RegisteredAgent {
  agentId: string;
  name: string;
}

export interface AwsAccountOwner {
  tenantId: string;
  accountId: string;
}

/** O que decide o dono de um alerta de agente, montado a cada execução do sync. */
export class AgentDirectory {
  private constructor(
    /** Cliente do nó; null com os agentes desligados no worker. */
    readonly tenantId: string | null,
    private readonly nameById: ReadonlyMap<string, string>,
    private readonly tenantsByAccount: ReadonlyMap<string, ReadonlySet<string>>,
    /** Hora da última lista do manager (a do arquivo que o host escreveu); null antes da primeira. */
    private readonly listedAt: Date | null,
  ) {}

  static from(input: {
    tenantId: string | null;
    /** Os agentes da lista do cliente do nó (`WazuhAgent`, pelo escopo dele). */
    agents: readonly RegisteredAgent[];
    /** Todas as contas AWS cadastradas, de qualquer cliente, ativas ou não. */
    awsAccounts: readonly AwsAccountOwner[];
    listedAt: Date | null;
  }): AgentDirectory {
    const nameById = new Map<string, string>();
    if (input.tenantId !== null) {
      for (const agent of input.agents) nameById.set(agent.agentId, agent.name);
    }
    const tenantsByAccount = new Map<string, Set<string>>();
    for (const { tenantId, accountId } of input.awsAccounts) {
      tenantsByAccount.set(accountId, new Set([...(tenantsByAccount.get(accountId) ?? []), tenantId]));
    }
    return new AgentDirectory(input.tenantId, nameById, tenantsByAccount, input.listedAt);
  }

  nameOf(agentId: string): string | undefined {
    return this.nameById.get(agentId);
  }

  /** A conta está cadastrada em algum cliente que não é o do nó. */
  belongsElsewhere(accountId: string): boolean {
    const tenants = this.tenantsByAccount.get(accountId);
    return tenants !== undefined && [...tenants].some((tenantId) => tenantId !== this.tenantId);
  }

  /** A lista pode estar atrás do alerta: é mais antiga que ele, e o alerta é recente o bastante para ser relido. */
  mayBeBehind(alertAt: Date, now: Date): boolean {
    const recent = now.getTime() - alertAt.getTime() < AGENT_LIST_GRACE_MS;
    return recent && (this.listedAt === null || this.listedAt < alertAt);
  }
}

function unowned(reason: AgentUnownedReason, accounts: string[]): AgentAlertOwner {
  return { status: 'unowned', reason, accounts };
}

export function resolveAgentAlertOwner(
  alert: WazuhAgentAlert,
  directory: AgentDirectory,
  now: Date,
): AgentAlertOwner {
  const origin = wazuhAgentRef(alert.agent.id);
  if (directory.tenantId === null) return unowned('agents_disabled', [origin]);
  if (alert.awsAccounts === null) return unowned('invalid_alert', [origin]);
  const accounts = [origin, ...alert.awsAccounts];

  const registered = directory.nameOf(alert.agent.id);
  if (registered !== alert.agent.name) {
    if (directory.mayBeBehind(new Date(alert.timestamp), now)) return { status: 'deferred' };
    return unowned(registered === undefined ? 'unknown_agent' : 'agent_name_mismatch', accounts);
  }
  if (alert.awsAccounts.some((account) => directory.belongsElsewhere(account))) {
    return unowned('agent_account_conflict', accounts);
  }
  return { status: 'owned', tenantId: directory.tenantId, agentId: alert.agent.id, agentName: registered };
}

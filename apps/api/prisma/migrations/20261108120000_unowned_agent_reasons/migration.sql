-- Alertas dos agentes do Wazuh nas instâncias do cliente: os motivos de um alerta de agente ficar sem dono.
-- Na dúvida, o alerta não é de ninguém (T5.2): agentes desligados no worker, agente fora da lista do cliente do nó,
-- nome diferente do da lista e conta AWS de outro cliente citada no alerta.

-- AlterEnum
ALTER TYPE "UnownedReason" ADD VALUE 'agents_disabled';
ALTER TYPE "UnownedReason" ADD VALUE 'unknown_agent';
ALTER TYPE "UnownedReason" ADD VALUE 'agent_name_mismatch';
ALTER TYPE "UnownedReason" ADD VALUE 'agent_account_conflict';

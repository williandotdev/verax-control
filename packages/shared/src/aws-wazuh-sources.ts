import { AWS_COLLECTION_ERROR_CODES } from './cloud-accounts.js';

/**
 * Onboarding self-service da AWS: os motivos do estado (`stateCode`) de uma fonte lida pelo Wazuh do nó, de bucket
 * (`method = s3`) ou do CloudWatch Logs (`method = cloudwatch`). Quem os grava é a tarefa `wazuh-config` do worker
 * (`apps/api/src/aws/wazuh-source-health.ts`); o painel decide o texto por eles. Só códigos neutros.
 *
 * O caminho de uma fonte autorizada: `authorized` (`awaiting_collector`) → `configuring` (`awaiting_apply`: está na
 * lista do manager, que o nó ainda não aplicou) → `waiting_events` (aplicada, sem nada lido ainda) → `collecting` (o
 * Wazuh leu um objeto ou um evento dela) → `stalled` (`no_progress`, só na trilha e nos flow logs: a origem tem objeto
 * novo e o Wazuh não o leu em 2 horas). `ingestion_error` leva um dos avisos do nó (`AWS_COLLECTION_ERROR_CODES`) ou o
 * motivo de a fonte ter ficado de fora da lista (`AWS_WAZUH_SOURCE_EXCLUSION_CODES`).
 */

/**
 * Por que uma fonte autorizada fica de fora da lista que o manager lê (o estado dela vira `ingestion_error`):
 * - `invalid_details`: o que a descoberta guardou da fonte não dá uma leitura (sem bucket, sem a data de início);
 * - `unsupported_name`: o nome tem caractere que o módulo do Wazuh recusa (o grupo de logs com `#` ou espaço, a Web
 *   ACL ou o prefixo fora de letras, números, ponto, hífen e sublinhado);
 * - `region_unsupported`: a região não está entre as que o módulo aceita;
 * - `organization_id_unknown`: trilha de organização sem o ID da organização (a pasta dela no bucket não foi achada);
 * - `custom_prefix_unsupported`: há um prefixo antes de `AWSLogs/` num bucket que não é do cadastro anterior da conta;
 * - `source_limit`: a conta passou do teto de fontes lidas pelo Wazuh;
 * - `log_group_name_conflict`: outro grupo do CloudWatch Logs com o mesmo nome, na mesma região, já é lido de outra
 *   conta deste nó (o marcador do módulo não separa as contas).
 */
export const AWS_WAZUH_SOURCE_EXCLUSION_CODES = [
  'invalid_details',
  'unsupported_name',
  'region_unsupported',
  'organization_id_unknown',
  'custom_prefix_unsupported',
  'source_limit',
  'log_group_name_conflict',
] as const;
export type WazuhSourceExclusionCode = (typeof AWS_WAZUH_SOURCE_EXCLUSION_CODES)[number];

/** `configuring`: a fonte está na lista do manager, e o nó ainda não a aplicou. */
export const AWS_WAZUH_AWAITING_APPLY = 'awaiting_apply';
/** `stalled`: a origem tem objeto novo, e o Wazuh não leu nada da fonte em 2 horas. */
export const AWS_WAZUH_NO_PROGRESS = 'no_progress';

/** Todos os motivos que a coleta pelo Wazuh grava numa fonte (além do `awaiting_collector` da autorização). */
export const AWS_WAZUH_SOURCE_STATE_CODES = [
  AWS_WAZUH_AWAITING_APPLY,
  AWS_WAZUH_NO_PROGRESS,
  ...AWS_COLLECTION_ERROR_CODES,
  ...AWS_WAZUH_SOURCE_EXCLUSION_CODES,
] as const;
export type WazuhSourceStateCode = (typeof AWS_WAZUH_SOURCE_STATE_CODES)[number];

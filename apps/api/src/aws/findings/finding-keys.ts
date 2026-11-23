import { createHash } from 'node:crypto';

/**
 * As chaves dos achados lidos pela API da AWS (tarefa `aws-findings`) e as regras que eles levam.
 *
 * **GuardDuty: a mesma chave do Wazuh.** O mesmo achado pode chegar por dois caminhos: o export para o S3, lido pelo
 * Wazuh, e a API do GuardDuty. Para um nunca duplicar o outro, o achado lido pela API sai com a mesma origem (`wazuh`)
 * e a mesma chave (`wazuh/<conta>/guardduty:<id>:<regra>`, `alerts/finding-draft.ts`). A chave leva o ID da regra do
 * Wazuh que casaria com o achado, então a regra é reproduzida aqui (`guardDutyWazuhRule`), pelo arquivo
 * `0350-amazon_rules.xml` do Wazuh 4.14.9:
 *
 * | Regra | Nível | Casa quando                                                    |
 * | ----- | ----- | -------------------------------------------------------------- |
 * | 80303 | 10    | o texto da severidade tem `7`, `8` ou `9`                       |
 * | 80302 | 6     | senão, tem `4`, `5` ou `6`                                      |
 * | 80301 | 3     | senão, tem `0`, `1`, `2` ou `3`                                 |
 * | 80307 | 10    | casou a 80303 e a ação é `PORT_PROBE`                           |
 * | 80306 | 6     | casou a 80302 e a ação é `PORT_PROBE`                           |
 * | 80305 | 3     | casou a 80301 e a ação é `PORT_PROBE`                           |
 *
 * O Wazuh testa as regras filhas da 80300 da de maior nível para a de menor, e o campo é comparado como texto, por
 * trecho (não por faixa): a severidade `10` não tem 7, 8 nem 9 e cai na 80301, e `3.7` (gravada `3.700000`) tem um 7 e
 * cai na 80303. A regra só entra na chave e no `ruleId`; a severidade do achado vem das faixas da própria AWS
 * (`findingSeverity`), nos dois caminhos.
 *
 * **Demais serviços:** a origem é `aws`, e a chave é `aws/<conta>/<serviço>:<id nativo>`, sem a regra (um achado tem
 * uma regra só, e ela não pode mudar a chave). O ID que não cabe, ou que tem caractere fora do conjunto seguro, entra
 * pelo resumo SHA-256.
 */

/** A origem (`Finding.source`) dos achados da API da AWS que não são do GuardDuty. */
export const AWS_FINDINGS_SOURCE = 'aws';

/** Até onde cabe na chave única do achado (`sourceEventId`, 128). */
const MAX_EVENT_ID = 128;
/** Caracteres que entram na chave como estão: os de um ARN e de um UUID. */
const SAFE_NATIVE_ID = /^[A-Za-z0-9._:/+=@-]+$/;

/** O nome do serviço na chave do achado. */
export const AWS_FINDING_KEY_LABELS = {
  guardduty: 'guardduty',
  security_hub: 'securityhub',
  inspector: 'inspector',
  access_analyzer: 'access-analyzer',
} as const;
export type AwsFindingKeyLabel = (typeof AWS_FINDING_KEY_LABELS)[keyof typeof AWS_FINDING_KEY_LABELS];

/**
 * Chave de um achado da API da AWS: `aws/<conta>/<serviço>:<id nativo>`. A conta é a do achado, já decidida como de um
 * cliente (cada conta é de um cliente só), então a chave de um cliente nunca cai na de outro. Fora do tamanho ou do
 * conjunto seguro de caracteres, o ID entra pelo resumo SHA-256 (40 caracteres hexadecimais).
 */
export function awsFindingKey(accountId: string, label: AwsFindingKeyLabel, nativeId: string): string {
  const key = `aws/${accountId}/${label}:${nativeId}`;
  if (key.length <= MAX_EVENT_ID && SAFE_NATIVE_ID.test(nativeId)) return key;
  const digest = createHash('sha256').update(nativeId).digest('hex').slice(0, 40);
  return `aws/${accountId}/${label}:sha256-${digest}`;
}

/**
 * Um número como o decoder JSON do analysisd do Wazuh o grava (conferido no `wazuh-logtest` do 4.14.9, ver
 * `alerts/wazuh-alert.ts`): o inteiro que cabe em 32 bits sai como o próprio número (`8`), os outros com seis casas
 * (`5.500000`).
 */
export function wazuhNumberText(value: number): string {
  return Number.isInteger(value) && Math.abs(value) <= 2_147_483_647 ? String(value) : value.toFixed(6);
}

export interface WazuhRule {
  id: string;
  level: number;
}

const GUARDDUTY_RULES: readonly { digits: RegExp; rule: WazuhRule; portProbe: WazuhRule }[] = [
  { digits: /[789]/, rule: { id: '80303', level: 10 }, portProbe: { id: '80307', level: 10 } },
  { digits: /[456]/, rule: { id: '80302', level: 6 }, portProbe: { id: '80306', level: 6 } },
  { digits: /[0123]/, rule: { id: '80301', level: 3 }, portProbe: { id: '80305', level: 3 } },
];

/** A ação do GuardDuty que tem regra própria no Wazuh (a sondagem de porta). */
export const GUARDDUTY_PORT_PROBE = 'PORT_PROBE';

/**
 * A regra do Wazuh que casa com um achado do GuardDuty, pela severidade (de 0 a 10) e pelo tipo da ação. É a regra que
 * o mesmo achado ganharia chegando pelo bucket: a chave dos dois caminhos depende de as duas baterem.
 */
export function guardDutyWazuhRule(severity: number, actionType: string | undefined): WazuhRule {
  const text = wazuhNumberText(severity);
  // Todo número tem ao menos um algarismo, e os três padrões juntos cobrem os dez: sempre há uma regra.
  const matched = GUARDDUTY_RULES.find(({ digits }) => digits.test(text)) ?? GUARDDUTY_RULES[2];
  if (matched === undefined) throw new RangeError('severidade do GuardDuty sem regra');
  return actionType === GUARDDUTY_PORT_PROBE ? matched.portProbe : matched.rule;
}

/**
 * A descrição que a regra do Wazuh monta para o achado, e que vira o título dele (o GuardDuty não tem título fixo em
 * `alerts/aws-rule-titles.ts`: o título vem da própria AWS). Na sondagem de porta, com o IP e a porta do item.
 */
export function guardDutyRuleDescription(input: {
  actionType: string | undefined;
  title: string;
  probe?: { ip: string | undefined; port: number | undefined };
}): string {
  const head =
    input.actionType === undefined
      ? `AWS GuardDuty: ${input.title}`
      : `AWS GuardDuty: ${input.actionType} - ${input.title}`;
  if (input.actionType !== GUARDDUTY_PORT_PROBE || input.probe === undefined) return `${head}.`;
  return `${head} [IP: ${input.probe.ip ?? '-'}] [Port: ${input.probe.port ?? '-'}].`;
}

/**
 * Títulos fixos em português das regras da AWS no Wazuh (fase 2, PR-V7): o título do achado e, quando o aviso por
 * e-mail chegar (PR-16), o do e-mail. A descrição da regra no Wazuh cita campos do evento (`$(aws.eventName)`, o IP, o
 * bucket) e, nas regras do próprio Wazuh, é em inglês; o título é sempre o mesmo para a mesma regra e não leva nada do
 * evento (o que veio do evento fica nos campos do achado).
 *
 * Cobre toda regra local com nível acima de 0 (`infra/wazuh/config/manager/rules`): as críticas da AWS (100300 a
 * 100324), as do papel de leitura do nó (100202 a 100205, PR-V4') e as correlações separadas por conta (80252, 80255
 * e 80443), mais o login com falha do Wazuh (80254), que o catálogo da AWS também lista. As demais regras do Wazuh
 * (o GuardDuty, cujo título vem da própria AWS, e o CloudTrail genérico) seguem com a descrição.
 */
export const AWS_RULE_TITLES: ReadonlyMap<string, string> = new Map([
  // Regras do Wazuh que o catálogo da AWS usa, e as correlações dele separadas por conta (verax_aws_rules.xml).
  ['80252', 'Muitos objetos apagados no S3 em pouco tempo'],
  ['80254', 'Login no console com falha'],
  ['80255', 'Possível força bruta no console'],
  ['80443', 'Rajada de bloqueios do WAF vinda do mesmo IP'],
  // O papel de leitura do nó (verax_reader_rules.xml; as de nível 0 nunca viram achado).
  ['100202', 'Sessão do papel de leitura da Verax usada fora do IP do nó'],
  ['100203', 'Tentativa de entrar no papel de leitura da Verax fora do IP do nó'],
  ['100204', 'Papel de leitura da Verax alterado'],
  ['100205', 'Política do papel de leitura da Verax alterada'],
  // Regras críticas da AWS (verax_aws_critical_rules.xml).
  ['100300', 'Login no console com a conta root'],
  ['100301', 'Login no console com a conta root sem MFA'],
  ['100302', 'Login no console sem MFA'],
  ['100303', 'Chave de acesso criada para a conta root'],
  ['100304', 'Chave de acesso criada pela conta root para um usuário IAM'],
  ['100305', 'Permissão de administrador concedida'],
  ['100306', 'Permissão de administrador concedida'],
  ['100307', 'Permissão de administrador concedida'],
  ['100308', 'Papel IAM que qualquer conta pode assumir'],
  ['100309', 'Papel IAM que qualquer conta pode assumir'],
  ['100310', 'CloudTrail parado ou apagado'],
  ['100311', 'GuardDuty desligado ou silenciado'],
  ['100312', 'GuardDuty desligado ou silenciado'],
  ['100313', 'GuardDuty desligado ou silenciado'],
  ['100314', 'Bucket S3 aberto ao público'],
  ['100315', 'Grupo de segurança aberto para a internet'],
  ['100316', 'Grupo de segurança aberto para a internet em todas as portas'],
  ['100317', 'Grupo de segurança aberto para a internet em porta de administração remota'],
  ['100318', 'Grupo de segurança aberto para a internet em porta de banco de dados'],
  ['100319', 'Snapshot ou imagem compartilhada publicamente'],
  ['100320', 'Domínio transferido, destravado ou com DNS trocado'],
  ['100321', 'Conta saiu da organização ou política da organização removida'],
  ['100322', 'WAF desligado, desassociado ou sem log'],
  ['100323', 'Regras do WAF alteradas'],
  ['100324', 'Conta root usada para alterar a conta'],
]);

/** O título do achado: o fixo da regra, quando ela tem um; senão, a descrição que o Wazuh gravou no alerta. */
export function awsAlertTitle(rule: { id: string; description: string }): string {
  return AWS_RULE_TITLES.get(rule.id) ?? rule.description;
}

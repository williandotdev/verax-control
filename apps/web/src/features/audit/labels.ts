import type { AuditOutcome, AuditPeriod, AuditResourceType } from '@verax/shared';
import { Ban, CircleCheck, CircleX, type LucideIcon } from 'lucide-react';

/** Nome de cada ação gravada na trilha, em português. Ação sem nome aqui aparece como foi gravada. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'auth.sign_in': 'Entrou no painel',
  'auth.sign_out': 'Saiu do painel',
  'auth.sso_login': 'Entrou pelo Admin master',
  'auth.mfa_enroll': 'Cadastrou o MFA',
  'auth.mfa_verify': 'Confirmou o código do MFA',
  'auth.mfa_recovery_code': 'Usou um código de recuperação',
  'auth.mfa_recovery_codes_regenerate': 'Gerou novos códigos de recuperação',
  'auth.password_reset_request': 'Pediu redefinição de senha',
  'auth.password_reset': 'Redefiniu a senha',
  'auth.password_change': 'Trocou a senha',
  'auth.session_revoke': 'Encerrou uma sessão',
  'auth.session_revoke_others': 'Encerrou as outras sessões',
  'session.switch_tenant': 'Equipe Verax entrou no cliente',
  'session.clear_tenant': 'Equipe Verax saiu do cliente',
  'tenant.create': 'Cadastrou cliente',
  'tenant.update': 'Alterou cliente',
  'tenant.deactivate': 'Desativou cliente',
  'user.create': 'Criou usuário',
  'user.temporary_password': 'Gerou senha temporária',
  // Do convite por e-mail, antes da senha temporária: continuam na trilha antiga.
  'user.invite': 'Convidou usuário',
  'user.resend_invitation': 'Reenviou convite',
  'user.update': 'Alterou usuário',
  'user.deactivate': 'Desativou usuário',
  'user.reset_mfa': 'Zerou o MFA de usuário',
  'user.notification_preference': 'Mudou a própria preferência de avisos por e-mail',
  'escalation_contact.update': 'Trocou o contato de escalonamento',
  'escalation_contact.resend': 'Pediu de novo a confirmação do contato de escalonamento',
  'escalation_contact.confirm': 'O contato de escalonamento confirmou o endereço',
  'escalation_contact.unsubscribe': 'O contato de escalonamento deixou de receber os avisos',
  'cloud_account.create': 'Conectou conta cloud',
  'cloud_account.update': 'Alterou conta cloud',
  'cloud_account.deactivate': 'Desativou conta cloud',
  'cloud_account.delete': 'Excluiu conta cloud',
  'cloud_account.aws_verify': 'Pediu a verificação da conta AWS',
  'cloud_account.aws_check': 'Verificou a conta AWS (papel de leitura)',
  'cloud_account.aws_collection': 'Atualizou o estado da coleta da conta AWS no nó',
  // Onboarding self-service da AWS: o "Conectar", a descoberta das fontes e a autorização delas.
  'cloud_account.aws_connect': 'Pediu a conexão da conta AWS',
  'cloud_account.aws_template': 'Leu a versão do modelo e as autorizações do papel de leitura da conta AWS',
  'cloud_account.aws_discovery_request': 'Pediu a descoberta das fontes de log da conta AWS',
  'cloud_account.aws_discovery': 'Descobriu as fontes de log da conta AWS',
  'cloud_account.aws_source_authorized': 'Autorizou a coleta de fontes de log da conta AWS',
  'cloud_account.aws_source_revoked': 'Desautorizou a coleta de uma fonte de log da conta AWS',
  'cloud_account.aws_source_retry': 'Pediu a conferência da permissão de uma fonte de log da conta AWS',
  'cloud_account.aws_source_collection': 'Mudou o estado da coleta de uma fonte da conta AWS',
  // Ataques web pelos logs do balanceador: a configuração do cliente.
  'web_logs.settings_update': 'Alterou o modo ou os limites da detecção de ataques web de um balanceador',
  'web_logs.estimate_request': 'Pediu a estimativa de volume de um balanceador',
  'web_logs.trusted_source_create': 'Incluiu fonte confiável na detecção de ataques web',
  'web_logs.trusted_source_update': 'Alterou fonte confiável da detecção de ataques web',
  'web_logs.trusted_source_delete': 'Removeu fonte confiável da detecção de ataques web',
  'web_logs.route_create': 'Declarou rota de um balanceador',
  'web_logs.route_update': 'Alterou rota declarada de um balanceador',
  'web_logs.route_delete': 'Removeu rota declarada de um balanceador',
  'cloud_credential.set': 'Guardou a credencial de leitura da conta',
  'cloud_credential.rotate': 'Trocou a credencial de leitura da conta',
  'cloud_credential.remove': 'Removeu a credencial de leitura da conta',
  'cloud_credential.wipe': 'Apagou a credencial da conta desativada ou excluída',
  'cloud_credential.refused': 'Credencial recusada pela origem',
  'cloud_credential.rekey': 'Recifrou a credencial com a chave nova do nó',
  'protected_resource.create': 'Incluiu item na lista de proteção',
  'protected_resource.update': 'Alterou item da lista de proteção',
  'protected_resource.delete': 'Removeu item da lista de proteção',
  'alert_exception.create': 'Criou exceção de alerta',
  'alert_exception.update': 'Alterou exceção de alerta',
  'alert_exception.delete': 'Removeu exceção de alerta',
  'alert_exception.create_batch': 'Criou exceções de alerta a partir de um caso',
  'alert_exception.scoped_create': 'Criou exceção ampla',
  'alert_exception.scoped_revoke': 'Revogou exceção ampla',
  'finding.status': 'Mudou o status de alerta',
  'finding.comment': 'Comentou alerta',
  'incident.update': 'Alterou incidente',
  'incident.create': 'Confirmou incidente (promoveu alertas)',
  'incident.attach': 'Anexou alertas a incidente',
  'incident.detach': 'Removeu alerta de incidente',
  'incident.dissolve': 'Desfez incidente automático (alertas voltaram para validação)',
  // Casos e triagem em massa (`apps/api/src/cases`): a pessoa pede, e o sistema registra o fim.
  'case.split': 'Dividiu um caso',
  'triage.bulk.request': 'Pediu triagem em massa',
  'triage.bulk.finish': 'Triagem em massa terminou',
  'triage.bulk.undo': 'Pediu para desfazer uma triagem em massa',
  'triage.bulk.undo_all': 'Pediu para desfazer tudo o que uma pessoa triou em massa',
  'triage.bulk.cancel': 'Cancelou uma triagem em massa',
  'triage.bulk.continue': 'Retomou uma triagem em massa',
  'triage.bulk.replay': 'Repetiu um pedido de triagem em massa (nada mudou)',
  'agents.install_instructions.view': 'Viu as instruções de instalação dos agentes',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export const AUDIT_OUTCOME_LABELS: Readonly<Record<AuditOutcome, { label: string; icon: LucideIcon }>> = {
  success: { label: 'Sucesso', icon: CircleCheck },
  failure: { label: 'Falha', icon: CircleX },
  denied: { label: 'Negado', icon: Ban },
};

export const AUDIT_RESOURCE_LABELS: Readonly<Record<AuditResourceType, string>> = {
  login: 'Login',
  tenant: 'Clientes',
  user: 'Usuários',
  cloud_account: 'Contas cloud',
  protected_resource: 'Lista de proteção',
  alert_exception: 'Exceções',
  finding: 'Alertas',
  incident: 'Incidentes',
  alert_case: 'Casos',
  triage_operation: 'Triagem em massa',
  wazuh_agents: 'Agentes',
};

/**
 * As áreas que só existem com os casos ligados. Um nó de antes recusa o valor no filtro (400), então elas só são oferecidas
 * quando a API diz que os casos valem.
 */
export const CASE_AUDIT_AREAS: readonly AuditResourceType[] = ['alert_case', 'triage_operation'];

export function resourceLabel(resourceType: string | null): string | null {
  if (resourceType === null) return null;
  return (AUDIT_RESOURCE_LABELS as Readonly<Record<string, string>>)[resourceType] ?? resourceType;
}

export const AUDIT_PERIOD_LABELS: Readonly<Record<AuditPeriod, string>> = {
  '24h': 'Últimas 24 horas',
  '7d': 'Últimos 7 dias',
  '30d': 'Últimos 30 dias',
  '90d': 'Últimos 90 dias',
  '12m': 'Últimos 12 meses',
};

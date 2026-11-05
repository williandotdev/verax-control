import type { AuditOutcome, AuditPeriod, AuditResourceType } from '@verax/shared';
import { Ban, CircleCheck, CircleX, type LucideIcon } from 'lucide-react';

/** Nome de cada ação gravada na trilha, em português. Ação sem nome aqui aparece como foi gravada. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  'auth.sign_in': 'Entrou no painel',
  'auth.sign_out': 'Saiu do painel',
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
  'cloud_account.create': 'Conectou conta cloud',
  'cloud_account.update': 'Alterou conta cloud',
  'cloud_account.deactivate': 'Desativou conta cloud',
  'cloud_account.aws_verify': 'Pediu a verificação da conta AWS',
  'cloud_account.aws_check': 'Verificou a conta AWS (papel de leitura)',
  'cloud_account.aws_collection': 'Atualizou o estado da coleta da conta AWS no nó',
  'cloud_credential.set': 'Guardou a credencial de leitura da conta',
  'cloud_credential.rotate': 'Trocou a credencial de leitura da conta',
  'cloud_credential.remove': 'Removeu a credencial de leitura da conta',
  'cloud_credential.wipe': 'Apagou a credencial da conta desativada',
  'cloud_credential.refused': 'Credencial recusada pela origem',
  'cloud_credential.rekey': 'Recifrou a credencial com a chave nova do nó',
  'protected_resource.create': 'Incluiu item na lista de proteção',
  'protected_resource.update': 'Alterou item da lista de proteção',
  'protected_resource.delete': 'Removeu item da lista de proteção',
  'alert_exception.create': 'Criou exceção de alerta',
  'alert_exception.update': 'Alterou exceção de alerta',
  'alert_exception.delete': 'Removeu exceção de alerta',
  'finding.status': 'Mudou o status de achado',
  'finding.comment': 'Comentou achado',
  'incident.update': 'Alterou incidente',
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
  finding: 'Achados',
  incident: 'Incidentes',
  wazuh_agents: 'Agentes',
};

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

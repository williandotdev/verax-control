import {
  CLOUDFLARE_OAUTH_REFUSED_CODE,
  type CloudflareGrantStatus,
  type CloudflareOauthAttemptError,
  type CloudflareZoneState,
} from '@verax/shared';
import { ApiRequestError } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';

/** Por que a conexão falhou, para quem administra a conta. Nada aqui vem do Cloudflare: são textos fixos por código. */
export const ATTEMPT_ERROR_TEXTS: Readonly<Record<CloudflareOauthAttemptError, string>> = {
  oauth_denied:
    'A autorização não foi dada no Cloudflare. Se foi engano, comece de novo e clique em Autorizar. Se o administrador da conta bloqueou aplicativos de terceiros, peça a liberação do Verax Control.',
  oauth_code_rejected:
    'O Cloudflare recusou a autorização (ela venceu ou já tinha sido usada). Comece de novo.',
  oauth_client_rejected:
    'O Cloudflare recusou o aplicativo da Verax. Não é nada na sua conta: fale com a Verax.',
  oauth_no_refresh:
    'O Cloudflare não liberou o acesso contínuo, e a leitura pararia em uma hora. Comece de novo e autorize o acesso offline, se o Cloudflare perguntar.',
  oauth_scope_missing:
    'O Cloudflare não liberou todas as permissões de leitura pedidas. Comece de novo e autorize todas elas.',
  oauth_scope_unexpected:
    'O Cloudflare liberou uma permissão que o Verax não pediu, e a conexão foi recusada por segurança. Fale com a Verax.',
  oauth_no_account:
    'Nenhuma conta autorizada permite ler a auditoria. Comece de novo e, no Cloudflare, escolha uma conta em que você tem acesso de leitura à auditoria.',
  oauth_account_mismatch:
    'A conta autorizada no Cloudflare não é a cadastrada aqui. Comece de novo e escolha a mesma conta.',
  account_exists: 'Esta conta do Cloudflare já está cadastrada e não pôde ser ligada a esta autorização.',
  plan_limit_reached:
    'O plano do cliente não tem vaga para mais contas. Libere uma vaga ou fale com a Verax e comece de novo.',
  tenant_plan_missing:
    'O plano do cliente ainda não chegou a este ambiente. Tente de novo em alguns minutos.',
  source_unavailable: 'O Cloudflare não respondeu agora. Tente de novo em alguns minutos.',
  internal_error: 'Não foi possível concluir a conexão. Tente de novo; se continuar, fale com a Verax.',
};

/** A recusa do retorno é sempre a mesma (outra sessão, outro usuário, vencida, repetida): nunca diz qual foi. */
export const RETURN_REFUSED_TEXT =
  'Não foi possível concluir a conexão com o Cloudflare. O link de retorno venceu, já foi usado ou não é desta sessão. Comece de novo pela tela de contas.';

/** O erro de começar ou concluir, para a tela. */
export function oauthErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === CLOUDFLARE_OAUTH_REFUSED_CODE) return RETURN_REFUSED_TEXT;
    if (error.code === 'CLOUDFLARE_OAUTH_ATTEMPTS_EXCEEDED') {
      return 'Muitas tentativas de conectar. Tente de novo em até uma hora.';
    }
    if (error.status === 404)
      return 'A conexão com o Cloudflare por autorização não está disponível neste ambiente.';
  }
  return errorMessage(error);
}

export const GRANT_STATUS_TEXTS: Readonly<Record<CloudflareGrantStatus, string>> = {
  active: 'Autorizada',
  reconnect: 'Precisa conectar de novo',
  revoking: 'Sendo revogada',
};

export const ZONE_STATE_TEXTS: Readonly<Record<CloudflareZoneState, string>> = {
  pending: 'Aguardando a primeira leitura',
  reading: 'Lendo',
  not_entitled: 'Sem o dado no plano da zona',
  forbidden: 'Sem permissão de leitura',
  over_limit: 'Além do limite de zonas',
  not_monitored: 'Fora do monitoramento',
  missing: 'Não aparece mais na conta',
};

export const ZONE_STATE_SEVERITY: Readonly<
  Record<CloudflareZoneState, 'ok' | 'medium' | 'critical' | 'low'>
> = {
  pending: 'low',
  reading: 'ok',
  not_entitled: 'medium',
  forbidden: 'critical',
  over_limit: 'medium',
  not_monitored: 'low',
  missing: 'low',
};

import { API_PREFIX } from '../common/http/api-prefix.js';

export const AUTH = Symbol('AUTH');
export const AUTH_BASE_PATH = `/${API_PREFIX}/auth`;

/**
 * Header interno com o IP do cliente, calculado pelo Express (respeitando `TRUST_PROXY_HOPS`) e repassado
 * ao Better Auth para limite de tentativas e registro de sessão. Qualquer valor vindo do cliente é
 * sobrescrito, então ele não consegue forjar o próprio IP.
 */
export const CLIENT_IP_HEADER = 'x-verax-client-ip';

/** Sessão expira após 30 min sem uso (renovada a cada minuto de atividade). */
export const SESSION_IDLE_TIMEOUT_SECONDS = 30 * 60;
export const SESSION_REFRESH_AFTER_SECONDS = 60;
/** E dura no máximo 12 h, mesmo com uso contínuo. */
export const SESSION_ABSOLUTE_MAX_MS = 12 * 60 * 60 * 1000;

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
/** Links de convite e de redefinição de senha: uso único, 60 min. */
export const PASSWORD_LINK_TTL_SECONDS = 60 * 60;

/** MFA (T2.2): falhas seguidas de TOTP/código de recuperação antes do bloqueio, e duração do bloqueio. */
export const MFA_MAX_FAILED_ATTEMPTS = 5;
export const MFA_LOCKOUT_SECONDS = 15 * 60;
/** Tempo para digitar o código depois da senha. */
export const MFA_CHALLENGE_SECONDS = 5 * 60;
export const BACKUP_CODES_AMOUNT = 10;

/** Código de erro devolvido quando a sessão ainda não cadastrou o MFA. */
export const MFA_REQUIRED_CODE = 'MFA_REQUIRED';

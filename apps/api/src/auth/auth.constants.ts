import { API_PREFIX } from '../common/http/api-prefix.js';

export const AUTH = Symbol('AUTH');
export const AUTH_BASE_PATH = `/${API_PREFIX}/auth`;

/**
 * Header interno com o IP do cliente, calculado pelo Express (respeitando `TRUST_PROXY_HOPS`) e repassado
 * ao Better Auth para limite de tentativas e registro de sessão. Qualquer valor vindo do cliente é
 * sobrescrito, então ele não consegue forjar o próprio IP.
 */
export const CLIENT_IP_HEADER = 'x-verax-client-ip';
/** Header interno com o request id, para a auditoria de login ligar o evento ao log. Também sobrescrito. */
export const REQUEST_ID_INTERNAL_HEADER = 'x-verax-request-id';

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

/** Código e mensagem de erro devolvidos quando a sessão ainda não cadastrou o MFA. */
export const MFA_REQUIRED_CODE = 'MFA_REQUIRED';
export const MFA_REQUIRED_MESSAGE = 'Cadastre a verificação em duas etapas para continuar';

/** Um código TOTP aceito no login não vale de novo por este tempo (cobre a janela de ±1 passo de 30 s). */
export const TOTP_REPLAY_WINDOW_SECONDS = 2 * 60;

/**
 * Limite por IP nas rotas de autenticação (T2.3), em janelas de segundos. Guardado no banco para valer
 * entre instâncias da API.
 */
export const AUTH_RATE_LIMIT_RULES = {
  default: { window: 60, max: 100 },
  '/sign-in/email': { window: 5 * 60, max: 20 },
  '/two-factor/verify-totp': { window: 60, max: 5 },
  '/two-factor/verify-backup-code': { window: 60, max: 5 },
  '/request-password-reset': { window: 15 * 60, max: 5 },
  '/reset-password': { window: 15 * 60, max: 10 },
  '/change-password': { window: 15 * 60, max: 10 },
} as const;

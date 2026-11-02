import type { AuditEntry } from '../common/audit/audit.service.js';
import { CLIENT_IP_HEADER, REQUEST_ID_INTERNAL_HEADER } from './auth.constants.js';

/** Eventos de autenticação gravados na trilha de auditoria (T2.3). Rotas fora deste mapa não são gravadas. */
export const AUTH_AUDIT_ACTIONS: Readonly<Record<string, string>> = {
  '/sign-in/email': 'auth.sign_in',
  '/sign-out': 'auth.sign_out',
  '/two-factor/enable': 'auth.mfa_enroll',
  '/two-factor/verify-totp': 'auth.mfa_verify',
  '/two-factor/verify-backup-code': 'auth.mfa_recovery_code',
  '/two-factor/generate-backup-codes': 'auth.mfa_recovery_codes_regenerate',
  '/request-password-reset': 'auth.password_reset_request',
  '/reset-password': 'auth.password_reset',
  '/change-password': 'auth.password_change',
  '/revoke-session': 'auth.session_revoke',
  '/revoke-other-sessions': 'auth.session_revoke_others',
};

export type AuthAuditSink = (entry: AuditEntry) => Promise<void>;

/** Dados de origem da requisição que o `AuthController` repassa ao Better Auth em headers internos. */
export function requestMetadata(
  headers: Headers | undefined,
): Pick<AuditEntry, 'ip' | 'userAgent' | 'requestId'> {
  return {
    ip: headers?.get(CLIENT_IP_HEADER) ?? undefined,
    userAgent: headers?.get('user-agent') ?? undefined,
    requestId: headers?.get(REQUEST_ID_INTERNAL_HEADER) ?? undefined,
  };
}

import { z } from 'zod';
import { api } from '@/lib/api';
import { ApiRequestError } from '@/lib/api-client';

/**
 * Chamadas às rotas de autenticação (Better Auth em `/v1/auth`). As respostas têm o formato da biblioteca;
 * os schemas validam só os campos que o painel usa.
 */
const signInResponse = z.object({ twoFactorRedirect: z.boolean().optional() });
const enableMfaResponse = z.object({
  totpURI: z.string().startsWith('otpauth://totp/'),
  backupCodes: z.array(z.string().min(1)),
});
const okResponse = z.object({}).loose();

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export async function signIn(email: string, password: string): Promise<{ needsCode: boolean }> {
  const response = await api.post('/v1/auth/sign-in/email', { email, password }, signInResponse);
  api.resetCsrf();
  return { needsCode: response.twoFactorRedirect === true };
}

export async function verifyTotp(code: string): Promise<void> {
  await api.post('/v1/auth/two-factor/verify-totp', { code }, okResponse);
  api.resetCsrf();
}

export async function verifyRecoveryCode(code: string): Promise<void> {
  await api.post('/v1/auth/two-factor/verify-backup-code', { code }, okResponse);
  api.resetCsrf();
}

export function enableMfa(password: string) {
  return api.post('/v1/auth/two-factor/enable', { password }, enableMfaResponse);
}

export async function requestPasswordReset(email: string): Promise<void> {
  await api.post('/v1/auth/request-password-reset', { email }, okResponse);
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await api.post('/v1/auth/reset-password', { token, newPassword }, okResponse);
}

/** Troca a senha da sessão (a temporária, no primeiro acesso). A sessão atual continua; as outras caem. */
export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await api.post('/v1/auth/change-password', { currentPassword, newPassword }, okResponse);
}

/** Segredo do TOTP extraído do URI, para quem não consegue ler o QR (digitado no aplicativo). */
export function totpSecretFromUri(uri: string): string {
  return new URL(uri).searchParams.get('secret') ?? '';
}

/**
 * Destino depois do login: só caminho interno do painel. Endereço absoluto, `//outro-site` ou `\` viram a
 * página inicial (sem redirecionamento aberto).
 */
export function safeRedirect(target: unknown): string {
  if (
    typeof target !== 'string' ||
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('\\')
  ) {
    return '/';
  }
  return target;
}

type AuthStep = 'sign-in' | 'code' | 'set-password' | 'change-password' | 'enroll';

/** Senha nova recusada pela API (redefinição ou troca): o motivo, quando ela diz qual é. */
function newPasswordProblem(error: ApiRequestError): string | undefined {
  if (error.code === 'PASSWORD_COMPROMISED')
    return 'Esta senha aparece em vazamentos conhecidos. Escolha outra.';
  if (error.code === 'PASSWORD_TOO_SHORT')
    return `A senha precisa ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`;
  if (error.code === 'PASSWORD_TOO_LONG')
    return `A senha pode ter no máximo ${PASSWORD_MAX_LENGTH} caracteres.`;
  return undefined;
}

/**
 * Mensagens de erro da autenticação. Nunca dizem se um e-mail existe: credencial errada, usuário
 * inexistente ou desativado recebem a mesma mensagem. A senha temporária vencida tem mensagem própria: a API só a
 * devolve a quem acertou a senha.
 */
export function authErrorMessage(error: unknown, step: AuthStep): string {
  if (!(error instanceof ApiRequestError))
    return 'Não foi possível falar com o servidor. Verifique a conexão.';
  if (error.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
  if (error.status >= 500) return 'O servidor não conseguiu concluir agora. Tente de novo em instantes.';

  if (error.code === 'TEMPORARY_PASSWORD_EXPIRED' && (step === 'sign-in' || step === 'code'))
    return 'Sua senha temporária venceu. Peça outra ao administrador.';

  switch (step) {
    case 'sign-in':
      return 'E-mail ou senha incorretos.';
    case 'code':
      return 'Código inválido ou expirado. Confira o aplicativo e tente de novo.';
    case 'enroll':
      return error.status === 400 || error.status === 401
        ? 'Senha incorreta.'
        : 'Não foi possível iniciar o cadastro.';
    case 'set-password':
      if (error.code === 'INVALID_TOKEN') return 'Este link é inválido ou expirou. Peça um novo.';
      return newPasswordProblem(error) ?? 'Não foi possível definir a senha. Tente de novo.';
    case 'change-password':
      if (error.code === 'INVALID_PASSWORD') return 'Senha temporária incorreta. Confira e digite de novo.';
      if (error.code === 'PASSWORD_UNCHANGED') return 'A senha nova precisa ser diferente da temporária.';
      // A sessão da senha temporária acabou (ou o administrador gerou outra): só um login novo resolve.
      if (error.status === 401) return 'Sua sessão terminou. Entre de novo com a senha temporária.';
      return newPasswordProblem(error) ?? 'Não foi possível trocar a senha. Tente de novo.';
  }
}

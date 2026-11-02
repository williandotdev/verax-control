import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { demoMe } from './fixtures';
import type { MockState } from './handlers';

/** Credenciais e códigos fictícios do modo mock (nenhum vale fora dele). */
export const MOCK_AUTH = {
  email: 'analista@demo.verax.local',
  password: 'senha-de-demonstracao',
  totp: '123456',
  recoveryCode: 'demo-recuperacao-1',
  validLinkToken: 'token-de-link-valido',
  leakedPassword: 'senha-vazada-demonstracao',
  backupCodes: Array.from({ length: 10 }, (_, i) => `demo-recuperacao-${i + 1}`),
  totpURI:
    'otpauth://totp/Verax%20Control:analista%40demo.verax.local?secret=JBSWY3DPEHPK3PXP&issuer=Verax%20Control&digits=6&period=30',
};

/** Valores aceitos pelo mock (conjuntos, não comparação direta com o valor digitado). */
const ACCEPTED_PASSWORDS = new Set([MOCK_AUTH.password]);
const VALID_LINK_TOKENS = new Set([MOCK_AUTH.validLinkToken]);

const url = (path: string): string => `${API_URL}/v1/auth${path}`;
const invalidCredentials = () =>
  HttpResponse.json(
    { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' },
    { status: 401 },
  );

/**
 * Rotas de autenticação simuladas. `mfa` decide o que o login devolve: com MFA, só um desafio; sem MFA,
 * uma sessão que só serve para cadastrar o MFA.
 */
export function createAuthHandlers(state: MockState & { pendingCode?: boolean; mfa?: boolean }) {
  return [
    http.post(url('/sign-in/email'), async ({ request }) => {
      const body = (await request.json()) as { email?: string; password?: string };
      if (body.email !== MOCK_AUTH.email || !ACCEPTED_PASSWORDS.has(body.password ?? '')) {
        return invalidCredentials();
      }
      if (state.mfa !== false) {
        state.pendingCode = true;
        return HttpResponse.json({ twoFactorRedirect: true });
      }
      state.me = demoMe('analista_cliente', { mfaEnabled: false });
      return HttpResponse.json({ redirect: false, token: 'oculto' });
    }),
    http.post(url('/two-factor/verify-totp'), async ({ request }) => {
      const { code } = (await request.json()) as { code?: string };
      if (code !== MOCK_AUTH.totp)
        return HttpResponse.json({ message: 'Invalid code', code: 'INVALID_CODE' }, { status: 401 });
      state.pendingCode = false;
      state.me = demoMe('analista_cliente');
      return HttpResponse.json({ token: 'oculto' });
    }),
    http.post(url('/two-factor/verify-backup-code'), async ({ request }) => {
      const { code } = (await request.json()) as { code?: string };
      if (code !== MOCK_AUTH.recoveryCode) {
        return HttpResponse.json(
          { message: 'Invalid backup code', code: 'INVALID_BACKUP_CODE' },
          { status: 401 },
        );
      }
      state.me = demoMe('analista_cliente');
      return HttpResponse.json({ token: 'oculto' });
    }),
    http.post(url('/two-factor/enable'), async ({ request }) => {
      const { password } = (await request.json()) as { password?: string };
      if (!ACCEPTED_PASSWORDS.has(password ?? ''))
        return HttpResponse.json({ message: 'Invalid password' }, { status: 400 });
      return HttpResponse.json({ totpURI: MOCK_AUTH.totpURI, backupCodes: MOCK_AUTH.backupCodes });
    }),
    // Mesma resposta para qualquer e-mail, como na API.
    http.post(url('/request-password-reset'), () =>
      HttpResponse.json({
        status: true,
        message: 'If this email exists in our system, check your email for the reset link',
      }),
    ),
    http.post(url('/reset-password'), async ({ request }) => {
      const { token, newPassword } = (await request.json()) as { token?: string; newPassword?: string };
      if (!VALID_LINK_TOKENS.has(token ?? ''))
        return HttpResponse.json({ message: 'Invalid token', code: 'INVALID_TOKEN' }, { status: 400 });
      if (newPassword === MOCK_AUTH.leakedPassword) {
        return HttpResponse.json(
          {
            message: 'Esta senha aparece em vazamentos conhecidos. Escolha outra.',
            code: 'PASSWORD_COMPROMISED',
          },
          { status: 400 },
        );
      }
      return HttpResponse.json({ status: true });
    }),
  ];
}

import type { FakeResponse } from './fake-admin-api';

/**
 * O acesso ao console simulado (`/v1/admin/login`, `/logout`, `/account/...`), em memória, para os testes de
 * componente e os de navegador. Credenciais FICTÍCIAS e de baixa entropia de propósito: só existem aqui, e o "segredo"
 * do aplicativo não serve para nada fora dos testes. Imita os códigos de erro da API (`login_failed` genérico,
 * `invalid_code`, `invalid_credentials`). Não há cadastro por HTTP (a conta nasce pela linha de comando).
 */
export const FICTITIOUS_LOGIN_PHRASE = 'teste-teste-teste';
export const FICTITIOUS_TOTP_CODE = '123456';
export const FICTITIOUS_TOTP_SEED = 'AAAABBBBCCCCDDDDEEEEFFFF';
export const FICTITIOUS_RECOVERY_CODES = [
  'AAAAA-AAAAA',
  'BBBBB-BBBBB',
  'CCCCC-CCCCC',
  'DDDDD-DDDDD',
  'EEEEE-EEEEE',
  'FFFFF-FFFFF',
  'GGGGG-GGGGG',
  'HHHHH-HHHHH',
  'JJJJJ-JJJJJ',
  'KKKKK-KKKKK',
];

export const LOGIN_FAILED_MESSAGE =
  'E-mail, senha ou código incorretos. Depois de 5 tentativas erradas, o acesso fica bloqueado por 15 minutos.';

export interface FakeAuthState {
  /** Com sessão aberta (o padrão dos testes das telas). */
  loggedIn: boolean;
  /** Sessão aberta de um e-mail que saiu da lista de responsáveis: toda rota protegida responde 403. */
  notOwner?: boolean;
  password: string;
  recoveryCodes: string[];
  /** A troca do aplicativo em andamento. */
  enrollment?: { id: string; email: string };
  /** O que a tela mandou por último (para o teste conferir o corpo). */
  lastBody?: unknown;
}

export function createFakeAuth(options: { loggedIn?: boolean } = {}): FakeAuthState {
  return {
    loggedIn: options.loggedIn ?? true,
    password: FICTITIOUS_LOGIN_PHRASE,
    recoveryCodes: [...FICTITIOUS_RECOVERY_CODES],
  };
}

function fail(
  status: number,
  message: string,
  code: string,
  details?: Record<string, unknown>,
): FakeResponse {
  return {
    status,
    body: { statusCode: status, message, code, ...(details === undefined ? {} : { details }) },
  };
}

function field(body: unknown, name: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function enrollment(id: string, email: string, now: Date) {
  return {
    enrollmentId: id,
    otpauthUri: `otpauth://totp/Verax%20Control:${encodeURIComponent(email)}?secret=${FICTITIOUS_TOTP_SEED}&issuer=Verax%20Control`,
    secret: FICTITIOUS_TOTP_SEED,
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
}

/** O segundo fator do corpo: o código do aplicativo ou um código de recuperação ainda não usado (gasta o código). */
function secondFactorOk(auth: FakeAuthState, body: unknown): boolean {
  const recovery = field(body, 'recoveryCode');
  if (recovery !== undefined) {
    const index = auth.recoveryCodes.indexOf(recovery.trim().toUpperCase());
    if (index < 0) return false;
    auth.recoveryCodes.splice(index, 1);
    return true;
  }
  return field(body, 'code') === FICTITIOUS_TOTP_CODE;
}

/** As rotas de acesso; `undefined` para as outras (que exigem sessão: sem ela, 401 `unauthenticated`). */
export function handleAuthRequest(
  auth: FakeAuthState,
  ownerEmail: string,
  now: Date,
  method: string,
  parts: readonly (string | undefined)[],
  body: unknown,
): FakeResponse | undefined {
  const [first, second, third] = parts;
  if (method !== 'GET') auth.lastBody = body;

  if (method === 'POST' && first === 'login' && second === undefined) {
    const email = (field(body, 'email') ?? '').trim().toLowerCase();
    const ok = email === ownerEmail && field(body, 'password') === auth.password;
    // O segundo fator só é conferido (e o código de recuperação só é gasto) com e-mail e senha certos.
    if (!ok || !secondFactorOk(auth, body)) return fail(401, LOGIN_FAILED_MESSAGE, 'login_failed');
    auth.loggedIn = true;
    return { status: 200, body: { email } };
  }

  if (method === 'POST' && first === 'logout' && second === undefined) {
    auth.loggedIn = false;
    return { status: 204, body: undefined };
  }

  if (!auth.loggedIn) return fail(401, 'Não autenticado', 'unauthenticated');
  if (auth.notOwner === true) return fail(403, 'Sem permissão', 'forbidden');

  if (method === 'POST' && first === 'account') {
    const credentialsWrong = (): FakeResponse =>
      fail(400, 'A senha atual ou o código não confere.', 'invalid_credentials');
    if (second === 'password' && third === undefined) {
      if (field(body, 'currentPassword') !== auth.password || !secondFactorOk(auth, body)) {
        return credentialsWrong();
      }
      const next = field(body, 'newPassword') ?? '';
      if (next.length < 12) {
        return fail(400, 'Dados inválidos.', 'invalid_request', {
          issues: [{ path: 'newPassword', message: 'deve ter pelo menos 12 caracteres' }],
        });
      }
      auth.password = next;
      return { status: 204, body: undefined };
    }
    if (second === 'totp' && third === 'start') {
      if (field(body, 'currentPassword') !== auth.password || !secondFactorOk(auth, body)) {
        return credentialsWrong();
      }
      auth.enrollment = { id: 'troca-1', email: ownerEmail };
      return { status: 200, body: enrollment('troca-1', ownerEmail, now) };
    }
    if (second === 'totp' && third === 'confirm') {
      const pending = auth.enrollment;
      if (pending === undefined || field(body, 'enrollmentId') !== pending.id) {
        return fail(410, 'A troca venceu.', 'enrollment_expired');
      }
      if (field(body, 'code') !== FICTITIOUS_TOTP_CODE) return fail(400, 'Código incorreto.', 'invalid_code');
      delete auth.enrollment;
      auth.recoveryCodes = FICTITIOUS_RECOVERY_CODES.map((code) => code.replace(/^./, 'Z'));
      return { status: 200, body: { recoveryCodes: [...auth.recoveryCodes] } };
    }
    return fail(404, 'Recurso não encontrado', 'not_found');
  }
  return undefined;
}

import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_URL } from '@/lib/env';
import { MOCK_AUTH } from './auth-handlers';
import { browserMockState, MOCK_SESSION_LOGGED_IN, MOCK_SESSION_STORAGE_KEY } from './demo-session';
import { DEMO_TENANTS } from './fixtures';
import { createHandlers, type MockState } from './handlers';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  window.sessionStorage.clear();
});
afterAll(() => server.close());

const ALFA = DEMO_TENANTS[0]?.id;

async function post(path: string, body: unknown): Promise<number> {
  const response = await fetch(`${API_URL}/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.status;
}

/** Login com MFA pelo acesso de demonstração, como a tela faz. */
async function signIn(state: MockState): Promise<void> {
  server.use(...createHandlers(state));
  expect(await post('/auth/sign-in/email', { email: MOCK_AUTH.email, password: MOCK_AUTH.password })).toBe(
    200,
  );
  expect(state.me).toBeNull();
  expect(await post('/auth/two-factor/verify-totp', { code: MOCK_AUTH.totp })).toBe(200);
}

const remembered = () => window.sessionStorage.getItem(MOCK_SESSION_STORAGE_KEY);

describe('sessão da demonstração no navegador', () => {
  it('começa fora da sessão', () => {
    expect(browserMockState().me).toBeNull();
  });

  it('com `verax.mock.session` no localStorage (testes e `dev:mock`), começa como o acesso de demonstração', () => {
    window.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, MOCK_SESSION_LOGGED_IN);
    expect(browserMockState().me).toMatchObject({
      role: 'admin_verax',
      activeTenantId: ALFA,
      scopeTenantId: ALFA,
    });
    window.localStorage.setItem('verax.mock.role', 'leitura');
    expect(browserMockState().me).toMatchObject({ role: 'leitura', scopeTenantId: ALFA });
    // Qualquer outro valor não abre a sessão.
    window.localStorage.setItem(MOCK_SESSION_STORAGE_KEY, 'sim');
    expect(browserMockState().me).toBeNull();
  });

  it('o login entra como o admin_verax com o primeiro cliente; recarregar mantém a sessão; sair a encerra', async () => {
    const state = browserMockState();
    await signIn(state);
    expect(state.me).toMatchObject({ role: 'admin_verax', activeTenantId: ALFA, scopeTenantId: ALFA });
    expect(remembered()).toBe(MOCK_SESSION_LOGGED_IN);
    // A página recarregada (um estado novo, na mesma aba) continua dentro.
    expect(browserMockState().me).toMatchObject({ role: 'admin_verax', scopeTenantId: ALFA });

    expect(await post('/auth/sign-out', {})).toBe(200);
    expect(state.me).toBeNull();
    expect(remembered()).toBeNull();
    expect(browserMockState().me).toBeNull();

    // Entra de novo sem recarregar.
    await signIn(state);
    expect(state.me).toMatchObject({ role: 'admin_verax', scopeTenantId: ALFA });
  });

  it('o login entra com o papel de `verax.mock.role`', async () => {
    window.localStorage.setItem('verax.mock.role', 'analista_cliente');
    const state = browserMockState();
    await signIn(state);
    expect(state.me).toMatchObject({ role: 'analista_cliente', scopeTenantId: ALFA });
  });

  it('primeiro acesso: a sessão da senha temporária não sobrevive a recarregar; trocada a senha e cadastrado o MFA, é o mesmo usuário', async () => {
    const state = browserMockState();
    server.use(...createHandlers(state));
    expect(
      await post('/auth/sign-in/email', { email: MOCK_AUTH.email, password: MOCK_AUTH.temporaryPassword }),
    ).toBe(200);
    expect(state.me).toMatchObject({ role: 'admin_verax', mustChangePassword: true, mfaEnabled: false });
    expect(remembered()).toBeNull();

    const password = 'uma-senha-nova-bem-longa';
    expect(
      await post('/auth/change-password', {
        currentPassword: MOCK_AUTH.temporaryPassword,
        newPassword: password,
      }),
    ).toBe(200);
    expect(state.me).toMatchObject({ mustChangePassword: false, mfaEnabled: false });
    expect(remembered()).toBeNull();

    expect(await post('/auth/two-factor/enable', { password })).toBe(200);
    expect(await post('/auth/two-factor/verify-totp', { code: MOCK_AUTH.totp })).toBe(200);
    expect(state.me).toMatchObject({
      role: 'admin_verax',
      scopeTenantId: ALFA,
      mfaEnabled: true,
      mustChangePassword: false,
    });
    expect(remembered()).toBe(MOCK_SESSION_LOGGED_IN);
  });

  it('o estado montado pelos testes não toca no sessionStorage', async () => {
    const state: MockState = { me: null };
    await signIn(state);
    expect(state.me).toMatchObject({ role: 'admin_verax' });
    expect(remembered()).toBeNull();
  });
});

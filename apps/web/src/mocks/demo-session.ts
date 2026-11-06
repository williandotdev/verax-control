import { type Me, type Role, ROLES } from '@verax/shared';
import { DEMO_TENANTS, demoMe } from './fixtures';
import type { MockState } from './handlers';

/**
 * Sessão do mock no navegador (`dev:mock` e o build de demonstração). Quem abre a demonstração começa fora dela, na
 * tela de login, e entra com o acesso de demonstração. Duas exceções, nesta ordem de uso:
 * - `localStorage['verax.mock.session'] = 'logged-in'`: toda carga da página começa com a sessão aberta. É o que os
 *   testes de navegador do projeto `mock` usam (no `playwright.config.ts`) e quem desenvolve as telas no `dev:mock`;
 * - a sessão aberta nesta aba fica marcada no `sessionStorage`, como o cookie de sessão do painel real: recarregar a
 *   página não tira ninguém do painel no meio de uma apresentação; fechar a aba ou sair, sim.
 */
export const MOCK_SESSION_STORAGE_KEY = 'verax.mock.session';
export const MOCK_SESSION_LOGGED_IN = 'logged-in';

function roleFromStorage(): Role {
  const stored = typeof window === 'undefined' ? null : window.localStorage.getItem('verax.mock.role');
  return (ROLES as readonly string[]).includes(stored ?? '') ? (stored as Role) : 'admin_verax';
}

/**
 * Quem entra com o acesso de demonstração: o papel de `localStorage['verax.mock.role']` (padrão: admin_verax). O
 * admin_verax já entra com o primeiro cliente selecionado, para a Torre abrir com dados.
 */
export function demoSessionMe(): Me {
  const role = roleFromStorage();
  const first = DEMO_TENANTS[0]?.id ?? null;
  return role === 'admin_verax'
    ? demoMe(role, { activeTenantId: first, scopeTenantId: first })
    : demoMe(role);
}

/** Sessão completa (com MFA e sem senha temporária): a única que sobrevive a recarregar a página. */
const isComplete = (me: Me | null): boolean => me !== null && me.mfaEnabled && !me.mustChangePassword;

function startsLoggedIn(): boolean {
  return (
    window.localStorage.getItem(MOCK_SESSION_STORAGE_KEY) === MOCK_SESSION_LOGGED_IN ||
    window.sessionStorage.getItem(MOCK_SESSION_STORAGE_KEY) === MOCK_SESSION_LOGGED_IN
  );
}

function rememberInThisTab(me: Me | null): void {
  if (isComplete(me)) window.sessionStorage.setItem(MOCK_SESSION_STORAGE_KEY, MOCK_SESSION_LOGGED_IN);
  else window.sessionStorage.removeItem(MOCK_SESSION_STORAGE_KEY);
}

/**
 * Estado inicial do mock no navegador. Toda troca de `me` (entrar, sair, trocar de cliente) passa pelo acessor, que
 * marca ou desmarca a sessão da aba: nenhum handler precisa lembrar de fazer isso. Os testes unitários montam o próprio
 * estado e não tocam no `sessionStorage`.
 */
export function browserMockState(): MockState {
  let me: Me | null = startsLoggedIn() ? demoSessionMe() : null;
  return {
    get me() {
      return me;
    },
    set me(value) {
      me = value;
      rememberInThisTab(value);
    },
  };
}

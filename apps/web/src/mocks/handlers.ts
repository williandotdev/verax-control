import { type Me, type Role, ROLES } from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { createAuthHandlers } from './auth-handlers';
import { DEMO_TENANTS, demoMe } from './fixtures';

/** Estado em memória do modo mock: quem está logado e qual cliente está selecionado. */
export interface MockState {
  me: Me | null;
  /** Login com MFA: devolve só o desafio do código (padrão). */
  mfa?: boolean;
  pendingCode?: boolean;
}

const url = (path: string): string => `${API_URL}${path}`;

function roleFromStorage(): Role {
  const stored = typeof window === 'undefined' ? null : window.localStorage.getItem('verax.mock.role');
  return (ROLES as readonly string[]).includes(stored ?? '') ? (stored as Role) : 'admin_verax';
}

/**
 * Handlers do Mock Service Worker com o mesmo contrato da API. No modo `dev:mock`, o papel do usuário
 * fictício sai de `localStorage['verax.mock.role']` (padrão: admin_verax).
 */
export function createHandlers(state: MockState = { me: demoMe(roleFromStorage()) }) {
  return [
    ...createAuthHandlers(state),
    http.get(url('/v1/me'), () =>
      state.me
        ? HttpResponse.json(state.me)
        : HttpResponse.json({ statusCode: 401, message: 'Não autenticado' }, { status: 401 }),
    ),
    http.get(url('/v1/csrf-token'), () => HttpResponse.json({ token: 'token-csrf-ficticio' })),
    http.get(url('/v1/tenants'), () => {
      if (state.me?.role !== 'admin_verax')
        return HttpResponse.json({ statusCode: 403, message: 'Sem permissão' }, { status: 403 });
      return HttpResponse.json({ items: DEMO_TENANTS, page: 1, pageSize: 100, total: DEMO_TENANTS.length });
    }),
    http.post(url('/v1/session/tenant'), async ({ request }) => {
      if (!state.me || state.me.role !== 'admin_verax')
        return HttpResponse.json({ statusCode: 403, message: 'Sem permissão' }, { status: 403 });
      if (request.headers.get('X-CSRF-Token') === null) {
        return HttpResponse.json({ statusCode: 403, code: 'CSRF_INVALID', message: 'CSRF' }, { status: 403 });
      }
      const body = (await request.json()) as { tenantId?: string };
      const tenant = DEMO_TENANTS.find(
        (candidate) => candidate.id === body.tenantId && candidate.status === 'active',
      );
      if (!tenant)
        return HttpResponse.json(
          { statusCode: 404, message: 'Cliente não encontrado ou inativo' },
          { status: 404 },
        );
      state.me = { ...state.me, activeTenantId: tenant.id, scopeTenantId: tenant.id };
      return HttpResponse.json({ activeTenantId: tenant.id });
    }),
    http.delete(url('/v1/session/tenant'), () => {
      if (state.me) state.me = { ...state.me, activeTenantId: null, scopeTenantId: null };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(url('/v1/auth/sign-out'), () => {
      state.me = null;
      return HttpResponse.json({ success: true });
    }),
  ];
}

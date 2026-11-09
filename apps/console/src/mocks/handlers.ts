import { http, HttpResponse } from 'msw';
import { createFakeState, type FakeAdminState, handleAdminRequest } from './fake-admin-api';

/** As rotas do console no MSW, sobre o estado em memória da API simulada (`fake-admin-api.ts`). */
export function adminHandlers(state: FakeAdminState = createFakeState()) {
  return [
    http.all('*/v1/admin/*', async ({ request }) => {
      const url = new URL(request.url);
      const text = request.method === 'GET' ? '' : await request.text();
      const response = handleAdminRequest(
        state,
        request.method,
        url.pathname,
        text === '' ? undefined : JSON.parse(text),
      );
      if (response.status === 204) return new HttpResponse(null, { status: 204 });
      return HttpResponse.json(response.body as Record<string, unknown>, { status: response.status });
    }),
  ];
}

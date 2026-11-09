import type { Page } from '@playwright/test';
import { createFakeState, type FakeAdminState, handleAdminRequest } from '../src/mocks/fake-admin-api';

/**
 * Liga a API do console simulada na página: toda chamada a `/v1/admin/...` é atendida em memória, com a sessão do
 * responsável já aberta (`createFakeState`); `createFakeState({ loggedIn: false })` começa na tela de entrada.
 */
export async function mockAdminApi(
  page: Page,
  state: FakeAdminState = createFakeState(),
): Promise<FakeAdminState> {
  await page.route('**/v1/admin/**', async (route) => {
    const request = route.request();
    const body = request.postData();
    const response = handleAdminRequest(
      state,
      request.method(),
      new URL(request.url()).pathname,
      body === null || body === '' ? undefined : (JSON.parse(body) as unknown),
    );
    if (response.status === 204) {
      await route.fulfill({ status: 204 });
      return;
    }
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  return state;
}

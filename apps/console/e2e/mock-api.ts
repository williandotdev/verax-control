import type { Page } from '@playwright/test';
import { createFakeState, type FakeAdminState, handleAdminRequest } from '../src/mocks/fake-admin-api';

/** Liga a API do console simulada na página: toda chamada a `/v1/admin/...` é atendida em memória. */
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
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    });
  });
  return state;
}

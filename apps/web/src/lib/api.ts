import { ApiClient, type ApiClientHooks } from './api-client';

let hooks: ApiClientHooks = {};

/** Cliente HTTP único do painel. As ações de navegação são ligadas pelo `App` depois de criar o roteador. */
export const api = new ApiClient(undefined, {
  onUnauthorized: () => hooks.onUnauthorized?.(),
  onMfaRequired: () => hooks.onMfaRequired?.(),
});

export function bindApiNavigation(next: ApiClientHooks): void {
  hooks = next;
}

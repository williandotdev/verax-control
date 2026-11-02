/// <reference types="msw/vite/client" />

/**
 * Liga o Mock Service Worker no modo `dev:mock` (desenvolvimento do painel sem a API). Só é importado quando
 * `import.meta.env.MODE === 'mock'`; o build de produção não contém este módulo nem o worker.
 */
export async function enableMocks(): Promise<void> {
  const [{ network }, { createHandlers }] = await Promise.all([import('virtual:msw'), import('./handlers')]);
  network.configure({ handlers: createHandlers() });
  await network.enable();
}

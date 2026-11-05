/// <reference types="msw/vite/client" />

/**
 * Liga o Mock Service Worker no modo `dev:mock` (desenvolvimento do painel sem a API). Só é importado quando
 * `import.meta.env.MODE === 'mock'`; o build de produção não contém este módulo nem o worker. A sessão começa fechada
 * (veja `demo-session.ts`).
 */
export async function enableMocks(): Promise<void> {
  const [{ network }, { createHandlers }, { browserMockState }] = await Promise.all([
    import('virtual:msw'),
    import('./handlers'),
    import('./demo-session'),
  ]);
  network.configure({ handlers: createHandlers(browserMockState()) });
  await network.enable();
}

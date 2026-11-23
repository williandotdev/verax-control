import { vi } from 'vitest';

/**
 * O jsdom não tem `URL.createObjectURL` nem `URL.revokeObjectURL`: os testes do arquivo baixado pelo painel põem os
 * dois no lugar e conferem o `Blob` criado e o endereço solto. `restore` tira os dois de novo.
 */
export function stubObjectUrls(url = 'blob:verax-teste') {
  const create = vi.fn<(blob: Blob) => string>(() => url);
  const revoke = vi.fn<(value: string) => void>();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revoke });
  return {
    create,
    revoke,
    restore: () => {
      Reflect.deleteProperty(URL, 'createObjectURL');
      Reflect.deleteProperty(URL, 'revokeObjectURL');
    },
  };
}

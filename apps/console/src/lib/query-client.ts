import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/** Erros 4xx não melhoram tentando de novo; só falhas de rede e 5xx têm uma segunda tentativa. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 1;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: shouldRetry, staleTime: 30_000, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

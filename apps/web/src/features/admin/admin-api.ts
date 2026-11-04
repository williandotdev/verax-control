import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AlertExceptionCreate,
  alertExceptionSchema,
  type AlertExceptionUpdate,
  type CloudAccount,
  type CloudAccountCreate,
  cloudAccountSchema,
  type CloudAccountUpdate,
  type CloudCredentialInput,
  paginatedSchema,
  type ProtectedResourceCreate,
  protectedResourceSchema,
  type ProtectedResourceUpdate,
  type TenantCreate,
  tenantCreatedSchema,
  tenantSchema,
  tenantSummarySchema,
  type TenantUpdate,
  temporaryPasswordSchema,
  type UserCreate,
  userCreatedSchema,
  userSchema,
  type UserUpdate,
} from '@verax/shared';
import { useCallback, useState } from 'react';
import type { z } from 'zod';
import { api } from '@/lib/api';

/**
 * Cadastros (E3) para as telas da T7.1 à T7.5. Cada lista tem a sua chave de cache; as escritas a invalidam, e a
 * troca de cliente da sessão já descarta o cache inteiro.
 */

const PAGE_SIZE = 20;

function useList<T>(key: string, path: string, schema: z.ZodType<T>, page: number, enabled: boolean) {
  const list = paginatedSchema(schema);
  return useQuery({
    queryKey: [key, page],
    queryFn: () => api.get(`${path}?page=${page}&pageSize=${PAGE_SIZE}`, list),
    enabled,
    placeholderData: keepPreviousData,
  });
}

function useWrite<TInput, TOutput>(
  keys: string[],
  write: (input: TInput) => Promise<TOutput>,
  options: { gcTime?: number } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    ...options,
    onSuccess: () => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const ADMIN_PAGE_SIZE = PAGE_SIZE;

/**
 * A senha temporária só vem na resposta que a gera (criar a conta, criar o cliente com o primeiro administrador ou
 * gerar outra). Ela fica no estado da mutação, que é esquecido assim que a tela que a mostra sai (`gcTime: 0`): nada
 * a guarda depois.
 */
const FORGET = { gcTime: 0 };

// --- Clientes (T3.1, só admin_verax) ---
export const useTenantList = (page: number, enabled: boolean) =>
  useList('admin-tenants', '/v1/tenants', tenantSummarySchema, page, enabled);
export const useTenant = (id: string | null) =>
  useQuery({
    queryKey: ['admin-tenant', id],
    queryFn: () => api.get(`/v1/tenants/${encodeURIComponent(id ?? '')}`, tenantSchema),
    enabled: id !== null,
  });
/** O cliente nasce com o primeiro administrador; a senha temporária dele vem só nesta resposta. */
export const useCreateTenant = () =>
  useWrite(
    ['admin-tenants', 'tenants'],
    (input: TenantCreate) => api.post('/v1/tenants', input, tenantCreatedSchema),
    FORGET,
  );
export const useUpdateTenant = (id: string) =>
  useWrite(['admin-tenants', 'admin-tenant', 'tenants'], (input: TenantUpdate) =>
    api.patch(`/v1/tenants/${encodeURIComponent(id)}`, input, tenantSchema),
  );

// --- Usuários do cliente (T3.2) ---
export const useUserList = (page: number, enabled: boolean) =>
  useList('admin-users', '/v1/users', userSchema, page, enabled);
export const useCreateUser = () =>
  useWrite(['admin-users'], (input: UserCreate) => api.post('/v1/users', input, userCreatedSchema), FORGET);
export const useUpdateUser = (id: string) =>
  useWrite(['admin-users'], (input: UserUpdate) =>
    api.patch(`/v1/users/${encodeURIComponent(id)}`, input, userSchema),
  );
/** Senha temporária nova: a anterior deixa de valer e as sessões abertas da pessoa caem. */
export const useGenerateTemporaryPassword = (id: string) =>
  useWrite(
    ['admin-users'],
    () =>
      api.post(`/v1/users/${encodeURIComponent(id)}/temporary-password`, undefined, temporaryPasswordSchema),
    FORGET,
  );

// --- Contas cloud (T3.3) ---
export const useCloudAccountList = (page: number, enabled: boolean) =>
  useList('admin-cloud-accounts', '/v1/cloud-accounts', cloudAccountSchema, page, enabled);
export const useCreateCloudAccount = () =>
  useWrite(['admin-cloud-accounts', 'cloud-accounts'], (input: CloudAccountCreate) =>
    api.post('/v1/cloud-accounts', input, cloudAccountSchema),
  );
export const useUpdateCloudAccount = (id: string) =>
  useWrite(['admin-cloud-accounts', 'cloud-accounts'], (input: CloudAccountUpdate) =>
    api.patch(`/v1/cloud-accounts/${encodeURIComponent(id)}`, input, cloudAccountSchema),
  );

/** Estado da última escrita da credencial: só o resultado (a conta, sem segredo) ou o erro, nunca o que foi colado. */
interface CredentialWriteState {
  pending: boolean;
  error: unknown;
  /** A conta depois do `PUT` (com `keyStatus`), para o aviso de sucesso. */
  saved: CloudAccount | null;
  removed: boolean;
}

const IDLE: CredentialWriteState = { pending: false, error: null, saved: null, removed: false };

/**
 * Credencial de leitura da conta (fase 2: o token do Cloudflare). Sem `useMutation` de propósito: o cache de mutações
 * guarda as `variables` (o token colado) enquanto a tela está aberta, e as ferramentas de desenvolvimento as mostram.
 * A chamada vai direto pelo cliente HTTP, e o estado guarda só a resposta e o erro. Depois de gravar ou remover, as
 * listas de contas são relidas (a resposta traz só os metadados, `keyStatus`).
 */
export function useCloudCredential(id: string) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<CredentialWriteState>(IDLE);
  const path = `/v1/cloud-accounts/${encodeURIComponent(id)}/credential`;

  const refresh = useCallback(() => {
    for (const key of ['admin-cloud-accounts', 'cloud-accounts']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  }, [queryClient]);

  const save = useCallback(
    async (input: CloudCredentialInput): Promise<CloudAccount | null> => {
      setState({ ...IDLE, pending: true });
      try {
        const saved = await api.put(path, input, cloudAccountSchema);
        setState({ ...IDLE, saved });
        refresh();
        return saved;
      } catch (error) {
        setState({ ...IDLE, error });
        return null;
      }
    },
    [path, refresh],
  );

  const remove = useCallback(async (): Promise<boolean> => {
    setState({ ...IDLE, pending: true });
    try {
      await api.delete(path);
      setState({ ...IDLE, removed: true });
      refresh();
      return true;
    } catch (error) {
      setState({ ...IDLE, error });
      return false;
    }
  }, [path, refresh]);

  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, save, remove, reset };
}

// --- Lista de proteção (T3.4) ---
export const useProtectedList = (page: number, enabled: boolean) =>
  useList('admin-protected', '/v1/protected-resources', protectedResourceSchema, page, enabled);
export const useCreateProtected = () =>
  useWrite(['admin-protected'], (input: ProtectedResourceCreate) =>
    api.post('/v1/protected-resources', input, protectedResourceSchema),
  );
export const useUpdateProtected = (id: string) =>
  useWrite(['admin-protected'], (input: ProtectedResourceUpdate) =>
    api.patch(`/v1/protected-resources/${encodeURIComponent(id)}`, input, protectedResourceSchema),
  );
export const useDeleteProtected = (id: string) =>
  useWrite(['admin-protected'], () => api.delete(`/v1/protected-resources/${encodeURIComponent(id)}`));

// --- Exceções (T3.5) ---
export const useExceptionList = (page: number, enabled: boolean) =>
  useList('admin-exceptions', '/v1/alert-exceptions', alertExceptionSchema, page, enabled);
export const useCreateException = () =>
  useWrite(['admin-exceptions'], (input: AlertExceptionCreate) =>
    api.post('/v1/alert-exceptions', input, alertExceptionSchema),
  );
export const useUpdateException = (id: string) =>
  useWrite(['admin-exceptions'], (input: AlertExceptionUpdate) =>
    api.patch(`/v1/alert-exceptions/${encodeURIComponent(id)}`, input, alertExceptionSchema),
  );
export const useDeleteException = (id: string) =>
  useWrite(['admin-exceptions'], () => api.delete(`/v1/alert-exceptions/${encodeURIComponent(id)}`));

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AlertExceptionCreate,
  alertExceptionRuleTitlesSchema,
  alertExceptionSchema,
  type AlertExceptionUpdate,
  type CloudAccount,
  type CloudAccountCreate,
  type CloudAccountDelete,
  cloudAccountSchema,
  cloudAccountSourceAttentionSchema,
  type CloudAccountUpdate,
  type CloudCredentialInput,
  type Paginated,
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

function useList<T>(
  key: string,
  path: string,
  schema: z.ZodType<T>,
  page: number,
  enabled: boolean,
  /** Relê a página nesse intervalo enquanto algum item pedir (ms); sem informar, só quando a tela pede. */
  pollWhile?: { intervalMs: number; item: (item: T) => boolean },
) {
  const list = paginatedSchema(schema);
  return useQuery({
    queryKey: [key, page],
    queryFn: () => api.get(`${path}?page=${page}&pageSize=${PAGE_SIZE}`, list),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      pollWhile && query.state.data?.items.some(pollWhile.item) === true ? pollWhile.intervalMs : false,
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
/**
 * Enquanto uma conta AWS tem o "Verificar" ou o "Conectar" pendente, a lista é relida a cada 5 s, até o worker gravar o
 * resultado (ele responde em até 30 s; em até 10 min se o papel ainda não valer no IAM; em até 60 min no "Conectar",
 * enquanto a pilha é criada). O "Verificar" e o resto do onboarding da AWS ficam em `aws-onboarding-api.ts`.
 */
export const AWS_CHECK_POLL_MS = 5_000;
export const useCloudAccountList = (page: number, enabled: boolean) =>
  useList('admin-cloud-accounts', '/v1/cloud-accounts', cloudAccountSchema, page, enabled, {
    intervalMs: AWS_CHECK_POLL_MS,
    item: (account) => account.checkRequestedAt !== null,
  });
/** A chave da contagem de fontes que pedem atenção: à parte da lista, que tem outro formato no cache. */
export const SOURCE_ATTENTION_KEY = 'admin-cloud-accounts-attention';

/**
 * Quantas fontes autorizadas de cada conta AWS pedem atenção (E-08), por conta. Null enquanto não chega, num nó de antes
 * (404) ou com erro: a lista mostra então só o selo da conexão, como antes.
 */
export function useCloudAccountSourceAttention(enabled: boolean): ReadonlyMap<string, number> | null {
  const query = useQuery({
    queryKey: [SOURCE_ATTENTION_KEY],
    queryFn: () => api.get('/v1/cloud-accounts/source-attention', cloudAccountSourceAttentionSchema),
    enabled,
    retry: false,
  });
  if (!query.data) return null;
  return new Map(query.data.items.map((item) => [item.cloudAccountId, item.sourcesNeedingAttention]));
}

export const useCreateCloudAccount = () =>
  useWrite(['admin-cloud-accounts', 'cloud-accounts'], (input: CloudAccountCreate) =>
    api.post('/v1/cloud-accounts', input, cloudAccountSchema),
  );
export const useUpdateCloudAccount = (id: string) =>
  useWrite(['admin-cloud-accounts', 'cloud-accounts'], (input: CloudAccountUpdate) =>
    api.patch(`/v1/cloud-accounts/${encodeURIComponent(id)}`, input, cloudAccountSchema),
  );

/**
 * Excluir o cadastro da conta (`POST /v1/cloud-accounts/:id/delete`, com o ID digitado). Confirmada a exclusão, a conta
 * sai das listas já guardadas na hora, antes de `onDeleted` fechar o painel: o painel não devolve o foco a uma linha que
 * vai sumir. Depois, as listas e o plano (a vaga liberada) são relidos.
 */
export function useDeleteCloudAccount(id: string, onDeleted: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CloudAccountDelete) =>
      api.post(`/v1/cloud-accounts/${encodeURIComponent(id)}/delete`, input),
    onSuccess: () => {
      queryClient.setQueriesData<Paginated<CloudAccount>>({ queryKey: ['admin-cloud-accounts'] }, (data) =>
        data === undefined
          ? data
          : {
              ...data,
              items: data.items.filter((account) => account.id !== id),
              total: Math.max(0, data.total - 1),
            },
      );
      onDeleted();
      for (const key of ['admin-cloud-accounts', SOURCE_ATTENTION_KEY, 'cloud-accounts', 'plan']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

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
/**
 * O título das regras de uma página de exceções (E-09), pelo número. Null enquanto não chega, num nó de antes (404) ou
 * com erro: a lista mostra então só o número, como antes.
 */
export function useExceptionRuleTitles(ruleIds: readonly string[]): ReadonlyMap<string, string> | null {
  const unique = [...new Set(ruleIds)].sort();
  const query = useQuery({
    queryKey: ['admin-exception-rule-titles', unique.join(',')],
    queryFn: () =>
      api.get(
        `/v1/alert-exceptions/rule-titles?ruleIds=${encodeURIComponent(unique.join(','))}`,
        alertExceptionRuleTitlesSchema,
      ),
    enabled: unique.length > 0,
    retry: false,
    staleTime: 5 * 60_000,
  });
  if (!query.data) return null;
  return new Map(query.data.items.map((item) => [item.ruleId, item.title]));
}

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

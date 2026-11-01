import { ApiRequestError, UnexpectedResponseError } from './api-client';

/** Mensagem para a tela. Nada de detalhe técnico; o `requestId` permite ao suporte achar o log. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 401) return 'Sua sessão terminou. Entre de novo.';
    if (error.status === 403) return 'Sem permissão para acessar isto.';
    if (error.status === 404) return 'Não encontrado.';
    if (error.code === 'TENANT_REQUIRED') return 'Selecione um cliente para continuar.';
    if (error.status === 429) return 'Muitas tentativas. Aguarde alguns minutos.';
    if (error.status >= 500) return 'O servidor não conseguiu concluir a operação. Tente de novo.';
    return error.message;
  }
  if (error instanceof UnexpectedResponseError) return 'O servidor respondeu algo inesperado. Tente de novo.';
  return 'Não foi possível falar com o servidor. Verifique a conexão.';
}

export function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiRequestError ? error.requestId : undefined;
}

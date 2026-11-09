import { ApiError, SessionExpiredError } from './api';

/** Mensagem para a tela: a da API (já pensada para o responsável) ou uma genérica, nunca detalhe técnico. */
export function errorMessage(error: unknown): string {
  if (error instanceof SessionExpiredError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 403 && error.code === 'forbidden')
      return 'Esta conta não é de um responsável pelo console.';
    if (error.status === 429) return 'Muitas tentativas. Aguarde alguns minutos e tente de novo.';
    if (error.status >= 500) return 'O console não conseguiu concluir a operação. Tente de novo.';
    return error.message;
  }
  return 'Não foi possível falar com o console. Verifique a conexão.';
}

export function requestIdOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.requestId : undefined;
}

import { describe, expect, it } from 'vitest';
import { ApiRequestError, UnexpectedResponseError } from './api-client';
import { errorMessage } from './errors';

describe('errorMessage', () => {
  it.each([
    [new ApiRequestError(401, 'x'), 'Sua sessão terminou. Entre de novo.'],
    [new ApiRequestError(403, 'detalhe'), 'Sem permissão para acessar isto.'],
    [new ApiRequestError(409, 'x', 'TENANT_REQUIRED'), 'Selecione um cliente para continuar.'],
    [new ApiRequestError(500, 'stack trace'), 'O servidor não conseguiu concluir a operação. Tente de novo.'],
    [
      new ApiRequestError(409, 'Este ID de conta já pertence a outro cliente'),
      'Este ID de conta já pertence a outro cliente',
    ],
    [new UnexpectedResponseError(), 'O servidor respondeu algo inesperado. Tente de novo.'],
    [new TypeError('Failed to fetch'), 'Não foi possível falar com o servidor. Verifique a conexão.'],
  ])('%s', (error, message) => {
    expect(errorMessage(error)).toBe(message);
  });
});

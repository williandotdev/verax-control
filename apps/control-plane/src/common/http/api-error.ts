import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Erro cuja mensagem pode ser mostrada ao cliente. Qualquer outro erro 4xx sai com uma mensagem
 * genérica do status, e qualquer 5xx sai como "Erro interno": a mensagem precisa ser opt-in (regra 9).
 */
export class ApiError extends HttpException {
  /**
   * Detalhe estruturado que a resposta mostra (só em 4xx), como o relatório da checagem de publicação no console do
   * responsável. Opt-in como a mensagem: nunca o erro original, nunca dado de terceiro. Não enumerável: o serializador
   * de erro do log copia as propriedades enumeráveis, e o detalhe é só para quem pediu.
   */
  declare readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    status: HttpStatus,
    publicMessage: string,
    /** Código estável para o site decidir o que fazer (ex.: `terms_outdated`). */
    readonly code?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(publicMessage, status);
    Object.defineProperty(this, 'details', { value: details, enumerable: false });
  }
}

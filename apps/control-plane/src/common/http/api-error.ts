import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Erro cuja mensagem pode ser mostrada ao cliente. Qualquer outro erro 4xx sai com uma mensagem
 * genérica do status, e qualquer 5xx sai como "Erro interno": a mensagem precisa ser opt-in (regra 9).
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    publicMessage: string,
    /** Código estável para o site decidir o que fazer (ex.: `terms_outdated`). */
    readonly code?: string,
  ) {
    super(publicMessage, status);
  }
}

import { HttpException, HttpStatus } from '@nestjs/common';

export interface ValidationIssue {
  /** Caminho do campo, separado por ponto (ex.: `contato.email`). Vazio quando o problema é no objeto. */
  path: string;
  code: string;
  message: string;
}

/**
 * Erro cuja mensagem pode ser mostrada ao cliente. Qualquer outro erro 4xx sai com uma mensagem
 * genérica do status, e qualquer 5xx sai como "Erro interno": a mensagem precisa ser opt-in.
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    publicMessage: string,
    /** Código estável para o painel decidir o que fazer (ex.: `MFA_REQUIRED`). */
    readonly code?: string,
  ) {
    super(publicMessage, status);
  }
}

/**
 * Recusa que fica gravada: o `AuditInterceptor` não desfaz a transação da requisição. Ele grava o registro da falha (com
 * a ação e os estados que o service descreveu) no mesmo commit e só depois responde o erro. Serve para a recusa que
 * outra requisição precisa enxergar assim que os locks desta forem soltos (o limite de tentativas da credencial colada
 * conta com ela). Lance só antes de qualquer escrita do handler, ou quando o que ele já escreveu deve ficar.
 */
export class CommittedApiError extends ApiError {}

/** Entrada que não passou na validação. Os problemas listados nunca repetem o valor recebido. */
export class ValidationException extends HttpException {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super('Dados inválidos', HttpStatus.BAD_REQUEST);
  }
}

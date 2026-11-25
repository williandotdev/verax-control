import { discoveryErrorCode } from '../../aws/discovery/discovery.js';
import { ReadOnlyViolation } from '../../aws/discovery/read-only.js';
import { isThrottling } from '../../aws/findings/throttle.js';
import { AwsConnectionError, awsErrorName } from '../../aws/web-identity.js';
import { REFUSED_CODES } from '../../inventory/collectors.js';

/** O que falhou no S3: a listagem ou a leitura de um objeto. */
export type AlbAction = 's3:ListBucket' | 's3:GetObject';

/** Uma chamada ao S3 que falhou. A mensagem é só a ação: a da AWS não vai para lugar nenhum. */
export class AlbCallError extends Error {
  constructor(
    readonly action: AlbAction,
    override readonly cause: unknown,
  ) {
    super(`leitura dos logs do ALB: ${action}`);
    this.name = 'AlbCallError';
  }
}

export type AlbFailure = { type: 'permission'; detail: string } | { type: 'failed'; code: string };

/** O que nunca vira o resultado de uma fonte: o cancelamento, a trava de só leitura e a sessão que caiu. */
export function isFatal(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof ReadOnlyViolation || error instanceof AwsConnectionError;
}

/** O objeto foi apagado entre a listagem e a leitura. */
export function isGone(error: unknown): boolean {
  return error instanceof AlbCallError && awsErrorName(error.cause) === 'NoSuchKey';
}

/** O objeto está arquivado (Glacier): só o cliente o traz de volta. */
export function isArchived(error: unknown): boolean {
  return error instanceof AlbCallError && awsErrorName(error.cause) === 'InvalidObjectState';
}

/** O que a falha diz da fonte: a permissão que falta, com o motivo, ou um erro que pode passar, com o código. */
export function albFailureOf(error: unknown): AlbFailure {
  const cause = error instanceof AlbCallError ? error.cause : error;
  const name = awsErrorName(cause);
  if (isThrottling(cause)) return { type: 'failed', code: 'throttled' };
  if (error instanceof AlbCallError) {
    if (name === 'NoSuchBucket') return { type: 'permission', detail: 'bucket_missing' };
    if (name.startsWith('KMS.')) return { type: 'permission', detail: 'kms_denied' };
    if (REFUSED_CODES.has(name)) {
      return {
        type: 'permission',
        detail: error.action === 's3:ListBucket' ? 'bucket_denied' : 's3:GetObject',
      };
    }
  }
  const code = discoveryErrorCode(cause);
  // O corpo cortado no meio chega como um erro de rede do Node, sem nome próprio.
  const network = code === 'Error' && typeof (cause as { code?: unknown }).code === 'string';
  return { type: 'failed', code: network ? 'NetworkError' : code };
}

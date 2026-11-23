import {
  AWS_BUCKET_ERROR_CODES,
  type AwsConnectionErrorCode,
  type CloudAccountConnection,
  parseAwsConnectionError,
} from '@verax/shared';

/**
 * Os erros de conexão que não impedem a entrada no papel: um bucket de log com problema (a mesma regra do inventário,
 * `inventory/inventory-job.ts`). Com qualquer outro (a confiança recusada, o token do nó, a AWS fora), a conta espera a
 * conferência da conexão voltar a "conectada".
 */
const ENTERABLE_ERRORS: ReadonlySet<AwsConnectionErrorCode> = new Set<AwsConnectionErrorCode>([
  ...AWS_BUCKET_ERROR_CODES,
]);

/**
 * O nó entra no papel de leitura desta conta agora? Só a conta já verificada ao menos uma vez (`ingestFrom`), conectada
 * ou com erro só num bucket. É o que a descoberta e a sondagem de uma fonte exigem antes de chamar a AWS, e o que a
 * API confere antes de aceitar o pedido de uma ou de outra.
 */
export function entersRole(account: {
  connection: CloudAccountConnection;
  connectionError: string | null;
  ingestFrom: Date | null;
}): boolean {
  if (account.ingestFrom === null) return false;
  if (account.connection === 'connected') return true;
  if (account.connection !== 'error' || account.connectionError === null) return false;
  const parsed = parseAwsConnectionError(account.connectionError);
  return parsed !== null && ENTERABLE_ERRORS.has(parsed.code);
}

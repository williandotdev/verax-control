import {
  AWS_READER_AUTHORIZATIONS,
  type AwsReaderAuthorization,
  sortAwsChosenCapabilities,
} from '@verax/shared';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * A escolha do cliente no painel (onboarding self-service da AWS): as autorizações que ele marcou para o arquivo da
 * pilha, como ficam em `CloudAccount.awsChosenCapabilities`. Um texto só, com as autorizações separadas por espaço e na
 * ordem do catálogo (o mesmo formato da tag `verax-control:capabilities` do papel, sem a descoberta, que vale sempre):
 * vazio é "só a descoberta", e null é "nenhuma escolha gravada". O CHECK da coluna repete o formato.
 *
 * É só o que o cliente escolheu, para a tela devolver as mesmas caixas marcadas e avisar quando o papel na AWS ficou
 * diferente: nada aqui dá ou tira permissão. O que o papel pode ler vem das tags dele (`awsCapabilities`).
 */

const SEPARATOR = ' ';

/**
 * Trava a linha da conta até o fim da transação da requisição. O "Conectar" e o "Verificar" a tomam antes de ler o
 * pedido pendente e a escolha gravada e de decidir o que gravar: dois pedidos da mesma conta rodam um depois do outro,
 * cada um lê o que o anterior gravou, e vale o último a ser gravado. Sem ela, um pedido decidia por uma leitura de
 * antes de o outro gravar: com o cliente desligando e ligando de volta uma autorização em seguida, o segundo pedido lia
 * a escolha original, não gravava nada, e ficava gravada a do primeiro.
 *
 * `FOR NO KEY UPDATE` é a mesma trava do `UPDATE` da linha: segura só quem grava a conta, e não quem grava as fontes
 * e as execuções da descoberta dela. É a linha, e não o lock das fontes (`lockAwsOnboarding`), de propósito: a tarefa
 * `aws-check` grava a linha da conta e só depois toma aquele lock para pedir a descoberta; um pedido que o tomasse
 * antes de gravar a linha travaria com ela, cada um esperando o outro. Recebe o cliente do banco sem escopo (o da
 * transação da requisição), porque o escopo não aceita SQL; a conta já foi lida pelo escopo do cliente da sessão.
 */
export async function lockAwsAccountRow(
  tx: Prisma.TransactionClient,
  account: { id: string; tenantId: string },
): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "CloudAccount" WHERE "id" = ${account.id}::uuid AND "tenantId" = ${account.tenantId}::uuid FOR NO KEY UPDATE`;
}

/** A escolha como a coluna a guarda. */
export function serializeChosenCapabilities(chosen: readonly AwsReaderAuthorization[]): string {
  return sortAwsChosenCapabilities(chosen).join(SEPARATOR);
}

/** A escolha gravada; null sem escolha. Um nome fora do catálogo fica de fora, em vez de quebrar a resposta. */
export function parseChosenCapabilities(stored: string | null): AwsReaderAuthorization[] | null {
  if (stored === null) return null;
  const names = stored.split(SEPARATOR);
  return AWS_READER_AUTHORIZATIONS.filter((authorization) => names.includes(authorization));
}

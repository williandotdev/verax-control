import {
  AWS_READER_AUTHORIZATIONS,
  type AwsReaderAuthorization,
  sortAwsChosenCapabilities,
} from '@verax/shared';

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

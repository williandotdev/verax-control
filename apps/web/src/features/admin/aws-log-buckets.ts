import { LOG_SOURCES, type LogBuckets, type LogSource, normalizeBucketName } from '@verax/shared';

/**
 * Buckets de log da conta AWS no painel (o campo do cadastro e da alteração): uma linha por bucket, com a fonte e o
 * nome. O schema compartilhado aceita no máximo um bucket por fonte (CloudTrail, GuardDuty e WAF), então a lista tem
 * até três linhas e cada fonte aparece numa só. Os nomes vão para o `LogBucketArns` da pilha do papel de leitura.
 */

/** Como cada fonte aparece na lista. */
export const LOG_SOURCE_LABELS: Readonly<Record<LogSource, string>> = {
  cloudtrail: 'CloudTrail',
  guardduty: 'GuardDuty',
  waf: 'WAF',
};

export const EMPTY_BUCKET_MESSAGE = 'Informe o nome do bucket, ou remova esta linha.';
export const REPEATED_SOURCE_MESSAGE = 'Esta fonte já tem um bucket na lista.';

/** Uma linha da lista: a chave só identifica a linha na tela (foco e erro), não vai para a API. */
export interface BucketRow {
  key: number;
  source: LogSource;
  name: string;
}

let lastKey = 0;

/** Uma linha nova, com uma chave que nenhuma outra linha da tela tem. */
export function newBucketRow(source: LogSource, name = ''): BucketRow {
  lastKey += 1;
  return { key: lastKey, source, name };
}

/** As linhas dos buckets já gravados, na ordem das fontes. */
export function bucketRowsOf(buckets: LogBuckets): BucketRow[] {
  return LOG_SOURCES.flatMap((source) => {
    const name = buckets[source];
    return name === null ? [] : [newBucketRow(source, name)];
  });
}

/** As fontes que ainda não têm linha, na ordem das fontes: a primeira é a da próxima linha. */
export function freeSources(rows: readonly BucketRow[]): LogSource[] {
  const used = new Set(rows.map((row) => row.source));
  return LOG_SOURCES.filter((source) => !used.has(source));
}

/**
 * O corpo dos buckets: as três fontes, com `null` nas que não estão na lista (a API tira o bucket delas). O nome passa
 * por `normalizeBucketName` (o ARN ou o `s3://` colados viram o nome).
 */
export function bucketsFromRows(rows: readonly BucketRow[]): Record<LogSource, string | null> {
  const buckets: Record<LogSource, string | null> = { cloudtrail: null, guardduty: null, waf: null };
  for (const row of rows) buckets[row.source] = normalizeBucketName(row.name);
  return buckets;
}

/**
 * O erro de cada linha, pela chave: a linha sem nome, a fonte repetida (o seletor já não deixa) e o que o schema
 * recusou no caminho `buckets.<fonte>` (as mensagens já vêm em português, de `bucketNameProblem`).
 */
export function bucketRowErrors(
  rows: readonly BucketRow[],
  schemaErrors: Readonly<Record<string, string>>,
): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<LogSource>();
  for (const row of rows) {
    const problem = schemaErrors[`buckets.${row.source}`];
    if (normalizeBucketName(row.name) === '') errors[row.key] = EMPTY_BUCKET_MESSAGE;
    else if (seen.has(row.source)) errors[row.key] = REPEATED_SOURCE_MESSAGE;
    else if (problem !== undefined) errors[row.key] = problem;
    seen.add(row.source);
  }
  return errors;
}

/** Os erros do schema que não são de um bucket (os do resto do formulário). */
export function withoutBucketErrors(errors: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([field]) => !field.startsWith('buckets')));
}

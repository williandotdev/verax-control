import { cloudAccountUpdateSchema } from '@verax/shared';
import { describe, expect, it } from 'vitest';
import {
  bucketRowErrors,
  bucketRowsOf,
  bucketsFromRows,
  EMPTY_BUCKET_MESSAGE,
  freeSources,
  newBucketRow,
  REPEATED_SOURCE_MESSAGE,
  withoutBucketErrors,
} from './aws-log-buckets';
import { fieldErrors } from './forms';

/** Os erros do schema da alteração, como o formulário confere antes de enviar. */
function schemaErrorsOf(rows: Parameters<typeof bucketsFromRows>[0]) {
  const parsed = cloudAccountUpdateSchema.safeParse({ buckets: bucketsFromRows(rows) });
  return parsed.success ? {} : fieldErrors(parsed.error);
}

describe('lista de buckets de log (painel)', () => {
  it('as linhas saem dos buckets gravados, na ordem das fontes, com chaves diferentes', () => {
    const rows = bucketRowsOf({
      cloudtrail: 'exemplo-cloudtrail-logs',
      guardduty: null,
      waf: 'aws-waf-logs-x',
    });
    expect(rows.map(({ source, name }) => [source, name])).toEqual([
      ['cloudtrail', 'exemplo-cloudtrail-logs'],
      ['waf', 'aws-waf-logs-x'],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(freeSources(rows)).toEqual(['guardduty']);
    expect(bucketRowsOf({ cloudtrail: null, guardduty: null, waf: null })).toEqual([]);
  });

  it('o corpo leva as três fontes (null nas que saíram) e o nome do ARN ou do s3:// colado', () => {
    expect(
      bucketsFromRows([
        newBucketRow('guardduty', ' arn:aws:s3:::exemplo-guardduty-findings '),
        newBucketRow('waf', 's3://aws-waf-logs-exemplo/'),
      ]),
    ).toEqual({ cloudtrail: null, guardduty: 'exemplo-guardduty-findings', waf: 'aws-waf-logs-exemplo' });
    expect(bucketsFromRows([])).toEqual({ cloudtrail: null, guardduty: null, waf: null });
  });

  it('cada erro fica na linha dele: o nome vazio, a fonte repetida e o que o schema recusou', () => {
    const empty = newBucketRow('cloudtrail', '   ');
    const waf = newBucketRow('waf', 'logs-do-waf');
    const guardduty = newBucketRow('guardduty', 'Exemplo_Maiusculo');
    const rows = [empty, waf, guardduty];
    expect(bucketRowErrors(rows, schemaErrorsOf(rows))).toEqual({
      [empty.key]: EMPTY_BUCKET_MESSAGE,
      [waf.key]:
        'O bucket do WAF começa com aws-waf-logs-: a AWS só grava o log do WAF num bucket com esse começo.',
      [guardduty.key]: 'Use só letras minúsculas, números, ponto (.) e hífen (-) no nome do bucket.',
    });
    const first = newBucketRow('cloudtrail', 'exemplo-a');
    const repeated = newBucketRow('cloudtrail', 'exemplo-b');
    expect(bucketRowErrors([first, repeated], {})).toEqual({ [repeated.key]: REPEATED_SOURCE_MESSAGE });
    expect(bucketRowErrors([newBucketRow('cloudtrail', 'exemplo-cloudtrail-logs')], {})).toEqual({});
  });

  it('os erros do resto do formulário ficam sem os dos buckets', () => {
    expect(
      withoutBucketErrors({ accountId: 'ID inválido', 'buckets.waf': 'x', buckets: 'y', regions: 'z' }),
    ).toEqual({ accountId: 'ID inválido', regions: 'z' });
  });
});

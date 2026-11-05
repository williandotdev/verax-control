import { describe, expect, it } from 'vitest';
import { awsLogBucketArns, awsReaderDeployCommand, AWS_READER_AUDIENCE } from './aws-reader.js';
import {
  bucketNameProblem,
  cloudAccountCreateSchema,
  cloudAccountUpdateSchema,
  type LogBuckets,
  logBucketNames,
  mergeLogBuckets,
  normalizeBucketName,
  sameLogBucketNames,
  WAF_LOG_BUCKET_PREFIX,
} from './cloud-accounts.js';

/** Buckets fictícios, como os do README do template. */
const TRAIL = 'exemplo-cloudtrail-logs';
const GUARDDUTY = 'exemplo-guardduty-findings';
const WAF = 'aws-waf-logs-exemplo-loja';

const awsCreate = (buckets: unknown) =>
  cloudAccountCreateSchema.safeParse({
    provider: 'aws',
    accountId: '111122223333',
    regions: ['sa-east-1'],
    buckets,
  });

/** A mensagem de cada problema, por caminho, como o painel mostra ao lado do campo. */
function issuesOf(result: ReturnType<typeof awsCreate>): Record<string, string> {
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path.join('.'), issue.message]));
}

describe('buckets de log da conta AWS: nome do bucket (regras do S3)', () => {
  it.each([
    'abc',
    TRAIL,
    'logs.exemplo.com.br',
    'trilha-111122223333',
    'a'.repeat(63),
    '1-bucket-com-numero-no-inicio',
    'conta-111122223333-us-east-1-an',
  ])('aceita %s', (name) => {
    expect(bucketNameProblem(name)).toBeNull();
  });

  it.each([
    ['curto demais', 'ab', 'O nome do bucket tem de 3 a 63 caracteres.'],
    ['longo demais', 'a'.repeat(64), 'O nome do bucket tem de 3 a 63 caracteres.'],
    ['vazio', '', 'O nome do bucket tem de 3 a 63 caracteres.'],
    [
      'maiúscula',
      'Trilha-Logs',
      'Use só letras minúsculas, números, ponto (.) e hífen (-) no nome do bucket.',
    ],
    [
      'sublinhado',
      'trilha_logs',
      'Use só letras minúsculas, números, ponto (.) e hífen (-) no nome do bucket.',
    ],
    ['espaço', 'trilha logs', 'Use só letras minúsculas, números, ponto (.) e hífen (-) no nome do bucket.'],
    [
      'barra (um caminho)',
      'trilha/AWSLogs',
      'Use só letras minúsculas, números, ponto (.) e hífen (-) no nome do bucket.',
    ],
    ['acento', 'trilha-ação', 'Use só letras minúsculas, números, ponto (.) e hífen (-) no nome do bucket.'],
    ['hífen no começo', '-trilha', 'O nome do bucket começa e termina com letra minúscula ou número.'],
    ['ponto no fim', 'trilha.', 'O nome do bucket começa e termina com letra minúscula ou número.'],
    ['dois pontos seguidos', 'trilha..logs', 'O nome do bucket não pode ter dois pontos seguidos.'],
    ['formato de IP', '192.168.5.4', 'O nome do bucket não pode ter o formato de um endereço IP.'],
    ['começo xn--', 'xn--trilha', 'O começo xn-- é reservado pela AWS e não serve para um bucket de log.'],
    [
      'começo sthree-',
      'sthree-trilha',
      'O começo sthree- é reservado pela AWS e não serve para um bucket de log.',
    ],
    [
      'começo amzn-s3-demo-',
      'amzn-s3-demo-bucket',
      'O começo amzn-s3-demo- é reservado pela AWS e não serve para um bucket de log.',
    ],
    [
      'alias de access point',
      'trilha-s3alias',
      'O fim -s3alias é reservado pela AWS e não serve para um bucket de log.',
    ],
    [
      'Object Lambda',
      'trilha--ol-s3',
      'O fim --ol-s3 é reservado pela AWS e não serve para um bucket de log.',
    ],
    [
      'Multi-Region Access Point',
      'trilha.mrap',
      'O fim .mrap é reservado pela AWS e não serve para um bucket de log.',
    ],
    [
      'directory bucket',
      'trilha--x-s3',
      'O fim --x-s3 é reservado pela AWS e não serve para um bucket de log.',
    ],
    [
      'table bucket',
      'trilha--table-s3',
      'O fim --table-s3 é reservado pela AWS e não serve para um bucket de log.',
    ],
  ])('recusa %s, com a mensagem do problema', (_label, name, message) => {
    expect(bucketNameProblem(name)).toBe(message);
    expect(issuesOf(awsCreate({ cloudtrail: name }))).toEqual({ 'buckets.cloudtrail': message });
  });

  it('um nome enorme é recusado pelo tamanho, sem percorrer o texto', () => {
    const started = Date.now();
    expect(bucketNameProblem(`${'a.'.repeat(100_000)}a`)).toBe('O nome do bucket tem de 3 a 63 caracteres.');
    expect(Date.now() - started).toBeLessThan(50);
  });
});

describe('buckets de log da conta AWS: fontes, repetição e limite', () => {
  it('um bucket por fonte (CloudTrail, GuardDuty e WAF), todos opcionais', () => {
    expect(awsCreate({ cloudtrail: TRAIL, guardduty: GUARDDUTY, waf: WAF }).success).toBe(true);
    expect(awsCreate({}).success).toBe(true);
    expect(awsCreate(undefined).success).toBe(true);
    expect(awsCreate({ cloudtrail: null, guardduty: null, waf: null }).success).toBe(true);
  });

  it(`o bucket do WAF começa com ${WAF_LOG_BUCKET_PREFIX} (exigência da AWS); as outras fontes, não`, () => {
    expect(issuesOf(awsCreate({ waf: 'logs-do-waf' }))).toEqual({
      'buckets.waf':
        'O bucket do WAF começa com aws-waf-logs-: a AWS só grava o log do WAF num bucket com esse começo.',
    });
    expect(awsCreate({ cloudtrail: 'logs-do-waf', guardduty: 'logs-do-waf' }).success).toBe(true);
  });

  it('o mesmo bucket em duas fontes da mesma conta vale (bucket central, pastas diferentes)', () => {
    expect(awsCreate({ cloudtrail: TRAIL, guardduty: TRAIL }).success).toBe(true);
  });

  it.each([
    ['outra fonte', { cloudtrail: TRAIL, vpcflow: 'exemplo-vpc-flow-logs' }],
    ['uma lista de buckets', [TRAIL, GUARDDUTY]],
    ['dois buckets na mesma fonte', { cloudtrail: [TRAIL, GUARDDUTY] }],
    ['um prefixo junto', { cloudtrail: TRAIL, prefix: 'AWSLogs/' }],
    ['o ARN no lugar do nome', { cloudtrail: `arn:aws:s3:::${TRAIL}` }],
    ['um número', { cloudtrail: 123 }],
  ])('recusa %s: são no máximo três, um por fonte', (_label, buckets) => {
    expect(awsCreate(buckets).success).toBe(false);
  });

  it('a alteração aceita os buckets sozinhos, null tira um, e as mesmas regras valem', () => {
    expect(cloudAccountUpdateSchema.safeParse({ buckets: { waf: WAF, cloudtrail: null } }).success).toBe(
      true,
    );
    expect(cloudAccountUpdateSchema.safeParse({ buckets: { waf: 'logs-do-waf' } }).success).toBe(false);
    expect(cloudAccountUpdateSchema.safeParse({ buckets: { guardduty: 'Maiusculo' } }).success).toBe(false);
    expect(cloudAccountUpdateSchema.safeParse({ buckets: { s3: TRAIL } }).success).toBe(false);
  });
});

describe('buckets de log da conta AWS: o que o cliente cola', () => {
  it.each([
    [`  ${TRAIL}  `, TRAIL],
    [`arn:aws:s3:::${TRAIL}`, TRAIL],
    [`arn:aws-us-gov:s3:::${TRAIL}`, TRAIL],
    [`s3://${TRAIL}/`, TRAIL],
    [`${TRAIL}/`, TRAIL],
    [`\tarn:aws:s3:::${WAF}\n`, WAF],
  ])('%j vira o nome do bucket', (pasted, name) => {
    expect(normalizeBucketName(pasted)).toBe(name);
  });

  it.each([
    // Um caminho dentro do bucket não é cortado: o cadastro não guarda prefixo, e o schema recusa com a mensagem.
    [`s3://${TRAIL}/AWSLogs/`, `${TRAIL}/AWSLogs`],
    // Outro serviço ou uma partição com caractere estranho não é tratado como ARN de bucket.
    [`arn:aws:iam::111122223333:role/${TRAIL}`, `arn:aws:iam::111122223333:role/${TRAIL}`],
    [`arn:aws$x:s3:::${TRAIL}`, `arn:aws$x:s3:::${TRAIL}`],
    ['Trilha', 'Trilha'],
  ])('%j só perde as pontas: o resto fica para o schema recusar', (pasted, kept) => {
    expect(normalizeBucketName(pasted)).toBe(kept);
    expect(bucketNameProblem(normalizeBucketName(pasted))).not.toBeNull();
  });
});

describe('buckets de log da conta AWS: a pilha e o "Verificar"', () => {
  const none: LogBuckets = { cloudtrail: null, guardduty: null, waf: null };

  it('os nomes saem sem repetir, na ordem das fontes', () => {
    expect(logBucketNames({ cloudtrail: TRAIL, guardduty: TRAIL, waf: WAF })).toEqual([TRAIL, WAF]);
    expect(logBucketNames(none)).toEqual([]);
  });

  it('a mesma lista de nomes, mesmo com a fonte trocada, não pede atualizar a pilha', () => {
    const before = { cloudtrail: TRAIL, guardduty: GUARDDUTY, waf: null };
    expect(sameLogBucketNames(before, { cloudtrail: GUARDDUTY, guardduty: TRAIL, waf: null })).toBe(true);
    expect(sameLogBucketNames(before, { ...before })).toBe(true);
    expect(sameLogBucketNames(before, { ...before, waf: WAF })).toBe(false);
    expect(sameLogBucketNames(before, { ...before, guardduty: null })).toBe(false);
    expect(sameLogBucketNames(before, { ...before, guardduty: TRAIL })).toBe(false);
    expect(sameLogBucketNames(none, none)).toBe(true);
  });

  it('a alteração só muda as fontes informadas; null tira o bucket', () => {
    const current = { cloudtrail: TRAIL, guardduty: GUARDDUTY, waf: null };
    expect(mergeLogBuckets(current, { waf: WAF, guardduty: null })).toEqual({
      cloudtrail: TRAIL,
      guardduty: null,
      waf: WAF,
    });
    expect(mergeLogBuckets(current, undefined)).toEqual(current);
    expect(mergeLogBuckets(current, {})).toEqual(current);
  });

  it('o comando da CLI leva a lista nova; sem bucket, LogBucketArns vazio, para a atualização tirar os antigos', () => {
    const command = (buckets: string[]) =>
      awsReaderDeployCommand({
        nodeServiceAccountId: '123456789012345678901',
        egressIps: ['203.0.113.10/32'],
        audience: AWS_READER_AUDIENCE,
        buckets,
      });
    expect(command(logBucketNames({ cloudtrail: TRAIL, guardduty: TRAIL, waf: WAF }))).toContain(
      `    LogBucketArns=arn:aws:s3:::${TRAIL},arn:aws:s3:::${WAF}`,
    );
    expect(command([]).split('\n').at(-1)).toBe('    LogBucketArns=""');
    // Um nome que o cadastro recusa (por exemplo, com começo reservado) não entra na pilha.
    expect(awsLogBucketArns(['amzn-s3-demo-bucket', TRAIL])).toEqual([`arn:aws:s3:::${TRAIL}`]);
  });
});

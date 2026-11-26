import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { awsReaderDeployCommand, prefillReaderTemplate } from './aws-reader.js';
import {
  ALB_ACCESS_LOG_KEYS,
  ALB_ACCESS_LOG_PREFIX,
  AWS_READER_ALB_LOGS_TAG,
  parseAlbLogsBucketTag,
  WEB_ALB_LOGGING_FAILURES,
  webAlbLoggingRequestSchema,
  webAlbLoggingSchema,
} from './web-alb-logging.js';

const template = readFileSync(
  new URL('../../../infra/cloudformation/verax-control-reader.yaml', import.meta.url),
  'utf8',
);
const values = {
  nodeServiceAccountId: '123456789012345678901',
  egressIps: ['203.0.113.10/32'],
  audience: 'https://control.veraxsistemas.com.br/aws-reader',
  buckets: [],
};
const tag = (Value: string, Key = AWS_READER_ALB_LOGS_TAG) => [{ Key, Value }];

describe('a etiqueta do bucket do log dos ALB no papel', () => {
  it('lê a região e o bucket', () => {
    expect(parseAlbLogsBucketTag(tag('sa-east-1/verax-control-reader-alblogsbucket-1a2b3c'))).toEqual({
      region: 'sa-east-1',
      bucket: 'verax-control-reader-alblogsbucket-1a2b3c',
    });
    // A chave de uma etiqueta de papel não distingue maiúsculas de minúsculas.
    expect(parseAlbLogsBucketTag(tag('us-east-1/logs-da-loja', 'Verax-Control:ALB-Logs-Bucket'))).toEqual({
      region: 'us-east-1',
      bucket: 'logs-da-loja',
    });
  });

  it('ignora o que não tem o formato: sem etiqueta, região ou bucket inválidos, partes a mais', () => {
    expect(parseAlbLogsBucketTag(undefined)).toBeNull();
    expect(parseAlbLogsBucketTag([])).toBeNull();
    expect(parseAlbLogsBucketTag([{ Key: 'verax-control:template', Value: '2' }])).toBeNull();
    for (const value of [
      '',
      'logs-da-loja',
      'sa-east-1/',
      '/logs-da-loja',
      'marte-1/logs-da-loja',
      'sa-east-1/Logs_Da_Loja',
      'sa-east-1/logs-da-loja/extra',
      'sa-east-1/ab',
      `sa-east-1/${'a'.repeat(64)}`,
    ]) {
      expect(parseAlbLogsBucketTag(tag(value)), value).toBeNull();
    }
  });
});

describe('o contrato do log ligado pelo painel', () => {
  it('só as três chaves do log de acesso, e sem prefixo', () => {
    expect(Object.values(ALB_ACCESS_LOG_KEYS)).toEqual([
      'access_logs.s3.enabled',
      'access_logs.s3.bucket',
      'access_logs.s3.prefix',
    ]);
    expect(ALB_ACCESS_LOG_PREFIX).toBe('');
  });

  it('o pedido só tem a confirmação', () => {
    expect(webAlbLoggingRequestSchema.safeParse({ confirm: true }).success).toBe(true);
    for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: true, bucket: 'outro' }]) {
      expect(webAlbLoggingRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it('a resposta vazia, a ligada e a falha; nenhum campo a mais', () => {
    const empty = {
      sourceId: '018f0000-0000-7000-8000-000000000001',
      pending: null,
      requestedAt: null,
      lastAction: null,
      status: null,
      errorCode: null,
      completedAt: null,
      enabledByVerax: false,
      bucket: null,
      enabledAt: null,
      enabledBy: null,
      disabledAt: null,
      disabledBy: null,
      previous: null,
    };
    const at = '2026-11-26T12:00:00.000Z';
    expect(webAlbLoggingSchema.safeParse(empty).success).toBe(true);
    expect(
      webAlbLoggingSchema.safeParse({
        ...empty,
        lastAction: 'enable',
        status: 'enabled',
        completedAt: at,
        enabledByVerax: true,
        bucket: 'logs-da-loja',
        enabledAt: at,
        enabledBy: 'usuario-1',
        previous: { enabled: false, bucket: null, prefix: null },
      }).success,
    ).toBe(true);
    for (const errorCode of WEB_ALB_LOGGING_FAILURES) {
      expect(
        webAlbLoggingSchema.safeParse({
          ...empty,
          lastAction: 'enable',
          status: 'failed',
          errorCode,
          completedAt: at,
        }).success,
      ).toBe(true);
    }
    expect(webAlbLoggingSchema.safeParse({ ...empty, errorCode: 'AccessDenied' }).success).toBe(false);
    expect(webAlbLoggingSchema.safeParse({ ...empty, extra: 1 }).success).toBe(false);
  });
});

describe('a pilha com o log dos ALB', () => {
  it('o template preenchido liga a opção só quando pedido', () => {
    const plain = prefillReaderTemplate(template, values);
    expect(plain).toContain('  EnableAlbAccessLogs:\n    Type: String');
    expect(plain.split('\n').filter((line) => line === "    Default: 'false'").length).toBeGreaterThan(0);
    const albLogs = prefillReaderTemplate(template, { ...values, albLogs: true });
    const lines = albLogs.split('\n');
    const at = lines.indexOf('  EnableAlbAccessLogs:');
    const defaultLine = lines.slice(at, at + 10).find((line) => line.startsWith('    Default:'));
    expect(defaultLine).toBe("    Default: 'true'");
    // Só essa linha muda em relação ao preenchido sem a opção.
    const before = plain.split('\n');
    expect(lines.filter((line, index) => line !== before[index])).toEqual(["    Default: 'true'"]);
  });

  it('o comando da CLI só menciona a opção quando pedida (sem ela, a pilha existente mantém o valor dela)', () => {
    expect(awsReaderDeployCommand(values)).not.toContain('EnableAlbAccessLogs');
    expect(awsReaderDeployCommand({ ...values, albLogs: true })).toContain('EnableAlbAccessLogs=true');
  });
});

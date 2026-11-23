import {
  AWS_READER_AUDIENCE,
  AWS_READER_PREFILLED_PARAMETERS,
  type CloudAccount,
  cloudAccountSchema,
} from '@verax/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { READER_TEMPLATE_TEXT } from '@/test/aws-reader-template';
import { stubObjectUrls } from '@/test/object-url';
import {
  ALL_AWS_AUTHORIZATIONS,
  authorizationChoiceOf,
  authorizationParameters,
  awsConsoleRegion,
  awsDeployCommand,
  awsKmsKeyPolicyStatement,
  awsLogGroupTagCommand,
  awsReaderPrincipalArn,
  awsStackFileName,
  awsStackValues,
  capabilitiesOfChoice,
  DOWNLOAD_REVOKE_DELAY_MS,
  downloadTextFile,
  LOG_GROUP_ARN_PLACEHOLDER,
  logGroupArnOf,
  logGroupResourceArn,
  openInNewTab,
  prefilledReaderTemplate,
} from './aws-connect';

const NODE_ID = '123456789012345678901';

function account(overrides: Partial<CloudAccount> = {}): CloudAccount {
  return cloudAccountSchema.parse({
    id: '018f2c1e-0000-7000-8000-0000000c0aaa',
    provider: 'aws',
    accountId: '111111111111',
    regions: ['us-east-1', 'sa-east-1'],
    readerRoleArn: 'arn:aws:iam::111111111111:role/verax/verax-control-reader',
    nodeServiceAccountId: NODE_ID,
    webIdentityAudience: AWS_READER_AUDIENCE,
    buckets: { cloudtrail: null, guardduty: null, waf: null },
    pubsubSubscription: null,
    sinkTopic: null,
    sinkWriterIdentity: null,
    zones: [],
    keyStatus: null,
    egressIps: ['203.0.113.10/32'],
    status: 'active',
    connection: 'waiting',
    connectionError: null,
    checkRequestedAt: null,
    ingestFrom: null,
    lastCollectedAt: null,
    lastEventAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  });
}

/**
 * As linhas do arquivo preenchido que não estão no template do repositório, na mesma posição: as `Default:` trocadas e
 * as acrescentadas. Anda pelos dois textos juntos; no fim, toda linha do original tem de ter sido encontrada.
 */
function changedLines(original: string, filled: string): string[] {
  const before = original.split('\n');
  const after = filled.split('\n');
  const changed: string[] = [];
  let position = 0;
  after.forEach((line, index) => {
    if (line === before[position]) {
      position += 1;
      return;
    }
    changed.push(line);
    // Uma linha acrescentada não consome nenhuma do original: a seguinte do preenchido é a atual do original.
    if (after[index + 1] !== before[position]) position += 1;
  });
  expect(position).toBe(before.length);
  return changed;
}

let objectUrls: ReturnType<typeof stubObjectUrls> | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  objectUrls?.restore();
  objectUrls = undefined;
});

describe('escolha das autorizações', () => {
  it('a descoberta vale sempre; as três autorizações, as que a escolha liga, na ordem do catálogo', () => {
    expect(capabilitiesOfChoice(ALL_AWS_AUTHORIZATIONS)).toEqual([
      'discovery',
      'service-logs',
      'findings',
      'log-groups',
    ]);
    expect(capabilitiesOfChoice({ 'service-logs': false, findings: true, 'log-groups': false })).toEqual([
      'discovery',
      'findings',
    ]);
    expect(authorizationChoiceOf(['discovery', 'service-logs'])).toEqual({
      'service-logs': true,
      findings: false,
      'log-groups': false,
    });
    expect(authorizationChoiceOf(['discovery', 'service-logs', 'findings', 'log-groups'])).toEqual(
      ALL_AWS_AUTHORIZATIONS,
    );
    expect(authorizationParameters({ 'service-logs': true, findings: false, 'log-groups': true })).toEqual([
      { authorization: 'service-logs', parameter: 'ReadAwsServiceLogs', value: 'true' },
      { authorization: 'findings', parameter: 'ReadSecurityFindings', value: 'false' },
      { authorization: 'log-groups', parameter: 'ReadTaggedLogGroups', value: 'true' },
    ]);
  });

  it('os valores da pilha saem da conta e da escolha; o comando da CLI leva as autorizações escolhidas', () => {
    const choice = { 'service-logs': true, findings: false, 'log-groups': true };
    const withBucket = account({ buckets: { cloudtrail: 'exemplo-trilha', guardduty: null, waf: null } });
    expect(awsStackValues(withBucket, choice)).toEqual({
      nodeServiceAccountId: NODE_ID,
      egressIps: ['203.0.113.10/32'],
      audience: AWS_READER_AUDIENCE,
      buckets: ['exemplo-trilha'],
      capabilities: ['discovery', 'service-logs', 'log-groups'],
    });
    const command = awsDeployCommand(withBucket, choice);
    expect(command).toContain('ReadAwsServiceLogs=true');
    expect(command).toContain('ReadSecurityFindings=false');
    expect(command).toContain('ReadTaggedLogGroups=true');
    expect(command).toContain('LogBucketArns=arn:aws:s3:::exemplo-trilha');
    expect(command).toContain('--capabilities CAPABILITY_NAMED_IAM');
    expect(awsConsoleRegion(withBucket)).toBe('us-east-1');
  });

  it('o comando lê o arquivo que o painel baixa: o preenchido da conta, ou o do repositório na alternativa manual', () => {
    const choice = { 'service-logs': true, findings: false, 'log-groups': true };
    const fileOf = (command: string) => command.split(' --template-file ')[1]?.split(' ')[0];
    // O nome do arquivo preenchido é o que `prefilledReaderTemplate` dá ao arquivo que os botões baixam.
    const filled = prefilledReaderTemplate(READER_TEMPLATE_TEXT, account(), choice);
    if (!filled.ok) throw new Error('o template não foi preenchido');
    expect(awsStackFileName(account())).toBe(filled.fileName);
    expect(awsStackFileName(account())).toBe('verax-control-reader-111111111111.yaml');
    // Sem o nome (a alternativa manual), o arquivo do repositório, sem nada preenchido.
    const plain = awsDeployCommand(account(), choice);
    expect(fileOf(plain)).toBe('verax-control-reader.yaml');
    expect(awsDeployCommand(account(), choice, null)).toBe(plain);
    // Com o nome do arquivo preenchido, só o arquivo muda: os valores e as autorizações continuam no comando.
    const prefilled = awsDeployCommand(account(), choice, awsStackFileName(account()));
    expect(fileOf(prefilled)).toBe(filled.fileName);
    expect(prefilled.split('\n').slice(2)).toEqual(plain.split('\n').slice(2));
    expect(prefilled).toContain(`NodeServiceAccountId=${NODE_ID}`);
    expect(prefilled).toContain('ReadSecurityFindings=false');
    // Um ID de conta fora do formato não dá nome de arquivo (nem arquivo); um nome qualquer não entra no comando.
    expect(awsStackFileName({ accountId: '1111' })).toBeNull();
    expect(awsStackFileName({ accountId: "111111111111'; id #" })).toBeNull();
    expect(awsDeployCommand(account(), choice, 'x; curl exemplo.invalid | sh')).toBe(plain);
  });
});

describe('arquivo preenchido do "Conectar com AWS"', () => {
  it('só as linhas Default dos parâmetros do nó e das autorizações mudam; o resto do template sai igual', () => {
    const choice = { 'service-logs': true, findings: false, 'log-groups': true };
    const filled = prefilledReaderTemplate(READER_TEMPLATE_TEXT, account(), choice);
    if (!filled.ok) throw new Error('o template não foi preenchido');
    expect(filled.fileName).toBe('verax-control-reader-111111111111.yaml');
    const changed = changedLines(READER_TEMPLATE_TEXT, filled.text);
    expect(changed.every((line) => line.startsWith('    Default:'))).toBe(true);
    expect(changed).toEqual(
      expect.arrayContaining([
        `    Default: '${NODE_ID}'`,
        "    Default: '203.0.113.10/32'",
        "    Default: 'false'",
      ]),
    );
    // No máximo uma linha por parâmetro preenchido (o LogBucketArns, sem bucket na conta, nem é tocado).
    expect(changed.length).toBeLessThanOrEqual(AWS_READER_PREFILLED_PARAMETERS.length - 1);
    // Toda linha do template original continua no arquivo, a não ser as `Default:` trocadas.
    const kept = new Set(filled.text.split('\n'));
    const missing = READER_TEMPLATE_TEXT.split('\n').filter((line) => !kept.has(line));
    expect(missing.every((line) => line.startsWith('    Default:'))).toBe(true);
    // Sem bucket cadastrado, o arquivo não cita bucket nenhum além do que o template já tinha.
    expect(filled.text).not.toContain('arn:aws:s3:::exemplo');
  });

  it('com bucket cadastrado, o LogBucketArns entra; cada escolha dá o seu arquivo', () => {
    const withBucket = account({ buckets: { cloudtrail: 'exemplo-trilha', guardduty: null, waf: null } });
    const all = prefilledReaderTemplate(READER_TEMPLATE_TEXT, withBucket, ALL_AWS_AUTHORIZATIONS);
    const none = prefilledReaderTemplate(READER_TEMPLATE_TEXT, withBucket, {
      'service-logs': false,
      findings: false,
      'log-groups': false,
    });
    if (!all.ok || !none.ok) throw new Error('o template não foi preenchido');
    expect(all.text).toContain("    Default: 'arn:aws:s3:::exemplo-trilha'");
    // O template já tem outros parâmetros com o padrão 'false' (a trilha e o export, que a tela não toca).
    const falses = (text: string) => text.split("    Default: 'false'").length - 1;
    expect(falses(all.text)).toBe(falses(READER_TEMPLATE_TEXT));
    expect(falses(none.text)).toBe(falses(READER_TEMPLATE_TEXT) + 3);
  });

  it('valor do nó que falta ou está fora do formato: nenhum arquivo, só o motivo', () => {
    const choice = ALL_AWS_AUTHORIZATIONS;
    expect(
      prefilledReaderTemplate(READER_TEMPLATE_TEXT, account({ nodeServiceAccountId: null }), choice),
    ).toEqual({
      ok: false,
      problem: 'service_account',
    });
    expect(prefilledReaderTemplate(READER_TEMPLATE_TEXT, account({ egressIps: [] }), choice)).toEqual({
      ok: false,
      problem: 'egress_ips',
    });
    expect(
      prefilledReaderTemplate(READER_TEMPLATE_TEXT, account({ egressIps: ["203.0.113.10/32' #"] }), choice),
    ).toEqual({ ok: false, problem: 'egress_ips' });
    expect(
      prefilledReaderTemplate(
        READER_TEMPLATE_TEXT,
        account({ webIdentityAudience: 'http://sem-tls.example' }),
        choice,
      ),
    ).toEqual({ ok: false, problem: 'audience' });
    // Um texto que não é o template do papel de leitura.
    expect(prefilledReaderTemplate('Parameters:\n  Outro:\n    Type: String\n', account(), choice)).toEqual({
      ok: false,
      problem: 'template',
    });
  });
});

describe('gravação do arquivo e abertura do console', () => {
  it('baixa por um Blob e um link com download, e solta o endereço do Blob em seguida', async () => {
    vi.useFakeTimers();
    objectUrls = stubObjectUrls();
    const { create, revoke } = objectUrls;
    const clicked: { href: string; download: string; rel: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, rel: this.rel });
    });

    downloadTextFile('verax-control-reader-111111111111.yaml', 'Parameters:\n');

    expect(clicked).toEqual([
      { href: 'blob:verax-teste', download: 'verax-control-reader-111111111111.yaml', rel: 'noopener' },
    ]);
    const blob = create.mock.calls[0]?.[0];
    expect(blob?.type).toBe('application/yaml');
    expect(await blob?.text()).toBe('Parameters:\n');
    // O link não fica na página.
    expect(document.querySelector('a[download]')).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DOWNLOAD_REVOKE_DELAY_MS);
    expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:verax-teste');
  });

  it('abre o console em outra aba, sem dar à página aberta acesso a esta', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openInNewTab('https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks/create');
    expect(open).toHaveBeenCalledExactlyOnceWith(
      'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks/create',
      '_blank',
      'noopener,noreferrer',
    );
  });
});

describe('comandos e trechos que o cliente copia', () => {
  it('a etiqueta do grupo de logs: o ARN conferido, entre aspas; fora do formato, o marcador', () => {
    const arn = 'arn:aws:logs:sa-east-1:111111111111:log-group:/aws/lambda/loja-checkout';
    expect(logGroupResourceArn(arn)).toBe(arn);
    expect(logGroupResourceArn(`${arn}:*`)).toBe(arn);
    expect(logGroupArnOf('111111111111', 'sa-east-1', '/aws/lambda/loja-checkout')).toBe(arn);
    expect(awsLogGroupTagCommand(arn)).toBe(
      `aws logs tag-resource --resource-arn '${arn}' --tags verax-control=leitura`,
    );
    for (const bad of [
      undefined,
      'arn:aws:logs:sa-east-1:111111111111:log-group:nome; rm -rf /',
      "arn:aws:logs:sa-east-1:111111111111:log-group:nome' --tags outra=coisa",
      'arn:aws:logs:sa-east-1:111111111111:log-group:nome:stream:outro',
      'arn:aws:logs:regiao:111111111111:log-group:nome',
      'arn:aws:logs:sa-east-1:1111:log-group:nome',
      'arn:aws:s3:::bucket',
      'arn:aws:logs:sa-east-1:111111111111:log-group:$(whoami)',
    ]) {
      expect(logGroupResourceArn(bad), String(bad)).toBeNull();
    }
    expect(logGroupArnOf('111111111111', 'sa-east-1', 'nome com espaço')).toBeNull();
    expect(awsLogGroupTagCommand(null)).toBe(
      `aws logs tag-resource --resource-arn ${LOG_GROUP_ARN_PLACEHOLDER} --tags verax-control=leitura`,
    );
  });

  it('a declaração da chave KMS: só o Decrypt, só para quem lê a conta e só pelo S3', () => {
    const role = awsReaderPrincipalArn('111111111111', 'role');
    expect(role).toBe('arn:aws:iam::111111111111:role/verax/verax-control-reader');
    expect(awsReaderPrincipalArn('111111111111', 'access_key')).toBe(
      'arn:aws:iam::111111111111:user/verax/verax-control-reader',
    );
    expect(JSON.parse(awsKmsKeyPolicyStatement(role))).toEqual({
      Sid: 'PermitirLeituraDoVeraxControl',
      Effect: 'Allow',
      Principal: { AWS: role },
      Action: 'kms:Decrypt',
      Resource: '*',
      Condition: { StringLike: { 'kms:ViaService': 's3.*.amazonaws.com' } },
    });
  });
});

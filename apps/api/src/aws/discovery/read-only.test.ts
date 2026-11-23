import {
  CreateAnalyzerCommand,
  GetFindingV2Command,
  ListAnalyzersCommand,
  ListFindingsV2Command,
  UpdateFindingsCommand,
} from '@aws-sdk/client-accessanalyzer';
import { DeleteTrailCommand, DescribeTrailsCommand, StopLoggingCommand } from '@aws-sdk/client-cloudtrail';
import {
  DeleteLogGroupCommand,
  DescribeLogGroupsCommand,
  PutRetentionPolicyCommand,
  StartQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  CreateFlowLogsCommand,
  DescribeFlowLogsCommand,
  EC2Client,
  RunInstancesCommand,
} from '@aws-sdk/client-ec2';
import {
  ArchiveFindingsCommand,
  CreateDetectorCommand,
  GetFindingsCommand as GetGuardDutyFindingsCommand,
  ListDetectorsCommand,
  ListFindingsCommand as ListGuardDutyFindingsCommand,
  UpdateDetectorCommand,
} from '@aws-sdk/client-guardduty';
import { AttachRolePolicyCommand, CreateAccessKeyCommand, GetRoleCommand } from '@aws-sdk/client-iam';
import {
  BatchGetAccountStatusCommand,
  EnableCommand,
  ListFindingsCommand as ListInspectorFindingsCommand,
} from '@aws-sdk/client-inspector2';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  BatchUpdateFindingsCommand,
  EnableSecurityHubCommand,
  GetFindingsCommand,
} from '@aws-sdk/client-securityhub';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { ListWebACLsCommand, PutLoggingConfigurationCommand } from '@aws-sdk/client-wafv2';
import { describe, expect, it, vi } from 'vitest';
import { DiscoveryRunClients } from './clients.js';
import { assertReadOnly, commandName, isReadOnlyCommand, readOnly, ReadOnlyViolation } from './read-only.js';

const READS = [
  new DescribeTrailsCommand({}),
  new DescribeFlowLogsCommand({}),
  new DescribeLogGroupsCommand({}),
  new ListDetectorsCommand({}),
  new ListWebACLsCommand({ Scope: 'REGIONAL' }),
  new ListObjectsV2Command({ Bucket: 'trilha-111111111111' }),
  new GetObjectCommand({ Bucket: 'trilha-111111111111', Key: 'AWSLogs/111111111111/a.json.gz' }),
  new GetRoleCommand({ RoleName: 'verax-control-reader' }),
  new GetFindingsCommand({}),
  new BatchGetAccountStatusCommand({}),
  // O que a tarefa `aws-findings` chama, além do `GetFindings` do Security Hub e do que divide com a descoberta.
  new ListGuardDutyFindingsCommand({ DetectorId: 'det1' }),
  new GetGuardDutyFindingsCommand({ DetectorId: 'det1', FindingIds: ['0a1b2c3d4e5f60718293a4b5c6d7e8f9'] }),
  new ListInspectorFindingsCommand({}),
  new ListAnalyzersCommand({}),
  new ListFindingsV2Command({ analyzerArn: 'arn:aws:access-analyzer:sa-east-1:111111111111:analyzer/conta' }),
  new GetFindingV2Command({
    analyzerArn: 'arn:aws:access-analyzer:sa-east-1:111111111111:analyzer/conta',
    id: '11111111-2222-3333-4444-555555555555',
  }),
];

const WRITES = [
  new PutObjectCommand({ Bucket: 'trilha-111111111111', Key: 'x' }),
  new DeleteObjectCommand({ Bucket: 'trilha-111111111111', Key: 'x' }),
  new DeleteTrailCommand({ Name: 'principal' }),
  new StopLoggingCommand({ Name: 'principal' }),
  new CreateFlowLogsCommand({ ResourceIds: ['vpc-0aaa'], ResourceType: 'VPC' }),
  new RunInstancesCommand({ MaxCount: 1, MinCount: 1 }),
  new DeleteLogGroupCommand({ logGroupName: '/aws/lambda/app' }),
  new PutRetentionPolicyCommand({ logGroupName: '/aws/lambda/app', retentionInDays: 1 }),
  // Lê, mas cobra e não começa com um dos prefixos de leitura: fica de fora.
  new StartQueryCommand({ queryString: 'fields @message', startTime: 0, endTime: 1 }),
  new CreateDetectorCommand({ Enable: true }),
  new UpdateDetectorCommand({ DetectorId: 'd', Enable: false }),
  new EnableCommand({ resourceTypes: ['EC2'] }),
  new EnableSecurityHubCommand({}),
  // Mexer num achado na origem (arquivar, mudar o fluxo de trabalho) também é escrita: o painel nunca fecha nada lá.
  new ArchiveFindingsCommand({ DetectorId: 'det1', FindingIds: ['0a1b2c3d4e5f60718293a4b5c6d7e8f9'] }),
  new BatchUpdateFindingsCommand({ FindingIdentifiers: [] }),
  new UpdateFindingsCommand({
    analyzerArn: 'arn:aws:access-analyzer:sa-east-1:111111111111:analyzer/conta',
    status: 'ARCHIVED',
  }),
  new CreateAnalyzerCommand({ analyzerName: 'conta', type: 'ACCOUNT' }),
  new PutLoggingConfigurationCommand({
    LoggingConfiguration: { ResourceArn: 'arn:aws:wafv2:x', LogDestinationConfigs: [] },
  }),
  new CreateAccessKeyCommand({}),
  new AttachRolePolicyCommand({ RoleName: 'r', PolicyArn: 'arn:aws:iam::aws:policy/AdministratorAccess' }),
  new AssumeRoleCommand({ RoleArn: 'arn:aws:iam::111111111111:role/x', RoleSessionName: 's' }),
];

describe('trava de só leitura dos clientes da descoberta', () => {
  it('deixa passar os comandos Describe, Get, List e BatchGet', () => {
    for (const command of READS) {
      expect(isReadOnlyCommand(command), commandName(command)).toBe(true);
      expect(() => assertReadOnly(command)).not.toThrow();
    }
  });

  it('recusa qualquer outro comando, citando só o nome dele', () => {
    for (const command of WRITES) {
      expect(isReadOnlyCommand(command), commandName(command)).toBe(false);
      expect(() => assertReadOnly(command)).toThrow(ReadOnlyViolation);
    }
    try {
      assertReadOnly(new PutObjectCommand({ Bucket: 'bucket-secreto', Key: 'chave-secreta' }));
      expect.unreachable();
    } catch (error) {
      expect((error as ReadOnlyViolation).command).toBe('PutObjectCommand');
      // O nome do comando, nunca a entrada dele.
      expect((error as Error).message).not.toMatch(/bucket-secreto|chave-secreta/);
    }
  });

  it('recusa o que não é um comando do SDK e nomes que só parecem de leitura', () => {
    for (const value of [null, undefined, {}, 'DescribeTrailsCommand', 42, Object.create(null)]) {
      expect(isReadOnlyCommand(value)).toBe(false);
    }
    // O prefixo de leitura precisa ser a palavra inteira, seguida de outra: `GetterCommand` e `DescribeCommand` não são.
    class GetterCommand {}
    class Getcommand {}
    class DescribeCommand {}
    class listBucketsCommand {}
    class GetObjectCommandWrapper {}
    for (const command of [
      new GetterCommand(),
      new Getcommand(),
      new DescribeCommand(),
      new listBucketsCommand(),
      new GetObjectCommandWrapper(),
    ]) {
      expect(isReadOnlyCommand(command), commandName(command)).toBe(false);
    }
  });

  it('o cliente com a trava lança antes de qualquer chamada: o cliente de verdade nunca é chamado', () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const guarded = readOnly<{ send: typeof send }>({ send });
    for (const command of WRITES) {
      expect(() => (guarded.send as (command: unknown) => unknown)(command)).toThrow(ReadOnlyViolation);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('o comando de leitura passa adiante com os mesmos argumentos', async () => {
    const send = vi.fn((_command: unknown, _options?: unknown) => Promise.resolve({ trailList: [] }));
    const guarded = readOnly<{ send: typeof send }>({ send });
    const command = new DescribeTrailsCommand({ includeShadowTrails: true });
    await expect(guarded.send(command, { abortSignal: undefined })).resolves.toEqual({ trailList: [] });
    expect(send).toHaveBeenCalledExactlyOnceWith(command, { abortSignal: undefined });
  });

  it('num cliente real do SDK, a escrita é recusada antes de o pedido sair (o handler de rede nunca roda)', async () => {
    const handle = vi.fn(() => Promise.reject(new Error('a rede não pode ser alcançada neste teste')));
    const ec2 = new EC2Client({
      region: 'sa-east-1',
      credentials: { accessKeyId: 'AKIAEXEMPLO000000000', secretAccessKey: 'segredo-de-teste-0000000000' },
      requestHandler: {
        handle,
        destroy: () => undefined,
        metadata: { handlerProtocol: 'http/1.1' },
      } as never,
      maxAttempts: 1,
    });
    const clients = new DiscoveryRunClients(
      { ec2: () => ec2 } as never,
      'sa-east-1',
      new AbortController().signal,
    );
    const send = clients.ec2('sa-east-1').send as (command: unknown) => Promise<unknown>;
    expect(() => send(new RunInstancesCommand({ MaxCount: 1, MinCount: 1 }))).toThrow(ReadOnlyViolation);
    expect(() => send(new CreateFlowLogsCommand({ ResourceIds: ['vpc-0aaa'], ResourceType: 'VPC' }))).toThrow(
      ReadOnlyViolation,
    );
    expect(handle).not.toHaveBeenCalled();
    // A leitura chega ao handler de rede (que aqui falha de propósito): a trava não a segura.
    await expect(send(new DescribeFlowLogsCommand({}))).rejects.toThrow();
    expect(handle).toHaveBeenCalledTimes(1);
    clients.destroy();
  });

  it('com o sinal da execução abortado, nem a leitura sai', async () => {
    const send = vi.fn(() => Promise.resolve({}));
    const controller = new AbortController();
    const clients = new DiscoveryRunClients(
      { cloudtrail: () => ({ send }) } as never,
      'sa-east-1',
      controller.signal,
    );
    controller.abort(new DOMException('o worker está parando', 'AbortError'));
    await expect(
      (clients.cloudtrail('sa-east-1').send as (command: unknown) => Promise<unknown>)(
        new DescribeTrailsCommand({}),
      ),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});

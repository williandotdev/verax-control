import type { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { GuardDutyClient } from '@aws-sdk/client-guardduty';
import type { S3ControlClient } from '@aws-sdk/client-s3-control';
import { describe, expect, it } from 'vitest';
import { AwsConnectionError } from '../../src/aws/web-identity.js';
import { MAX_ITEMS, collectBuckets, collectIamUsers } from '../../src/inventory/collectors.js';
import {
  collectInventory,
  concurrencyLimit,
  IAM_CONCURRENCY,
  InventoryRunClients,
  InventoryUnavailable,
  inventoryRegions,
} from '../../src/inventory/inventory.js';
import { ACCOUNT, fakeAccount, fakeFactory, fakeIam, fakeS3, REFUSED_ACL } from './fake-account.js';
import { awsError } from './fake-aws.js';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const REGIONS = ['sa-east-1', 'us-east-1'];

const refuse =
  (name: string, status = 403) =>
  () => {
    throw awsError(name, status);
  };

describe('coleta do inventário (T5.9)', () => {
  it('IAM: páginas de usuários, console, MFA e chaves com último uso', async () => {
    const { users, truncated } = await collectIamUsers(fakeIam().client);
    expect(truncated).toBe(false);
    expect(users).toEqual([
      {
        userName: 'ana',
        arn: `arn:aws:iam::${ACCOUNT}:user/ana`,
        createdAt: '2025-01-01T00:00:00.000Z',
        consoleAccess: true,
        mfaEnabled: false,
        accessKeys: [],
      },
      {
        userName: 'bot',
        arn: `arn:aws:iam::${ACCOUNT}:user/bot`,
        createdAt: null,
        consoleAccess: false,
        mfaEnabled: true,
        accessKeys: [
          {
            id: 'AKIABOT0000000000000',
            status: 'Active',
            createdAt: '2026-01-01T00:00:00.000Z',
            lastUsedAt: '2026-10-30T00:00:00.000Z',
          },
        ],
      },
    ]);
  });

  it('IAM: erro que não é "sem perfil de console" sobe, em vez de virar "sem console"', async () => {
    const failing = fakeIam({ GetLoginProfileCommand: refuse('AccessDenied') });
    await expect(collectIamUsers(failing.client)).rejects.toThrow('AccessDenied');
  });

  it('IAM: conta enorme para no teto de itens e avisa', async () => {
    let page = 0;
    const huge = fakeIam({
      ListUsersCommand: () => {
        page += 1;
        return {
          Users: Array.from({ length: 100 }, (_, n) => ({
            UserName: `u${page}-${n}`,
            Arn: `arn:${page}:${n}`,
          })),
          IsTruncated: true,
          Marker: `m${page}`,
        };
      },
    });
    const { users, truncated } = await collectIamUsers(huge.client);
    expect(users).toHaveLength(MAX_ITEMS);
    expect(truncated).toBe(true);
    expect(huge.calls.filter((call) => call.command === 'ListUsersCommand')).toHaveLength(MAX_ITEMS / 100);
  });

  it('S3: política e ACL públicas, bloqueio ausente e leitura recusada, cada bucket pelo S3 da região dele', async () => {
    const { clients, calls } = fakeAccount({ s3: REFUSED_ACL });
    const { buckets } = await collectBuckets((region) => clients.s3(region));
    expect(buckets).toEqual([
      {
        name: 'site-publico',
        region: 'sa-east-1',
        policyPublic: true,
        aclPublic: false,
        publicAccessBlock: null,
        unreadable: [],
      },
      {
        name: 'dados',
        region: 'us-east-1',
        policyPublic: false,
        aclPublic: true,
        publicAccessBlock: null,
        unreadable: [],
      },
      {
        name: 'restrito',
        region: null,
        policyPublic: false,
        aclPublic: null,
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
        unreadable: ['GetBucketAcl: AccessDenied'],
      },
    ]);
    // A listagem pelo S3 de partida; as leituras de cada bucket pelo da região dele, sem redirecionamento.
    const regionOf = (bucket: string) =>
      new Set(
        calls()
          .filter((call) => call.input['Bucket'] === bucket)
          .map((call) => call.region),
      );
    expect(calls()[0]).toMatchObject({ region: null, command: 'ListBucketsCommand' });
    expect(regionOf('site-publico')).toEqual(new Set(['sa-east-1']));
    expect(regionOf('dados')).toEqual(new Set(['us-east-1']));
    expect(regionOf('restrito')).toEqual(new Set([null]));
  });
});

describe('inventário da conta pela sessão sem chave (PR-14)', () => {
  it('conta inteira: só as regiões monitoradas, sem DescribeRegions, e só leituras', async () => {
    const { clients, calls } = fakeAccount();
    const inventory = await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW });
    expect(inventory).toMatchObject({
      accountId: ACCOUNT,
      collectedAt: NOW.toISOString(),
      regions: REGIONS,
      root: { mfaEnabled: false, accessKeysPresent: true },
      truncated: [],
      errors: [],
    });
    expect(inventory.users.map((user) => user.userName)).toEqual(['ana', 'bot']);
    expect(inventory.buckets).toHaveLength(3);
    expect(inventory.instances.map((instance) => instance.instanceId)).toEqual([
      'i-0aaa1000000000000',
      'i-0bbb1000000000000',
      'i-0aaa2000000000000',
      'i-0bbb2000000000000',
    ]);
    expect(inventory.securityGroups.map((group) => [group.region, group.openToWorld])).toEqual([
      [
        'sa-east-1',
        [
          { protocol: 'tcp', fromPort: 22, toPort: 22 },
          { protocol: 'tcp', fromPort: 443, toPort: 443 },
        ],
      ],
      ['us-east-1', expect.any(Array)],
    ]);
    const commands = new Set(calls().map((call) => call.command));
    expect(commands).not.toContain('DescribeRegionsCommand');
    // Só List, Get e Describe: nada que escreva na conta do cliente.
    for (const command of commands) expect(command).toMatch(/^(List|Get|Describe)[A-Za-z]+Command$/);
    expect(
      new Set(
        calls()
          .filter((call) => call.service === 'ec2')
          .map((call) => call.region),
      ),
    ).toEqual(new Set(REGIONS));
  });

  it('regiões: só as válidas, sem repetir, na ordem do cadastro', () => {
    expect(inventoryRegions(['sa-east-1', 'lua-1', 'sa-east-1', 'us-east-1', ''])).toEqual(REGIONS);
    expect(inventoryRegions([])).toEqual([]);
  });

  it('parte recusada (SCP numa região, IAM negado): fica em errors com o código e o resto segue', async () => {
    const { clients } = fakeAccount({
      iam: { ListUsersCommand: refuse('AccessDenied') },
      ec2: { 'us-east-1': { DescribeInstancesCommand: refuse('UnauthorizedOperation') } },
    });
    const inventory = await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW });
    expect(inventory.errors).toEqual([
      { section: 'iam', region: null, code: 'AccessDenied' },
      { section: 'ec2', region: 'us-east-1', code: 'UnauthorizedOperation' },
    ]);
    expect(inventory.users).toEqual([]);
    expect(inventory.root).not.toBeNull();
    expect(inventory.instances.map((instance) => instance.region)).toEqual(['sa-east-1', 'sa-east-1']);
    // Os security groups da mesma região foram lidos.
    expect(inventory.securityGroups.map((group) => group.region)).toEqual(REGIONS);
    // A mensagem da AWS (com ARN) nunca entra no inventário.
    expect(JSON.stringify(inventory)).not.toContain('detalhe-interno');
  });

  it('região desligada ou fora do opt-in (AuthFailure) e erro que não passa sozinho: coleta parcial', async () => {
    const { clients } = fakeAccount({
      ec2: {
        'sa-east-1': {
          DescribeInstancesCommand: refuse('AuthFailure', 401),
          DescribeSecurityGroupsCommand: refuse('AuthFailure', 401),
        },
        'us-east-1': { DescribeSecurityGroupsCommand: refuse('InvalidParameterValue', 400) },
      },
    });
    const inventory = await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW });
    expect(inventory.errors).toEqual([
      { section: 'ec2', region: 'sa-east-1', code: 'AuthFailure' },
      { section: 'sg', region: 'sa-east-1', code: 'AuthFailure' },
      { section: 'sg', region: 'us-east-1', code: 'InvalidParameterValue' },
    ]);
  });

  it('falha passageira (limite, 5xx, rede): a coleta inteira para, sem retrato parcial', async () => {
    for (const failure of [
      () => {
        throw awsError('Throttling', 400);
      },
      refuse('InternalError', 500),
      () => {
        // Sem resposta (a rede caiu): o SDK não traz `$metadata`.
        throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      },
    ]) {
      const { clients } = fakeAccount({ ec2: { 'us-east-1': { DescribeInstancesCommand: failure } } });
      const promise = collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW });
      await expect(promise).rejects.toBeInstanceOf(InventoryUnavailable);
      await expect(promise).rejects.toMatchObject({ code: 'aws_unavailable' });
    }
  });

  it('nenhuma parte lida (sessão revogada, política trocada): inventory_refused, nada a gravar', async () => {
    const { clients } = fakeAccount({
      iam: {
        GetAccountSummaryCommand: refuse('AccessDenied'),
        ListUsersCommand: refuse('AccessDenied'),
      },
      s3: { ListBucketsCommand: refuse('AccessDenied') },
      ec2: Object.fromEntries(
        REGIONS.map((region) => [
          region,
          {
            DescribeInstancesCommand: refuse('UnauthorizedOperation'),
            DescribeSecurityGroupsCommand: refuse('UnauthorizedOperation'),
          },
        ]),
      ),
    });
    await expect(
      collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW }),
    ).rejects.toMatchObject({ name: 'inventory_refused', code: 'inventory_refused' });
  });

  it('leitura recusada num bucket (a ACL): entra na coleta parcial, e o bucket fica com o motivo', async () => {
    const { clients } = fakeAccount({ s3: REFUSED_ACL });
    const inventory = await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW });
    expect(inventory.errors).toEqual([{ section: 's3', region: null, code: 'AccessDenied' }]);
    expect(inventory.buckets.find((bucket) => bucket.name === 'restrito')).toMatchObject({
      aclPublic: null,
      unreadable: ['GetBucketAcl: AccessDenied'],
    });
    // Os outros buckets e as outras partes foram lidos.
    expect(inventory.buckets).toHaveLength(3);
    expect(inventory.users).toHaveLength(2);
  });

  it('falha passageira numa leitura de bucket (limite, 5xx, rede): a coleta para, sem retrato com a configuração desconhecida', async () => {
    for (const failure of [
      () => {
        throw awsError('SlowDown', 503);
      },
      refuse('InternalError', 500),
      () => {
        throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      },
    ]) {
      const { clients } = fakeAccount({
        s3: {
          GetBucketPolicyStatusCommand: (input) => {
            if (input['Bucket'] === 'dados') failure();
            return { PolicyStatus: { IsPublic: false } };
          },
        },
      });
      await expect(
        collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW }),
      ).rejects.toMatchObject({ code: 'aws_unavailable' });
    }
  });

  it('falha passageira num bucket: nenhum bucket novo começa depois dela', async () => {
    const names = Array.from({ length: 12 }, (_, n) => `bucket-${n}`);
    const { clients, calls } = fakeAccount({
      s3: {
        ListBucketsCommand: () => ({ Buckets: names.map((Name) => ({ Name, BucketRegion: 'sa-east-1' })) }),
        GetBucketAclCommand: (input) => {
          if (input['Bucket'] === 'bucket-0') throw awsError('SlowDown', 503);
          return { Grants: [] };
        },
      },
    });
    await expect(
      collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW }),
    ).rejects.toMatchObject({ code: 'aws_unavailable' });
    const touched = new Set(calls().flatMap((call) => (call.service === 's3' ? [call.input['Bucket']] : [])));
    touched.delete(undefined);
    expect(touched.size).toBeLessThan(names.length);
    // A coleta parou no S3: nada do EC2 foi chamado.
    expect(calls().filter((call) => call.service === 'ec2')).toEqual([]);
  });

  it('a sessão que cai numa leitura de bucket para a coleta com o código da conexão', async () => {
    const { clients } = fakeAccount({
      s3: {
        GetPublicAccessBlockCommand: () => {
          throw new AwsConnectionError('token_invalid', false);
        },
      },
    });
    await expect(
      collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW }),
    ).rejects.toMatchObject({ code: 'token_invalid' });
  });

  it('o bucket que sumiu entre a listagem e a leitura (NoSuchBucket) fica de fora, sem erro', async () => {
    const { clients } = fakeAccount({
      s3: {
        GetBucketAclCommand: (input) => {
          if (input['Bucket'] === 'dados') throw awsError('NoSuchBucket', 404);
          return { Grants: [] };
        },
      },
    });
    const inventory = await collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW });
    expect(inventory.buckets.map((bucket) => bucket.name)).toEqual(['site-publico', 'restrito']);
    expect(inventory.errors).toEqual([]);
  });

  it('a sessão que cai no meio (o provedor não renova) para a coleta com o código da conexão', async () => {
    const { clients } = fakeAccount({
      s3: {
        ListBucketsCommand: () => {
          throw new AwsConnectionError('trust_denied', true);
        },
      },
    });
    await expect(
      collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, { now: NOW }),
    ).rejects.toMatchObject({ code: 'trust_denied' });
  });

  it('o sinal abortado (parada do worker, orçamento) para a coleta com o motivo dele', async () => {
    const controller = new AbortController();
    const reason = new DOMException('o worker está parando', 'AbortError');
    const { clients } = fakeAccount({
      s3: {
        ListBucketsCommand: () => {
          controller.abort(reason);
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      },
    });
    await expect(
      collectInventory({ accountId: ACCOUNT, regions: REGIONS }, clients, {
        now: NOW,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });
});

describe('clientes da coleta: sinal, limite do IAM e fechamento', () => {
  it(`no máximo ${IAM_CONCURRENCY} chamadas do IAM ao mesmo tempo, com muitos usuários e chaves`, async () => {
    let inFlight = 0;
    let peak = 0;
    const slow =
      (answer: (input: Record<string, unknown>) => unknown) =>
      async (input: Record<string, unknown>): Promise<unknown> => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return answer(input);
      };
    const users = Array.from({ length: 12 }, (_, n) => ({
      UserName: `u${n}`,
      Arn: `arn:aws:iam::${ACCOUNT}:user/u${n}`,
    }));
    const iam = fakeIam({
      ListUsersCommand: () => ({ Users: users, IsTruncated: false }),
      GetLoginProfileCommand: () => ({ LoginProfile: {} }),
      ListMFADevicesCommand: () => ({ MFADevices: [] }),
      ListAccessKeysCommand: (input) => ({
        AccessKeyMetadata: [1, 2].map((n) => ({
          AccessKeyId: `AKIA${String(input['UserName']).toUpperCase().padEnd(15, '0')}${n}`,
          Status: 'Active',
        })),
      }),
      GetAccessKeyLastUsedCommand: () => ({ AccessKeyLastUsed: {} }),
    });
    const timed = {
      send: (command: { constructor: { name: string }; input: Record<string, unknown> }) =>
        slow(() => (iam.client as unknown as { send: (c: unknown) => Promise<unknown> }).send(command))(
          command.input,
        ),
    };
    const run = new InventoryRunClients(
      {
        iam: () => timed,
        s3: () => fakeS3().client,
        ec2: () => ({}) as EC2Client,
        s3control: () => ({}) as S3ControlClient,
        cloudtrail: () => ({}) as CloudTrailClient,
        guardduty: () => ({}) as GuardDutyClient,
      },
      'sa-east-1',
      new AbortController().signal,
    );
    const { users: collected } = await collectIamUsers(run.iam());
    expect(collected).toHaveLength(12);
    expect(iam.calls.length).toBe(1 + 12 * 3 + 12 * 2);
    expect(peak).toBe(IAM_CONCURRENCY);
  });

  it('o sinal vai em toda chamada; um cliente por região, fechados no fim; S3 sem região válida é o de partida', async () => {
    const fake = fakeFactory();
    const controller = new AbortController();
    const run = new InventoryRunClients(
      fake.factory(() => Promise.reject(new Error('sem uso')), 'sa-east-1'),
      'sa-east-1',
      controller.signal,
    );
    await run
      .ec2('us-east-1')
      .send({ constructor: { name: 'DescribeSecurityGroupsCommand' }, input: {} } as never);
    await run
      .ec2('us-east-1')
      .send({ constructor: { name: 'DescribeSecurityGroupsCommand' }, input: {} } as never);
    await run.s3('lua-1').send({ constructor: { name: 'ListBucketsCommand' }, input: {} } as never);
    await run.s3(null).send({ constructor: { name: 'ListBucketsCommand' }, input: {} } as never);
    expect(fake.signals).toEqual(Array.from({ length: 4 }, () => ({ abortSignal: controller.signal })));
    expect(fake.calls().map((call) => call.region)).toEqual([
      'us-east-1',
      'us-east-1',
      'sa-east-1',
      'sa-east-1',
    ]);
    run.destroy();
    // Dois clientes: o EC2 de us-east-1 e o S3 de partida.
    expect(fake.destroyed()).toBe(2);
    const reason = new DOMException('parando', 'AbortError');
    controller.abort(reason);
    const calls = fake.calls().length;
    await expect(
      run.ec2('us-east-1').send({ constructor: { name: 'DescribeInstancesCommand' }, input: {} } as never),
    ).rejects.toBe(reason);
    // Com o sinal abortado, a chamada nem sai.
    expect(fake.calls()).toHaveLength(calls);
  });

  it('a fila passa a vez direto: quem chega depois não fura o limite', async () => {
    const limit = concurrencyLimit(2);
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    const task = () =>
      limit(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      });
    const running = [task(), task(), task()];
    await Promise.resolve();
    expect(releases).toHaveLength(2);
    releases.shift()?.();
    // Entre a saída de uma e a entrada da que esperava, outra chega: tem de esperar também.
    running.push(task());
    for (let round = 0; round < 10 && releases.length > 0; round += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      releases.shift()?.();
    }
    await Promise.all(running);
    expect(peak).toBe(2);
  });
});

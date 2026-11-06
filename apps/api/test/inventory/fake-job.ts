import type { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { GuardDutyClient } from '@aws-sdk/client-guardduty';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { S3Client } from '@aws-sdk/client-s3';
import type { S3ControlClient } from '@aws-sdk/client-s3-control';
import type { AwsConnectionError, AwsCredentialProvider, ReaderSession } from '../../src/aws/web-identity.js';
import type { InventoryClientFactory, InventoryClients } from '../../src/inventory/inventory.js';
import type { InventoryCredentials } from '../../src/inventory/inventory-job.js';
import { TemporaryCredentials } from '../../src/inventory/read-only-session.js';
import { fakeAccount, type FakeAccountOptions } from './fake-account.js';

/**
 * O que os testes da tarefa `aws-inventory` dividem (o inventário, PR-14', e a postura, PR-15'): o relógio, o provedor
 * falso das sessões e a fábrica de clientes falsa com a conta fictícia de `fake-account.ts`.
 */

/** Um relógio do teste, que só anda quando o teste manda. */
export function clockAt(start: Date) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

/**
 * O provedor falso das sessões: cada entrada no papel anotada, um erro programado por conta, e o provedor de cada conta
 * marcado com ela (a fábrica de clientes falsa descobre de que conta é a coleta).
 */
export class FakeCredentials implements InventoryCredentials {
  readonly sessions: { accountId: string; region: string }[] = [];
  readonly forgotten: string[] = [];
  readonly failures = new Map<string, AwsConnectionError>();
  readonly owners = new Map<AwsCredentialProvider, string>();

  session(accountId: string, region: string): Promise<ReaderSession> {
    this.sessions.push({ accountId, region });
    const failure = this.failures.get(accountId);
    if (failure !== undefined) return Promise.reject(failure);
    return Promise.resolve({
      credentials: new TemporaryCredentials({
        accessKeyId: 'ASIAEXEMPLO000000000',
        secretAccessKey: 'segredo-de-teste-da-sessao-0000',
        sessionToken: 'token-de-teste-da-sessao-0000',
      }),
      stsRegion: region,
      regionFallback: false,
    });
  }

  credentialsFor(accountId: string): AwsCredentialProvider {
    const provider: AwsCredentialProvider = () => Promise.reject(new Error('o falso não resolve credencial'));
    this.owners.set(provider, accountId);
    return provider;
  }

  forget(accountId: string): void {
    this.forgotten.push(accountId);
  }
}

type Wrap = <T extends { send: unknown }>(
  service: string,
  client: Pick<T, 'send'>,
) => Pick<T, 'send'> & { destroy?: () => void };

/** A fábrica com os clientes de uma conta fictícia, cada um passando por `wrap` (que anota ou resolve a sessão). */
export function factoryOf(clients: InventoryClients, wrap: Wrap): ReturnType<InventoryClientFactory> {
  return {
    iam: () => wrap<IAMClient>('iam', clients.iam()),
    s3: (region) => wrap<S3Client>('s3', clients.s3(region)),
    ec2: (region) => wrap<EC2Client>('ec2', clients.ec2(region)),
    s3control: () => wrap<S3ControlClient>('s3control', clients.s3control()),
    cloudtrail: (region) => wrap<CloudTrailClient>('cloudtrail', clients.cloudtrail(region)),
    guardduty: (region) => wrap<GuardDutyClient>('guardduty', clients.guardduty(region)),
  };
}

/** A fábrica de clientes falsa: a conta fictícia de `fake-account.ts`, com o comportamento programado por conta AWS. */
export function factoryFor(
  owners: (provider: AwsCredentialProvider) => string | undefined,
  behavior: Record<string, FakeAccountOptions> = {},
) {
  const calls: { accountId: string; service: string; command: string }[] = [];
  const factory: InventoryClientFactory = (credentials) => {
    const owner = owners(credentials) ?? 'desconhecida';
    const account = fakeAccount(behavior[owner] ?? {});
    return factoryOf(account.clients, (service, client) => ({
      send: (command: { constructor: { name: string } }) => {
        calls.push({ accountId: owner, service, command: command.constructor.name });
        return (client as unknown as { send: (c: unknown) => Promise<unknown> }).send(command);
      },
    }));
  };
  return { factory, calls };
}

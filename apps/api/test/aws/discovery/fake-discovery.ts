import type { DiscoveryClientFactory, DiscoveryClients } from '../../../src/aws/discovery/clients.js';
import { awsError } from '../../inventory/fake-aws.js';

/**
 * Uma conta AWS fictícia para os testes da descoberta: cada comando é atendido pelo handler com o nome da classe dele,
 * por serviço e região, e toda chamada fica registrada. Nada sai para a rede.
 *
 * Sem handler, a resposta é a de uma conta vazia: nenhuma trilha, nenhum flow log, nenhum detector, o Security Hub
 * desligado (a AWS responde `InvalidAccessException`), o Inspector desligado e nenhum bucket. Cada teste só declara o que
 * importa para ele. `deny` recusa um serviço inteiro numa região (ou em todas, com `*`).
 */

type Handler = (input: Record<string, unknown>) => unknown;
export type Handlers = Record<string, Handler>;

export interface FakeDiscoveryAccount {
  /** As regiões habilitadas (a resposta do `DescribeRegions`). */
  regions: string[];
  /** Handlers por `serviço:região` (`ec2:sa-east-1`, `iam:global`, `s3:*`), depois por nome do comando. */
  handlers?: Record<string, Handlers>;
  /** O erro que um serviço responde a qualquer comando, por `serviço:região` ou `serviço:*`. */
  deny?: Record<string, Error>;
}

export interface FakeDiscoveryCall {
  service: string;
  region: string;
  command: string;
  input: Record<string, unknown>;
}

type Service =
  | 'ec2'
  | 'cloudtrail'
  | 'guardduty'
  | 's3'
  | 'iam'
  | 'logs'
  | 'wafv2'
  | 'securityhub'
  | 'inspector2'
  | 'accessanalyzer'
  | 'rds'
  | 'elbv2'
  | 'config';

/** As respostas de uma conta vazia. */
function defaults(account: FakeDiscoveryAccount): Partial<Record<Service, Handlers>> {
  return {
    ec2: {
      DescribeRegionsCommand: () => ({ Regions: account.regions.map((RegionName) => ({ RegionName })) }),
    },
    securityhub: {
      DescribeHubCommand: () => {
        throw awsError('InvalidAccessException');
      },
    },
    iam: {
      GetAccountSummaryCommand: () => ({ SummaryMap: { Users: 0, AccountMFAEnabled: 1 } }),
    },
    s3: {
      ListBucketsCommand: () => ({ Buckets: [] }),
      GetObjectCommand: () => ({ Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(1)) } }),
    },
  };
}

export function fakeDiscovery(account: FakeDiscoveryAccount) {
  const calls: FakeDiscoveryCall[] = [];
  const base = defaults(account);

  function client(service: Service, region: string) {
    const send = (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      calls.push({ service, region, command: name, input: command.input });
      const denied = account.deny?.[`${service}:${region}`] ?? account.deny?.[`${service}:*`];
      if (denied !== undefined) return Promise.reject(denied);
      const handler =
        account.handlers?.[`${service}:${region}`]?.[name] ??
        account.handlers?.[`${service}:*`]?.[name] ??
        base[service]?.[name];
      if (handler === undefined) return Promise.resolve({});
      try {
        return Promise.resolve(handler(command.input));
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    return { send };
  }

  const clients = {
    ec2: (region: string) => client('ec2', region),
    cloudtrail: (region: string) => client('cloudtrail', region),
    guardduty: (region: string) => client('guardduty', region),
    s3: (region: string | null) => client('s3', region ?? 'home'),
    iam: () => client('iam', 'global'),
    logs: (region: string) => client('logs', region),
    wafv2: (region: string) => client('wafv2', region),
    securityhub: (region: string) => client('securityhub', region),
    inspector2: (region: string) => client('inspector2', region),
    accessanalyzer: (region: string) => client('accessanalyzer', region),
    rds: (region: string) => client('rds', region),
    elbv2: (region: string) => client('elbv2', region),
    config: (region: string) => client('config', region),
  } as unknown as DiscoveryClients;

  /** A fábrica que a tarefa recebe: os mesmos clientes falsos, sem a sessão. */
  const factory: DiscoveryClientFactory = () => clients;

  return {
    clients,
    factory,
    calls,
    /** Os comandos mandados a um serviço (em qualquer região, ou numa). */
    commands: (service: string, region?: string) =>
      calls
        .filter((call) => call.service === service && (region === undefined || call.region === region))
        .map((call) => call.command),
  };
}

export { awsError };

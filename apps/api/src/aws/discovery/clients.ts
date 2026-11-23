import type { AccessAnalyzerClient } from '@aws-sdk/client-accessanalyzer';
import type { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { ConfigServiceClient } from '@aws-sdk/client-config-service';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import type { GuardDutyClient } from '@aws-sdk/client-guardduty';
import type { IAMClient } from '@aws-sdk/client-iam';
import type { Inspector2Client } from '@aws-sdk/client-inspector2';
import type { RDSClient } from '@aws-sdk/client-rds';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SecurityHubClient } from '@aws-sdk/client-securityhub';
import type { WAFV2Client } from '@aws-sdk/client-wafv2';
import { isAwsRegion } from '@verax/shared';
import { concurrencyLimit } from '../../inventory/inventory.js';
import type { AwsCredentialProvider } from '../web-identity.js';
import { assertReadOnly } from './read-only.js';

/**
 * Os clientes da AWS de uma descoberta (onboarding self-service), já com a sessão de leitura da conta. Toda chamada
 * passa pela trava de só leitura (`read-only.ts`), leva o sinal da execução, tem um tempo máximo próprio e entra numa
 * fila: no máximo `DISCOVERY_CALL_CONCURRENCY` chamadas ao mesmo tempo na conta inteira, para não disputar os limites
 * de requisição da conta do cliente com a automação dele.
 */

export type Sender<T extends { send: unknown }> = Pick<T, 'send'>;
type SdkClient<T extends { send: unknown }> = Sender<T> & { destroy?: () => void };

/** Tempo máximo de uma chamada: a região que não responde não prende a execução. */
export const DISCOVERY_CALL_TIMEOUT_MS = 15_000;
/** Chamadas ao mesmo tempo, somadas todas as regiões. */
export const DISCOVERY_CALL_CONCURRENCY = 8;

/** O que a descoberta usa da AWS. Os testes trocam por falsos. */
export interface DiscoveryClients {
  ec2(region: string): Sender<EC2Client>;
  cloudtrail(region: string): Sender<CloudTrailClient>;
  guardduty(region: string): Sender<GuardDutyClient>;
  /** O S3 da região do bucket; `null` é a região de partida (os clientes seguem o redirecionamento). */
  s3(region: string | null): Sender<S3Client>;
  iam(): Sender<IAMClient>;
  logs(region: string): Sender<CloudWatchLogsClient>;
  wafv2(region: string): Sender<WAFV2Client>;
  securityhub(region: string): Sender<SecurityHubClient>;
  inspector2(region: string): Sender<Inspector2Client>;
  accessanalyzer(region: string): Sender<AccessAnalyzerClient>;
  rds(region: string): Sender<RDSClient>;
  elbv2(region: string): Sender<ElasticLoadBalancingV2Client>;
  config(region: string): Sender<ConfigServiceClient>;
}

/** Cria os clientes da AWS de uma conta: o provedor da sessão e a região de partida. */
export type DiscoveryClientFactory = (
  credentials: AwsCredentialProvider,
  homeRegion: string,
) => {
  ec2(region: string): SdkClient<EC2Client>;
  cloudtrail(region: string): SdkClient<CloudTrailClient>;
  guardduty(region: string): SdkClient<GuardDutyClient>;
  s3(region: string): SdkClient<S3Client>;
  iam(): SdkClient<IAMClient>;
  logs(region: string): SdkClient<CloudWatchLogsClient>;
  wafv2(region: string): SdkClient<WAFV2Client>;
  securityhub(region: string): SdkClient<SecurityHubClient>;
  inspector2(region: string): SdkClient<Inspector2Client>;
  accessanalyzer(region: string): SdkClient<AccessAnalyzerClient>;
  rds(region: string): SdkClient<RDSClient>;
  elbv2(region: string): SdkClient<ElasticLoadBalancingV2Client>;
  config(region: string): SdkClient<ConfigServiceClient>;
};

export interface DiscoveryRunClientOptions {
  callTimeoutMs?: number;
  concurrency?: number;
}

/**
 * Os clientes de uma execução: criados sob demanda (um por serviço e região), com a trava, o sinal, o tempo máximo e a
 * fila em toda chamada, e fechados no fim (`destroy`).
 */
export class DiscoveryRunClients implements DiscoveryClients {
  readonly #cache = new Map<string, SdkClient<{ send: unknown }>>();
  readonly #guarded = new Map<string, Sender<{ send: unknown }>>();
  readonly #limit: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #callTimeoutMs: number;

  constructor(
    private readonly factory: ReturnType<DiscoveryClientFactory>,
    private readonly homeRegion: string,
    private readonly signal: AbortSignal,
    {
      callTimeoutMs = DISCOVERY_CALL_TIMEOUT_MS,
      concurrency = DISCOVERY_CALL_CONCURRENCY,
    }: DiscoveryRunClientOptions = {},
  ) {
    this.#limit = concurrencyLimit(concurrency);
    this.#callTimeoutMs = callTimeoutMs;
  }

  #get<T extends { send: unknown }>(key: string, create: () => SdkClient<T>): Sender<T> {
    const known = this.#guarded.get(key);
    if (known !== undefined) return known as Sender<T>;
    const client = create();
    this.#cache.set(key, client);
    const target = client as unknown as { send(command: unknown, options: unknown): Promise<unknown> };
    const send = (command: unknown): Promise<unknown> => {
      // A trava vem antes de tudo: o comando que não é de leitura nem entra na fila.
      assertReadOnly(command);
      return this.#limit(async () => {
        this.signal.throwIfAborted();
        const abortSignal = AbortSignal.any([this.signal, AbortSignal.timeout(this.#callTimeoutMs)]);
        return target.send(command, { abortSignal });
      });
    };
    const wrapped = { send } as unknown as Sender<T>;
    this.#guarded.set(key, wrapped);
    return wrapped;
  }

  ec2(region: string): Sender<EC2Client> {
    return this.#get(`ec2:${region}`, () => this.factory.ec2(region));
  }

  cloudtrail(region: string): Sender<CloudTrailClient> {
    return this.#get(`cloudtrail:${region}`, () => this.factory.cloudtrail(region));
  }

  guardduty(region: string): Sender<GuardDutyClient> {
    return this.#get(`guardduty:${region}`, () => this.factory.guardduty(region));
  }

  s3(region: string | null): Sender<S3Client> {
    const chosen = region !== null && isAwsRegion(region) ? region : this.homeRegion;
    return this.#get(`s3:${chosen}`, () => this.factory.s3(chosen));
  }

  iam(): Sender<IAMClient> {
    return this.#get('iam', () => this.factory.iam());
  }

  logs(region: string): Sender<CloudWatchLogsClient> {
    return this.#get(`logs:${region}`, () => this.factory.logs(region));
  }

  wafv2(region: string): Sender<WAFV2Client> {
    return this.#get(`wafv2:${region}`, () => this.factory.wafv2(region));
  }

  securityhub(region: string): Sender<SecurityHubClient> {
    return this.#get(`securityhub:${region}`, () => this.factory.securityhub(region));
  }

  inspector2(region: string): Sender<Inspector2Client> {
    return this.#get(`inspector2:${region}`, () => this.factory.inspector2(region));
  }

  accessanalyzer(region: string): Sender<AccessAnalyzerClient> {
    return this.#get(`accessanalyzer:${region}`, () => this.factory.accessanalyzer(region));
  }

  rds(region: string): Sender<RDSClient> {
    return this.#get(`rds:${region}`, () => this.factory.rds(region));
  }

  elbv2(region: string): Sender<ElasticLoadBalancingV2Client> {
    return this.#get(`elbv2:${region}`, () => this.factory.elbv2(region));
  }

  config(region: string): Sender<ConfigServiceClient> {
    return this.#get(`config:${region}`, () => this.factory.config(region));
  }

  destroy(): void {
    for (const client of this.#cache.values()) client.destroy?.();
    this.#cache.clear();
    this.#guarded.clear();
  }
}

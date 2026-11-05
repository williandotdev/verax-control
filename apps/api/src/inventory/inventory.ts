import { EC2Client } from '@aws-sdk/client-ec2';
import { IAMClient } from '@aws-sdk/client-iam';
import { S3Client } from '@aws-sdk/client-s3';
import {
  type InventorySection,
  type InventorySectionError,
  isAwsRegion,
  isInventoryErrorCode,
} from '@verax/shared';
import {
  AWS_CLIENT_OPTIONS,
  AwsConnectionError,
  type AwsCredentialProvider,
  awsErrorName,
  isTransientAwsError,
  STS_FALLBACK_REGION,
} from '../aws/web-identity.js';
import {
  collectBuckets,
  collectIamUsers,
  collectInstances,
  collectRootAccount,
  collectSecurityGroups,
  type BucketInfo,
  type Ec2Instance,
  type IamUser,
  type RootAccount,
  type SecurityGroupInfo,
} from './collectors.js';

/**
 * Inventário de uma conta (T5.9 e fase 2, PR-14'): identidades, chaves, instâncias, security groups e buckets, pela
 * sessão do papel de leitura sem chave (`aws/web-identity.ts`). Só leitura, cada chamada uma linha no CloudTrail do
 * cliente: as regiões são as monitoradas na conta (sem `DescribeRegions`), e o IAM, global e dividido com a automação
 * do próprio cliente, recebe no máximo 2 chamadas ao mesmo tempo.
 *
 * Cada parte (a conta root, o IAM, o S3 e, por região, o EC2 e os security groups) é lida por inteiro ou fica de fora:
 * - **recusada** pela AWS (permissão, SCP da organização, região desligada) ou com outro erro que não passa sozinho: vai
 *   para `errors` com o nome do erro (nunca a mensagem), e o resto segue: o retrato sai parcial;
 * - **falha passageira** (limite, 5xx, rede, já com as novas tentativas do SDK) ou a sessão que caiu no meio: a coleta
 *   inteira para (`InventoryUnavailable`), nada é gravado e a tarefa tenta de novo mais tarde. Um retrato com uma parte
 *   vazia por um tropeço da AWS apagaria da tela o que o anterior tinha;
 * - **nenhuma parte lida** (todas recusadas: a sessão revogada no console, a política trocada): também para, com
 *   `inventory_refused`, pelo mesmo motivo.
 */

type Sender<T extends { send: unknown }> = Pick<T, 'send'>;
type SdkClient<T extends { send: unknown }> = Sender<T> & { destroy?: () => void };

/** Os clientes de uma coleta, já com a sessão do papel. Os testes trocam por falsos. */
export interface InventoryClients {
  iam(): Sender<IAMClient>;
  /** O S3 da região do bucket; `null` é a região de partida (a listagem). */
  s3(region: string | null): Sender<S3Client>;
  ec2(region: string): Sender<EC2Client>;
}

/** Cria os clientes da AWS de uma conta: o provedor da sessão e a região de partida (a primeira monitorada). */
export type InventoryClientFactory = (
  credentials: AwsCredentialProvider,
  homeRegion: string,
) => {
  iam(): SdkClient<IAMClient>;
  s3(region: string): SdkClient<S3Client>;
  ec2(region: string): SdkClient<EC2Client>;
};

/** Chamadas do IAM ao mesmo tempo, no máximo (o pedido da frente de inventário: o IAM é global e é do cliente também). */
export const IAM_CONCURRENCY = 2;

/**
 * Opções dos clientes do inventário: as do worker (tempo curto) com uma tentativa a mais e o modo adaptativo, que
 * espaça as chamadas quando a AWS limita. As novas tentativas só acontecem num limite ou numa falha passageira.
 */
const INVENTORY_CLIENT_OPTIONS = { ...AWS_CLIENT_OPTIONS, maxAttempts: 3, retryMode: 'adaptive' } as const;

/**
 * Os clientes de verdade. O IAM é global (assinado em us-east-1); o S3 segue o redirecionamento só quando a listagem
 * não informa a região do bucket. O provedor é o `credentialsFor` da conta: o SDK guarda a sessão e pede outra ao
 * provedor quando faltam 5 min para vencer, numa coleta longa.
 */
export const sdkInventoryClients: InventoryClientFactory = (credentials, homeRegion) => ({
  iam: () => new IAMClient({ region: STS_FALLBACK_REGION, credentials, ...INVENTORY_CLIENT_OPTIONS }),
  s3: (region) =>
    new S3Client({
      region: isAwsRegion(region) ? region : homeRegion,
      credentials,
      followRegionRedirects: true,
      ...INVENTORY_CLIENT_OPTIONS,
    }),
  ec2: (region) => new EC2Client({ region, credentials, ...INVENTORY_CLIENT_OPTIONS }),
});

/** Uma fila de no máximo `max` tarefas ao mesmo tempo; quem termina passa a vez direto para o próximo da fila. */
export function concurrencyLimit(max: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active < max) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active -= 1;
      else next();
    }
  };
}

type Limiter = <T>(task: () => Promise<T>) => Promise<T>;
const unlimited: Limiter = async (task) => task();

/** O `send` do cliente com o sinal da tarefa em toda chamada e, no IAM, a fila de chamadas simultâneas. */
function guarded<T extends { send: unknown }>(
  client: Sender<T>,
  signal: AbortSignal,
  limit: Limiter = unlimited,
): Sender<T> {
  const target = client as unknown as { send(command: unknown, options: unknown): Promise<unknown> };
  // Assíncrono de ponta a ponta: com o sinal abortado, a chamada é recusada (rejeitada), sem sair para a AWS.
  const send = (command: unknown) =>
    limit(async () => {
      signal.throwIfAborted();
      return target.send(command, { abortSignal: signal });
    });
  return { send };
}

/**
 * Os clientes de uma coleta: criados sob demanda (um por região), com o sinal e o limite do IAM em toda chamada, e
 * fechados no fim (`destroy`), para a conexão não ficar presa no worker.
 */
export class InventoryRunClients implements InventoryClients {
  readonly #cache = new Map<string, SdkClient<{ send: unknown }>>();
  readonly #guarded = new Map<string, Sender<{ send: unknown }>>();
  readonly #iamLimit = concurrencyLimit(IAM_CONCURRENCY);

  constructor(
    private readonly factory: ReturnType<InventoryClientFactory>,
    private readonly homeRegion: string,
    private readonly signal: AbortSignal,
  ) {}

  #get<T extends { send: unknown }>(key: string, create: () => SdkClient<T>, limit?: Limiter): Sender<T> {
    const known = this.#guarded.get(key);
    if (known !== undefined) return known as Sender<T>;
    const client = create();
    this.#cache.set(key, client);
    const wrapped = guarded(client, this.signal, limit);
    this.#guarded.set(key, wrapped);
    return wrapped;
  }

  iam(): Sender<IAMClient> {
    return this.#get('iam', () => this.factory.iam(), this.#iamLimit);
  }

  s3(region: string | null): Sender<S3Client> {
    const chosen = region !== null && isAwsRegion(region) ? region : this.homeRegion;
    return this.#get(`s3:${chosen}`, () => this.factory.s3(chosen));
  }

  ec2(region: string): Sender<EC2Client> {
    return this.#get(`ec2:${region}`, () => this.factory.ec2(region));
  }

  destroy(): void {
    for (const client of this.#cache.values()) client.destroy?.();
    this.#cache.clear();
    this.#guarded.clear();
  }
}

export interface AccountInventory {
  accountId: string;
  /** Início da coleta: a chave do retrato, junto com a conta. */
  collectedAt: string;
  regions: string[];
  root: RootAccount | null;
  users: IamUser[];
  instances: Ec2Instance[];
  securityGroups: SecurityGroupInfo[];
  buckets: BucketInfo[];
  /** Partes que passaram do teto de itens (`iam`, `s3`, `ec2:<região>`, `sg:<região>`). */
  truncated: string[];
  /** Partes que ficaram de fora, com o nome do erro da AWS. */
  errors: InventorySectionError[];
}

/** A coleta não pôde terminar: nada é gravado, e a tarefa tenta de novo mais tarde. O nome do erro é o código. */
export class InventoryUnavailable extends Error {
  constructor(readonly code: 'aws_unavailable' | 'inventory_refused') {
    super(`inventário da AWS: ${code}`);
    this.name = code;
  }
}

/**
 * Recusas da AWS: permissão negada (pela política do papel ou por uma SCP), região que não aceita a sessão (desligada,
 * opt-in) ou o serviço indisponível para a conta. Não passam sozinhas: a parte fica de fora e o resto segue.
 */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'UnauthorizedAccess',
  'AuthFailure',
  'OptInRequired',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'AllAccessDisabled',
  'Blocked',
]);

/** O nome do erro como vai para o retrato; fora do formato, `Unknown`. */
function sectionCode(error: unknown): string {
  const name = awsErrorName(error);
  return isInventoryErrorCode(name) ? name : 'Unknown';
}

/** As regiões monitoradas da conta, válidas e sem repetir, na ordem do cadastro. */
export function inventoryRegions(regions: readonly string[]): string[] {
  return [...new Set(regions.filter(isAwsRegion))].slice(0, 40);
}

export interface CollectOptions {
  now?: Date;
  signal?: AbortSignal;
}

export async function collectInventory(
  target: { accountId: string; regions: readonly string[] },
  clients: InventoryClients,
  { now = new Date(), signal }: CollectOptions = {},
): Promise<AccountInventory> {
  const inventory: AccountInventory = {
    accountId: target.accountId,
    collectedAt: now.toISOString(),
    regions: inventoryRegions(target.regions),
    root: null,
    users: [],
    instances: [],
    securityGroups: [],
    buckets: [],
    truncated: [],
    errors: [],
  };
  let collected = 0;

  async function section<T>(
    name: InventorySection,
    region: string | null,
    collect: () => Promise<T>,
  ): Promise<T | null> {
    try {
      const value = await collect();
      collected += 1;
      return value;
    } catch (error) {
      // A parada do worker ou o orçamento da tarefa: a coleta para aqui, com o motivo do sinal.
      signal?.throwIfAborted();
      // A sessão não renovou no meio da coleta: a conferência da conexão mostra o porquê.
      if (error instanceof AwsConnectionError) throw error;
      const code = sectionCode(error);
      if (!REFUSED_CODES.has(code) && isTransientAwsError(error))
        throw new InventoryUnavailable('aws_unavailable');
      inventory.errors.push({ section: name, region, code });
      return null;
    }
  }

  inventory.root = await section('root', null, () => collectRootAccount(clients.iam()));
  const iam = await section('iam', null, () => collectIamUsers(clients.iam()));
  if (iam !== null) {
    inventory.users = iam.users;
    if (iam.truncated) inventory.truncated.push('iam');
  }
  const s3 = await section('s3', null, () => collectBuckets((region) => clients.s3(region)));
  if (s3 !== null) {
    inventory.buckets = s3.buckets;
    if (s3.truncated) inventory.truncated.push('s3');
  }
  for (const region of inventory.regions) {
    const ec2 = clients.ec2(region);
    const instances = await section('ec2', region, () => collectInstances(ec2, region));
    if (instances !== null) {
      inventory.instances.push(...instances.instances);
      if (instances.truncated) inventory.truncated.push(`ec2:${region}`);
    }
    const groups = await section('sg', region, () => collectSecurityGroups(ec2, region));
    if (groups !== null) {
      inventory.securityGroups.push(...groups.groups);
      if (groups.truncated) inventory.truncated.push(`sg:${region}`);
    }
  }
  if (collected === 0) throw new InventoryUnavailable('inventory_refused');
  return inventory;
}

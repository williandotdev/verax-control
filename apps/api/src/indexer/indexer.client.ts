import { Client, type ClientOptions } from '@opensearch-project/opensearch';
import { z } from 'zod';
import { ALERTS_INDEX, assertStructuredQuery, type AlertSearch } from './alert-queries.js';
import type { IndexerConfig } from './indexer.config.js';
import type { IndexerSecrets } from './indexer-secrets.js';

export interface AlertHit {
  index: string;
  id: string;
  sort: unknown[];
  source: Record<string, unknown>;
}

const searchResponseSchema = z.object({
  timed_out: z.boolean(),
  _shards: z.object({ failed: z.number().int().min(0) }),
  hits: z.object({
    hits: z.array(
      z.object({
        _index: z.string(),
        _id: z.string(),
        _source: z.record(z.string(), z.unknown()),
        sort: z.array(z.unknown()).optional(),
      }),
    ),
  }),
});

/**
 * Erro do indexer sem nada da requisição: os erros do driver carregam a requisição (com o cabeçalho de autenticação),
 * e nada disso pode chegar a log nem a resposta.
 */
export class IndexerError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message);
    this.name = 'IndexerError';
  }
}

function statusOf(error: unknown): number | null {
  const status = (error as { meta?: { statusCode?: unknown } } | null)?.meta?.statusCode;
  return typeof status === 'number' ? status : null;
}

function describe(error: unknown): IndexerError {
  const status = statusOf(error);
  const name = (error as { name?: unknown } | null)?.name;
  if (status !== null) return new IndexerError(`o indexer respondeu ${status}`, status);
  if (name === 'TimeoutError') return new IndexerError('o indexer não respondeu no tempo limite');
  if (name === 'ConnectionError') return new IndexerError('falha de conexão ou de TLS com o indexer');
  return new IndexerError('falha ao consultar o indexer');
}

export type ClientFactory = (options: ClientOptions) => Pick<Client, 'search'>;

/**
 * Leitura dos alertas do Wazuh (T5.1). Só busca, só no padrão de alertas e só com consultas dos construtores
 * tipados; não há método de escrita. TLS validado contra a CA do Wazuh, timeout curto e credencial do usuário só
 * leitura, renovada uma vez se o indexer recusar (senha rotacionada).
 */
export class IndexerClient {
  private client: Pick<Client, 'search'> | null = null;

  constructor(
    private readonly config: IndexerConfig,
    private readonly secrets: IndexerSecrets,
    private readonly createClient: ClientFactory = (options) => new Client(options),
  ) {}

  async search(request: AlertSearch): Promise<AlertHit[]> {
    if (request.index !== ALERTS_INDEX) {
      throw new IndexerError('índice não permitido');
    }
    assertStructuredQuery(request.body);
    const body = await this.withRenewal(async (client) => {
      const response = await client.search({
        index: request.index,
        body: request.body,
        // Por padrão o OpenSearch responde 200 com o que conseguiu quando um shard falha ou o tempo estoura. Na
        // leitura incremental, avançar o cursor sobre uma página incompleta perderia alertas para sempre.
        allow_partial_search_results: false,
      });
      return response.body as unknown;
    });
    const parsed = searchResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new IndexerError('resposta do indexer fora do formato esperado');
    }
    if (parsed.data.timed_out || parsed.data._shards.failed > 0) {
      throw new IndexerError('o indexer devolveu uma resposta incompleta');
    }
    return parsed.data.hits.hits.map((hit) => ({
      index: hit._index,
      id: hit._id,
      sort: hit.sort ?? [],
      source: hit._source,
    }));
  }

  private async withRenewal<T>(call: (client: Pick<Client, 'search'>) => Promise<T>): Promise<T> {
    try {
      return await call(await this.connect(false));
    } catch (error) {
      if (statusOf(error) !== 401) throw describe(error);
    }
    try {
      return await call(await this.connect(true));
    } catch (error) {
      throw describe(error);
    }
  }

  private async connect(refresh: boolean): Promise<Pick<Client, 'search'>> {
    if (this.client !== null && !refresh) {
      return this.client;
    }
    const [credentials, ca] = await Promise.all([
      this.secrets.credentials(refresh),
      this.secrets.certificateAuthority(),
    ]);
    this.client = this.createClient({
      node: this.config.INDEXER_URL,
      auth: credentials,
      ssl: { ca, rejectUnauthorized: true },
      requestTimeout: this.config.INDEXER_TIMEOUT_MS,
      maxRetries: 1,
      sniffOnStart: false,
      sniffOnConnectionFault: false,
    });
    return this.client;
  }
}

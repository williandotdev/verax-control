import { z } from 'zod';
import { registerLiveSecret } from '../common/logger/sanitize.js';

/**
 * Contrato com o bootstrap do nó do cliente (CP-10): o que a VM grava no segredo `vx-<slug>-admin-bootstrap`, no
 * projeto dos nós, e o cp-worker lê uma vez na revelação (plano §4c, passos 9 e 10).
 *
 * - Cada versão é um JSON UTF-8 com exatamente três campos: `email` (o login do primeiro `admin_cliente`), `password`
 *   (a senha temporária, 16 a 256 caracteres; troca e MFA no primeiro login) e `expiresAt` (até quando a senha vale,
 *   ISO 8601 com fuso, como `2026-11-07T12:00:00.000Z`). Exemplo de forma, sem valor real:
 *   `{"email":"admin@cliente-demo-a.example","password":"<senha temporária>","expiresAt":"<ISO 8601>"}`.
 * - O cp-worker lê a versão `latest` (a habilitada mais recente). O segredo guarda só o admin do cliente: a senha de
 *   outra conta (a de suporte `admin_verax`, que o plano do CP-10 pensava pôr na versão 2) vai para outro segredo,
 *   senão a `latest` mostraria a senha do suporte ao cliente. Uma senha renovada (plano §10, item 7) é uma versão nova.
 * - Depois da revelação, o passo `secrets.destroy_bootstrap` destrói todas as versões (`versions.destroy`,
 *   permanente). Formato diferente é recusado sem mostrar nada e sem consumir a revelação.
 */
export const bootstrapCredentialsSchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(16).max(256),
  expiresAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
});

export interface BootstrapCredentials {
  email: string;
  password: string;
  expiresAt: Date;
}

/** Nome do segredo do tenant no projeto dos nós (o mesmo do módulo `node`, `infra/gcp/modules/node/secrets.tf`). */
export function bootstrapSecretName(projectId: string, slug: string): string {
  return `projects/${projectId}/secrets/vx-${slug}-admin-bootstrap`;
}

/** Não há o que revelar: segredo ou versão inexistente, destruída, sem permissão ou fora do contrato. */
export class BootstrapUnavailableError extends Error {
  constructor(readonly reason: 'not_found' | 'invalid_format' | 'permission_denied') {
    super(`senha inicial indisponível: ${reason}`);
    this.name = 'BootstrapUnavailableError';
  }
}

/**
 * O cofre da senha inicial do tenant, atrás de uma interface (o Secret Manager em produção, um dublê em memória nos
 * testes). Só o cp-worker o usa: é a conta dele que recebe, por tenant, `secretAccessor` e `secretVersionManager`
 * nesse segredo (envs/tenant, CP-06).
 */
export interface BootstrapSecrets {
  /**
   * A versão `latest`, conferida pelo contrato. A senha entra na máscara do logger antes de qualquer `await` de quem
   * chamou (`registerLiveSecret`). Erro transitório do Secret Manager é repassado como está (quem chamou desfaz a
   * marcação da revelação e o cliente tenta de novo).
   */
  readLatest(slug: string): Promise<BootstrapCredentials>;
  /** Destrói toda versão ainda não destruída. Idempotente: sem segredo ou sem versão viva, devolve 0. */
  destroyAll(slug: string): Promise<number>;
}

export const BOOTSTRAP_SECRETS = Symbol('BOOTSTRAP_SECRETS');

/**
 * Lê o conteúdo de uma versão pelo contrato. A senha é registrada na máscara antes de qualquer outra coisa; o texto
 * bruto e o erro do `JSON.parse` (que repete trechos da entrada) nunca saem daqui.
 */
export function parseBootstrapPayload(payload: Uint8Array | string): BootstrapCredentials {
  const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BootstrapUnavailableError('invalid_format');
  }
  const candidate = (parsed as { password?: unknown } | null)?.password;
  if (typeof candidate === 'string') registerLiveSecret(candidate);
  const result = bootstrapCredentialsSchema.safeParse(parsed);
  if (!result.success || Number.isNaN(result.data.expiresAt.getTime())) {
    throw new BootstrapUnavailableError('invalid_format');
  }
  return result.data;
}

/** Códigos gRPC que o Secret Manager devolve e que não mudam numa nova tentativa. */
const GRPC_PERMISSION_DENIED = 7;
const GRPC_NOT_FOUND = 5;
const GRPC_FAILED_PRECONDITION = 9;

function grpcCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

/** O pouco do cliente do Secret Manager que o cofre usa (o SDK em produção; um dublê no teste da montagem). */
export interface SecretManagerApi {
  accessLatest(name: string): Promise<Uint8Array | string | null | undefined>;
  listVersions(secret: string): Promise<{ name: string; state: string }[]>;
  destroyVersion(name: string): Promise<void>;
}

/** `SecretVersion.State` chega como texto (`DESTROYED`) ou, conforme a opção do gRPC, como o número do enum. */
const VERSION_STATES: Readonly<Record<string, string>> = {
  '0': 'STATE_UNSPECIFIED',
  '1': 'ENABLED',
  '2': 'DISABLED',
  '3': 'DESTROYED',
};

export function versionStateName(state: unknown): string {
  const text = typeof state === 'string' || typeof state === 'number' ? String(state) : '';
  return VERSION_STATES[text] ?? text;
}

/** O SDK oficial, carregado só na primeira revelação (gRPC e protos pesam na partida, como no Cloud Tasks). */
export async function loadSecretManagerApi(): Promise<SecretManagerApi> {
  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
  const client = new SecretManagerServiceClient();
  return {
    async accessLatest(name) {
      const [version] = await client.accessSecretVersion({ name: `${name}/versions/latest` });
      return version.payload?.data;
    },
    async listVersions(secret) {
      const [versions] = await client.listSecretVersions({ parent: secret });
      return versions.map((version) => ({
        name: version.name ?? '',
        state: versionStateName(version.state),
      }));
    },
    async destroyVersion(name) {
      await client.destroySecretVersion({ name });
    },
  };
}

/** O cofre no Secret Manager do projeto dos nós (`NODES_PROJECT_ID`), com a identidade do cp-worker. */
export class SecretManagerBootstrapSecrets implements BootstrapSecrets {
  private api: Promise<SecretManagerApi> | undefined;

  constructor(
    private readonly projectId: string,
    private readonly load: () => Promise<SecretManagerApi> = loadSecretManagerApi,
  ) {}

  async readLatest(slug: string): Promise<BootstrapCredentials> {
    const api = await this.client();
    let payload: Uint8Array | string | null | undefined;
    try {
      payload = await api.accessLatest(bootstrapSecretName(this.projectId, slug));
    } catch (error) {
      const code = grpcCode(error);
      if (code === GRPC_NOT_FOUND || code === GRPC_FAILED_PRECONDITION) {
        throw new BootstrapUnavailableError('not_found');
      }
      if (code === GRPC_PERMISSION_DENIED) throw new BootstrapUnavailableError('permission_denied');
      throw error;
    }
    if (payload === null || payload === undefined) throw new BootstrapUnavailableError('not_found');
    return parseBootstrapPayload(payload);
  }

  async destroyAll(slug: string): Promise<number> {
    const api = await this.client();
    const secret = bootstrapSecretName(this.projectId, slug);
    let versions: { name: string; state: string }[];
    try {
      versions = await api.listVersions(secret);
    } catch (error) {
      if (grpcCode(error) === GRPC_NOT_FOUND) return 0;
      throw error;
    }
    let destroyed = 0;
    for (const version of versions) {
      if (version.state === 'DESTROYED' || !version.name.startsWith(`${secret}/versions/`)) continue;
      try {
        await api.destroyVersion(version.name);
        destroyed += 1;
      } catch (error) {
        // Destruída entre a listagem e agora (outra execução do passo): o que se queria já aconteceu.
        const code = grpcCode(error);
        if (code !== GRPC_NOT_FOUND && code !== GRPC_FAILED_PRECONDITION) throw error;
      }
    }
    return destroyed;
  }

  private async client(): Promise<SecretManagerApi> {
    this.api ??= this.load();
    try {
      return await this.api;
    } catch (error) {
      // Um carregamento que falhou não fica guardado: a próxima chamada tenta de novo.
      this.api = undefined;
      throw error;
    }
  }
}

/** Sem `NODES_PROJECT_ID` não há onde ler: a revelação responde 503 sem marcar nada. */
export class UnconfiguredBootstrapSecrets implements BootstrapSecrets {
  readLatest(_slug: string): Promise<never> {
    return Promise.reject(new BootstrapUnavailableError('not_found'));
  }

  destroyAll(_slug: string): Promise<never> {
    return Promise.reject(new Error('cofre da senha inicial sem configuração: NODES_PROJECT_ID'));
  }
}

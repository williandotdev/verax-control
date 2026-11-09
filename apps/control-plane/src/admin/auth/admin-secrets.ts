import { loadSecretManagerApi, type SecretManagerApi } from '../../access/bootstrap-secrets.js';

/**
 * Os dois cofres do login do console no Secret Manager do projeto do plano de controle (`ADMIN_SECRETS_PROJECT_ID`),
 * lidos pela API com a identidade do cp-admin (`secretAccessor` só neles, secrets.tf), na versão `latest`. Não são
 * montados como variável: o serviço sobe com os cofres vazios (o login e o cadastro respondem 503 até o responsável
 * gravar) e a versão do token de cadastro pode ser desativada ou destruída depois do uso sem derrubar revisões novas.
 *
 * - `cp-admin-totp-key`: a chave mestra (`admin-crypto.ts`). Lida uma vez e guardada na memória do processo;
 * - `cp-admin-setup-token`: o token de uso único do primeiro cadastro (`/configurar`). Lido a cada tentativa de
 *   cadastro (raras, e limitadas por IP), para uma versão nova ou desativada valer na hora.
 *
 * O conteúdo nunca vai a log nem a erro: uma falha da API vira só `undefined` ou `SecretUnavailableError`.
 */
export const TOTP_KEY_SECRET = 'cp-admin-totp-key';
export const SETUP_TOKEN_SECRET = 'cp-admin-setup-token';

export const ADMIN_SECRETS = Symbol('ADMIN_SECRETS');

export interface AdminSecretSource {
  /** O conteúdo do cofre da chave mestra; `undefined` sem versão habilitada. */
  totpKey(): Promise<string | undefined>;
  /** O conteúdo do cofre do token de cadastro; `undefined` sem versão habilitada. */
  setupToken(): Promise<string | undefined>;
}

/** A API do Secret Manager falhou (rede, permissão): o console responde 503, sem detalhe. */
export class SecretUnavailableError extends Error {
  constructor() {
    super('cofre do console indisponível');
    this.name = 'SecretUnavailableError';
  }
}

const GRPC_NOT_FOUND = 5;
const GRPC_FAILED_PRECONDITION = 9;

function grpcCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

function asText(payload: Uint8Array | string | null | undefined): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  const text = typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8');
  // Uma quebra de linha no fim (o `echo` de quem gravou) não faz parte do valor.
  const trimmed = text.replace(/\r?\n$/, '');
  return trimmed === '' ? undefined : trimmed;
}

export class SecretManagerAdminSecrets implements AdminSecretSource {
  private api: Promise<SecretManagerApi> | undefined;

  constructor(
    private readonly projectId: string,
    private readonly load: () => Promise<SecretManagerApi> = loadSecretManagerApi,
  ) {}

  totpKey(): Promise<string | undefined> {
    return this.read(TOTP_KEY_SECRET);
  }

  setupToken(): Promise<string | undefined> {
    return this.read(SETUP_TOKEN_SECRET);
  }

  private async read(secretId: string): Promise<string | undefined> {
    this.api ??= this.load();
    let api: SecretManagerApi;
    try {
      api = await this.api;
    } catch {
      this.api = undefined;
      throw new SecretUnavailableError();
    }
    try {
      return asText(await api.accessLatest(`projects/${this.projectId}/secrets/${secretId}`));
    } catch (error) {
      const code = grpcCode(error);
      // Sem versão nenhuma, ou a última desativada ou destruída: o cofre está "vazio".
      if (code === GRPC_NOT_FOUND || code === GRPC_FAILED_PRECONDITION) return undefined;
      throw new SecretUnavailableError();
    }
  }
}

import { isPubsubSubscriptionName } from '@verax/shared';
import { z } from 'zod';
import {
  type CheckedCredential,
  CredentialRejected,
  CredentialSourceUnavailable,
} from '../credentials/credential-check.js';
import type { GcpServiceAccountKey } from '../credentials/credential-vault.js';
import { GOOGLE_TOKEN_URL, GoogleTokenError, ServiceAccountTokenProvider } from './service-account-token.js';

/** O Pub/Sub oficial; só os testes apontam para um servidor falso em 127.0.0.1. */
export const PUBSUB_API_BASE_URL = 'https://pubsub.googleapis.com/v1';
/** Orçamento de cada chamada da conferência (o token e a permissão), dentro da requisição de quem colou. */
export const GCP_KEY_CHECK_TIMEOUT_MS = 5_000;
/** A permissão que a coleta usa na assinatura: ler e confirmar as mensagens (`roles/pubsub.subscriber`). */
export const PUBSUB_CONSUME_PERMISSION = 'pubsub.subscriptions.consume';

const permissionsResponseSchema = z.object({ permissions: z.array(z.string().max(128)).max(16).optional() });

export interface GcpKeyCheckOptions {
  /** Só para os testes (servidores falsos em 127.0.0.1); fora deles, os endereços oficiais. */
  tokenUrl?: string;
  pubsubBaseUrl?: string;
  timeoutMs?: number;
}

function isAllowedPubsubUrl(url: string): boolean {
  if (url === PUBSUB_API_BASE_URL) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Conferência da chave da conta de serviço colada no painel (VM própria do cliente), na memória da API, antes de
 * cifrar:
 * 1. o token do Google com a chave (o JWT assinado, trocado no `oauth2.googleapis.com`): uma chave apagada ou
 *    desativada, ou de uma conta de serviço apagada, é recusada aqui (`invalid`);
 * 2. o `testIamPermissions` na assinatura cadastrada na conta: a conta de serviço precisa de
 *    `pubsub.subscriptions.consume` nela (o `roles/pubsub.subscriber`), senão `no_account_access`. A chamada não lê
 *    nem confirma mensagem nenhuma, e não exige permissão própria: só diz quais das pedidas a conta tem.
 *
 * Cada chamada em até 5 s. A chave privada só assina o JWT; nada da resposta vai para o log, só códigos.
 */
export class GcpServiceAccountKeyCheck {
  readonly #tokenUrl: string;
  readonly #pubsubBaseUrl: string;
  readonly #timeoutMs: number;

  constructor({
    tokenUrl = GOOGLE_TOKEN_URL,
    pubsubBaseUrl = PUBSUB_API_BASE_URL,
    timeoutMs = GCP_KEY_CHECK_TIMEOUT_MS,
  }: GcpKeyCheckOptions = {}) {
    if (!isAllowedPubsubUrl(pubsubBaseUrl)) throw new Error('endereço do Pub/Sub fora da lista');
    this.#tokenUrl = tokenUrl;
    this.#pubsubBaseUrl = pubsubBaseUrl;
    this.#timeoutMs = timeoutMs;
  }

  async check(key: GcpServiceAccountKey, subscription: string): Promise<CheckedCredential> {
    // O nome vem do cadastro da conta, já validado; a conferência de novo impede montar outra URL com ele.
    if (!isPubsubSubscriptionName(subscription)) throw new CredentialRejected('no_account_access');
    const tokens = new ServiceAccountTokenProvider(key, { url: this.#tokenUrl, timeoutMs: this.#timeoutMs });
    let token: string;
    try {
      token = await tokens.token();
    } catch (error) {
      if (!(error instanceof GoogleTokenError)) throw error;
      if (error.rejected) throw new CredentialRejected('invalid', error.status);
      throw new CredentialSourceUnavailable(error.code);
    }
    try {
      await this.#assertConsume(token, subscription);
    } finally {
      tokens.release();
    }
    return { keyIdSuffix: key.privateKeyId.slice(-4), issuedAt: null, expiresAt: null };
  }

  async #assertConsume(token: string, subscription: string): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#pubsubBaseUrl}/${subscription}:testIamPermissions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: [PUBSUB_CONSUME_PERMISSION] }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      throw new CredentialSourceUnavailable(name === 'TimeoutError' ? 'timeout' : 'network');
    }
    // Assinatura que não existe, ou que a conta de serviço nem enxerga: a chave não lê o que a conta cadastrou.
    if (response.status === 403 || response.status === 404) {
      throw new CredentialRejected('no_account_access', response.status);
    }
    if (response.status === 401) throw new CredentialRejected('invalid', response.status);
    if (!response.ok) throw new CredentialSourceUnavailable(`http_${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CredentialSourceUnavailable('bad_response');
    }
    const parsed = permissionsResponseSchema.safeParse(body);
    if (!parsed.success) throw new CredentialSourceUnavailable('bad_response');
    if (!(parsed.data.permissions ?? []).includes(PUBSUB_CONSUME_PERMISSION)) {
      throw new CredentialRejected('no_account_access', response.status);
    }
  }
}

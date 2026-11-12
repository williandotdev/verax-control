import { isPubsubSubscriptionName } from '@verax/shared';
import { z } from 'zod';

/**
 * Leitura de uma assinatura do Pub/Sub pela API REST, sem biblioteca do Google e sem chave: o token vem da identidade
 * da própria VM (servidor de metadados da GCP), que só tem `roles/pubsub.subscriber` nas assinaturas do nó.
 */

export interface PubsubMessage {
  ackId: string;
  /** LogEntry em JSON, em base64. */
  data: string | undefined;
  messageId: string;
  /** Quando o Pub/Sub recebeu a mensagem (RFC 3339): o dia do volume da franquia (CE-09). */
  publishTime?: string | undefined;
}

export interface PubsubReader {
  pull(subscription: string, maxMessages: number): Promise<PubsubMessage[]>;
  acknowledge(subscription: string, ackIds: readonly string[]): Promise<void>;
}

export interface AccessTokenProvider {
  token(): Promise<string>;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z.number().int().min(0),
});

const pullResponseSchema = z.object({
  receivedMessages: z
    .array(
      z.object({
        ackId: z.string().min(1).max(1024),
        message: z.object({
          data: z.string().max(10_000_000).optional(),
          messageId: z.string().max(256),
          publishTime: z.string().max(64).optional(),
        }),
      }),
    )
    .max(1000)
    .optional(),
});

const TIMEOUT_MS = 30_000;
/** O token da VM vale cerca de uma hora: renova com folga, um minuto antes de vencer. */
const TOKEN_MARGIN_MS = 60_000;

/** Token da conta de serviço da VM, pelo servidor de metadados (só existe dentro da GCP). */
export class MetadataTokenProvider implements AccessTokenProvider {
  private cached: { value: string; until: number } | null = null;

  constructor(
    private readonly url = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
  ) {}

  async token(): Promise<string> {
    if (this.cached && Date.now() < this.cached.until) return this.cached.value;
    const response = await fetch(this.url, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`servidor de metadados respondeu ${response.status}`);
    const body = tokenResponseSchema.parse(await response.json());
    this.cached = {
      value: body.access_token,
      until: Date.now() + Math.max(0, body.expires_in * 1000 - TOKEN_MARGIN_MS),
    };
    return body.access_token;
  }
}

export class PubsubRestReader implements PubsubReader {
  constructor(
    private readonly tokens: AccessTokenProvider,
    private readonly baseUrl = 'https://pubsub.googleapis.com/v1',
  ) {}

  private async call(subscription: string, action: 'pull' | 'acknowledge', body: object): Promise<unknown> {
    // O nome vem do cadastro da conta, já validado; a conferência de novo impede montar outra URL com ele.
    if (!isPubsubSubscriptionName(subscription)) throw new Error('assinatura do Pub/Sub em formato inválido');
    const response = await fetch(`${this.baseUrl}/${subscription}:${action}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.tokens.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Só o código: a resposta de erro do Google pode citar recursos, e não vai para o log.
    if (!response.ok) throw new Error(`Pub/Sub ${action} respondeu ${response.status}`);
    return response.json();
  }

  async pull(subscription: string, maxMessages: number): Promise<PubsubMessage[]> {
    const body = pullResponseSchema.parse(await this.call(subscription, 'pull', { maxMessages }));
    return (body.receivedMessages ?? []).map((received) => ({
      ackId: received.ackId,
      data: received.message.data,
      messageId: received.message.messageId,
      publishTime: received.message.publishTime,
    }));
  }

  async acknowledge(subscription: string, ackIds: readonly string[]): Promise<void> {
    if (ackIds.length === 0) return;
    await this.call(subscription, 'acknowledge', { ackIds });
  }
}

import { isPubsubTopicName } from '@verax/shared';
import { z } from 'zod';
import {
  type AccessTokenSource,
  bearer,
  cloudRequest,
  expectOk,
  invalidResponse,
  jsonOf,
} from '../provisioning/cloud-http.js';

/** O endereço da API do Pub/Sub. Nos testes, um servidor falso em 127.0.0.1 (nunca pelo ambiente: o token vai junto). */
export const PUBSUB_ENDPOINT = 'https://pubsub.googleapis.com/v1';

/** Uma mensagem de comando: o JSON do contrato em base64, a chave de ordenação (o cliente) e atributos sem dado. */
export interface CellPubsubMessage {
  data: string;
  orderingKey: string;
  attributes: Readonly<Record<string, string>>;
}

/** A publicação de um comando no tópico de comandos de uma célula. */
export interface CellCommandSink {
  publish(topic: string, message: CellPubsubMessage): Promise<string>;
}

export const CELL_COMMAND_SINK = Symbol('CELL_COMMAND_SINK');

const publishResponseSchema = z.object({ messageIds: z.array(z.string().min(1).max(256)).length(1) });

/**
 * `topics.publish` pela API REST com o token do cp-worker (`roles/pubsub.publisher` só no tópico de comandos de cada
 * célula, concedido pelo ambiente da célula). O erro diz só o status e o código curto, nunca a mensagem.
 */
export class PubsubCommandSink implements CellCommandSink {
  constructor(
    private readonly tokens: AccessTokenSource,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly base: string = PUBSUB_ENDPOINT,
  ) {}

  async publish(topic: string, message: CellPubsubMessage): Promise<string> {
    if (!isPubsubTopicName(topic)) throw new TypeError('tópico do Pub/Sub inválido');
    const response = await cloudRequest(this.fetchFn, 'pubsub', 'publish', {
      method: 'POST',
      url: `${this.base}/${topic}:publish`,
      authorization: await bearer(this.tokens),
      json: { messages: [message] },
    });
    const parsed = publishResponseSchema.safeParse(
      jsonOf('pubsub', 'publish', expectOk('pubsub', 'publish', response)),
    );
    if (!parsed.success) throw invalidResponse('pubsub', 'publish');
    return parsed.data.messageIds[0] as string;
  }
}

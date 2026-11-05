/**
 * Clientes falsos da AWS para os testes do inventário: cada comando é atendido pelo handler com o nome da classe
 * dele (ex.: `ListUsersCommand`), e toda chamada fica registrada. Nada sai para a rede.
 */

type Handler = (input: Record<string, unknown>) => unknown;

export interface FakeClient<T extends { send: unknown }> {
  client: Pick<T, 'send'>;
  calls: { command: string; input: Record<string, unknown> }[];
}

export function fakeClient<T extends { send: unknown }>(handlers: Record<string, Handler>): FakeClient<T> {
  const calls: FakeClient<T>['calls'] = [];
  const send = (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name;
    calls.push({ command: name, input: command.input });
    const handler = handlers[name];
    if (handler === undefined) return Promise.reject(awsError('NotSimulated'));
    try {
      return Promise.resolve(handler(command.input));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  };
  return { client: { send }, calls };
}

/**
 * Erro como os do SDK: o nome é o código da AWS, a resposta tem o código HTTP (`$metadata`, que separa a recusa da
 * falha passageira) e a mensagem traz detalhes que não podem vazar.
 */
export function awsError(name: string, status = 400): Error {
  const error = Object.assign(
    new Error(`${name}: User arn:aws:iam::111122223333:role/x is not authorized (detalhe-interno)`),
    { $metadata: { httpStatusCode: status } },
  );
  error.name = name;
  return error;
}

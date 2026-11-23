import { DescribeTrailsCommand } from '@aws-sdk/client-cloudtrail';
import { DescribeFlowLogsCommand } from '@aws-sdk/client-ec2';
import { describe, expect, it, vi } from 'vitest';
import { DiscoveryRunClients } from './clients.js';
import { discoveryErrorCode } from './discovery.js';

type Send = (command: unknown, options: { abortSignal: AbortSignal }) => Promise<unknown>;

/** Os clientes de uma execução sobre um `send` falso, igual para todo serviço. */
function clientsOver(send: Send, options: { callTimeoutMs?: number; concurrency?: number } = {}) {
  const created: string[] = [];
  const destroyed: string[] = [];
  const service = (name: string) => (region?: string) => {
    const key = region === undefined ? name : `${name}:${region}`;
    created.push(key);
    return { send, destroy: () => destroyed.push(key) };
  };
  const factory = {
    ec2: service('ec2'),
    cloudtrail: service('cloudtrail'),
    s3: service('s3'),
    iam: service('iam'),
  };
  const controller = new AbortController();
  const clients = new DiscoveryRunClients(factory as never, 'sa-east-1', controller.signal, options);
  return { clients, created, destroyed, controller };
}

const call = (client: { send: unknown }, command: unknown) =>
  (client.send as (command: unknown) => Promise<unknown>)(command);

describe('clientes de uma execução da descoberta', () => {
  it('um cliente por serviço e região, criado sob demanda e fechado no fim', async () => {
    const send = vi.fn<Send>(() => Promise.resolve({}));
    const { clients, created, destroyed } = clientsOver(send);
    await call(clients.ec2('sa-east-1'), new DescribeFlowLogsCommand({}));
    await call(clients.ec2('sa-east-1'), new DescribeFlowLogsCommand({}));
    await call(clients.ec2('us-east-1'), new DescribeFlowLogsCommand({}));
    await call(clients.cloudtrail('sa-east-1'), new DescribeTrailsCommand({}));
    // O S3 sem região (ou com uma fora do formato) usa a de partida; o IAM é um só.
    clients.s3(null);
    clients.s3('regiao invalida');
    clients.s3('us-east-1');
    clients.iam();
    clients.iam();
    expect(created).toEqual([
      'ec2:sa-east-1',
      'ec2:us-east-1',
      'cloudtrail:sa-east-1',
      's3:sa-east-1',
      's3:us-east-1',
      'iam',
    ]);
    expect(send).toHaveBeenCalledTimes(4);
    clients.destroy();
    expect(destroyed.sort()).toEqual([...created].sort());
  });

  it('cada chamada tem um tempo máximo: a que não responde é cancelada e sai como TimeoutError', async () => {
    // O cliente falso só termina quando o sinal da chamada é abortado, como o SDK.
    const send: Send = (_command, { abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener('abort', () => {
          const error = new Error('Request aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const { clients, controller } = clientsOver(send, { callTimeoutMs: 20 });
    const started = Date.now();
    const failure = await call(clients.ec2('sa-east-1'), new DescribeFlowLogsCommand({})).catch(
      (error: unknown) => error,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    // A execução continua (o sinal dela não foi abortado), e a leitura fica registrada com o nome do tempo esgotado.
    expect(controller.signal.aborted).toBe(false);
    expect(discoveryErrorCode(failure)).toBe('TimeoutError');
  });

  it('no máximo N chamadas ao mesmo tempo, somados todos os serviços e regiões', async () => {
    let running = 0;
    let peak = 0;
    const send: Send = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return {};
    };
    const { clients } = clientsOver(send, { concurrency: 3 });
    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        index % 2 === 0
          ? call(clients.ec2(index % 4 === 0 ? 'sa-east-1' : 'us-east-1'), new DescribeFlowLogsCommand({}))
          : call(clients.cloudtrail('sa-east-1'), new DescribeTrailsCommand({})),
      ),
    );
    expect(peak).toBe(3);
  });

  it('o código do erro que vai para o registro: só o nome, limpo; a mensagem nunca', () => {
    const named = (name: string, message = 'User arn:aws:iam::111111111111:role/x is not authorized') => {
      const error = new Error(message);
      error.name = name;
      return error;
    };
    expect(discoveryErrorCode(named('AccessDeniedException'))).toBe('AccessDeniedException');
    expect(discoveryErrorCode(named('AbortError'))).toBe('TimeoutError');
    expect(discoveryErrorCode(named('TimeoutError'))).toBe('TimeoutError');
    expect(discoveryErrorCode(named('Erro com espaço e "aspas"'))).toBe('Errocomespaoeaspas');
    expect(discoveryErrorCode(named('x'.repeat(200)))).toHaveLength(64);
    expect(discoveryErrorCode(named(''))).toBe('Unknown');
    expect(discoveryErrorCode('texto solto')).toBe('Unknown');
    expect(discoveryErrorCode(null)).toBe('Unknown');
  });
});

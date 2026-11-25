import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { DiscoveryClientFactory } from '../../src/aws/discovery/clients.js';
import { commandName } from '../../src/aws/discovery/read-only.js';
import { albLine, type LineSpec, objectKey, SLOT } from './alb-lines.js';

/**
 * O S3 falso dos testes da tarefa `web-logs`: em processo, com o corpo em pedaços, a listagem do S3 (prefixo, `StartAfter`,
 * páginas) e falhas programadas. Toda chamada fica anotada, para os testes conferirem o que saiu para a AWS.
 */

export const awsFault = (name: string, status = 400): Error =>
  Object.assign(new Error('mensagem da AWS que não pode aparecer'), {
    name,
    $metadata: { httpStatusCode: status },
  });

export interface S3Call {
  command: string;
  bucket: string;
  /** A chave, ou o prefixo da listagem. */
  key: string;
  range: string | null;
  startAfter: string | null;
  region: string;
}

/** O que acontece com uma leitura. */
export interface GetFault {
  /** A chamada falha. */
  error?: Error;
  /** O corpo é cortado depois destes bytes, com erro de rede (ou só acaba, com `quiet`). */
  cutAt?: number;
  quiet?: boolean;
  /** O corpo para de vir depois destes bytes. */
  stallAt?: number;
}

const CHUNK = 16 * 1024;

export class FakeAlbS3 {
  readonly calls: S3Call[] = [];
  /** Conteúdo por `bucket/chave`. */
  private readonly objects = new Map<string, { body: Buffer; size: number }>();
  /** Objetos por página. */
  pageSize = 1_000;
  onList: (call: S3Call) => Error | Promise<Error | undefined> | undefined = () => undefined;
  onGet: (call: S3Call) => GetFault | Promise<GetFault | undefined> | undefined = () => undefined;
  /** Corpos abertos e ainda não fechados. */
  open = 0;

  put(bucket: string, key: string, body: Buffer, size = body.length): string {
    this.objects.set(`${bucket}/${key}`, { body, size });
    return key;
  }

  remove(bucket: string, key: string): void {
    this.objects.delete(`${bucket}/${key}`);
  }

  get gets(): S3Call[] {
    return this.calls.filter((call) => call.command === 'GetObjectCommand' && call.range === null);
  }

  get lists(): S3Call[] {
    return this.calls.filter((call) => call.command === 'ListObjectsV2Command');
  }

  get tails(): S3Call[] {
    return this.calls.filter((call) => call.range !== null);
  }

  readonly factory: DiscoveryClientFactory = () => {
    const refuse = (): never => {
      throw new Error('serviço que a leitura dos logs do ALB não usa');
    };
    return {
      ec2: refuse,
      cloudtrail: refuse,
      guardduty: refuse,
      iam: refuse,
      logs: refuse,
      wafv2: refuse,
      securityhub: refuse,
      inspector2: refuse,
      accessanalyzer: refuse,
      rds: refuse,
      elbv2: refuse,
      config: refuse,
      s3: (region) => {
        const send = (command: unknown, options: unknown): Promise<unknown> =>
          this.send(command, region, (options as { abortSignal?: AbortSignal }).abortSignal);
        return { send };
      },
    };
  };

  private async send(command: unknown, region: string, signal: AbortSignal | undefined): Promise<unknown> {
    signal?.throwIfAborted();
    const { input } = command as { input: Record<string, unknown> };
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    const call: S3Call = {
      command: commandName(command),
      bucket: text(input['Bucket']) ?? '',
      key: text(input['Key']) ?? text(input['Prefix']) ?? '',
      range: text(input['Range']),
      startAfter: text(input['StartAfter']),
      region,
    };
    this.calls.push(call);
    // A AWS de verdade responde em outro turno do laço de eventos.
    await new Promise((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
    if (call.command === 'ListObjectsV2Command') return this.list(call, Number(input['MaxKeys'] ?? 1_000));
    if (call.command === 'GetObjectCommand') return this.get(call, signal);
    throw new Error(`comando inesperado: ${call.command}`);
  }

  private async list(call: S3Call, maxKeys: number): Promise<unknown> {
    const fault = await this.onList(call);
    if (fault !== undefined) throw fault;
    const head = `${call.bucket}/`;
    const keys = [...this.objects]
      .filter(([id]) => id.startsWith(`${head}${call.key}`))
      .map(([id, { size }]) => ({ Key: id.slice(head.length), Size: size, LastModified: new Date() }))
      .filter(({ Key }) => call.startAfter === null || Key > call.startAfter)
      .sort((a, b) => (a.Key < b.Key ? -1 : 1));
    const page = Math.min(maxKeys, this.pageSize);
    return { Contents: keys.slice(0, page), IsTruncated: keys.length > page, KeyCount: keys.length };
  }

  private async get(call: S3Call, signal: AbortSignal | undefined): Promise<unknown> {
    const fault = await this.onGet(call);
    if (fault?.error !== undefined) throw fault.error;
    const stored = this.objects.get(`${call.bucket}/${call.key}`);
    if (stored === undefined) throw awsFault('NoSuchKey', 404);
    if (call.range !== null) {
      const bytes = new Uint8Array(stored.body.subarray(-4));
      return { Body: { transformToByteArray: () => Promise.resolve(bytes) } };
    }
    return { Body: this.bodyOf(stored.body, fault ?? {}, signal), ContentLength: stored.size };
  }

  private bodyOf(body: Buffer, fault: GetFault, signal: AbortSignal | undefined): Readable {
    const stop = fault.cutAt ?? fault.stallAt ?? body.length;
    let at = 0;
    this.open += 1;
    const stream = new Readable({
      read() {
        const end = Math.min(at + CHUNK, stop);
        if (at < end) {
          const chunk = body.subarray(at, end);
          at = end;
          this.push(chunk);
          return;
        }
        if (fault.stallAt !== undefined) return;
        if (fault.cutAt !== undefined && fault.quiet !== true) {
          this.destroy(Object.assign(new Error('aborted'), { name: 'Error', code: 'ECONNRESET' }));
          return;
        }
        this.push(null);
      },
    });
    stream.once('close', () => {
      this.open -= 1;
    });
    // Como no SDK: o sinal da chamada derruba o corpo que ainda está vindo.
    signal?.addEventListener('abort', () => stream.destroy(new Error('aborted')), { once: true });
    return stream;
  }
}

export const gzipLines = (lines: readonly string[]): Buffer =>
  gzipSync(Buffer.from(lines.map((line) => `${line}\n`).join(''), 'latin1'));

/** As linhas de um arquivo: o horário padrão é um minuto antes do fim do intervalo. */
export const linesOf = (endMs: number, specs: readonly LineSpec[]): string[] =>
  specs.map((spec) => albLine({ time: endMs - 60_000, ...spec }));

export interface Balancer {
  bucket: string;
  account: string;
  region: string;
  lb: string;
  prefix?: string;
}

/** Entrega um arquivo do balanceador que termina em `endMs`; `day` é a pasta (o dia da entrega). */
export function deliver(
  s3: FakeAlbS3,
  balancer: Balancer,
  endMs: number,
  specs: readonly LineSpec[] | Buffer,
  options: { random?: string; node?: string; day?: string; size?: number } = {},
): string {
  const { account, region, lb, prefix } = balancer;
  const key = objectKey(endMs, {
    account,
    region,
    lb,
    ...(prefix !== undefined && { prefix }),
    ...(options.random !== undefined && { random: options.random }),
    ...(options.node !== undefined && { node: options.node }),
  });
  const own = new Date(endMs).toISOString().slice(0, 10).split('-').join('/');
  const placed =
    options.day === undefined ? key : key.split(`/${own}/`).join(`/${options.day.split('-').join('/')}/`);
  const body = Buffer.isBuffer(specs)
    ? specs
    : gzipLines(linesOf(endMs, specs).map((line) => line.split(LB_DEFAULT).join(lb)));
  return s3.put(balancer.bucket, placed, body, options.size);
}

const LB_DEFAULT = 'app/loja/0123456789abcdef';

export { SLOT };

import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createGunzip } from 'node:zlib';
import { LineSplitter } from '../line-splitter.js';

/**
 * A leitura de um arquivo de log: S3, gunzip e linhas, em pedaços, sem nunca ter o objeto inteiro na memória. Quem manda no
 * ritmo é a contagem: o próximo pedaço só é pedido depois de o anterior ser contado.
 *
 * O bucket é do cliente, e quem escreve nele pode plantar um arquivo: cada limite abaixo é conferido durante a leitura, e o
 * objeto que o passa é recusado (`ObjectRejected`), nunca pulado em silêncio.
 */
export interface ReadLimits {
  compressed: number;
  decompressed: number;
  /** O descompactado sobre o compactado já lido, depois de `ratioFloor` bytes descompactados. */
  ratio: number;
  ratioFloor: number;
  lines: number;
  /** Tempo máximo sem nenhum pedaço novo. */
  idleMs: number;
}

const MIB = 1024 * 1024;
export const READ_LIMITS: ReadLimits = {
  compressed: 64 * MIB,
  decompressed: 512 * MIB,
  ratio: 200,
  ratioFloor: MIB,
  lines: 2_000_000,
  idleMs: 20_000,
};

/** Tempo de contagem seguido antes de soltar o laço de eventos. */
const TURN_MS = 12;
const CHUNK_BYTES = 64 * 1024;

export type RejectReason = 'compressed' | 'decompressed' | 'ratio' | 'lines' | 'corrupt';

/** O objeto não serve: grande demais, uma bomba ou um gzip quebrado. Ler de novo daria no mesmo. */
export class ObjectRejected extends Error {
  readonly reason: RejectReason;

  constructor(reason: RejectReason) {
    super(`objeto recusado: ${reason}`);
    this.name = 'ObjectRejected';
    this.reason = reason;
  }
}

/** O corpo acabou antes do tamanho que a listagem deu: a rede cortou, e a próxima leitura tenta de novo. */
export class ObjectCut extends Error {
  constructor() {
    super('leitura do objeto interrompida');
    this.name = 'IncompleteBody';
  }
}

export interface ObjectRead {
  /** Descompactados: os que contam no plano. */
  bytes: number;
  /** Todas as linhas não vazias, inclusive as maiores que o limite. */
  lines: number;
  oversize: number;
}

const isZlibError = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
};

export interface ReadOptions {
  limits?: ReadLimits;
  /** Recebe os bytes descompactados até agora: o que foi gasto com um objeto que não deu certo também conta. */
  progress?: { bytes: number };
}

export async function readAlbObject(
  body: Readable,
  expectedBytes: number,
  onLine: (line: string) => void,
  signal: AbortSignal,
  { limits = READ_LIMITS, progress = { bytes: 0 } }: ReadOptions = {},
): Promise<ObjectRead> {
  let compressed = 0;
  let counted = 0;

  const idle = new AbortController();
  const timer = setTimeout(() => {
    idle.abort(new DOMException('o S3 parou de responder', 'TimeoutError'));
  }, limits.idleMs);
  const meter = new Transform({
    transform(chunk: Uint8Array, _encoding, done) {
      timer.refresh();
      compressed += chunk.length;
      if (compressed > limits.compressed) done(new ObjectRejected('compressed'));
      else done(null, chunk);
    },
  });
  const splitter = new LineSplitter((line) => {
    counted += 1;
    onLine(line);
  });
  try {
    await pipeline(
      body,
      meter,
      createGunzip({ chunkSize: CHUNK_BYTES }),
      async (chunks: AsyncIterable<Buffer>) => {
        let turn = performance.now();
        for await (const chunk of chunks) {
          progress.bytes += chunk.length;
          const { bytes } = progress;
          if (bytes > limits.decompressed) throw new ObjectRejected('decompressed');
          if (bytes > limits.ratioFloor && bytes > compressed * limits.ratio)
            throw new ObjectRejected('ratio');
          splitter.push(chunk);
          if (counted + splitter.oversize > limits.lines) throw new ObjectRejected('lines');
          if (performance.now() - turn >= TURN_MS) {
            await nextTurn();
            turn = performance.now();
          }
          // A contagem pode demorar mais que a rede: só o S3 parado estoura o tempo.
          timer.refresh();
        }
      },
      { signal: AbortSignal.any([signal, idle.signal]) },
    );
    splitter.end();
  } catch (error) {
    if (signal.aborted) throw error;
    if (idle.signal.aborted) throw idle.signal.reason;
    if (isZlibError(error))
      throw compressed < expectedBytes ? new ObjectCut() : new ObjectRejected('corrupt');
    throw error;
  } finally {
    clearTimeout(timer);
    body.destroy();
  }
  // O gzip fechou antes do fim do arquivo: a rede cortou entre dois membros.
  if (compressed < expectedBytes) throw new ObjectCut();
  return { bytes: progress.bytes, lines: counted + splitter.oversize, oversize: splitter.oversize };
}

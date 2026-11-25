import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { albLine, Harness, objectKey, T0, times } from '../../../test/support/alb-lines.js';
import { MAX_LINE_CHARS } from '../alb/alb-line.js';
import { ObjectTraffic } from '../traffic.js';
import { ObjectCut, ObjectRejected, READ_LIMITS, readAlbObject, type ReadLimits } from './object-reader.js';

const LIMITS: ReadLimits = { ...READ_LIMITS, idleMs: 2_000 };
const never = new AbortController().signal;
const bodyOf = (data: Buffer, chunk = 1_000): Readable =>
  Readable.from(
    (function* () {
      for (let at = 0; at < data.length; at += chunk) yield data.subarray(at, at + chunk);
    })(),
    { objectMode: false },
  );
const noise = (count: number) => times(count, (i) => `${i} ${randomBytes(30).toString('hex')}`);
const gzip = (lines: readonly string[]) =>
  gzipSync(Buffer.from(lines.map((line) => `${line}\n`).join(''), 'latin1'));

async function read(data: Buffer, limits: Partial<ReadLimits> = {}, expected = data.length) {
  const lines: string[] = [];
  const body = bodyOf(data);
  const result = await readAlbObject(body, expected, (line) => lines.push(line), never, {
    limits: { ...LIMITS, ...limits },
  });
  expect(body.destroyed).toBe(true);
  return { ...result, seen: lines };
}

describe('leitura de um arquivo de log', () => {
  it('as linhas, os bytes descompactados e as grandes demais', async () => {
    const lines = noise(500);
    const data = gzip([...lines, 'x'.repeat(MAX_LINE_CHARS + 1), 'fim']);
    const result = await read(data);
    expect(result.seen).toEqual([...lines, 'fim']);
    expect(result).toMatchObject({ lines: 502, oversize: 1 });
    expect(result.bytes).toBe(
      [...lines, 'fim'].reduce((sum, line) => sum + line.length + 1, 0) + MAX_LINE_CHARS + 2,
    );
  });

  it('sem quebra no fim, linha vazia, CRLF, sem linha nenhuma e vários membros', async () => {
    const raw = (text: string) => gzipSync(Buffer.from(text, 'latin1'));
    expect((await read(raw('a\n\r\nb\r\n\nc'))).seen).toEqual(['a', 'b', 'c']);
    expect((await read(raw(''))).lines).toBe(0);
    const joined = Buffer.concat([raw('a\nb'), raw('c\nd\n')]);
    expect((await read(joined)).seen).toEqual(['a', 'bc', 'd']);
  });

  it.each([
    ['compressed', { compressed: 2_000 }],
    ['decompressed', { decompressed: 20_000 }],
    ['lines', { lines: 499 }],
  ] as const)('acima do teto de %s: recusado, com o corpo fechado', async (reason, limits) => {
    const data = gzip(noise(500));
    const body = bodyOf(data);
    await expect(
      readAlbObject(body, data.length, () => undefined, never, { limits: { ...LIMITS, ...limits } }),
    ).rejects.toMatchObject({ name: 'ObjectRejected', reason });
    expect(body.destroyed).toBe(true);
  });

  it('no teto exato, passa', async () => {
    const lines = noise(500);
    const data = gzip(lines);
    const bytes = lines.reduce((sum, line) => sum + line.length + 1, 0);
    await expect(
      read(data, { compressed: data.length, decompressed: bytes, lines: 500 }),
    ).resolves.toMatchObject({ lines: 500, bytes });
  });

  it('a razão só é cobrada depois do piso, e contra o que já foi lido', async () => {
    const repeated = gzip(times(2_000, () => 'a'.repeat(100)));
    await expect(read(repeated)).resolves.toMatchObject({ lines: 2_000 });
    await expect(read(repeated, { ratioFloor: 50_000 })).rejects.toMatchObject({ reason: 'ratio' });
    await expect(read(repeated, { ratioFloor: 50_000, ratio: 1_000 })).resolves.toMatchObject({
      lines: 2_000,
    });
  });

  it('a bomba é parada cedo: só o que os buffers já tinham adiantado', async () => {
    // O quanto os buffers adiantam é do Node e da máquina: vale ser uma fração pequena do conteúdo.
    const size = 400_000_000;
    const bomb = gzipSync(Buffer.alloc(size, 0x61));
    const progress = { bytes: 0 };
    await expect(
      readAlbObject(bodyOf(bomb, 512), bomb.length, () => undefined, never, { limits: LIMITS, progress }),
    ).rejects.toMatchObject({ reason: 'ratio' });
    expect(progress.bytes).toBeLessThan(size / 4);
  });

  describe('gzip que não fecha', () => {
    const data = gzip(noise(400));

    it('quebrado no meio, ou que nem é gzip: recusado', async () => {
      const broken = Buffer.from(data);
      broken.fill(0xff, 2_000, 2_100);
      await expect(read(broken)).rejects.toMatchObject({ reason: 'corrupt' });
      await expect(read(Buffer.from('isto não é gzip'.repeat(50)))).rejects.toMatchObject({
        reason: 'corrupt',
      });
      const checksum = Buffer.from(data);
      checksum.fill(0, data.length - 8, data.length - 4);
      await expect(read(checksum)).rejects.toMatchObject({ reason: 'corrupt' });
    });

    it('cortado na origem (o tamanho é o listado): recusado; cortado na rede (falta corpo): passageiro', async () => {
      const cut = data.subarray(0, data.length - 20);
      await expect(read(cut)).rejects.toBeInstanceOf(ObjectRejected);
      await expect(read(cut, {}, data.length)).rejects.toBeInstanceOf(ObjectCut);
    });

    it('cortado exatamente entre dois membros também é corte', async () => {
      await expect(read(data, {}, data.length * 2)).rejects.toBeInstanceOf(ObjectCut);
    });

    it('lixo depois do fim não é erro', async () => {
      await expect(read(Buffer.concat([data, Buffer.alloc(40)]))).resolves.toMatchObject({ lines: 400 });
    });
  });

  it('o erro da rede sobe como veio', async () => {
    const body = new Readable({
      read() {
        this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      },
    });
    await expect(readAlbObject(body, 10, () => undefined, never, { limits: LIMITS })).rejects.toMatchObject({
      code: 'ECONNRESET',
    });
  });

  it('o corpo parado estoura o tempo; o corpo lento, mas andando, não', async () => {
    const data = gzip(noise(200));
    const stalled = new Readable({ read: () => undefined });
    stalled.push(data.subarray(0, 100));
    await expect(
      readAlbObject(stalled, data.length, () => undefined, never, { limits: { ...LIMITS, idleMs: 80 } }),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(stalled.destroyed).toBe(true);
    const slow = Readable.from(
      (async function* () {
        for (let at = 0; at < data.length; at += 1_500) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          yield data.subarray(at, at + 1_500);
        }
      })(),
      { objectMode: false },
    );
    await expect(
      readAlbObject(slow, data.length, () => undefined, never, { limits: { ...LIMITS, idleMs: 120 } }),
    ).resolves.toMatchObject({ lines: 200 });
  });

  it('o sinal para a leitura e fecha o corpo', async () => {
    const controller = new AbortController();
    const data = gzip(noise(20_000));
    const body = bodyOf(data);
    let seen = 0;
    await expect(
      readAlbObject(
        body,
        data.length,
        () => {
          seen += 1;
          if (seen === 10) controller.abort(new DOMException('parada', 'AbortError'));
        },
        controller.signal,
        { limits: LIMITS },
      ),
    ).rejects.toThrow();
    expect(body.destroyed).toBe(true);
    expect(seen).toBeLessThan(20_000);
  });

  it('um erro na contagem sobe e fecha o corpo', async () => {
    const data = gzip(noise(10));
    const body = bodyOf(data);
    await expect(
      readAlbObject(
        body,
        data.length,
        () => {
          throw new Error('defeito');
        },
        never,
        { limits: LIMITS },
      ),
    ).rejects.toThrow('defeito');
    expect(body.destroyed).toBe(true);
  });

  /**
   * Um arquivo de 96 MB descompactados (o de 512 MB está no benchmark): a memória depois da coleta, medida durante a leitura,
   * e o maior atraso do laço de eventos não crescem com o tamanho.
   */
  it('a memória e o laço de eventos não dependem do tamanho do arquivo', async () => {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;
    const text = Buffer.from(
      times(
        1_500,
        (i) =>
          `${albLine({ client: `198.51.100.${i % 250}`, path: `/p/${randomBytes(8).toString('hex')}`, status: 404 })}\n`,
      ).join(''),
      'latin1',
    );
    const member = gzipSync(text);
    const copies = Math.ceil((96 * 1024 * 1024) / text.length);
    const harness = new Harness();
    const traffic = new ObjectTraffic(null);
    const object = harness.engine.openObject(objectKey(T0), T0, traffic);
    if (!object.ok) throw new Error(object.reason);
    const memory = () => {
      gc();
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      return heapUsed + arrayBuffers;
    };
    const before = memory();
    let peak = 0;
    let lines = 0;
    let longest = 0;
    let last = performance.now();
    const ticker = setInterval(() => {
      longest = Math.max(longest, performance.now() - last);
      last = performance.now();
    }, 1);
    const body = Readable.from(
      (function* () {
        for (let i = 0; i < copies; i += 1) {
          for (let at = 0; at < member.length; at += 64 * 1024) yield member.subarray(at, at + 64 * 1024);
        }
      })(),
      { objectMode: false },
    );
    let collecting = 0;
    const result = await readAlbObject(
      body,
      copies * member.length,
      (line) => {
        harness.engine.ingest(object, line);
        lines += 1;
        if (lines % 25_000 === 0) {
          const started = performance.now();
          peak = Math.max(peak, memory() - before);
          collecting = Math.max(collecting, performance.now() - started);
        }
      },
      never,
      { limits: LIMITS },
    );
    clearInterval(ticker);
    expect(result.lines).toBe(copies * 1_500);
    expect(traffic.deltas({ tenantId: '', sourceId: '' }, new Date(0))[0]?.requests).toBe(result.lines);
    expect(peak).toBeLessThan(40_000_000);
    // Sem a coleta forçada do teste; com folga para a máquina ocupada.
    expect(longest - collecting).toBeLessThan(250);
  }, 120_000);
});

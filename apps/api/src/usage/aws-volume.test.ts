import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decompressedSize,
  ISIZE_FALLBACK_RATIO,
  nodeTenantIdentity,
  objectHash,
  pendingCellIdentity,
  tenantAwsIdentityFor,
} from './aws-volume.js';

/** Os 4 últimos bytes de um gzip de verdade. */
function tailOf(gzip: Uint8Array): Uint8Array {
  return gzip.subarray(gzip.length - 4);
}

describe('medição da AWS na origem: o ISIZE do gzip (CE-09)', () => {
  it('lê o tamanho descompactado no fim do gzip de um membro só', () => {
    const json = JSON.stringify({
      Records: Array.from({ length: 200 }, (_, index) => ({ eventName: `Get${index}` })),
    });
    const gzip = gzipSync(Buffer.from(json, 'utf8'));
    expect(decompressedSize('AWSLogs/x.json.gz', gzip.length, tailOf(gzip))).toEqual({
      bytes: Buffer.byteLength(json, 'utf8'),
      fallback: false,
    });
    // O S3 devolve o objeto inteiro quando ele é menor que o pedido: vale o fim do que veio.
    expect(decompressedSize('AWSLogs/x.json.gz', gzip.length, gzip).bytes).toBe(
      Buffer.byteLength(json, 'utf8'),
    );
  });

  it('ISIZE impossível ou não lido: a estimativa pelo compactado, marcada', () => {
    const fallback = { bytes: 1_000 * ISIZE_FALLBACK_RATIO, fallback: true };
    // Menor que o compactado.
    expect(decompressedSize('a.gz', 1_000, Uint8Array.from([10, 0, 0, 0]))).toEqual(fallback);
    // Acima de 1032 vezes o compactado (o máximo do deflate): um gzip de vários membros, ou corrompido.
    const huge = new Uint8Array(4);
    new DataView(huge.buffer).setUint32(0, 1_000 * 1033, true);
    expect(decompressedSize('a.gz', 1_000, huge)).toEqual(fallback);
    // Exatamente 1032 vezes ainda vale.
    new DataView(huge.buffer).setUint32(0, 1_000 * 1032, true);
    expect(decompressedSize('a.gz', 1_000, huge)).toEqual({ bytes: 1_032_000, fallback: false });
    // Menos de 4 bytes, ou nada lido.
    expect(decompressedSize('a.gz', 1_000, Uint8Array.from([1, 2]))).toEqual(fallback);
    expect(decompressedSize('a.gz', 1_000, null)).toEqual(fallback);
  });

  it('objeto sem gzip conta o próprio tamanho; vazio conta zero', () => {
    expect(decompressedSize('AWSLogs/x.json', 512, null)).toEqual({ bytes: 512, fallback: false });
    expect(decompressedSize('AWSLogs/x.json.gz', 0, null)).toEqual({ bytes: 0, fallback: false });
  });

  it('o hash do objeto: bucket e chave, sem guardar a chave', () => {
    expect(objectHash('bucket-a', 'chave')).toMatch(/^[0-9a-f]{64}$/);
    expect(objectHash('bucket-a', 'chave')).not.toBe(objectHash('bucket-b', 'chave'));
    // O separador impede que bucket e chave se confundam.
    expect(objectHash('a', 'b/c')).not.toBe(objectHash('a/b', 'c'));
  });
});

describe('a identidade de cada cliente (CE-09; a da célula vem no CE-11)', () => {
  const node = { credentialsFor: () => () => Promise.reject(new Error('não usado')) };

  it('nó dedicado: a identidade do nó para o cliente dele', () => {
    expect(tenantAwsIdentityFor('dedicated', node).sessionsFor('qualquer')).toBe(node);
    expect(nodeTenantIdentity(node).sessionsFor('outro')).toBe(node);
  });

  it('célula: nenhum cliente tem identidade até o CE-11, nem com a identidade do nó disponível', () => {
    expect(tenantAwsIdentityFor('cell', node).sessionsFor('cliente')).toBeNull();
    expect(pendingCellIdentity().sessionsFor('cliente')).toBeNull();
    // Sem a identidade do nó (NODE_SA_UNIQUE_ID), ninguém tem.
    expect(tenantAwsIdentityFor('dedicated', null).sessionsFor('cliente')).toBeNull();
  });
});

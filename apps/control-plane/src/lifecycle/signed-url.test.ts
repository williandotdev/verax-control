import { createHash, createVerify, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encodeRfc3986, signedUrl, signedUrlParts } from './signed-url.js';

const SIGNER = 'cp-exporter@projeto-exemplo.iam.gserviceaccount.com';
const NOW = new Date('2026-11-15T12:34:56.789Z');

describe('link assinado V4 do Cloud Storage', () => {
  it('o pedido canônico e o texto a assinar no formato da documentação do Google', () => {
    const parts = signedUrlParts({
      method: 'GET',
      base: 'https://storage.googleapis.com',
      bucket: 'projeto-dos-nos-demo-vx-cliente-demo-a-backups',
      object: 'postgres/verax-20261115T063000Z.dump',
      signer: SIGNER,
      now: NOW,
      expiresSeconds: 86_400,
    });
    const query =
      'X-Goog-Algorithm=GOOG4-RSA-SHA256' +
      '&X-Goog-Credential=cp-exporter%40projeto-exemplo.iam.gserviceaccount.com%2F20261115%2Fauto%2Fstorage%2Fgoog4_request' +
      '&X-Goog-Date=20261115T123456Z&X-Goog-Expires=86400&X-Goog-SignedHeaders=host';
    const canonical = [
      'GET',
      '/projeto-dos-nos-demo-vx-cliente-demo-a-backups/postgres/verax-20261115T063000Z.dump',
      query,
      'host:storage.googleapis.com\n',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    expect(parts.canonicalRequest).toBe(canonical);
    expect(parts.stringToSign).toBe(
      [
        'GOOG4-RSA-SHA256',
        '20261115T123456Z',
        '20261115/auto/storage/goog4_request',
        createHash('sha256').update(canonical).digest('hex'),
      ].join('\n'),
    );
    expect(parts.unsignedUrl).toBe(
      `https://storage.googleapis.com/projeto-dos-nos-demo-vx-cliente-demo-a-backups/postgres/verax-20261115T063000Z.dump?${query}`,
    );
  });

  it('a assinatura RSA SHA-256 do texto vai em hexadecimal no fim, e confere com a chave pública', async () => {
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const request = {
      method: 'HEAD' as const,
      base: 'http://127.0.0.1:9999/storage',
      bucket: 'bucket-demo',
      object: 'postgres/verax-20261115T063000Z.dump',
      signer: SIGNER,
      now: NOW,
      expiresSeconds: 60,
    };
    const url = await signedUrl(request, (payload) =>
      Promise.resolve(sign('RSA-SHA256', payload, keys.privateKey)),
    );
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/storage/bucket-demo/postgres/verax-20261115T063000Z.dump');
    const signature = parsed.searchParams.get('X-Goog-Signature') ?? '';
    expect(signature).toMatch(/^[0-9a-f]{512}$/);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signedUrlParts(request).stringToSign);
    expect(verifier.verify(keys.publicKey, Buffer.from(signature, 'hex'))).toBe(true);
    expect(signedUrlParts(request).canonicalRequest.startsWith('HEAD\n')).toBe(true);
  });

  it('recusa bucket, objeto e validade fora do formato', () => {
    const base = {
      method: 'GET' as const,
      base: 'https://storage.googleapis.com',
      bucket: 'bucket-demo',
      object: 'postgres/x.dump',
      signer: SIGNER,
      now: NOW,
      expiresSeconds: 60,
    };
    expect(() => signedUrlParts({ ...base, bucket: 'Bucket/Outro' })).toThrow(TypeError);
    expect(() => signedUrlParts({ ...base, object: '' })).toThrow(TypeError);
    expect(() => signedUrlParts({ ...base, object: '/postgres/x.dump' })).toThrow(TypeError);
    expect(() => signedUrlParts({ ...base, object: 'postgres/../x.dump' })).toThrow(TypeError);
    expect(() => signedUrlParts({ ...base, expiresSeconds: 0 })).toThrow(TypeError);
    expect(() => signedUrlParts({ ...base, expiresSeconds: 7 * 24 * 3600 + 1 })).toThrow(TypeError);
  });

  it('RFC 3986: os caracteres que o encodeURIComponent deixa passar também são codificados', () => {
    expect(encodeRfc3986("a!b'c(d)e*f g/h@i")).toBe('a%21b%27c%28d%29e%2Af%20g%2Fh%40i');
  });
});

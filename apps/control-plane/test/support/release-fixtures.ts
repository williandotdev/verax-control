import { createHash, generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';

/**
 * Um release do nó montado no teste: o manifesto no formato do `scripts/node-release.sh`, assinado com uma chave P-256
 * gerada aqui (nunca a de release da Verax), e o bundle do painel (CP-09) num tar ustar escrito aqui mesmo.
 */
export class TestReleaseKey {
  private readonly privateKey: KeyObject;
  readonly publicPem: string;

  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    this.publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** Assinatura DER com SHA-256, como a que o Cloud KMS devolve. */
  sign(data: Buffer): Buffer {
    return sign('sha256', data, { key: this.privateKey, dsaEncoding: 'der' });
  }

  get keys(): Record<string, string> {
    return { 'release-teste': this.publicPem };
  }
}

export const TEST_COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
export const TEST_PACKAGE_SHA256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** O manifesto como o `node-release.sh manifest` escreve (mais o `panel` do CP-09, se vier). */
export function manifestFor(
  release: string,
  options: { commit?: string; packageSha256?: string; panel?: { url: string; sha256: string } } = {},
): Buffer {
  const commit = options.commit ?? TEST_COMMIT;
  const repository = 'williandotdev/verax-control';
  return Buffer.from(
    `${JSON.stringify(
      {
        schema: 1,
        kind: 'verax-node-release',
        version: commit,
        release,
        releasedAt: '2026-11-05T12:00:00Z',
        package: {
          url: `https://github.com/${repository}/releases/download/${release}/verax-node.tar.gz`,
          sha256: options.packageSha256 ?? TEST_PACKAGE_SHA256,
        },
        images: {
          api: `ghcr.io/${repository}/api@sha256:${'1'.repeat(64)}`,
          migrate: `ghcr.io/${repository}/migrate@sha256:${'2'.repeat(64)}`,
        },
        thirdPartyImages: [`postgres:18-alpine@sha256:${'3'.repeat(64)}`],
        notes: `https://github.com/${repository}/releases/tag/${release}`,
        ...(options.panel === undefined ? {} : { panel: options.panel }),
      },
      null,
      2,
    )}\n`,
  );
}

export function panelUrl(release: string, commit = TEST_COMMIT): string {
  return `https://github.com/williandotdev/verax-control/releases/download/${release}/panel-${commit}.tar.gz`;
}

export interface TarEntry {
  path: string;
  content?: Buffer | string;
  /** `0` arquivo (padrão), `5` pasta, `2` link simbólico, `g` cabeçalho global do pax. */
  type?: '0' | '5' | '2' | 'g' | 'x';
  linkTarget?: string;
}

function header(entry: TarEntry, size: number): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(entry.path, 0, 100, 'utf8');
  block.write('0000644\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write('00000000000\0', 136, 12, 'ascii');
  block.write('        ', 148, 8, 'ascii');
  block.write(entry.type ?? '0', 156, 1, 'ascii');
  if (entry.linkTarget !== undefined) block.write(entry.linkTarget, 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

/** Um tar ustar com estas entradas (e os dois blocos vazios do fim). */
export function ustar(entries: readonly TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = Buffer.from(entry.content ?? '');
    parts.push(header(entry, content.length), content, Buffer.alloc((512 - (content.length % 512)) % 512, 0));
  }
  parts.push(Buffer.alloc(1024, 0));
  return Buffer.concat(parts);
}

/** A configuração-modelo do build único (CP-08): a CSP com `https://api-{tenant}...`. */
export function hostingTemplate(zone = 'veraxsistemas.com.br'): string {
  return JSON.stringify({
    headers: [
      {
        glob: '**',
        headers: {
          'Content-Security-Policy': `default-src 'self'; connect-src 'self' https://api-{tenant}.${zone}`,
          'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
          'Cache-Control': 'no-cache',
        },
      },
      { glob: '/assets/**', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
    ],
    rewrites: [{ glob: '**', path: '/index.html' }],
  });
}

/** O bundle do painel: `dist/` com o index e um asset, e o `dist-hosting.json` com o marcador. */
export function panelBundle(extra: readonly TarEntry[] = [], template = hostingTemplate()): Buffer {
  return gzipSync(
    ustar([
      { path: './', type: '5' },
      { path: './dist/', type: '5' },
      { path: './dist/index.html', content: '<!doctype html><title>Verax Control</title>' },
      { path: './dist/assets/', type: '5' },
      { path: './dist/assets/app-abc123.js', content: 'console.log("painel")' },
      { path: './dist-hosting.json', content: template },
      ...extra,
    ]),
  );
}

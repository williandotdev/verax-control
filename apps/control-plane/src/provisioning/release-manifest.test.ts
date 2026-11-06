import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  manifestFor,
  panelUrl,
  sha256,
  TEST_COMMIT,
  TEST_PACKAGE_SHA256,
  TestReleaseKey,
} from '../../test/support/release-fixtures.js';
import { RELEASE_PUBLIC_KEYS } from './release-keys.js';
import {
  parseReleaseDetails,
  parseReleaseManifest,
  readReleaseDetails,
  readReleaseManifest,
  releaseKeyFingerprint,
  ReleaseManifestError,
  verifyManifestSignature,
} from './release-manifest.js';

const RELEASE = 'node-v1.2.3';
const KEYS_DIR = new URL('../../../../infra/node/keys/', import.meta.url);

function storageWith(objects: Record<string, Buffer>): {
  read: (bucket: string, object: string) => Promise<Buffer | undefined>;
} {
  return { read: (bucket, object) => Promise.resolve(objects[`${bucket}/${object}`]) };
}

describe('chaves de release', () => {
  it('são exatamente as públicas de infra/node/keys, byte a byte (as que o nó usa na instalação)', () => {
    const files = readdirSync(KEYS_DIR)
      .filter((name) => /^release-.*\.pem$/.test(name))
      .sort();
    expect(Object.keys(RELEASE_PUBLIC_KEYS).sort()).toEqual(files.map((name) => name.replace(/\.pem$/, '')));
    for (const file of files) {
      expect(RELEASE_PUBLIC_KEYS[file.replace(/\.pem$/, '')]).toBe(
        readFileSync(new URL(file, KEYS_DIR), 'utf8'),
      );
    }
  });
});

describe('a versão para o cliente instalar na infraestrutura dele (contrato direto)', () => {
  const key = new TestReleaseKey();
  const github = 'https://github.com/williandotdev/verax-control';

  function variant(change: (manifest: Record<string, unknown>) => void): Buffer {
    const manifest = JSON.parse(manifestFor(RELEASE).toString('utf8')) as Record<string, unknown>;
    change(manifest);
    return Buffer.from(JSON.stringify(manifest));
  }

  it('lê do manifesto conferido o release, o pacote, as imagens pelo digest e os endereços no GitHub', async () => {
    const manifest = manifestFor(RELEASE);
    const storage = storageWith({
      [`releases-demo/${RELEASE}/manifest.json`]: manifest,
      [`releases-demo/${RELEASE}/manifest.json.sig`]: key.sign(manifest),
    });
    expect(await readReleaseDetails(storage, 'releases-demo', RELEASE, key.keys)).toEqual({
      release: RELEASE,
      commit: TEST_COMMIT,
      releasedAt: '2026-11-05T12:00:00Z',
      repositoryUrl: github,
      releaseUrl: `${github}/releases/tag/${RELEASE}`,
      manifestUrl: `${github}/releases/download/${RELEASE}/manifest.json`,
      signatureUrl: `${github}/releases/download/${RELEASE}/manifest.json.sig`,
      package: {
        url: `${github}/releases/download/${RELEASE}/verax-node.tar.gz`,
        sha256: TEST_PACKAGE_SHA256,
      },
      images: {
        api: `ghcr.io/williandotdev/verax-control/api@sha256:${'1'.repeat(64)}`,
        migrate: `ghcr.io/williandotdev/verax-control/migrate@sha256:${'2'.repeat(64)}`,
      },
      thirdPartyImages: [`postgres:18-alpine@sha256:${'3'.repeat(64)}`],
      releaseKey: { name: 'release-teste', sha256: releaseKeyFingerprint(key.publicPem) },
    });
    // A assinatura de outra chave: recusado antes de ler qualquer campo.
    const forged = storageWith({
      [`releases-demo/${RELEASE}/manifest.json`]: manifest,
      [`releases-demo/${RELEASE}/manifest.json.sig`]: new TestReleaseKey().sign(manifest),
    });
    await expect(readReleaseDetails(forged, 'releases-demo', RELEASE, key.keys)).rejects.toThrow(
      new ReleaseManifestError('release_manifest_invalid'),
    );
  });

  it('a impressão digital da chave é o SHA-256 da pública em DER (a mesma conta do openssl), e a do repositório confere', () => {
    for (const [name, pem] of Object.entries(RELEASE_PUBLIC_KEYS)) {
      const der = Buffer.from(pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
      expect(releaseKeyFingerprint(pem), name).toBe(createHash('sha256').update(der).digest('hex'));
    }
  });

  it('recusa imagem sem digest, pacote ou notas de outro repositório ou de outra versão, e endereço fora do GitHub', () => {
    const bad = [
      variant((m) => {
        m['images'] = { api: 'ghcr.io/williandotdev/verax-control/api:latest', migrate: 'x' };
      }),
      variant((m) => {
        m['thirdPartyImages'] = ['postgres:18-alpine'];
      }),
      variant((m) => {
        m['package'] = {
          url: `https://github.com/outro-dono/verax-control/releases/download/${RELEASE}/verax-node.tar.gz`,
          sha256: TEST_PACKAGE_SHA256,
        };
      }),
      variant((m) => {
        m['notes'] = `${github}/releases/tag/node-v9.9.9`;
      }),
      variant((m) => {
        m['notes'] = `https://exemplo.example/williandotdev/verax-control/releases/tag/${RELEASE}`;
      }),
    ];
    for (const manifest of bad) {
      expect(() => parseReleaseDetails(manifest, RELEASE)).toThrow(ReleaseManifestError);
    }
  });
});

describe('manifesto da versão', () => {
  const key = new TestReleaseKey();

  it('confere a assinatura dos bytes exatos com a chave certa', () => {
    const manifest = manifestFor(RELEASE);
    expect(verifyManifestSignature(manifest, key.sign(manifest), key.keys)).toBe('release-teste');
    // Um byte a mais (um espaço) e a assinatura não fecha.
    expect(
      verifyManifestSignature(Buffer.concat([manifest, Buffer.from(' ')]), key.sign(manifest), key.keys),
    ).toBeUndefined();
    // Outra chave.
    expect(verifyManifestSignature(manifest, new TestReleaseKey().sign(manifest), key.keys)).toBeUndefined();
    // As chaves de verdade não aceitam a assinatura do teste.
    expect(verifyManifestSignature(manifest, key.sign(manifest))).toBeUndefined();
    // Assinatura vazia ou grande demais nem chega a conferir.
    expect(verifyManifestSignature(manifest, Buffer.alloc(0), key.keys)).toBeUndefined();
    expect(verifyManifestSignature(manifest, Buffer.alloc(73, 1), key.keys)).toBeUndefined();
  });

  it('lê o commit, o SHA-256 do pacote e o bundle do painel da pasta da versão', () => {
    const info = parseReleaseManifest(
      manifestFor(RELEASE, { panel: { url: panelUrl(RELEASE), sha256: 'f'.repeat(64) } }),
      RELEASE,
    );
    expect(info).toEqual({
      release: RELEASE,
      commit: TEST_COMMIT,
      packageSha256: TEST_PACKAGE_SHA256,
      panel: { object: `${RELEASE}/panel-${TEST_COMMIT}.tar.gz`, sha256: 'f'.repeat(64) },
    });
    // Sem o bundle (o CP-09 ainda não publica): o manifesto vale, e o `firebase.site` decide.
    expect(parseReleaseManifest(manifestFor(RELEASE), RELEASE).panel).toBeUndefined();
  });

  it.each([
    ['outra versão', manifestFor('node-v1.2.4'), RELEASE],
    ['commit fora do formato', manifestFor(RELEASE, { commit: 'abc' }), RELEASE],
    ['SHA-256 do pacote em maiúsculas', manifestFor(RELEASE, { packageSha256: 'A'.repeat(64) }), RELEASE],
    [
      'bundle de outro release',
      manifestFor(RELEASE, { panel: { url: panelUrl('node-v1.2.2'), sha256: 'f'.repeat(64) } }),
      RELEASE,
    ],
    [
      'bundle de outro commit',
      manifestFor(RELEASE, { panel: { url: panelUrl(RELEASE, 'b'.repeat(40)), sha256: 'f'.repeat(64) } }),
      RELEASE,
    ],
    [
      'bundle fora do GitHub',
      manifestFor(RELEASE, {
        panel: {
          url: `https://example.com/releases/download/${RELEASE}/panel-${TEST_COMMIT}.tar.gz`,
          sha256: 'f'.repeat(64),
        },
      }),
      RELEASE,
    ],
    [
      'bundle em http',
      manifestFor(RELEASE, {
        panel: { url: panelUrl(RELEASE).replace('https:', 'http:'), sha256: 'f'.repeat(64) },
      }),
      RELEASE,
    ],
    ['não é JSON', Buffer.from('{'), RELEASE],
  ])('recusa: %s', (_name, manifest, release) => {
    expect(() => parseReleaseManifest(manifest, release)).toThrow(ReleaseManifestError);
  });

  it('do bucket: sem o manifesto ou a assinatura, `release_manifest_missing`; assinatura que não fecha, `invalid`', async () => {
    const manifest = manifestFor(RELEASE);
    const signature = key.sign(manifest);
    const complete = storageWith({
      [`releases/${RELEASE}/manifest.json`]: manifest,
      [`releases/${RELEASE}/manifest.json.sig`]: signature,
    });
    await expect(readReleaseManifest(complete, 'releases', RELEASE, key.keys)).resolves.toMatchObject({
      commit: TEST_COMMIT,
    });
    await expect(
      readReleaseManifest(
        storageWith({ [`releases/${RELEASE}/manifest.json`]: manifest }),
        'releases',
        RELEASE,
        key.keys,
      ),
    ).rejects.toMatchObject({ code: 'release_manifest_missing' });
    await expect(readReleaseManifest(complete, 'releases', RELEASE)).rejects.toMatchObject({
      code: 'release_manifest_invalid',
    });
    await expect(readReleaseManifest(complete, 'releases', 'v1.2.3', key.keys)).rejects.toMatchObject({
      code: 'release_manifest_invalid',
    });
    expect(sha256(manifest)).toMatch(/^[0-9a-f]{64}$/);
  });
});

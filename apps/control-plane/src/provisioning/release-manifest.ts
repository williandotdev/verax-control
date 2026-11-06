import { createHash, createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { NODE_RELEASE_PATTERN } from '../common/config/env.schema.js';
import type { StorageApi } from './google-apis.js';
import { RELEASE_PUBLIC_KEYS } from './release-keys.js';

/**
 * O manifesto da versão do nó (SH-02: `scripts/node-release.sh manifest`, assinado pela chave de release no Cloud KMS),
 * lido pelo `preflight` no bucket de releases (`RELEASE_BUCKET`): `<versão>/manifest.json` e `<versão>/manifest.json.sig`,
 * os mesmos bytes do release `node-vX.Y.Z` do GitHub. A assinatura é conferida com as chaves públicas do repositório
 * (`release-keys.ts`) antes de qualquer campo ser lido, como o `verify-release.sh` faz no nó.
 *
 * O que o plano de controle usa: o commit (`version`), o SHA-256 do pacote do nó (vai para o Terraform; o nó confere de
 * novo contra o manifesto, PR-N7) e o bundle do painel (`panel`, do CP-09), que o `firebase.site` publica.
 */
export const MANIFEST_OBJECT = 'manifest.json';
export const SIGNATURE_OBJECT = 'manifest.json.sig';
const MAX_MANIFEST_BYTES = 65_536;
/** Uma assinatura ECDSA P-256 em DER tem de 8 a 72 bytes (`verify-release.sh`). */
const MIN_SIGNATURE_BYTES = 8;
const MAX_SIGNATURE_BYTES = 72;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);
const PANEL_FILE_PATTERN = /^panel-[0-9a-f]{40}\.tar\.gz$/;
const GITHUB_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;

/** Dono ou repositório no GitHub: letras, números, `_`, `.` e `-`. */
function isGithubName(segment: string): boolean {
  return GITHUB_NAME_PATTERN.test(segment);
}

function isPanelFile(file: string): boolean {
  return PANEL_FILE_PATTERN.test(file);
}

/**
 * Contrato do bundle do painel no manifesto (para o CP-09): `panel: {url, sha256}`, como `package`. `url` é o arquivo
 * `panel-<commit>.tar.gz` no release desta versão no GitHub; o plano de controle o lê do bucket de releases, na pasta
 * da versão (`<versão>/panel-<commit>.tar.gz`), e confere o SHA-256 do arquivo inteiro (o `.tar.gz`).
 */
const panelSchema = z.strictObject({ url: z.url({ protocol: /^https$/ }).max(500), sha256: sha256Hex });

const manifestSchema = z.object({
  schema: z.literal(1),
  kind: z.literal('verax-node-release'),
  version: commitSchema,
  release: z.string().regex(NODE_RELEASE_PATTERN),
  package: z.object({ sha256: sha256Hex }),
  panel: panelSchema.optional(),
});

/** O que o provisionamento guarda da versão (no documento da execução; nada de segredo). */
export interface ReleaseInfo {
  release: string;
  commit: string;
  packageSha256: string;
  /** Ausente enquanto o CP-09 não publicar o bundle no manifesto: o `firebase.site` para com `panel_bundle_missing`. */
  panel?: { object: string; sha256: string };
}

export type ReleaseManifestProblem = 'release_manifest_missing' | 'release_manifest_invalid';

/** O manifesto (ou a assinatura) não está no bucket, não fecha com nenhuma chave ou está fora do formato. */
export class ReleaseManifestError extends Error {
  constructor(readonly code: ReleaseManifestProblem) {
    super(`manifesto da versão recusado: ${code}`);
    this.name = 'ReleaseManifestError';
  }
}

/** O nome da chave cuja assinatura fecha com os bytes exatos do manifesto, ou `undefined`. */
export function verifyManifestSignature(
  manifest: Buffer,
  signature: Buffer,
  keys: Readonly<Record<string, string>> = RELEASE_PUBLIC_KEYS,
): string | undefined {
  if (manifest.length === 0 || manifest.length > MAX_MANIFEST_BYTES) return undefined;
  if (signature.length < MIN_SIGNATURE_BYTES || signature.length > MAX_SIGNATURE_BYTES) return undefined;
  for (const [name, pem] of Object.entries(keys)) {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') continue;
    if (verify('sha256', manifest, { key, dsaEncoding: 'der' }, signature)) return name;
  }
  return undefined;
}

/** Lê o manifesto já conferido: a versão tem de ser a pedida, e o bundle do painel, se houver, desta versão. */
export function parseReleaseManifest(manifest: Buffer, release: string): ReleaseInfo {
  let raw: unknown;
  try {
    raw = JSON.parse(manifest.toString('utf8'));
  } catch {
    throw new ReleaseManifestError('release_manifest_invalid');
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.release !== release)
    throw new ReleaseManifestError('release_manifest_invalid');
  const { version: commit, package: pkg, panel } = parsed.data;
  const info: ReleaseInfo = { release, commit, packageSha256: pkg.sha256 };
  if (panel === undefined) return info;
  const file = panelFileOf(panel.url, release, commit);
  if (file === undefined) throw new ReleaseManifestError('release_manifest_invalid');
  return { ...info, panel: { object: `${release}/${file}`, sha256: panel.sha256 } };
}

/** `panel-<commit>.tar.gz` do release desta versão no GitHub, ou `undefined` se a URL não for essa. */
function panelFileOf(url: string, release: string, commit: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.hostname !== 'github.com' || parsed.search !== '' || parsed.hash !== '') return undefined;
  // /<dono>/<repositório>/releases/download/<versão>/<arquivo>
  const [empty, owner, repository, releases, download, tag, file, ...extra] = parsed.pathname.split('/');
  const shape =
    empty === '' &&
    owner !== undefined &&
    isGithubName(owner) &&
    repository !== undefined &&
    isGithubName(repository) &&
    releases === 'releases' &&
    download === 'download' &&
    tag === release &&
    extra.length === 0;
  if (!shape || file === undefined) return undefined;
  return isPanelFile(file) && file === `panel-${commit}.tar.gz` ? file : undefined;
}

/** Baixa, confere a assinatura e lê o manifesto da versão no bucket de releases. */
export async function readReleaseManifest(
  storage: Pick<StorageApi, 'read'>,
  bucket: string,
  release: string,
  keys: Readonly<Record<string, string>> = RELEASE_PUBLIC_KEYS,
): Promise<ReleaseInfo> {
  if (!NODE_RELEASE_PATTERN.test(release)) throw new ReleaseManifestError('release_manifest_invalid');
  const manifest = await storage.read(bucket, `${release}/${MANIFEST_OBJECT}`, MAX_MANIFEST_BYTES);
  const signature = await storage.read(bucket, `${release}/${SIGNATURE_OBJECT}`, MAX_SIGNATURE_BYTES);
  if (manifest === undefined || signature === undefined)
    throw new ReleaseManifestError('release_manifest_missing');
  if (verifyManifestSignature(manifest, signature, keys) === undefined) {
    throw new ReleaseManifestError('release_manifest_invalid');
  }
  return parseReleaseManifest(manifest, release);
}

// --- O que o responsável manda ao cliente que instala na própria infraestrutura (contrato direto) ---------------------

const GHCR_IMAGE_PATTERN =
  /^ghcr\.io\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}\/(api|migrate)@sha256:[0-9a-f]{64}$/;
/**
 * Uma imagem de terceiro sempre pelo digest: o nome (com registro e tag opcionais) e `@sha256:`. Mais solta que o
 * `third_party_re` do `scripts/node-release.sh` (que já recusou o resto antes de assinar), sem repetição aninhada: o
 * manifesto chega aqui só com a assinatura conferida, e esta forma só garante que nada sem digest vai ao console.
 */
const THIRD_PARTY_IMAGE_PATTERN = /^[a-z0-9][A-Za-z0-9._/:-]{0,250}@sha256:[0-9a-f]{64}$/;

const detailsSchema = z.object({
  release: z.string().regex(NODE_RELEASE_PATTERN),
  version: commitSchema,
  releasedAt: z.iso.datetime().optional(),
  package: z.object({ url: z.url({ protocol: /^https$/ }).max(500), sha256: sha256Hex }),
  images: z.object({
    api: z.string().max(300).regex(GHCR_IMAGE_PATTERN),
    migrate: z.string().max(300).regex(GHCR_IMAGE_PATTERN),
  }),
  thirdPartyImages: z.array(z.string().max(300).regex(THIRD_PARTY_IMAGE_PATTERN)).min(1).max(20),
  notes: z.url({ protocol: /^https$/ }).max(500),
});

/**
 * A versão do nó como o cliente a instala na infraestrutura dele (`docs/runbooks/instalacao-no-cliente.md`): o release
 * do GitHub, o manifesto e a assinatura (que o `verify-release.sh` confere), o pacote com o SHA-256 e as imagens pelo
 * digest (as do Verax no GHCR público, as de terceiros pela origem). Nada de segredo: tudo é público no release.
 */
export interface ReleaseDetails {
  release: string;
  commit: string;
  releasedAt?: string;
  /** `https://github.com/<dono>/<repositório>`, de onde saem os outros endereços. */
  repositoryUrl: string;
  releaseUrl: string;
  manifestUrl: string;
  signatureUrl: string;
  package: { url: string; sha256: string };
  images: { api: string; migrate: string };
  thirdPartyImages: string[];
  /**
   * A chave de release que fechou a assinatura: o nome (o arquivo `infra/node/keys/<nome>.pem`) e o SHA-256 da pública
   * em DER, a impressão digital que o cliente confere fora do GitHub antes de confiar na primeira instalação
   * (`openssl pkey -pubin -in <nome>.pem -outform DER | openssl dgst -sha256`).
   */
  releaseKey?: { name: string; sha256: string };
}

/** O SHA-256 da chave pública em DER (SPKI): a impressão digital que o `openssl` também calcula. */
export function releaseKeyFingerprint(pem: string): string {
  return createHash('sha256')
    .update(createPublicKey(pem).export({ type: 'spki', format: 'der' }))
    .digest('hex');
}

/**
 * O dono e o repositório de um endereço do release (`https://github.com/<dono>/<repositório>/releases/<resto>`), se
 * ele for exatamente do release `release` no GitHub; senão, `undefined`.
 */
function releaseRepositoryOf(url: string, release: string, rest: readonly string[]): string | undefined {
  const parsed = new URL(url);
  if (parsed.hostname !== 'github.com' || parsed.search !== '' || parsed.hash !== '') return undefined;
  const [empty, owner, repository, releases, ...tail] = parsed.pathname.split('/');
  const shape =
    empty === '' &&
    owner !== undefined &&
    isGithubName(owner) &&
    repository !== undefined &&
    isGithubName(repository) &&
    releases === 'releases' &&
    tail.length === rest.length &&
    tail.every((segment, index) => segment === (rest[index] === '<release>' ? release : rest[index]));
  return shape ? `${owner}/${repository}` : undefined;
}

/** Lê o manifesto já conferido com tudo o que o cliente precisa para instalar a versão; fora do formato, recusado. */
export function parseReleaseDetails(manifest: Buffer, release: string): ReleaseDetails {
  const info = parseReleaseManifest(manifest, release);
  let raw: unknown;
  try {
    raw = JSON.parse(manifest.toString('utf8'));
  } catch {
    throw new ReleaseManifestError('release_manifest_invalid');
  }
  const parsed = detailsSchema.safeParse(raw);
  if (!parsed.success) throw new ReleaseManifestError('release_manifest_invalid');
  const data = parsed.data;
  const repository = releaseRepositoryOf(data.notes, release, ['tag', '<release>']);
  if (
    repository === undefined ||
    releaseRepositoryOf(data.package.url, release, ['download', '<release>', 'verax-node.tar.gz']) !==
      repository
  ) {
    throw new ReleaseManifestError('release_manifest_invalid');
  }
  const base = `https://github.com/${repository}`;
  const download = `${base}/releases/download/${release}`;
  return {
    release,
    commit: info.commit,
    ...(data.releasedAt === undefined ? {} : { releasedAt: data.releasedAt }),
    repositoryUrl: base,
    releaseUrl: `${base}/releases/tag/${release}`,
    manifestUrl: `${download}/${MANIFEST_OBJECT}`,
    signatureUrl: `${download}/${SIGNATURE_OBJECT}`,
    package: { url: data.package.url, sha256: info.packageSha256 },
    images: { api: data.images.api, migrate: data.images.migrate },
    thirdPartyImages: [...data.thirdPartyImages],
  };
}

/** Baixa, confere a assinatura e lê o manifesto da versão no bucket de releases, com o que o cliente instala. */
export async function readReleaseDetails(
  storage: Pick<StorageApi, 'read'>,
  bucket: string,
  release: string,
  keys: Readonly<Record<string, string>> = RELEASE_PUBLIC_KEYS,
): Promise<ReleaseDetails> {
  if (!NODE_RELEASE_PATTERN.test(release)) throw new ReleaseManifestError('release_manifest_invalid');
  const manifest = await storage.read(bucket, `${release}/${MANIFEST_OBJECT}`, MAX_MANIFEST_BYTES);
  const signature = await storage.read(bucket, `${release}/${SIGNATURE_OBJECT}`, MAX_SIGNATURE_BYTES);
  if (manifest === undefined || signature === undefined)
    throw new ReleaseManifestError('release_manifest_missing');
  const keyName = verifyManifestSignature(manifest, signature, keys);
  const pem = keyName === undefined ? undefined : keys[keyName];
  if (keyName === undefined || pem === undefined) throw new ReleaseManifestError('release_manifest_invalid');
  return {
    ...parseReleaseDetails(manifest, release),
    releaseKey: { name: keyName, sha256: releaseKeyFingerprint(pem) },
  };
}

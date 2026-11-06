import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import type { HostingConfig } from './google-apis.js';

/**
 * O bundle do painel (CP-09): `panel-<commit>.tar.gz` com o build único do painel (CP-08) e a configuração-modelo do
 * Firebase Hosting. Lido em memória, sem tocar no disco e sem dependência nova (o leitor de tar é este, só o pouco que o
 * formato ustar precisa). Contrato para o CP-09:
 * - gzip de um tar ustar (`tar --format=ustar`), com arquivos comuns e pastas, sem link nem dispositivo;
 * - `dist/...`: os arquivos do site (o `index.html` obrigatório na raiz de `dist/`);
 * - `dist-hosting.json`: a configuração-modelo (`firebaseHostingConfig` com `https://api-{tenant}...`, o
 *   `dist-hosting.json` que o build único grava ao lado do `dist`).
 * O que vai para o site: os arquivos de `dist/` (o caminho sem o `dist`) e a configuração com o marcador trocado pelo
 * subdomínio do cliente (`siteHostingConfig` do painel), conferida para ter a API desse cliente na CSP.
 */
export const TENANT_PLACEHOLDER = '{tenant}';
const SITE_PREFIX = 'dist/';
const CONFIG_FILE = 'dist-hosting.json';
/** Tetos do bundle: o build do painel tem poucos MB e algumas dezenas de arquivos. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 2000;
const BLOCK = 512;

export type PanelBundleProblem = 'panel_bundle_invalid' | 'panel_bundle_sha256_mismatch';

export class PanelBundleError extends Error {
  constructor(readonly code: PanelBundleProblem) {
    super(`bundle do painel recusado: ${code}`);
    this.name = 'PanelBundleError';
  }
}

export interface PanelBundle {
  /** Caminho no site (`/index.html`, `/assets/...`) → conteúdo. */
  files: Map<string, Buffer>;
  /** A configuração-modelo, ainda com `{tenant}`. */
  template: string;
}

function invalid(): PanelBundleError {
  return new PanelBundleError('panel_bundle_invalid');
}

/** Texto de um campo do cabeçalho, até o primeiro NUL. */
function field(header: Buffer, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
}

/** Campo numérico em octal (o ustar), com espaços e NUL nas pontas. */
function octal(header: Buffer, offset: number, length: number): number {
  const text = field(header, offset, length).trim();
  if (!/^[0-7]{1,12}$/.test(text)) throw invalid();
  return Number.parseInt(text, 8);
}

/** Soma dos bytes do cabeçalho com o campo da soma como espaços (o ustar). */
function checksumMatches(header: Buffer): boolean {
  const expected = octal(header, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  return sum === expected;
}

/**
 * Caminho seguro dentro do bundle: relativo, sem `..`, sem barra invertida, sem segmento vazio, só ASCII visível. O
 * `./` do começo (o `tar -C pasta .`) sai.
 */
function safePath(raw: string): string | undefined {
  const path = raw.startsWith('./') ? raw.slice(2) : raw;
  if (path === '' || path === '.') return '';
  if (path.startsWith('/') || path.includes('\\') || !/^[\x21-\x7e]+$/.test(path)) return undefined;
  const segments = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined;
  return segments.join('/');
}

/** Os arquivos comuns de um tar ustar, em memória. Link, dispositivo e caminho fora do formato: recusado. */
export function readTar(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumMatches(header)) throw invalid();
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const magic = field(header, 257, 6);
    const prefix = magic.startsWith('ustar') ? field(header, 345, 155) : '';
    const name = prefix === '' ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) throw invalid();
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    // Cabeçalho global do pax (o `git archive` põe o commit): só metadados, ignorado. Um pax por arquivo pode trocar o
    // nome do arquivo seguinte: recusado, para o caminho conferido ser o que vale.
    if (type === 'g') continue;
    if (type === '5') {
      if (safePath(name) === undefined) throw invalid();
      continue;
    }
    if (type !== '0' && type !== '\0') throw invalid();
    const path = safePath(name);
    if (path === undefined || path === '' || files.has(path)) throw invalid();
    total += size;
    if (files.size >= MAX_FILES || total > MAX_UNPACKED_BYTES) throw invalid();
    files.set(path, Buffer.from(archive.subarray(dataStart, dataEnd)));
  }
  return files;
}

/** Confere o SHA-256 do `.tar.gz` inteiro (o do manifesto assinado) e abre o bundle. */
export function openPanelBundle(archive: Buffer, expectedSha256: string): PanelBundle {
  if (createHash('sha256').update(archive).digest('hex') !== expectedSha256) {
    throw new PanelBundleError('panel_bundle_sha256_mismatch');
  }
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES + 1024 * 1024 });
  } catch {
    throw invalid();
  }
  const entries = readTar(tar);
  const template = entries.get(CONFIG_FILE);
  if (template === undefined) throw invalid();
  const files = new Map<string, Buffer>();
  for (const [path, content] of entries) {
    if (path === CONFIG_FILE) continue;
    if (!path.startsWith(SITE_PREFIX)) throw invalid();
    files.set(`/${path.slice(SITE_PREFIX.length)}`, content);
  }
  if (!files.has('/index.html')) throw invalid();
  return { files, template: template.toString('utf8') };
}

const hostingConfigSchema = z.strictObject({
  headers: z
    .array(
      z.strictObject({
        glob: z.string().min(1).max(200),
        headers: z.record(z.string().max(100), z.string().max(4000)),
      }),
    )
    .min(1)
    .max(50),
  rewrites: z
    .array(z.strictObject({ glob: z.string().min(1).max(200), path: z.string().min(1).max(200) }))
    .max(50),
});

/**
 * A configuração do site do cliente: o marcador trocado pelo subdomínio (o `siteHostingConfig` do painel, CP-08). Uma
 * configuração sem o marcador é recusada (daria a todos os sites a mesma API), e a de saída precisa citar a API deste
 * cliente (a `connect-src` da CSP).
 */
export function siteHostingConfig(template: string, slug: string, apiOrigin: string): HostingConfig {
  if (!template.includes(TENANT_PLACEHOLDER)) throw invalid();
  const filled = template.replaceAll(TENANT_PLACEHOLDER, slug);
  let parsed: unknown;
  try {
    parsed = JSON.parse(filled);
  } catch {
    throw invalid();
  }
  const config = hostingConfigSchema.safeParse(parsed);
  if (!config.success || !filled.includes(apiOrigin)) throw invalid();
  return config.data;
}

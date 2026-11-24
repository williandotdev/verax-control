import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { IpCountry } from './ip-country.js';
import { decodeTables } from './ip-country-format.js';

/** O gerador (`scripts/update-ip-country.mjs`) de ponta a ponta, com CSV sintéticos. */
const script = fileURLToPath(new URL('../../../../scripts/update-ip-country.mjs', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'ip-country-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const LINES = 150_000;
const CODES = ['BR', 'US', 'XK', 'AC', 'TA', 'AN'];
const ipv4 = (word: number): string =>
  `${word >>> 24}.${(word >>> 16) & 255}.${(word >>> 8) & 255}.${word & 255}`;
/** Faixas de 256 endereços, uma sim, uma não, a partir de 11.0.0.0 (antes, 10.255.255.0, reservada). */
const v4Lines = Array.from({ length: LINES }, (_, i) => {
  const start = (i === 0 ? 0x0aff_ff00 : 0x0b00_0000 + (i - 1) * 512) >>> 0;
  return `${ipv4(start)},${ipv4(start + 255)},${CODES[i % CODES.length] ?? ''}`;
});
/** Um /48 por faixa, a partir de 2a00::. A segunda é dividida no meio de um /64. */
const v6Lines = Array.from({ length: LINES }, (_, i) => {
  const net = `${(0x2a00 + (i >> 16)).toString(16)}:${(i & 0xffff).toString(16)}:0`;
  if (i === 1) return `${net}::,${net}::ff,BR`;
  if (i === 2) return '2a00:1::100,2a00:1:0:ffff:ffff:ffff:ffff:ffff,US';
  return `${net}::,${net}:ffff:ffff:ffff:ffff:ffff,${CODES[i % CODES.length] ?? ''}`;
});

let runs = 0;
interface Run {
  status: number | null;
  stderr: string;
  files: string[];
  dir: string;
}
function run(v4: string, v6: string): Run {
  runs += 1;
  const dir = mkdtempSync(join(work, `${runs}-`));
  const input = mkdtempSync(join(work, `in-${runs}-`));
  const names = [join(input, 'user-country-ipv4.csv'), join(input, 'user-country-ipv6.csv')] as const;
  writeFileSync(names[0], v4, 'latin1');
  writeFileSync(names[1], v6, 'latin1');
  const { status, stderr } = spawnSync(process.execPath, [script, ...names, dir], { encoding: 'utf8' });
  return { status, stderr, files: readdirSync(dir).sort(), dir };
}
const text = (lines: readonly string[]): string => `${lines.join('\n')}\n`;
const V4 = text(v4Lines);
const V6 = text(v6Lines);
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

describe('update-ip-country', { timeout: 120_000 }, () => {
  it('gera a tabela e os metadados; a mesma entrada dá os mesmos bytes', () => {
    const first = run(V4, V6);
    expect([first.status, first.stderr]).toEqual([0, expect.stringContaining('150000 faixas') as string]);
    expect(first.files).toEqual(['ip-country-meta.ts', 'ip-country.bin.gz']);
    const file = readFileSync(join(first.dir, 'ip-country.bin.gz'));
    const meta = readFileSync(join(first.dir, 'ip-country-meta.ts'), 'utf8');
    const content = gunzipSync(file);
    // Sem hora e sem o sistema de quem gerou.
    expect([...file.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 2, 255]);
    for (const hash of [sha256(file), sha256(content), sha256(V4), sha256(V6)]) expect(meta).toContain(hash);
    expect(meta).toContain("name: 'user-country-ipv4.csv'");
    expect(meta).toMatch(/generatedAt: '\d{4}-\d\d-\d\dT[\d:.]{12}Z'/);
    expect(meta).not.toContain(work);

    const lookup = new IpCountry(decodeTables(content), '2026-11-24T00:00:00.000Z');
    const expected = { BR: 'BR', US: 'US', XK: 'XK', AC: 'SH', TA: 'SH', AN: null } as const;
    expect(lookup.countryOf('10.255.255.1')).toBeNull(); // reservada
    for (let i = 1; i < 13; i += 1) {
      const start = 0x0b00_0000 + (i - 1) * 512;
      const code = expected[(CODES[i % CODES.length] ?? 'AN') as keyof typeof expected];
      expect(lookup.countryOf(ipv4(start))).toBe(code);
      expect(lookup.countryOf(ipv4(start + 255))).toBe(code);
      expect(lookup.countryOf(ipv4(start + 256))).toBeNull();
    }
    expect(lookup.countryOf('2a00::1')).toBe('BR');
    // 256 endereços de um lado, o resto do /64 do outro: a maioria.
    expect(lookup.countryOf('2a00:1::1')).toBe('US');
    expect(lookup.countryOf('2a00:1:0:ffff::')).toBe('US');
    expect(lookup.countryOf('2a00:3::')).toBe('SH');
    expect(lookup.countryOf('2a00:5::')).toBeNull();

    const again = run(V4, V6);
    expect(sha256(readFileSync(join(again.dir, 'ip-country.bin.gz')))).toBe(sha256(file));
  });

  /** O CSV com a linha `index` trocada. */
  const patched = (lines: readonly string[], index: number, line: string): string =>
    text([...lines.slice(0, index), line, ...lines.slice(index + 1)]);

  it.each<[string, string, string, RegExp]>([
    ['poucas linhas', text(v4Lines.slice(1)), V6, /download incompleto/],
    ['última linha cortada', V4.slice(0, -1), V6, /cortada/],
    ['vazio', '', V6, /cortada|incompleto/],
    ['famílias trocadas', V6, V4, /linha 1: endereço inválido/],
    ['fim de linha do Windows', V4.replaceAll('\n', '\r\n'), V6, /linha 1: código inválido/],
    ['campo a mais', patched(v4Lines, 3, `${v4Lines[3] ?? ''},x`), V6, /linha 4: não são três campos/],
    ['campo a menos', patched(v4Lines, 3, '11.0.4.0,11.0.4.255'), V6, /linha 4: não são três campos/],
    ['linha vazia', patched(v4Lines, 3, ''), V6, /linha 4: não são três campos/],
    ['zero à esquerda', patched(v4Lines, 3, '011.0.4.0,11.0.4.255,BR'), V6, /linha 4: endereço inválido/],
    ['não é endereço', patched(v4Lines, 3, 'x,11.0.4.255,BR'), V6, /linha 4: endereço inválido/],
    ['invertida', patched(v4Lines, 3, '11.0.4.255,11.0.4.0,BR'), V6, /linha 4: faixa invertida/],
    ['fora de ordem', patched(v4Lines, 3, '11.0.0.0,11.0.0.1,BR'), V6, /linha 4: fora de ordem/],
    ['sobreposta', patched(v4Lines, 3, '11.0.2.255,11.0.4.255,BR'), V6, /linha 4: fora de ordem/],
    ['código minúsculo', patched(v4Lines, 3, '11.0.4.0,11.0.4.255,br'), V6, /linha 4: código inválido/],
    ['código de três letras', patched(v4Lines, 3, '11.0.4.0,11.0.4.255,BRA'), V6, /linha 4: código inválido/],
    ['código com aspas', patched(v4Lines, 3, '11.0.4.0,11.0.4.255,"B'), V6, /linha 4: código inválido/],
    ['código desconhecido', patched(v4Lines, 3, '11.0.4.0,11.0.4.255,ZZ'), V6, /linha 4: código fora da ISO/],
    ['nome herdado', patched(v4Lines, 3, '11.0.4.0,11.0.4.255,constructor'), V6, /código inválido/],
    [
      'IPv6 com zona',
      V4,
      patched(v6Lines, 0, '2a00::%a,2a00::1,BR'),
      /ipv6\.csv, linha 1: endereço inválido/,
    ],
    ['IPv6 com IPv4', V4, patched(v6Lines, 0, '2a00::1.2.3.4,2a00::2:0:0,BR'), /linha 1: endereço inválido/],
    ['IPv6 sobreposta', V4, patched(v6Lines, 3, '2a00:1::ff00,2a00:1::ffff,BR'), /linha 4: fora de ordem/],
  ])('recusa e não escreve nada: %s', (_name, v4, v6, message) => {
    const { status, stderr, files } = run(v4, v6);
    expect(stderr).toMatch(message);
    expect(status).not.toBe(0);
    expect(files).toEqual([]);
  });

  it('sem os três argumentos, explica o uso', () => {
    const { status, stderr } = spawnSync(process.execPath, [script, 'a', 'b'], { encoding: 'utf8' });
    expect([status, stderr]).toEqual([2, expect.stringContaining('uso:') as string]);
  });
});

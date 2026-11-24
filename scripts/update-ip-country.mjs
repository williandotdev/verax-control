// Gera a tabela de país por endereço IP (apps/api/src/geo/data/) a partir dos dois CSV da base `user-country` do projeto
// sapics/ip-location-db (https://github.com/sapics/ip-location-db), já baixados. Não acessa a rede: quem roda baixa os
// arquivos e confere o SHA-256 publicado com eles.
//
//   node scripts/update-ip-country.mjs user-country-ipv4.csv user-country-ipv6.csv apps/api/src/geo/data
//
// Escreve `ip-country.bin.gz` (os mesmos CSV dão sempre os mesmos bytes; a data fica só no outro arquivo) e
// `ip-country-meta.ts`. Qualquer linha inválida, fora de ordem, sobreposta ou com código desconhecido para tudo, sem
// escrever nada. Roda o TypeScript do módulo direto (o Node remove os tipos).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { format, resolveConfig } from 'prettier';
import { resolveCountryCode } from '../apps/api/src/geo/country-codes.ts';
import {
  buildV4,
  buildV6,
  decodeTables,
  encodeTables,
  FORMAT_VERSION,
} from '../apps/api/src/geo/ip-country-format.ts';

/** Hoje são 303.658 e 295.458 linhas: abaixo disto, o download está incompleto. */
const MIN_LINES = 150_000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const [v4File, v6File, outDir, extra] = process.argv.slice(2);
if (outDir === undefined || extra !== undefined) {
  console.error('uso: node scripts/update-ip-country.mjs <ipv4.csv> <ipv6.csv> <pasta de saída>');
  process.exit(2);
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- CSV baixado, passado na linha de comando
const read = (file) => readFileSync(file);
// eslint-disable-next-line security/detect-non-literal-fs-filename -- pasta de saída, passada na linha de comando
const write = (name, data) => writeFileSync(join(outDir, name), data);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const ipv4ToBigInt = (text) => BigInt(text.split('.').reduce((sum, part) => sum * 256 + Number(part), 0));

/** O IPv6 com IPv4 embutido ou com zona passaria no `isIP`, e não é o que a fonte publica. */
const isAddress = (text, version) =>
  isIP(text) === version && (version === 4 || !(text.includes('.') || text.includes('%')));
const isCode = (text) => text.length === 2 && [...text].every((char) => char >= 'A' && char <= 'Z');

/** Só o que `isAddress` já aceitou. */
function ipv6ToBigInt(text) {
  const side = (part) => (part === '' ? [] : part.split(':'));
  const [head, tail] = text.split('::').map(side);
  const groups =
    tail === undefined ? head : [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail];
  return BigInt(`0x${groups.map((group) => group.padStart(4, '0')).join('')}`);
}

/** As faixas de um CSV `início,fim,código`, conferidas linha a linha. */
function parse(file, version) {
  const bytes = read(file);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${basename(file)}: arquivo grande demais`);
  const lines = bytes.toString('latin1').split('\n');
  if (lines.pop() !== '') throw new Error(`${basename(file)}: a última linha está cortada`);
  if (lines.length < MIN_LINES) {
    throw new Error(
      `${basename(file)}: ${lines.length} linhas, menos que ${MIN_LINES}: download incompleto?`,
    );
  }
  const toBigInt = version === 4 ? ipv4ToBigInt : ipv6ToBigInt;
  const ranges = [];
  let dropped = 0;
  let previous = -1n;
  lines.forEach((line, i) => {
    const fail = (reason) => {
      throw new Error(`${basename(file)}, linha ${i + 1}: ${reason}: ${JSON.stringify(line.slice(0, 120))}`);
    };
    const [from, to, source, rest] = line.split(',');
    if (source === undefined || rest !== undefined) fail('não são três campos');
    if (!isAddress(from, version) || !isAddress(to, version)) fail('endereço inválido');
    const start = toBigInt(from);
    const end = toBigInt(to);
    if (start > end) fail('faixa invertida');
    if (start <= previous) fail('fora de ordem ou sobreposta à anterior');
    previous = end;
    if (!isCode(source)) fail('código inválido');
    const code = resolveCountryCode(source);
    if (code === undefined) fail('código fora da ISO 3166-1 e de SPECIAL_CODES (country-codes.ts)');
    if (code === null) dropped += 1;
    else ranges.push({ start, end, code });
  });
  console.error(`${basename(file)}: ${lines.length} faixas (${dropped} de código sem país)`);
  return { ranges, source: { name: basename(file), sha256: sha256(bytes), ranges: lines.length } };
}

/** O que se vai gravar, lido de volta, é a mesma tabela. */
function verify(tables, v4, v6) {
  const same =
    tables.v4Starts.length === v4.length &&
    tables.v6Low.length === v6.length &&
    v4.every(
      ({ start, code }, i) =>
        BigInt(tables.v4Starts[i]) === start && tables.codes[tables.v4Codes[i]] === code,
    ) &&
    v6.every(
      ({ start, code }, i) =>
        ((BigInt(tables.v6High[i]) << 32n) | BigInt(tables.v6Low[i])) === start &&
        tables.codes[tables.v6Codes[i]] === code,
    );
  if (!same) throw new Error('a tabela lida de volta é diferente da montada');
}

const v4Input = parse(v4File, 4);
const v6Input = parse(v6File, 6);
const v4 = buildV4(v4Input.ranges);
const v6 = buildV6(v6Input.ranges);
const content = encodeTables(v4, v6);
const tables = decodeTables(content);
verify(tables, v4, v6);

const file = gzipSync(content, { level: 9 });
// Cabeçalho sem nome nem hora (o zlib já escreve assim) e sem o sistema de quem gerou (RFC 1952, byte 9: 255 é desconhecido).
file.fill(0, 4, 8);
file[9] = 255;

const meta = {
  formatVersion: FORMAT_VERSION,
  generatedAt: new Date().toISOString(),
  sources: [v4Input.source, v6Input.source],
  counts: { codes: tables.codes.length - 1, v4Boundaries: v4.length, v6Boundaries: v6.length },
  sha256: sha256(file),
  contentSha256: sha256(content),
};
const target = fileURLToPath(new URL('../apps/api/src/geo/data/ip-country-meta.ts', import.meta.url));
const source = `import type { IpCountryMeta } from '../ip-country.js';

/** GERADO por \`scripts/update-ip-country.mjs\` junto com \`ip-country.bin.gz\`; não editar à mão. Fonte e licença: README.md. */
export const IP_COUNTRY_META: IpCountryMeta = ${JSON.stringify(meta)};
`;
const metaText = await format(source, { ...(await resolveConfig(target)), parser: 'typescript' });

write('ip-country.bin.gz', file);
write('ip-country-meta.ts', metaText);
console.error(
  `${meta.counts.v4Boundaries} fronteiras IPv4, ${meta.counts.v6Boundaries} IPv6, ${meta.counts.codes} códigos, ${file.length} bytes`,
);

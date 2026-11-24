// Escreve na saída padrão o apps/api/src/weblogs/data/proxy-ranges.ts, a partir das listas oficiais já baixadas. Não acessa
// a rede: quem roda baixa os três arquivos, e o diff do arquivo gerado é o que se revisa.
//
//   curl -fsSLO https://www.cloudflare.com/ips-v4
//   curl -fsSLO https://www.cloudflare.com/ips-v6
//   curl -fsSLO https://ip-ranges.amazonaws.com/ip-ranges.json
//   node scripts/update-proxy-ranges.mjs ips-v4 ips-v6 ip-ranges.json > apps/api/src/weblogs/data/proxy-ranges.ts
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';

const [v4File, v6File, awsFile] = process.argv.slice(2);
if (awsFile === undefined) {
  console.error('uso: node scripts/update-proxy-ranges.mjs <ips-v4> <ips-v6> <ip-ranges.json>');
  process.exit(2);
}

/** O arquivo vira código: só entra o que tem forma de CIDR. O resto das conferências é do teste (`client-class.test.ts`). */
function cidr(text, version) {
  const [address, prefix, extra] = String(text).split('/');
  if (isIP(address) !== version || !/^\d{1,3}$/.test(prefix ?? '') || extra !== undefined) {
    throw new Error(`faixa inválida: ${JSON.stringify(text).slice(0, 80)}`);
  }
  return `${address}/${prefix}`;
}

// eslint-disable-next-line security/detect-non-literal-fs-filename -- lista baixada, passada na linha de comando
const read = (file) => readFileSync(file, 'utf8');
const lines = (file) =>
  read(file)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
const unique = (values) => [...new Set(values)];

const cloudflare = [
  ...lines(v4File).map((line) => cidr(line, 4)),
  ...lines(v6File).map((line) => cidr(line, 6)),
];
const aws = JSON.parse(read(awsFile));
const facing = (item) => item.service === 'CLOUDFRONT_ORIGIN_FACING';
const cloudfront = [
  ...aws.prefixes.filter(facing).map((item) => cidr(item.ip_prefix, 4)),
  ...aws.ipv6_prefixes.filter(facing).map((item) => cidr(item.ipv6_prefix, 6)),
];
if (cloudflare.length < 10 || cloudfront.length < 20)
  throw new Error('lista curta demais: download incompleto?');

const target = fileURLToPath(new URL('../apps/api/src/weblogs/data/proxy-ranges.ts', import.meta.url));
const generatedAt = new Date().toISOString();
const entry = (provider, source, ranges) =>
  `{ provider: '${provider}', source: '${source}', generatedAt: '${generatedAt}', ranges: ${JSON.stringify(unique(ranges))} }`;

const source = `/**
 * Faixas de saída das CDNs, VENDORIZADAS: o motor nunca busca faixa na rede nem faz consulta de DNS.
 *
 * GERADO por \`scripts/update-proxy-ranges.mjs\` a partir das listas oficiais; não editar à mão. Atualizar a cada versão do
 * nó: lista com mais de 180 dias vira a nota \`proxy_ranges_stale\`. Da AWS entra só \`CLOUDFRONT_ORIGIN_FACING\`, o que o
 * CloudFront usa para chamar a origem (o resto da AWS é cliente como outro qualquer).
 *
 * Sem as faixas de uma das CDNs, o motor não distingue um visitante de uma borda: todo endereço público fica
 * \`unverified\` e as regras por IP ficam desligadas (\`client-class.ts\`).
 */

export type ProxyProvider = 'cloudflare' | 'cloudfront';

export interface ProviderRanges {
  provider: ProxyProvider;
  /** De onde as faixas são copiadas. */
  source: string;
  /** Quando foram copiadas (ISO 8601); null sem lista. */
  generatedAt: string | null;
  ranges: readonly string[];
}

export const PROXY_RANGES: readonly ProviderRanges[] = [
  ${entry('cloudflare', 'https://www.cloudflare.com/ips-v4 e https://www.cloudflare.com/ips-v6', cloudflare)},
  ${entry('cloudfront', 'https://ip-ranges.amazonaws.com/ip-ranges.json (service CLOUDFRONT_ORIGIN_FACING)', cloudfront)},
];
`;
process.stdout.write(await format(source, { ...(await resolveConfig(target)), parser: 'typescript' }));
console.error(`cloudflare: ${unique(cloudflare).length} faixas; cloudfront: ${unique(cloudfront).length}`);

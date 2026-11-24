// Benchmark da consulta de país por endereço IP (apps/api/src/geo), só por pedido: não roda no CI nem nos testes. Mede o
// código compilado, o mesmo que vai na imagem.
//
//   pnpm --filter @verax/api build
//   node --expose-gc scripts/bench-ip-country.mjs
//
// Alvos: carga abaixo de 150 ms, menos de 8 MB de memória e mais de 2 milhões de consultas por segundo no caminho numérico.
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setImmediate } from 'node:timers/promises';

const gc = globalThis.gc;
if (gc === undefined) throw new Error('rode com --expose-gc');
const { loadIpCountry } = await import(new URL('../apps/api/dist/geo/ip-country.js', import.meta.url).href);

const N = 1 << 20;
const ROUNDS = 10;
const MB = 1024 * 1024;

const memory = async () => {
  // O que o V8 libera fora do heap só sai depois de mais uma volta do laço de eventos.
  for (let i = 0; i < 3; i += 1) {
    gc();
    await setImmediate();
  }
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return { heap: heapUsed, buffers: arrayBuffers };
};

const before = await memory();
const start = performance.now();
const lookup = loadIpCountry();
const loadMs = performance.now() - start;
const after = await memory();

/** Consultas por segundo, na melhor rodada e na mediana. O total impede o V8 de jogar a conta fora. */
function rate(label, run) {
  const times = [];
  let sink = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    const from = performance.now();
    for (let i = 0; i < N; i += 1) sink += run(i);
    times.push(performance.now() - from);
  }
  times.sort((a, b) => a - b);
  const perSecond = (ms) => Math.round(N / ms / 10) / 100;
  console.log(
    `${label}: mediana ${perSecond(times[ROUNDS >> 1])} mi/s, melhor ${perSecond(times[0])} mi/s (${sink})`,
  );
}

/** Sequência fixa (xorshift32): as rodadas são comparáveis. */
let state = 0x9e37_79b9;
const random = () => {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return state >>> 0;
};
const a = new Uint32Array(N).map(random);
const b = new Uint32Array(N).map(random);
// Só 2000::/3, onde as fronteiras estão.
const head = a.map((word) => ((word >>> 3) | 0x2000_0000) >>> 0);
// Endereços em que a base tem mais fronteiras: 2a00::/8.
const dense = a.map((word) => ((word >>> 8) | 0x2a00_0000) >>> 0);
const hex = (word) => `${(word >>> 16).toString(16)}:${(word & 0xffff).toString(16)}`;
const TEXTS = 1 << 16;
const v4Texts = Array.from(
  { length: TEXTS },
  (_, i) => `${a[i] >>> 24}.${(a[i] >>> 16) & 255}.${(a[i] >>> 8) & 255}.${a[i] & 255}`,
);
const v6Texts = Array.from({ length: TEXTS }, (_, i) => `${hex(dense[i])}:${hex(b[i])}::1`);

console.log(`node ${process.version}, ${process.arch}, ${process.platform}; tabela de ${lookup.generatedAt}`);
console.log(
  `carga: ${loadMs.toFixed(1)} ms; heap ${((after.heap - before.heap) / MB).toFixed(2)} MB; ` +
    `arrays ${((after.buffers - before.buffers) / MB).toFixed(2)} MB`,
);
rate('IPv4 numérico', (i) => lookup.countryOfV4(a[i]));
rate('IPv6 numérico (2000::/3)', (i) => lookup.countryOfV6(head[i], b[i]));
rate('IPv6 numérico (2a00::/8)', (i) => lookup.countryOfV6(dense[i], b[i]));
rate('IPv4 texto', (i) => (lookup.countryOf(v4Texts[i & (TEXTS - 1)]) === null ? 0 : 1));
rate('IPv6 texto', (i) => (lookup.countryOf(v6Texts[i & (TEXTS - 1)]) === null ? 0 : 1));

// O caminho numérico não aloca: depois de aquecido, o heap não cresce com a quantidade de consultas.
function growth(queries) {
  gc();
  const from = process.memoryUsage().heapUsed;
  let last = 0;
  for (let i = 0; i < queries; i += 1) {
    last = lookup.countryOfV4(a[i & (N - 1)]) ^ lookup.countryOfV6(head[i & (N - 1)], b[i & (N - 1)]);
  }
  return [process.memoryUsage().heapUsed - from, last];
}
for (const queries of [N, N, N, 16 * N]) {
  console.log(`heap a mais em ${2 * queries} consultas: ${growth(queries)[0]} bytes`);
}

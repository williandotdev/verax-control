// Benchmark do motor de ataques web (apps/api/src/weblogs), só por pedido: não roda no CI nem nos testes.
//
//   node --expose-gc scripts/bench-weblogs.mjs [linhas, padrão 1000000] [comum|enchente|objeto] [sem-pais]
//
// Alvos do desenho (1 milhão de linhas, tráfego comum): até 25 s de CPU, até 40 MB de heap a mais e até 50 ms de bloqueio
// do laço de eventos (`blocoMaxMs`, um pedaço de 64 KB; `passoMaxMs`, um passo da avaliação). A `enchente` é o pior caso
// que um atacante consegue: tudo único, tudo recusado. Dados fictícios (RFC 3849). As linhas passam pelo separador em pedaços de 64 KB, como na
// leitura de um objeto do S3; gerar as linhas não entra na conta. Com a conta por país (a tabela de verdade), a menos de
// `sem-pais`.
//
// `objeto` é a leitura inteira de um arquivo de 512 MB descompactados (`collect/object-reader.ts`): corpo em pedaços, gunzip,
// linhas, motor e conta por país. Alvos: até 40 MB de memória a mais e até 50 ms de bloqueio do laço de eventos.
//
// Roda o TypeScript direto (o Node remove os tipos); precisa do `packages/shared` compilado (`pnpm typecheck` o compila).
import { registerHooks } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL !== undefined) {
      try {
        return next(new URL(`${specifier.slice(0, -3)}.ts`, context.parentURL).href, context);
      } catch {
        // Não é um módulo do repositório: fica o nome como veio.
      }
    }
    return next(specifier, context);
  },
});

const api = new URL('../apps/api/', import.meta.url);
const { albLine, Harness, objectKey, prng, SLOT, T0 } = await import(
  new URL('test/support/alb-lines.ts', api).href
);
const { LineSplitter } = await import(new URL('src/weblogs/line-splitter.ts', api).href);
const { ObjectTraffic } = await import(new URL('src/weblogs/traffic.ts', api).href);
const { readAlbObject } = await import(new URL('src/weblogs/collect/object-reader.ts', api).href);
const { loadIpCountry } = await import(new URL('src/geo/ip-country.ts', api).href);

const scenario = process.argv[3];
const countries = process.argv.includes('sem-pais') ? null : loadIpCountry();

const TOTAL = Number(process.argv[2] ?? 1_000_000);
const SLOTS = 12;
const BATCH = 10_000;
const CHUNK = 64 * 1024;
const gc = globalThis.gc;
if (gc === undefined) throw new Error('rode com --expose-gc');

/** Um cliente por número: um /64 do bloco de documentação. */
const visitor = (i) =>
  `2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::${(i % 1000).toString(16)}`;

/** Tráfego comum: 12 mil visitantes, caminhos repetidos, 5% de erro, logins e meia dúzia de atacantes. */
function common(random, time) {
  const dice = random();
  const client = visitor(Math.floor(random() ** 2 * 12_000));
  const userAgent = `Mozilla/5.0 (variante ${Math.floor(random() * 400)}) Chrome/140.0 Safari/537.36`;
  if (dice < 0.02)
    return { time, client, userAgent, method: 'POST', path: '/login', status: random() < 0.3 ? 401 : 302 };
  if (dice < 0.04)
    return { time, client: visitor(90_000), path: `/p${Math.floor(random() * 2e6)}`, status: 404 };
  if (dice < 0.05) return { time, client: visitor(90_001), method: 'POST', path: '/login', status: 401 };
  if (dice < 0.06)
    return { time, client: visitor(90_002), path: `/x${Math.floor(random() * 500)}/.env`, status: 404 };
  if (dice < 0.1)
    return { time, client, userAgent, path: `/sumiu/${Math.floor(random() * 50)}`, status: 404 };
  if (dice < 0.5) return { time, client, userAgent, path: `/estatico/${Math.floor(random() * 300)}.js` };
  return {
    time,
    client,
    userAgent,
    path: `/produto/${Math.floor(random() * 40_000)}?ref=${Math.floor(random() * 1e9)}`,
  };
}

/** Enchente: IP, caminho, User-Agent e host únicos, tudo recusado, com sondas e logins de rotas inventadas. */
function hostile(random, time, i) {
  const base = {
    time,
    client: visitor(i),
    userAgent: `agente-${i}-${'x'.repeat(200)}`,
    domain: `h${i % 5_000}.exemplo.com.br`,
  };
  const kind = i % 4;
  if (kind === 0) return { ...base, path: `/c${i}/${'segmento/'.repeat(20)}?q=${i}`, status: 404 };
  if (kind === 1) return { ...base, method: 'POST', path: `/r${i % 50_000}/login`, status: 401 };
  if (kind === 2) return { ...base, path: `/d${i}/.env`, status: 200, sent: 300 + (i % 4_000) };
  return { ...base, path: `/%6${i % 10}${'%41'.repeat(50)}${i}`, status: 403, userAgent: `x"${i}` };
}

/** Heap e buffers depois da coleta. Os buffers de linhas do próprio benchmark só saem num ciclo seguinte. */
async function settled() {
  for (let i = 0; i < 3; i += 1) {
    gc();
    await setImmediate();
  }
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

async function run(name, build) {
  const random = prng(1);
  const heapBefore = await settled();
  const harness = new Harness({ now: T0, countries });
  let cpu = 0;
  let maxChunk = 0;
  let maxEvaluate = 0;
  let maxStep = 0;
  let maxHeap = 0;
  let bytes = 0;
  let last;
  const perSlot = Math.ceil(TOTAL / SLOTS);
  let line = 0;
  for (let slot = 0; slot < SLOTS; slot += 1) {
    const endMs = T0 + slot * SLOT;
    const traffic = countries === null ? null : new ObjectTraffic(countries);
    const object = harness.engine.openObject(objectKey(endMs), endMs, traffic);
    if (!object.ok) throw new Error(object.reason);
    const splitter = new LineSplitter((text) => harness.engine.ingest(object, text));
    for (let done = 0; done < perSlot; done += BATCH) {
      const lines = [];
      for (let i = 0; i < Math.min(BATCH, perSlot - done); i += 1) {
        lines.push(albLine({ fields: 36, ...build(random, endMs - Math.floor(random() * SLOT), line) }));
        line += 1;
      }
      const data = Buffer.from(`${lines.join('\n')}\n`, 'latin1');
      bytes += data.length;
      const started = process.cpuUsage();
      for (let at = 0; at < data.length; at += CHUNK) {
        const clock = performance.now();
        splitter.push(data.subarray(at, at + CHUNK));
        maxChunk = Math.max(maxChunk, performance.now() - clock);
      }
      const spent = process.cpuUsage(started);
      cpu += spent.user + spent.system;
    }
    splitter.end();
    const started = process.cpuUsage();
    const whole = performance.now();
    const steps = harness.engine.evaluateSteps({ now: endMs + 60_000 });
    for (;;) {
      const clock = performance.now();
      const step = steps.next();
      maxStep = Math.max(maxStep, performance.now() - clock);
      if (step.done) {
        last = step.value;
        break;
      }
    }
    maxEvaluate = Math.max(maxEvaluate, performance.now() - whole);
    const spent = process.cpuUsage(started);
    cpu += spent.user + spent.system;
    maxHeap = Math.max(maxHeap, (await settled()) - heapBefore);
  }
  const { counters, drafts, notes } = last;
  console.log(
    JSON.stringify({
      cenario: name,
      linhas: line,
      MB: Math.round(bytes / 1e6),
      cpuSegundos: Number((cpu / 1e6).toFixed(1)),
      linhasPorSegundo: Math.round(line / (cpu / 1e6)),
      heapMaxMB: Number((maxHeap / 1e6).toFixed(1)),
      blocoMaxMs: Number(maxChunk.toFixed(1)),
      avaliacaoMaxMs: Number(maxEvaluate.toFixed(1)),
      passoMaxMs: Number(maxStep.toFixed(1)),
      uso: harness.engine.usage,
      contadores: counters,
      achados: drafts.length,
      notas: notes,
    }),
  );
}

// Aquecimento, fora da medida.
{
  const harness = new Harness({ now: T0 });
  const object = harness.engine.openObject(objectKey(T0), T0);
  const random = prng(2);
  for (let i = 0; i < 20_000; i += 1) harness.engine.ingest(object, albLine(common(random, T0 - 1_000)));
  harness.evaluate();
}
/**
 * Um arquivo de 512 MB descompactados, em membros de gzip iguais: o corpo não ocupa memória. Com `collect`, a memória é
 * medida no meio da leitura, depois da coleta (que para o laço de eventos: por isso, à parte do tempo).
 */
async function runObject(collect) {
  const random = prng(3);
  const lines = [];
  for (let i = 0; i < 12_000; i += 1) lines.push(albLine({ fields: 36, ...common(random, T0 - 1_000) }));
  const text = Buffer.from(`${lines.join('\n')}\n`, 'latin1');
  const member = gzipSync(text);
  const copies = Math.floor((512 * 1024 * 1024) / text.length);
  lines.length = 0;
  const heapBefore = await settled();
  const harness = new Harness({ now: T0, countries });
  const traffic = countries === null ? null : new ObjectTraffic(countries);
  const object = harness.engine.openObject(objectKey(T0), T0, traffic);
  if (!object.ok) throw new Error(object.reason);
  function* body() {
    for (let i = 0; i < copies; i += 1) {
      for (let at = 0; at < member.length; at += CHUNK) yield member.subarray(at, at + CHUNK);
    }
  }
  let counted = 0;
  let peak = 0;
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  const started = process.cpuUsage();
  const read = await readAlbObject(
    Readable.from(body(), { objectMode: false }),
    copies * member.length,
    (line) => {
      harness.engine.ingest(object, line);
      counted += 1;
      if (collect && counted % 100_000 === 0) {
        gc();
        const { heapUsed, arrayBuffers } = process.memoryUsage();
        peak = Math.max(peak, heapUsed + arrayBuffers - heapBefore);
      }
    },
    new AbortController().signal,
  );
  const spent = process.cpuUsage(started);
  delay.disable();
  const mb = (value) => Number((value / 1e6).toFixed(1));
  console.log(
    JSON.stringify({
      cenario: 'objeto',
      linhas: read.lines,
      MB: Math.round(read.bytes / 1e6),
      compactadoMB: Math.round((copies * member.length) / 1e6),
      ...(collect
        ? { heapMaxMB: mb(peak) }
        : {
            cpuSegundos: mb(spent.user + spent.system),
            lacoMaxMs: mb(delay.max),
            lacoP99Ms: mb(delay.percentile(99)),
          }),
      contado:
        traffic
          ?.deltas({ tenantId: '', sourceId: '' }, new Date(0))
          .reduce((sum, row) => sum + row.requests, 0) ?? 0,
    }),
  );
}

if (scenario === 'objeto') {
  await runObject(false);
  await runObject(true);
} else {
  if (scenario !== 'enchente') await run('comum', common);
  if (scenario !== 'comum') await run('enchente', hostile);
}

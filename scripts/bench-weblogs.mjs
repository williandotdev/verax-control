// Benchmark do motor de ataques web (apps/api/src/weblogs), só por pedido: não roda no CI nem nos testes.
//
//   node --expose-gc scripts/bench-weblogs.mjs [linhas, padrão 1000000] [comum|enchente]
//
// Alvos do desenho (1 milhão de linhas, tráfego comum): até 25 s de CPU, até 40 MB de heap a mais e até 50 ms de bloqueio
// do laço de eventos (`blocoMaxMs`, um pedaço de 64 KB; `passoMaxMs`, um passo da avaliação). A `enchente` é o pior caso
// que um atacante consegue: tudo único, tudo recusado. Dados fictícios (RFC 5737, RFC 2544 e RFC 3849). As linhas passam pelo separador em pedaços de 64 KB, como na
// leitura de um objeto do S3; gerar as linhas não entra na conta.
//
// Roda o TypeScript direto (o Node remove os tipos); precisa do `packages/shared` compilado (`pnpm typecheck` o compila).
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setImmediate } from 'node:timers/promises';

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

const TOTAL = Number(process.argv[2] ?? 1_000_000);
const SLOTS = 12;
const BATCH = 10_000;
const CHUNK = 64 * 1024;
const gc = globalThis.gc;
if (gc === undefined) throw new Error('rode com --expose-gc');

const ipv4 = (i) => `198.${18 + ((i >> 16) & 1)}.${(i >> 8) & 255}.${i & 255}`;
const ipv6 = (i) => `2001:db8:${(i >> 8) & 0xffff}:${i & 255}::${(i % 1000).toString(16)}`;

/** Tráfego comum: 12 mil visitantes, caminhos repetidos, 5% de erro, logins e meia dúzia de atacantes. */
function common(random, time) {
  const dice = random();
  const client = ipv4(Math.floor(random() ** 2 * 12_000));
  const userAgent = `Mozilla/5.0 (variante ${Math.floor(random() * 400)}) Chrome/140.0 Safari/537.36`;
  if (dice < 0.02)
    return { time, client, userAgent, method: 'POST', path: '/login', status: random() < 0.3 ? 401 : 302 };
  if (dice < 0.04)
    return { time, client: ipv4(90_000), path: `/p${Math.floor(random() * 2e6)}`, status: 404 };
  if (dice < 0.05) return { time, client: ipv4(90_001), method: 'POST', path: '/login', status: 401 };
  if (dice < 0.06)
    return { time, client: ipv4(90_002), path: `/x${Math.floor(random() * 500)}/.env`, status: 404 };
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
    client: i % 3 === 0 ? ipv6(i) : ipv4(i % 131_072),
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
  const harness = new Harness({ now: T0 });
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
    const object = harness.engine.openObject(objectKey(endMs), endMs);
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
if (process.argv[3] !== 'enchente') await run('comum', common);
if (process.argv[3] !== 'comum') await run('enchente', hostile);

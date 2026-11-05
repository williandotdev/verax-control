import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import {
  GUEST_ATTRIBUTE_SPACING_MS,
  GuestAttributeWriteError,
  type NodeStatusSource,
  NodeStatusReporter,
  type StatFs,
  WritePacer,
} from '../src/node-status/node-status.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** Quando o pedido chegou, pelo relógio monotônico. */
  at: number;
}

/** O limite da GCP para os guest attributes: no máximo 3 consultas em qualquer janela de 1 s. */
const BURST_LIMIT = 3;
const BURST_WINDOW_MS = 1000;

/**
 * Servidor de metadados falso, em 127.0.0.1: guarda cada pedido (método, caminho, cabeçalhos, corpo e a hora em que
 * chegou) e responde com o status do momento (200; 403 como a VM com os guest attributes desligados; 500; ou um
 * redirecionamento). Confere o ritmo como a GCP pede: o pedido que faz mais de 3 caírem na mesma janela de 1 s conta
 * como violação e recebe 429. A conta atravessa os testes (as execuções seguidas também entram nela).
 */
class FakeMetadata {
  readonly received: Received[] = [];
  status = 200;
  violations = 0;
  private readonly arrivals: number[] = [];
  private server: Server | undefined;

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const at = performance.now();
      this.arrivals.push(at);
      const burst = this.arrivals.filter((other) => other > at - BURST_WINDOW_MS).length > BURST_LIMIT;
      if (burst) this.violations += 1;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        this.received.push({
          method: request.method ?? '',
          path: request.url ?? '',
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          at,
        });
        if (burst) {
          response.writeHead(429).end();
          return;
        }
        if (this.status === 302) {
          response.writeHead(302, { location: 'http://127.0.0.1:9/outro' }).end();
          return;
        }
        response.writeHead(this.status, { 'content-type': 'text/plain' }).end('corpo que não é lido');
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/computeMetadata/v1/instance/guest-attributes`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** O valor gravado em cada atributo, na ordem dos PUTs. */
  attributes(): Record<string, string> {
    return Object.fromEntries(
      this.received.map((item) => [item.path.replace(/^.*\/guest-attributes\//, ''), item.body]),
    );
  }
}

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
/** Disco com 1000 blocos, 237 livres para quem não é root: 23%. */
const fixedDisk: StatFs = () => Promise.resolve({ bavail: 237, blocks: 1000 });

class RecordingLogger {
  readonly warnings: { fields: object; message: string }[] = [];
  warn(fields: object, message: string): void {
    this.warnings.push({ fields, message });
  }
}

describe('tarefa node-status do worker: estado do nó nos guest attributes (fase 3, CP-10)', () => {
  const metadata = new FakeMetadata();
  let baseUrl: string;
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let emptyTenant: string;
  const accountIds: string[] = [];
  const at = (iso: string) => new Date(iso);

  async function account(
    tenantId: string,
    data: {
      connection: 'waiting' | 'connected' | 'error';
      status?: 'active' | 'inactive';
      lastEventAt?: Date;
    },
  ): Promise<void> {
    const accountId = String(randomInt(100_000_000_000, 999_999_999_999));
    accountIds.push(accountId);
    await prisma.cloudAccount.create({
      data: {
        tenantId,
        accountId,
        regions: ['sa-east-1'],
        connection: data.connection,
        status: data.status ?? 'active',
        lastEventAt: data.lastEventAt ?? null,
      },
    });
  }

  const reporter = (
    db: NodeStatusSource,
    overrides: Partial<ConstructorParameters<typeof NodeStatusReporter>[1]> = {},
  ) =>
    new NodeStatusReporter(db, {
      version: COMMIT,
      logger: new RecordingLogger(),
      baseUrl,
      statfs: fixedDisk,
      ...overrides,
    });

  beforeAll(async () => {
    baseUrl = await metadata.start();
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (estado do nó)');
    tenantB = await createTenant(app, 'Cliente Demo B (estado do nó)');
    emptyTenant = await createTenant(app, 'Cliente Demo C (estado do nó, sem contas)');
    // Cliente A: duas conectadas (a mais recente em 03/11), uma aguardando, uma com erro e uma desativada com evento
    // mais novo (fica de fora: só as ativas contam).
    await account(tenantA, { connection: 'connected', lastEventAt: at('2026-11-02T10:00:00.000Z') });
    await account(tenantA, { connection: 'connected', lastEventAt: at('2026-11-03T08:30:15.250Z') });
    await account(tenantA, { connection: 'waiting' });
    await account(tenantA, { connection: 'error', lastEventAt: at('2026-11-01T00:00:00.000Z') });
    await account(tenantA, {
      connection: 'connected',
      status: 'inactive',
      lastEventAt: at('2026-11-04T00:00:00.000Z'),
    });
    // Cliente B: uma conectada, com evento mais novo que todos os do A.
    await account(tenantB, { connection: 'connected', lastEventAt: at('2026-11-04T12:00:00.000Z') });
  });

  beforeEach(() => {
    metadata.received.length = 0;
    metadata.status = 200;
  });

  afterEach(() => {
    // Nenhum teste passou do limite da GCP: nenhuma janela de 1 s com mais de 3 PUTs.
    expect(metadata.violations).toBe(0);
  });

  afterAll(async () => {
    await app.close();
    await metadata.stop();
  });

  it('grava os quatro atributos com PUT, no namespace verax, com o cabeçalho do servidor de metadados', async () => {
    const report = await reporter(prisma.forTenant(tenantA)).runOnce();
    expect(report).toEqual({ written: 4 });
    expect(metadata.received.map((item) => `${item.method} ${item.path}`)).toEqual([
      'PUT /computeMetadata/v1/instance/guest-attributes/verax/version',
      'PUT /computeMetadata/v1/instance/guest-attributes/verax/accounts-connected',
      'PUT /computeMetadata/v1/instance/guest-attributes/verax/last-event-at',
      'PUT /computeMetadata/v1/instance/guest-attributes/verax/disk-free',
    ]);
    for (const item of metadata.received) expect(item.headers['metadata-flavor']).toBe('Google');
    expect(metadata.attributes()).toEqual({
      'verax/version': COMMIT,
      'verax/accounts-connected': '2',
      'verax/last-event-at': '2026-11-03T08:30:15.250Z',
      'verax/disk-free': '23',
    });
  });

  it('A/B: cada cliente só com as próprias contas; nenhum atributo identifica cliente ou conta', async () => {
    await reporter(prisma.forTenant(tenantB)).runOnce();
    expect(metadata.attributes()).toMatchObject({
      'verax/accounts-connected': '1',
      'verax/last-event-at': '2026-11-04T12:00:00.000Z',
    });
    metadata.received.length = 0;
    await reporter(prisma.forTenant(tenantA)).runOnce();
    expect(metadata.attributes()['verax/accounts-connected']).toBe('2');

    // No worker, a busca é de sistema: o nó inteiro (aqui, com os outros arquivos no mesmo banco, pelo menos os três).
    metadata.received.length = 0;
    await reporter(prisma).runOnce();
    expect(Number(metadata.attributes()['verax/accounts-connected'])).toBeGreaterThanOrEqual(3);

    const everything = JSON.stringify(metadata.received);
    for (const value of [tenantA, tenantB, ...accountIds, 'Cliente Demo']) {
      expect(everything).not.toContain(value);
    }
  });

  it('sem conta nem evento: zero contas e last-event-at = none', async () => {
    await reporter(prisma.forTenant(emptyTenant)).runOnce();
    expect(metadata.attributes()).toMatchObject({
      'verax/accounts-connected': '0',
      'verax/last-event-at': 'none',
    });
  });

  it('guest attributes desligados (403): avisa uma vez, para no primeiro PUT e não lê o banco', async () => {
    metadata.status = 403;
    const logger = new RecordingLogger();
    const untouchable = new Proxy({} as NodeStatusSource, {
      get() {
        throw new Error('o banco não deveria ser lido com os guest attributes desligados');
      },
    });
    const task = reporter(untouchable, { logger });
    for (let run = 0; run < 3; run += 1) {
      expect(await task.runOnce()).toEqual({ written: 0, disabled: true });
    }
    expect(metadata.received).toHaveLength(3);
    expect(metadata.received.every((item) => item.path.endsWith('/verax/version'))).toBe(true);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]?.message).toContain('guest attributes desligados');
  });

  it('ligados depois: volta a publicar; desligados de novo, avisa de novo uma vez', async () => {
    const logger = new RecordingLogger();
    const task = reporter(prisma.forTenant(tenantA), { logger });
    metadata.status = 404;
    await task.runOnce();
    metadata.status = 200;
    expect(await task.runOnce()).toEqual({ written: 4 });
    metadata.status = 403;
    await task.runOnce();
    await task.runOnce();
    expect(logger.warnings).toHaveLength(2);
  });

  it('outro erro do servidor de metadados falha a execução (só o status, nunca o corpo)', async () => {
    metadata.status = 500;
    const failure = reporter(prisma.forTenant(tenantA)).runOnce();
    await expect(failure).rejects.toBeInstanceOf(GuestAttributeWriteError);
    await expect(failure).rejects.toMatchObject({ status: 500 });
    await expect(failure).rejects.not.toThrow('corpo que não é lido');
  });

  it('não segue redirecionamento', async () => {
    metadata.status = 302;
    await expect(reporter(prisma.forTenant(tenantA)).runOnce()).rejects.toThrow();
    expect(metadata.received).toHaveLength(1);
  });

  it('disco que não pode ser medido: os outros atributos saem, e o disk-free fica como estava', async () => {
    const report = await reporter(prisma.forTenant(tenantA), {
      statfs: () => Promise.reject(new Error('ENOENT')),
    }).runOnce();
    expect(report).toEqual({ written: 3, diskFree: 'unavailable' });
    expect(Object.keys(metadata.attributes())).toEqual([
      'verax/version',
      'verax/accounts-connected',
      'verax/last-event-at',
    ]);
  });

  it('disco: porcentagem inteira de 0 a 100, pelo espaço livre para quem não é root', async () => {
    const cases: [number | bigint, number | bigint, string][] = [
      [0, 1000, '0'],
      [1000, 1000, '100'],
      [999, 1000, '99'],
      [5n, 10n, '50'],
    ];
    for (const [bavail, blocks, expected] of cases) {
      metadata.received.length = 0;
      await reporter(prisma.forTenant(emptyTenant), {
        statfs: () => Promise.resolve({ bavail, blocks }),
      }).runOnce();
      expect(metadata.attributes()['verax/disk-free']).toBe(expected);
    }
    // Disco com zero blocos (não deveria existir): o atributo fica de fora.
    metadata.received.length = 0;
    const report = await reporter(prisma.forTenant(emptyTenant), {
      statfs: () => Promise.resolve({ bavail: 0, blocks: 0 }),
    }).runOnce();
    expect(report).toMatchObject({ diskFree: 'unavailable' });
  });

  it('o disco de verdade (statfs do Node num caminho que existe) dá um valor de 0 a 100', async () => {
    await reporter(prisma.forTenant(emptyTenant), { statfs: undefined, diskProbe: process.cwd() }).runOnce();
    expect(Number(metadata.attributes()['verax/disk-free'])).toBeGreaterThanOrEqual(0);
    expect(Number(metadata.attributes()['verax/disk-free'])).toBeLessThanOrEqual(100);
  });

  it('ritmo: os PUTs saem espaçados, também entre execuções seguidas, e nenhum segundo tem mais de 3', async () => {
    await reporter(prisma.forTenant(tenantA)).runOnce();
    await reporter(prisma.forTenant(tenantB)).runOnce();
    expect(metadata.received).toHaveLength(8);
    const gaps = metadata.received
      .slice(1)
      .map((item, index) => item.at - (metadata.received[index]?.at ?? 0));
    // O espaço é medido no começo de cada PUT; na chegada, uma folga para o agendamento do processo.
    for (const gap of gaps) expect(gap).toBeGreaterThan(GUEST_ATTRIBUTE_SPACING_MS - 100);
    for (const item of metadata.received) {
      const inWindow = metadata.received.filter((other) => other.at > item.at - 1000 && other.at <= item.at);
      expect(inWindow.length).toBeLessThanOrEqual(3);
    }
  });

  it('o falso confere o limite: PUTs sem o ritmo passam de 3 por segundo e são recusados', async () => {
    const unpaced = reporter(prisma.forTenant(tenantA), { pacer: new WritePacer(0) });
    await expect(unpaced.runOnce()).rejects.toMatchObject({ status: 429 });
    expect(metadata.violations).toBeGreaterThan(0);
    // A violação era do teste: zera para o afterEach, e o próximo teste espera a janela passar.
    metadata.violations = 0;
    await new Promise((resolve) => setTimeout(resolve, BURST_WINDOW_MS));
  });

  it('o ritmo reserva o horário antes de esperar (chamadas ao mesmo tempo saem espaçadas) e respeita o sinal', async () => {
    const pacer = new WritePacer(200);
    const never = new AbortController().signal;
    const started = performance.now();
    const times: number[] = [];
    await Promise.all(
      [0, 1, 2].map(async () => {
        await pacer.wait(never);
        times.push(performance.now() - started);
      }),
    );
    times.sort((a, b) => a - b);
    expect(times[1]).toBeGreaterThanOrEqual(150);
    expect(times[2]).toBeGreaterThanOrEqual(350);

    const slow = new WritePacer(60_000);
    await slow.wait(never);
    const controller = new AbortController();
    const waiting = slow.wait(controller.signal);
    controller.abort(new DOMException('o worker está parando', 'AbortError'));
    await expect(waiting).rejects.toThrow('o worker está parando');
  });

  it('o sinal do agendador (parada do worker, orçamento) interrompe a execução', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('o worker está parando', 'AbortError'));
    await expect(reporter(prisma.forTenant(tenantA)).runOnce(controller.signal)).rejects.toThrow();
  });
});

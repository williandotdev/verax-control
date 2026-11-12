import 'reflect-metadata';
import { randomBytes, randomInt } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
  type CellCommand,
  type CellReport,
  cellCloudIdentitySchema,
  cellReportSchema,
  type CellTenantState,
} from '@verax/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findWazuhSourceRows } from '../src/aws/wazuh-sources.js';
import {
  CellCommands,
  type CellCommandsLogger,
  type TenantExporter,
  type TenantPurger,
} from '../src/cell/cell-commands.js';
import { CellReportOutbox } from '../src/cell/cell-report-outbox.js';
import { CELL_REPORT_RETRY_MS, CellReportPublisher } from '../src/cell/cell-report-publisher.js';
import { readCellTenantState, recordTenantExport } from '../src/cell/cell-tenant-state.js';
import { CellTenantStatusReporter } from '../src/cell/cell-tenant-status.js';
import { listRouteInputKeys } from '../src/common/http/route-contracts.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import type {
  PubsubMessage,
  PubsubOutgoingMessage,
  PubsubPublisher,
  PubsubReader,
} from '../src/gcp/pubsub.client.js';
import { setTenantLifecycleStatus } from '../src/tenants/tenant-lifecycle.js';
import { createApp } from './support/create-app.js';

const CELL = 'celula-teste';
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Um ULID novo a cada chamada (os arquivos de teste dividem o banco). */
function ulid(): string {
  return Array.from({ length: 26 }, () => ULID_ALPHABET[randomInt(0, 32)]).join('');
}

/** Subdomínio único, curto o bastante para caber em `vxt-<slug>`. */
function slug(): string {
  return `ct-${randomBytes(4).toString('hex')}`;
}

function uniqueId(): string {
  return `1${Array.from({ length: 20 }, () => randomInt(0, 10)).join('')}`;
}

/** O estado desejado de um cliente da Plataforma, no domínio reservado para exemplos. */
function stateOf(tenantSlug: string, overrides: Partial<CellTenantState> = {}): CellTenantState {
  return {
    slug: tenantSlug,
    name: `Cliente Demo ${tenantSlug}`,
    hosts: { api: `api-${tenantSlug}.example.com`, panel: `${tenantSlug}.control.example.com` },
    status: 'active',
    plan: {
      planId: 'plataforma',
      limits: { maxCloudAccounts: 10, maxUsers: 10, monthlyGib: null, historyDays: 90 },
      franchiseGbPerDay: 3,
    },
    franchiseSchedule: [{ from: '2026-11-01', gbPerDay: 3 }],
    billingPeriod: { start: '2026-11-01', end: '2026-11-30' },
    cloudIdentity: {
      saEmail: `vxt-${tenantSlug}@projeto-exemplo.iam.gserviceaccount.com`,
      saUniqueId: uniqueId(),
    },
    gcpSources: [],
    natIps: ['203.0.113.10'],
    lastBilledCycle: null,
    unitPrices: null,
    ...overrides,
  };
}

function envelope(tenantId: string) {
  return { v: 1 as const, commandId: ulid(), cellId: CELL, tenantId, issuedAt: new Date().toISOString() };
}

function upsert(tenantId: string, generation: number, state: CellTenantState): CellCommand {
  return { ...envelope(tenantId), kind: 'tenant.upsert', generation, state };
}

/** O logger do worker num dublê: guarda os campos, para conferir que nada do comando vaza. */
class RecordingLogger implements CellCommandsLogger {
  readonly lines: { fields: object; message: string }[] = [];
  info(fields: object, message: string): void {
    this.lines.push({ fields, message });
  }
  warn(fields: object, message: string): void {
    this.lines.push({ fields, message });
  }
  error(fields: object, message: string): void {
    this.lines.push({ fields, message });
  }
}

/** A assinatura de comandos em memória: entrega o que foi posto e guarda o que foi confirmado. */
class MemoryReader implements PubsubReader {
  queue: PubsubMessage[] = [];
  readonly acked: string[] = [];
  put(data: string, ackId = `ack-${randomBytes(4).toString('hex')}`): string {
    this.queue.push({ ackId, data: Buffer.from(data, 'utf8').toString('base64'), messageId: ackId });
    return ackId;
  }
  pull(_subscription: string, max: number): Promise<PubsubMessage[]> {
    const pending = this.queue.filter((message) => !this.acked.includes(message.ackId));
    return Promise.resolve(pending.slice(0, max));
  }
  acknowledge(_subscription: string, ackIds: readonly string[]): Promise<void> {
    this.acked.push(...ackIds);
    return Promise.resolve();
  }
}

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles(srcDir)
    .filter((file) => pattern.test(readFileSync(file, 'utf8')))
    .map((file) => relative(srcDir, file).replaceAll('\\', '/'))
    .sort();
}

describe('canal da célula, lado do nó (CE-05)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: CellReportOutbox;
  let logger: RecordingLogger;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    outbox = new CellReportOutbox(CELL);
    logger = new RecordingLogger();
  });

  afterAll(async () => {
    await app.close();
  });

  function commands(
    options: { exporter?: TenantExporter; purger?: TenantPurger; reader?: MemoryReader } = {},
  ) {
    return new CellCommands(prisma, {
      cellId: CELL,
      subscription: 'projects/projeto-exemplo/subscriptions/vxc-celula-teste-comandos',
      reader: options.reader ?? new MemoryReader(),
      outbox,
      logger,
      exporter: options.exporter ?? null,
      purger: options.purger ?? null,
    });
  }

  /** Os relatórios na caixa de saída que citam o cliente (do plano de controle), na ordem em que nasceram. */
  async function reportsOf(controlPlaneId: string): Promise<CellReport[]> {
    const rows = await prisma.cellReport.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    return rows
      .map((row) => cellReportSchema.parse(row.body))
      .filter((report) => report.kind !== 'cell.status' && report.tenantId === controlPlaneId);
  }

  async function nodeTenantOf(controlPlaneId: string): Promise<string> {
    return (await prisma.cellTenantState.findUniqueOrThrow({ where: { controlPlaneId } })).tenantId;
  }

  /** Um cliente da célula já criado pelo canal, na geração 1. */
  async function cellTenant(state: CellTenantState = stateOf(slug())) {
    const controlPlaneId = ulid();
    expect(await commands().apply(upsert(controlPlaneId, 1, state))).toEqual({
      outcome: 'applied',
      created: true,
    });
    return { controlPlaneId, tenantId: await nodeTenantOf(controlPlaneId), state };
  }

  describe('tenant.upsert', () => {
    it('o cliente novo nasce com endereço, plano, estado, identidade e o tenant.applied, numa transação', async () => {
      const { controlPlaneId, tenantId, state } = await cellTenant();
      const tenant = await prisma.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        include: { host: true, tenantPlan: true, cloudIdentity: true, cellState: true },
      });
      expect(tenant).toMatchObject({
        name: state.name,
        status: 'active',
        host: { slug: state.slug },
        tenantPlan: { planId: 'plataforma', franchiseGbPerDay: 3, source: 'control_plane' },
        cloudIdentity: state.cloudIdentity,
        cellState: { controlPlaneId, generation: 1, collectionPausedAt: null },
      });
      expect((await readCellTenantState(prisma, tenantId))?.desired).toEqual({
        franchiseSchedule: state.franchiseSchedule,
        billingPeriod: state.billingPeriod,
        natIps: state.natIps,
        gcpSources: [],
        lastBilledCycle: null,
        unitPrices: null,
      });
      expect(await reportsOf(controlPlaneId)).toMatchObject([
        { kind: 'tenant.applied', cellId: CELL, tenantId: controlPlaneId, generation: 1 },
      ]);
      const trail = await prisma.auditLog.findMany({
        where: { tenantId, action: 'tenant.cell_state_applied' },
      });
      expect(trail).toMatchObject([{ actorType: 'system', actorId: 'control-plane', outcome: 'success' }]);
    });

    it('a geração seguinte aplica o estado inteiro: nome, plano, suspensão (com a trilha) e franquia', async () => {
      const { controlPlaneId, tenantId, state } = await cellTenant();
      const next = stateOf(state.slug, {
        name: `${state.name} Ltda`,
        status: 'suspended',
        cloudIdentity: state.cloudIdentity,
        plan: { ...state.plan, franchiseGbPerDay: 5 },
        franchiseSchedule: [
          { from: '2026-11-01', gbPerDay: 3 },
          { from: '2026-11-12', gbPerDay: 5 },
        ],
      });
      expect(await commands().apply(upsert(controlPlaneId, 2, next))).toEqual({
        outcome: 'applied',
        created: false,
      });
      expect(
        await prisma.tenant.findUniqueOrThrow({
          where: { id: tenantId },
          include: { tenantPlan: true, cellState: true },
        }),
      ).toMatchObject({
        name: next.name,
        status: 'suspended',
        tenantPlan: { franchiseGbPerDay: 5 },
        cellState: { generation: 2 },
      });
      const lifecycle = await prisma.auditLog.findMany({
        where: { tenantId, action: 'tenant.lifecycle_suspend' },
      });
      expect(lifecycle).toMatchObject([{ actorType: 'system', actorId: 'control-plane' }]);
    });

    it('idempotente: o mesmo comando de novo não muda nada e repete o tenant.applied', async () => {
      const controlPlaneId = ulid();
      const command = upsert(controlPlaneId, 1, stateOf(slug()));
      expect(await commands().apply(command)).toMatchObject({ outcome: 'applied' });
      const tenantId = await nodeTenantOf(controlPlaneId);
      const before = await prisma.cellTenantState.findUniqueOrThrow({ where: { tenantId } });
      expect(await commands().apply(command)).toEqual({ outcome: 'duplicate' });
      expect(await prisma.cellTenantState.findUniqueOrThrow({ where: { tenantId } })).toEqual(before);
      expect(await prisma.tenant.count({ where: { cellState: { controlPlaneId } } })).toBe(1);
      expect((await reportsOf(controlPlaneId)).map((report) => report.kind)).toEqual([
        'tenant.applied',
        'tenant.applied',
      ]);
      const trail = await prisma.auditLog.count({ where: { tenantId, action: 'tenant.cell_state_applied' } });
      expect(trail).toBe(1);
    });

    it('geração velha é ignorada: o estado da mais nova fica, sem relatório', async () => {
      const { controlPlaneId, tenantId, state } = await cellTenant();
      const renamed = stateOf(state.slug, { name: 'Nome da geração 3', cloudIdentity: state.cloudIdentity });
      await commands().apply(upsert(controlPlaneId, 3, renamed));
      const old = stateOf(state.slug, { name: 'Nome da geração 2', cloudIdentity: state.cloudIdentity });
      expect(await commands().apply(upsert(controlPlaneId, 2, old))).toEqual({ outcome: 'stale' });
      expect(await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).toMatchObject({
        name: 'Nome da geração 3',
      });
      expect((await prisma.cellTenantState.findUniqueOrThrow({ where: { tenantId } })).generation).toBe(3);
      expect((await reportsOf(controlPlaneId)).map((report) => report.kind)).toEqual([
        'tenant.applied',
        'tenant.applied',
      ]);
    });

    it('o subdomínio de outro cliente é recusado inteiro: nenhum cliente nasce, e sai o command.refused', async () => {
      const first = await cellTenant();
      const controlPlaneId = ulid();
      const tenantsBefore = await prisma.tenant.count();
      const result = await commands().apply(upsert(controlPlaneId, 1, stateOf(first.state.slug)));
      expect(result).toEqual({ outcome: 'refused', code: 'slug_conflict' });
      expect(await prisma.tenant.count()).toBe(tenantsBefore);
      expect(await prisma.cellTenantState.findUnique({ where: { controlPlaneId } })).toBeNull();
      expect(await reportsOf(controlPlaneId)).toMatchObject([
        { kind: 'command.refused', command: 'tenant.upsert', code: 'slug_conflict' },
      ]);
    });

    it('a conta de serviço de outro cliente é recusada (uma conta nunca é de dois clientes)', async () => {
      const first = await cellTenant();
      const controlPlaneId = ulid();
      const other = stateOf(slug(), { cloudIdentity: first.state.cloudIdentity });
      expect(await commands().apply(upsert(controlPlaneId, 1, other))).toEqual({
        outcome: 'refused',
        code: 'identity_conflict',
      });
      expect(await prisma.tenantHost.findUnique({ where: { slug: other.slug } })).toBeNull();
    });

    it('a transição fora da tabela é recusada, e o estado anterior fica (cancelado não volta a ativo)', async () => {
      const { controlPlaneId, tenantId, state } = await cellTenant();
      await commands().apply(upsert(controlPlaneId, 2, { ...state, status: 'canceled' }));
      const result = await commands().apply(
        upsert(controlPlaneId, 3, { ...state, status: 'active', name: 'Outro' }),
      );
      expect(result).toEqual({ outcome: 'refused', code: 'transition_refused' });
      expect(await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).toMatchObject({
        status: 'canceled',
        name: state.name,
      });
      expect((await prisma.cellTenantState.findUniqueOrThrow({ where: { tenantId } })).generation).toBe(2);
    });
  });

  describe('a tarefa: assinatura, contrato estrito e confirmação', () => {
    it('confirma e descarta o que não é do contrato ou de outra célula, sem tocar o banco nem logar o conteúdo', async () => {
      const reader = new MemoryReader();
      const controlPlaneId = ulid();
      const valid = upsert(controlPlaneId, 1, stateOf(slug()));
      reader.put('{não é json');
      reader.put(JSON.stringify({ ...valid, admin: 'valor-secreto-que-nao-vaza' }));
      reader.put(JSON.stringify({ ...valid, v: 2 }));
      reader.put(JSON.stringify({ ...valid, cellId: 'outra-celula' }));
      const good = reader.put(JSON.stringify(valid));
      const report = await commands({ reader }).runOnce();
      expect(report).toMatchObject({ received: 5, invalid: 3, foreign: 1, applied: 1 });
      expect(reader.acked).toHaveLength(5);
      expect(reader.acked).toContain(good);
      expect(await prisma.cellTenantState.count({ where: { controlPlaneId } })).toBe(1);
      expect(JSON.stringify(logger.lines)).not.toContain('valor-secreto-que-nao-vaza');
    });

    it('uma falha do banco não confirma a mensagem (ela volta) e não deixa nada pela metade', async () => {
      const reader = new MemoryReader();
      const controlPlaneId = ulid();
      const state = stateOf(slug());
      reader.put(JSON.stringify(upsert(controlPlaneId, 1, state)));
      const failing = new CellCommands(prisma, {
        cellId: CELL,
        subscription: 'projects/projeto-exemplo/subscriptions/vxc-celula-teste-comandos',
        reader,
        // A caixa de saída que falha: o relatório é a última escrita da transação.
        outbox: { enqueue: () => Promise.reject(new Error('banco fora')) } as unknown as CellReportOutbox,
        logger,
      });
      await expect(failing.runOnce()).rejects.toThrow('banco fora');
      expect(reader.acked).toEqual([]);
      expect(await prisma.cellTenantState.count({ where: { controlPlaneId } })).toBe(0);
      expect(await prisma.tenantHost.findUnique({ where: { slug: state.slug } })).toBeNull();
      expect(await prisma.tenant.count({ where: { name: state.name } })).toBe(0);
    });
  });

  describe('exportação e expurgo: as guardas', () => {
    const purgeOf = (controlPlaneId: string, confirmSlug: string): CellCommand => ({
      ...envelope(controlPlaneId),
      kind: 'tenant.purge',
      purgeId: ulid(),
      confirmSlug,
    });
    const exportOf = (controlPlaneId: string, exportId = ulid()): CellCommand => ({
      ...envelope(controlPlaneId),
      kind: 'tenant.export',
      exportId,
    });
    const fakeExport = (controlPlaneId: string, exportId: string) => ({
      exportId,
      object: `${CELL}/${controlPlaneId}/20261111T120000Z.tar.gz`,
      sha256: 'a'.repeat(64),
      bytes: 2048,
    });

    it('cliente desconhecido, subdomínio errado e cliente não cancelado são recusados, nessa ordem', async () => {
      expect(await commands().apply(purgeOf(ulid(), 'qualquer'))).toEqual({
        outcome: 'refused',
        code: 'tenant_unknown',
      });
      const { controlPlaneId, state } = await cellTenant();
      expect(await commands().apply(purgeOf(controlPlaneId, 'outro-slug'))).toEqual({
        outcome: 'refused',
        code: 'purge_slug_mismatch',
      });
      expect(await commands().apply(purgeOf(controlPlaneId, state.slug))).toEqual({
        outcome: 'refused',
        code: 'purge_not_canceled',
      });
      expect(await commands().apply(exportOf(controlPlaneId))).toEqual({
        outcome: 'refused',
        code: 'export_not_canceled',
      });
    });

    it('cancelado sem a exportação gravada: recusado; com ela e sem expurgador (até o CE-16): recusado sem mudar o estado', async () => {
      const { controlPlaneId, tenantId, state } = await cellTenant();
      await setTenantLifecycleStatus(prisma, tenantId, 'canceled');
      expect(await commands().apply(purgeOf(controlPlaneId, state.slug))).toEqual({
        outcome: 'refused',
        code: 'purge_export_missing',
      });
      expect(await commands().apply(exportOf(controlPlaneId))).toEqual({
        outcome: 'refused',
        code: 'export_unavailable',
      });
      await prisma.$transaction((tx) =>
        recordTenantExport(tx, outbox, tenantId, fakeExport(controlPlaneId, ulid()), new Date()),
      );
      expect(await commands().apply(purgeOf(controlPlaneId, state.slug))).toEqual({
        outcome: 'refused',
        code: 'purge_unavailable',
      });
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe('canceled');
    });

    it('com exportador e expurgador: exporta (o mesmo pedido repete o relatório), vai a purging e relata tenant.purged', async () => {
      const { controlPlaneId, tenantId, state } = await cellTenant();
      await setTenantLifecycleStatus(prisma, tenantId, 'canceled');
      const exportId = ulid();
      let exports = 0;
      const exporter: TenantExporter = {
        exportTenant: (request) => {
          exports += 1;
          expect(request).toEqual({ tenantId, controlPlaneId, exportId });
          return Promise.resolve(fakeExport(controlPlaneId, exportId));
        },
      };
      const purged: string[] = [];
      const purger: TenantPurger = {
        purgeTenant: async (id) => {
          expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).status).toBe('purging');
          purged.push(id);
        },
      };
      expect(await commands({ exporter }).apply(exportOf(controlPlaneId, exportId))).toEqual({
        outcome: 'applied',
      });
      expect(await commands({ exporter }).apply(exportOf(controlPlaneId, exportId))).toEqual({
        outcome: 'duplicate',
      });
      expect(exports).toBe(1);
      expect(await commands({ purger }).apply(purgeOf(controlPlaneId, state.slug))).toEqual({
        outcome: 'applied',
      });
      expect(purged).toEqual([tenantId]);
      expect((await reportsOf(controlPlaneId)).map((report) => report.kind)).toEqual([
        'tenant.applied',
        'export.ready',
        'export.ready',
        'tenant.purged',
      ]);
      // Em expurgo, só o expurgo mexe no cliente.
      expect(await commands().apply(upsert(controlPlaneId, 9, state))).toEqual({
        outcome: 'refused',
        code: 'tenant_purging',
      });
    });
  });

  describe('tenant.collection_pause', () => {
    it('a pausa tira as contas do cliente da coleta, sem mudar o estado; retomar as devolve', async () => {
      const { controlPlaneId, tenantId } = await cellTenant();
      await prisma.cloudAccount.create({
        data: {
          tenantId,
          provider: 'aws',
          accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
          regions: ['sa-east-1'],
          cloudtrailBucket: `trilha-${randomInt(1_000_000, 9_999_999)}`,
          connection: 'connected',
          ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
        },
      });
      expect(await findWazuhSourceRows(prisma, [tenantId])).toHaveLength(1);
      const pause = { ...envelope(controlPlaneId), kind: 'tenant.collection_pause' as const };
      expect(await commands().apply({ ...pause, paused: true, reason: 'runaway_volume' })).toEqual({
        outcome: 'applied',
      });
      expect(await findWazuhSourceRows(prisma, [tenantId])).toHaveLength(0);
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).status).toBe('active');
      expect(await commands().apply({ ...pause, commandId: ulid(), paused: true, reason: 'owner' })).toEqual({
        outcome: 'duplicate',
      });
      expect(await commands().apply({ ...pause, commandId: ulid(), paused: false })).toEqual({
        outcome: 'applied',
      });
      expect(await findWazuhSourceRows(prisma, [tenantId])).toHaveLength(1);
    });
  });

  describe('o que só o sistema grava', () => {
    it('nenhuma rota aceita a identidade do cliente na nuvem nem o estado do canal, em nenhuma profundidade', () => {
      const fields = ['cloudIdentity', 'controlPlaneId', ...Object.keys(cellCloudIdentitySchema.shape)];
      expect(fields).toEqual(['cloudIdentity', 'controlPlaneId', 'saEmail', 'saUniqueId']);
      const offenders = listRouteInputKeys(app).flatMap(({ route, keys }) =>
        keys.filter((key) => fields.includes(key)).map((key) => `${route}: ${key}`),
      );
      expect(offenders).toEqual([]);
      expect(listRouteInputKeys(app).some(({ keys }) => keys.includes('accountId'))).toBe(true);
    });

    it('só o módulo da célula grava a identidade e o estado do canal, e só o comando chama o gravador', () => {
      const identityWrites =
        /\btenantCloudIdentity\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/;
      const stateWrites =
        /\bcellTenantState\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\b/;
      expect(filesMatching(identityWrites)).toEqual(['cell/tenant-cloud-identity.ts']);
      expect(filesMatching(stateWrites)).toEqual(['cell/cell-commands.ts', 'cell/cell-tenant-state.ts']);
      expect(filesMatching(/\bwriteTenantCloudIdentity\b/)).toEqual([
        'cell/cell-commands.ts',
        'cell/tenant-cloud-identity.ts',
      ]);
      // As escritas do comando são só as do sistema: nenhuma outra tabela de cliente é gravada direto por ele.
      const source = readFileSync(join(srcDir, 'cell/cell-commands.ts'), 'utf8');
      const direct = [...source.matchAll(/\btx\.(\w+)\.(create|update|upsert|delete)\w*\(/g)].map(
        (match) => match[1],
      );
      expect([...new Set(direct)].sort()).toEqual(['cellTenantState', 'tenant']);
    });

    it('o escopo do cliente lê o próprio estado da célula, mas recusa gravá-lo', async () => {
      const { tenantId } = await cellTenant();
      const scoped = prisma.forTenant(tenantId);
      expect(await scoped.tenantCloudIdentity.findUnique({ where: { tenantId } })).not.toBeNull();
      expect(await readCellTenantState(scoped, tenantId)).not.toBeNull();
      expect(() =>
        scoped.tenantCloudIdentity.update({ where: { tenantId }, data: { saUniqueId: uniqueId() } }),
      ).toThrow(TenantScopeViolation);
      expect(() => scoped.cellTenantState.update({ where: { tenantId }, data: { generation: 99 } })).toThrow(
        TenantScopeViolation,
      );
    });

    it('o banco recusa a identidade fora do formato (o mesmo do contrato)', async () => {
      const { tenantId } = await cellTenant();
      await expect(
        prisma.tenantCloudIdentity.update({
          where: { tenantId },
          data: { saEmail: 'node@outro.iam.gserviceaccount.com' },
        }),
      ).rejects.toThrow(/TenantCloudIdentity_saEmail_format/);
    });
  });

  describe('caixa de saída e publicação', () => {
    class MemoryPublisher implements PubsubPublisher {
      readonly sent: PubsubOutgoingMessage[] = [];
      fail = false;
      publish(_topic: string, messages: readonly PubsubOutgoingMessage[]): Promise<string[]> {
        if (this.fail) return Promise.reject(new Error('Pub/Sub publish respondeu 503'));
        this.sent.push(...messages);
        return Promise.resolve(messages.map((_, index) => String(index)));
      }
    }
    const TOPIC = 'projects/projeto-exemplo/topics/vxc-celula-teste-relatorios';

    it('o cliente que não veio do canal não tem a quem relatar', async () => {
      const tenant = await prisma.tenant.create({ data: { name: 'Cliente Demo dedicado' } });
      const result = await prisma.$transaction((tx) =>
        outbox.enqueueForTenant(tx, tenant.id, {
          kind: 'tenant.status',
          accountsConnected: 0,
          lastEventAt: null,
        }),
      );
      expect(result).toBeNull();
    });

    it('publica em ordem, marca o publicado; a falha deixa o relatório para depois, sem perder', async () => {
      const { controlPlaneId, tenantId } = await cellTenant();
      const reporter = new CellTenantStatusReporter(prisma, outbox);
      expect((await reporter.runOnce()).reported).toBeGreaterThanOrEqual(1);
      const pending = await prisma.cellReport.findMany({ where: { publishedAt: null } });
      const ours = (await reportsOf(controlPlaneId)).map((report) => report.reportId);
      expect(ours).toHaveLength(2);
      expect(await reportsOf(controlPlaneId)).toMatchObject([
        { kind: 'tenant.applied' },
        { kind: 'tenant.status', accountsConnected: 0, lastEventAt: null },
      ]);

      const publisher = new MemoryPublisher();
      publisher.fail = true;
      const now = new Date();
      const failing = new CellReportPublisher(prisma, publisher, TOPIC, logger, () => now);
      expect(await failing.runOnce()).toMatchObject({ published: 0 });
      const retried = await prisma.cellReport.findUniqueOrThrow({ where: { id: ours[0] } });
      expect(retried).toMatchObject({ publishedAt: null, attempts: 1 });
      expect(retried.nextAttemptAt.getTime()).toBe(now.getTime() + CELL_REPORT_RETRY_MS);

      publisher.fail = false;
      const later = new Date(now.getTime() + CELL_REPORT_RETRY_MS);
      const working = new CellReportPublisher(prisma, publisher, TOPIC, logger, () => later);
      // Outros arquivos não gravam relatório; os deste arquivo saem todos, no máximo 500 por execução.
      while ((await prisma.cellReport.count({ where: { publishedAt: null } })) > 0) await working.runOnce();
      expect(pending.length).toBeGreaterThan(0);
      const sent = publisher.sent.map((message) =>
        cellReportSchema.parse(JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))),
      );
      const ourSent = sent.filter(
        (report) => report.kind !== 'cell.status' && report.tenantId === controlPlaneId,
      );
      expect(ourSent.map((report) => report.reportId)).toEqual(ours);
      expect(publisher.sent.every((message) => message.attributes?.['v'] === '1')).toBe(true);
      expect(await prisma.cellReport.findUniqueOrThrow({ where: { id: ours[0] } })).toMatchObject({
        publishedAt: later,
      });
      expect(tenantId).toBeDefined();
    });
  });
});

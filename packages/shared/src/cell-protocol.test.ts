import { describe, expect, it } from 'vitest';
import {
  CELL_MESSAGE_MAX_BYTES,
  type CellCommand,
  cellCommandSchema,
  cellMessageJson,
  cellReportSchema,
  cellReportTenantId,
  isPubsubTopicName,
  parseCellCommandJson,
  parseCellReportJson,
  utf8ByteLength,
} from './cell-protocol.js';

const TENANT = '01JD0000000000000000000000';
const COMMAND = '01JD0000000000000000000001';

/** Um estado desejado que vale: Plataforma, com franquia, no domínio reservado para exemplos. */
function platformState() {
  return {
    slug: 'cliente-demo-a',
    name: 'Cliente Demo A',
    hosts: { api: 'api-cliente-demo-a.example.com', panel: 'cliente-demo-a.control.example.com' },
    status: 'active',
    plan: {
      planId: 'plataforma',
      limits: { maxCloudAccounts: 10, maxUsers: 10, monthlyGib: null, historyDays: 90 },
      franchiseGbPerDay: 3,
    },
    franchiseSchedule: [
      { from: '2026-11-01', gbPerDay: 3 },
      { from: '2026-11-15', gbPerDay: 5 },
    ],
    billingPeriod: { start: '2026-11-01', end: '2026-11-30' },
    cloudIdentity: {
      saEmail: 'vxt-cliente-demo-a@projeto-exemplo.iam.gserviceaccount.com',
      saUniqueId: '100000000000000000001',
    },
    gcpSources: [],
    natIps: ['203.0.113.10'],
    lastBilledCycle: null,
    unitPrices: { currency: 'brl', additionalGbPerDayCents: 1000, overageHundredthCentsDecimal: '12.5' },
    firstAdmin: { email: 'admin@cliente-demo-a.example' },
  };
}

function upsert(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    kind: 'tenant.upsert',
    commandId: COMMAND,
    cellId: 'verax-celula',
    tenantId: TENANT,
    issuedAt: '2026-11-11T12:00:00.000Z',
    generation: 1,
    state: platformState(),
    ...overrides,
  };
}

const json = (value: unknown): string => JSON.stringify(value);

describe('contrato do canal da célula (CE-05)', () => {
  describe('comandos', () => {
    it('o tenant.upsert inteiro passa e volta igual', () => {
      const parsed = parseCellCommandJson(json(upsert()));
      expect(parsed).toEqual({ ok: true, value: upsert() });
    });

    it.each([
      ['um campo a mais no envelope', { extra: true }],
      ['outra versão do contrato', { v: 2 }],
      ['um tipo de comando desconhecido', { kind: 'tenant.delete' }],
      ['geração zero', { generation: 0 }],
      ['geração fracionária', { generation: 1.5 }],
      ['id de cliente fora do ULID', { tenantId: 'cliente-a' }],
      ['célula com maiúsculas', { cellId: 'Verax' }],
      ['instante sem fuso', { issuedAt: '2026-11-11T12:00:00' }],
    ])('recusa %s (estrito)', (_label, overrides) => {
      expect(parseCellCommandJson(json(upsert(overrides)))).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it.each([
      ['um campo a mais no estado', { ...platformState(), admin: true }],
      [
        'o endereço da API de outro subdomínio',
        {
          ...platformState(),
          hosts: { api: 'api-outro.example.com', panel: 'cliente-demo-a.control.example.com' },
        },
      ],
      [
        'API e painel em domínios diferentes',
        {
          ...platformState(),
          hosts: { api: 'api-cliente-demo-a.example.com', panel: 'cliente-demo-a.control.example.org' },
        },
      ],
      ['Plataforma sem franquia agendada', { ...platformState(), franchiseSchedule: [] }],
      [
        'franquia fora de ordem',
        {
          ...platformState(),
          franchiseSchedule: [
            { from: '2026-11-15', gbPerDay: 5 },
            { from: '2026-11-01', gbPerDay: 3 },
          ],
        },
      ],
      [
        'o plano que não vale (Plataforma com volume mensal)',
        {
          ...platformState(),
          plan: { ...platformState().plan, limits: { ...platformState().plan.limits, monthlyGib: 10 } },
        },
      ],
      ['estado purging (só o tenant.purge leva a ele)', { ...platformState(), status: 'purging' }],
      [
        'conta de serviço fora do padrão vxt-',
        { ...platformState(), cloudIdentity: { saEmail: 'node@p.iam.gserviceaccount.com', saUniqueId: '1' } },
      ],
      ['IP repetido', { ...platformState(), natIps: ['203.0.113.10', '203.0.113.10'] }],
      ['nome com quebra de linha', { ...platformState(), name: 'Cliente\nDemo' }],
    ])('recusa o estado com %s', (_label, state) => {
      expect(cellCommandSchema.safeParse(upsert({ state })).success).toBe(false);
    });

    it('fora da Plataforma, a franquia agendada é vazia e o ciclo pode faltar', () => {
      const state = {
        ...platformState(),
        plan: {
          planId: 'interno',
          limits: { maxCloudAccounts: null, maxUsers: null, monthlyGib: null, historyDays: null },
          franchiseGbPerDay: null,
        },
        franchiseSchedule: [],
        billingPeriod: null,
        unitPrices: null,
      };
      expect(cellCommandSchema.safeParse(upsert({ state })).success).toBe(true);
    });

    it('o expurgo exige a confirmação do subdomínio, e a pausa leva o motivo só quando pausa', () => {
      const base = {
        v: 1,
        commandId: COMMAND,
        cellId: 'verax-celula',
        tenantId: TENANT,
        issuedAt: '2026-11-11T12:00:00.000Z',
      };
      expect(cellCommandSchema.safeParse({ ...base, kind: 'tenant.purge', purgeId: COMMAND }).success).toBe(
        false,
      );
      expect(
        cellCommandSchema.safeParse({
          ...base,
          kind: 'tenant.purge',
          purgeId: COMMAND,
          confirmSlug: 'cliente-demo-a',
        }).success,
      ).toBe(true);
      expect(
        cellCommandSchema.safeParse({
          ...base,
          kind: 'tenant.collection_pause',
          paused: true,
          reason: 'owner',
        }).success,
      ).toBe(true);
      expect(
        cellCommandSchema.safeParse({ ...base, kind: 'tenant.collection_pause', paused: true }).success,
      ).toBe(false);
      expect(
        cellCommandSchema.safeParse({
          ...base,
          kind: 'tenant.collection_pause',
          paused: false,
          reason: 'owner',
        }).success,
      ).toBe(false);
    });
  });

  describe('relatórios', () => {
    const envelope = {
      v: 1,
      reportId: '0195f3a0-0000-7000-8000-000000000001',
      cellId: 'verax-celula',
      emittedAt: '2026-11-11T12:00:00.000Z',
    };

    it('cada tipo passa com os campos dele, e o cliente citado sai do relatório', () => {
      const reports = [
        { ...envelope, kind: 'tenant.applied', tenantId: TENANT, generation: 3 },
        { ...envelope, kind: 'tenant.status', tenantId: TENANT, accountsConnected: 2, lastEventAt: null },
        {
          ...envelope,
          kind: 'usage.daily',
          tenantId: TENANT,
          day: '2026-11-10',
          final: true,
          sources: { aws: { bytes: 1_000_000, events: 900 }, gcp: { bytes: 0, events: 0 } },
        },
        {
          ...envelope,
          kind: 'export.ready',
          tenantId: TENANT,
          exportId: COMMAND,
          object: `verax-celula/${TENANT}/20261111T120000Z.tar.gz`,
          sha256: 'a'.repeat(64),
          bytes: 123,
        },
        { ...envelope, kind: 'tenant.purged', tenantId: TENANT, purgeId: COMMAND },
        {
          ...envelope,
          kind: 'franchise.requested',
          tenantId: TENANT,
          requestId: COMMAND,
          targetGbPerDay: 5,
          requestedBy: '0195f3a0-0000-7000-8000-000000000002',
        },
        {
          ...envelope,
          kind: 'gcp_source.request',
          tenantId: TENANT,
          cloudAccountId: '0195f3a0-0000-7000-8000-000000000003',
          projectId: 'projeto-exemplo',
          writerIdentity: 'serviceAccount:service-123@gcp-sa-logging.iam.gserviceaccount.com',
        },
        {
          ...envelope,
          kind: 'cell.status',
          tenants: 3,
          cpuPercent: 40,
          memoryPercent: 60,
          diskFreePercent: null,
          analysisdQueuePercent: 1,
          eventsDropped: 0,
          wodleLagSeconds: 120,
        },
        {
          ...envelope,
          kind: 'command.refused',
          tenantId: TENANT,
          commandId: COMMAND,
          command: 'tenant.purge',
          code: 'purge_export_missing',
        },
      ];
      for (const report of reports) {
        const parsed = cellReportSchema.parse(report);
        expect(cellReportTenantId(parsed)).toBe(report.kind === 'cell.status' ? null : TENANT);
      }
    });

    it('recusa o relatório com campo a mais, tipo desconhecido ou objeto de exportação fora da pasta', () => {
      const applied = { ...envelope, kind: 'tenant.applied', tenantId: TENANT, generation: 3 };
      expect(parseCellReportJson(json({ ...applied, extra: 1 }))).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
      expect(parseCellReportJson(json({ ...applied, kind: 'tenant.deleted' }))).toMatchObject({ ok: false });
      expect(
        cellReportSchema.safeParse({
          ...envelope,
          kind: 'export.ready',
          tenantId: TENANT,
          exportId: COMMAND,
          object: '../outro/arquivo.tar.gz',
          sha256: 'a'.repeat(64),
          bytes: 1,
        }).success,
      ).toBe(false);
    });
  });

  describe('codificação', () => {
    it('recusa texto que não é JSON e o que passa do teto, sem ler o conteúdo', () => {
      expect(parseCellCommandJson('{')).toEqual({ ok: false, reason: 'not_json', issues: [] });
      expect(parseCellCommandJson(' '.repeat(CELL_MESSAGE_MAX_BYTES + 1))).toEqual({
        ok: false,
        reason: 'too_large',
        issues: [],
      });
    });

    it('a recusa diz o caminho e o motivo, nunca o valor recebido', () => {
      const parsed = parseCellCommandJson(json(upsert({ tenantId: 'valor-que-nao-pode-vazar' })));
      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain('valor-que-nao-pode-vazar');
    });

    it('o JSON publicado é conferido de novo e volta igual', () => {
      const command = cellCommandSchema.parse(upsert());
      expect(parseCellCommandJson(cellMessageJson(command))).toEqual({ ok: true, value: command });
      expect(() => cellMessageJson({ ...command, generation: -1 } as CellCommand)).toThrow();
    });

    it('conta os bytes em UTF-8 e reconhece o nome de um tópico', () => {
      expect(utf8ByteLength('ação')).toBe(6);
      expect(isPubsubTopicName('projects/projeto-exemplo/topics/vxc-celula-comandos')).toBe(true);
      expect(isPubsubTopicName('projects/projeto-exemplo/subscriptions/x')).toBe(false);
      expect(isPubsubTopicName('projects/projeto-exemplo/topics/goog-x')).toBe(false);
    });
  });
});

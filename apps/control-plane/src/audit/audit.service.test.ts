import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/support/fake-clock.js';
import { REDACTED } from '../common/logger/sanitize.js';
import { MemoryDocumentStore } from '../firestore/memory-document-store.js';
import {
  AUDIT_RETENTION_MONTHS,
  AuditService,
  auditRetentionLimit,
  MAX_DETAILS_BYTES,
  toStoredDetails,
} from './audit.service.js';

const TENANT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

function harness(): { audit: AuditService; clock: FakeClock; documents: MemoryDocumentStore } {
  const documents = new MemoryDocumentStore();
  const clock = new FakeClock();
  return { audit: new AuditService(documents, clock), clock, documents };
}

describe('AuditService (CP-02)', () => {
  it('grava ator, ação, cliente, requestId e o prazo de retenção de 24 meses', async () => {
    const { audit, clock } = harness();

    await audit.write({
      actor: 'system',
      action: 'tick.run',
      tenantId: TENANT_ID,
      requestId: 'req-demo-00001',
    });

    const [entry] = await audit.listForTenant(TENANT_ID);
    expect(entry).toMatchObject({
      actor: 'system',
      action: 'tick.run',
      tenantId: TENANT_ID,
      requestId: 'req-demo-00001',
      at: clock.now(),
      expiresAt: auditRetentionLimit(clock.now()),
    });
    expect(entry?.details).toBeUndefined();
    expect(auditRetentionLimit(new Date('2026-11-04T12:00:00.000Z'))).toEqual(
      new Date('2028-11-04T12:00:00.000Z'),
    );
    expect(AUDIT_RETENTION_MONTHS).toBe(24);
  });

  it('aceita os quatro formatos de ator e recusa os demais', async () => {
    const { audit } = harness();
    for (const actor of [
      'system',
      'stripe:evt_1Abc',
      'owner:cp-deployer@projeto-demo.iam.gserviceaccount.com',
      `customer:${TENANT_ID}`,
    ]) {
      await expect(audit.write({ actor, action: 'teste.ok' })).resolves.toBeUndefined();
    }
    for (const actor of ['', 'alguem', 'customer:x', 'stripe:', 'owner:com espaço']) {
      await expect(audit.write({ actor, action: 'teste.ok' })).rejects.toThrow();
    }
    await expect(audit.write({ actor: 'system', action: 'Ação Inválida' })).rejects.toThrow();
  });

  it('lista por cliente em ordem de tempo e não mistura clientes', async () => {
    const { audit, clock } = harness();
    const other = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
    await audit.write({ actor: 'system', action: 'a.primeira', tenantId: TENANT_ID });
    clock.advance(1000);
    await audit.write({ actor: 'system', action: 'b.outro', tenantId: other });
    clock.advance(1000);
    await audit.write({ actor: 'system', action: 'c.segunda', tenantId: TENANT_ID });

    expect((await audit.listForTenant(TENANT_ID)).map((entry) => entry.action)).toEqual([
      'a.primeira',
      'c.segunda',
    ]);
    expect((await audit.listForTenant(other)).map((entry) => entry.action)).toEqual(['b.outro']);
  });

  it('details passa pela limpeza dos logs e tem teto de tamanho', () => {
    expect(toStoredDetails(undefined)).toBeUndefined();
    expect(toStoredDetails({ step: 'preflight', token: 'x', nested: { secret: 'y', ok: true } })).toEqual({
      step: 'preflight',
      token: REDACTED,
      nested: { secret: REDACTED, ok: true },
    });
    const big = toStoredDetails({ dump: 'x'.repeat(MAX_DETAILS_BYTES) });
    expect(big).toEqual({ truncated: true, bytes: expect.any(Number) as number });
  });
});

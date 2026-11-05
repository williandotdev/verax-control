import 'reflect-metadata';
import { randomInt } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backoffDelay,
  CollectorCursors,
  type CursorKey,
  DEFAULT_BACKOFF,
} from '../src/collectors/collector-cursor.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { scopeToTenant, TenantScopeViolation } from '../src/common/prisma/tenant-scope.js';
import { createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';

const MINUTE = 60_000;

class AccessDeniedException extends Error {
  override name = 'AccessDeniedException';
}

/** Fluxo próprio de cada teste: a listagem por fluxo não enxerga cursores de outros testes no mesmo banco. */
const stream = (prefix: string) => `${prefix}_${randomInt(100_000, 999_999)}`;

describe('cursor dos coletores (fase 2)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let cursors: CollectorCursors;
  let tenantId: string;

  /** Conta AWS fictícia do cliente de teste. */
  async function newAccount(status: 'active' | 'inactive' = 'active'): Promise<string> {
    const account = await prisma.cloudAccount.create({
      data: {
        tenantId,
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: ['sa-east-1'],
        status,
      },
    });
    return account.id;
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    cursors = new CollectorCursors(prisma);
    tenantId = await createTenant(app, 'Cliente demo (cursor)');
  });

  afterAll(async () => {
    await app.close();
  });

  it('um cursor por conta, fluxo e região: o banco recusa o repetido', async () => {
    const cloudAccountId = await newAccount();
    const create = (data: { stream: string; region?: string }) =>
      prisma.collectorCursor.create({ data: { cloudAccountId, ...data } });

    await create({ stream: 'aws_cloudtrail', region: 'sa-east-1' });
    await expect(create({ stream: 'aws_cloudtrail', region: 'sa-east-1' })).rejects.toMatchObject({
      code: 'P2002',
    });
    // Outra região, outro fluxo e o fluxo sem região são outros cursores.
    await create({ stream: 'aws_cloudtrail', region: 'us-east-1' });
    await create({ stream: 'aws_guardduty', region: 'sa-east-1' });
    await create({ stream: 'cloudflare_audit' });
    await expect(create({ stream: 'cloudflare_audit', region: '' })).rejects.toMatchObject({ code: 'P2002' });
    expect(await prisma.collectorCursor.count({ where: { cloudAccountId } })).toBe(4);
  });

  it('a conta apagada leva os cursores junto (cascade)', async () => {
    const cloudAccountId = await newAccount();
    const other = await newAccount();
    await cursors.read({ cloudAccountId, stream: 'aws_cloudtrail', region: 'sa-east-1' }, new Date());
    await cursors.read({ cloudAccountId, stream: 'aws_guardduty', region: 'sa-east-1' }, new Date());
    await cursors.read({ cloudAccountId: other, stream: 'aws_cloudtrail', region: 'sa-east-1' }, new Date());

    await prisma.cloudAccount.delete({ where: { id: cloudAccountId } });
    expect(await prisma.collectorCursor.count({ where: { cloudAccountId } })).toBe(0);
    expect(await prisma.collectorCursor.count({ where: { cloudAccountId: other } })).toBe(1);
  });

  it('a primeira leitura cria o cursor vazio e pronto para rodar; as seguintes devolvem o mesmo', async () => {
    const key: CursorKey = { cloudAccountId: await newAccount(), stream: 'cloudflare_audit' };
    const now = new Date('2026-11-03T10:00:00.000Z');
    const first = await cursors.read(key, now);
    expect(first).toMatchObject({
      region: '',
      cursorAt: null,
      continuation: null,
      nextRunAt: now,
      lastSuccessAt: null,
      lastErrorKind: null,
      failures: 0,
    });
    const again = await cursors.read(key, new Date('2026-11-03T11:00:00.000Z'));
    expect(again.id).toBe(first.id);
    expect(again.nextRunAt).toEqual(now);

    // Duas leituras ao mesmo tempo também ficam com um cursor só.
    const concurrent: CursorKey = { ...key, stream: 'aws_cloudtrail', region: 'us-east-1' };
    const [a, b] = await Promise.all([cursors.read(concurrent, now), cursors.read(concurrent, now)]);
    expect(a.id).toBe(b.id);
  });

  it('avanço: o cursor só anda para a frente, guarda a continuação, zera as falhas e marca a próxima leitura', async () => {
    const key: CursorKey = {
      cloudAccountId: await newAccount(),
      stream: 'aws_cloudtrail',
      region: 'sa-east-1',
    };
    const now = new Date('2026-11-03T10:00:00.000Z');
    await cursors.read(key, now);
    await cursors.fail(key, new Error('falha'), now);

    const newer = new Date('2026-11-03T09:58:00.000Z');
    const next = new Date('2026-11-03T10:05:00.000Z');
    const advanced = await cursors.advance(
      key,
      { cursorAt: newer, continuation: 'pagina-2', nextRunAt: next },
      now,
    );
    expect(advanced).toMatchObject({
      cursorAt: newer,
      continuation: 'pagina-2',
      nextRunAt: next,
      lastSuccessAt: now,
      lastErrorKind: null,
      failures: 0,
    });

    // Uma leitura que só viu eventos mais antigos não volta o cursor; a continuação termina.
    const later = new Date('2026-11-03T10:05:00.000Z');
    const older = await cursors.advance(
      key,
      { cursorAt: new Date('2026-11-03T09:30:00.000Z'), continuation: null, nextRunAt: later },
      later,
    );
    expect(older).toMatchObject({
      cursorAt: newer,
      continuation: null,
      nextRunAt: later,
      lastSuccessAt: later,
    });

    // Sem evento novo, a posição fica.
    const quiet = await cursors.advance(key, { continuation: null, nextRunAt: next }, later);
    expect(quiet.cursorAt).toEqual(newer);

    await expect(
      cursors.advance(key, { continuation: 'x'.repeat(2049), nextRunAt: next }, later),
    ).rejects.toThrow(RangeError);
  });

  it('falha: guarda só o tipo do erro, não mexe na posição e recua em dobro até o teto', async () => {
    const key: CursorKey = {
      cloudAccountId: await newAccount(),
      stream: 'aws_cloudtrail',
      region: 'sa-east-1',
    };
    const now = new Date('2026-11-03T10:00:00.000Z');
    await cursors.read(key, now);
    const position = new Date('2026-11-03T09:59:00.000Z');
    await cursors.advance(key, { cursorAt: position, continuation: 'pagina-7', nextRunAt: now }, now);

    const denied = new AccessDeniedException(
      'arn:aws:iam::111111111111:role/VeraxControlReadOnly sem permissão',
    );
    const first = await cursors.fail(key, denied, now);
    expect(first).toMatchObject({
      cursorAt: position,
      continuation: 'pagina-7',
      lastSuccessAt: now,
      lastErrorKind: 'AccessDeniedException',
      failures: 1,
      nextRunAt: new Date(now.getTime() + MINUTE),
    });
    expect(JSON.stringify(first)).not.toContain('111111111111');

    const second = await cursors.fail(key, denied, now);
    expect(second).toMatchObject({ failures: 2, nextRunAt: new Date(now.getTime() + 2 * MINUTE) });

    // A fonte pediu outra hora (Retry-After, throttling): vale a hora dela.
    const retryAt = new Date('2026-11-03T10:00:30.000Z');
    expect((await cursors.fail(key, new Error('limite'), now, { retryAt })).nextRunAt).toEqual(retryAt);

    // Recuo próprio do fluxo, com teto.
    const capped = await cursors.fail(key, new Error('limite'), now, {
      backoff: { baseMs: 1000, maxMs: 3000 },
    });
    expect(capped).toMatchObject({ failures: 4, nextRunAt: new Date(now.getTime() + 3000) });

    // O sucesso seguinte zera a contagem e limpa o tipo do erro.
    const recovered = await cursors.advance(key, { continuation: null, nextRunAt: now }, now);
    expect(recovered).toMatchObject({ failures: 0, lastErrorKind: null, cursorAt: position });
  });

  it('adiar: só empurra a próxima leitura para depois, sem contar falha nem mexer no erro e na posição', async () => {
    const key: CursorKey = { cloudAccountId: await newAccount(), stream: 'cloudflare_check' };
    const now = new Date('2026-11-04T12:00:00.000Z');
    await cursors.read(key, now);
    await cursors.fail(key, Object.assign(new Error('x'), { name: 'zone_not_found' }), now, {
      retryAt: new Date(now.getTime() + 60 * MINUTE),
    });
    await cursors.postpone(key, new Date(now.getTime() + 20 * MINUTE));
    // Já marcada para depois do prazo: fica como está.
    expect(await cursors.read(key, now)).toMatchObject({
      nextRunAt: new Date(now.getTime() + 60 * MINUTE),
      failures: 1,
      lastErrorKind: 'zone_not_found',
    });
    await cursors.postpone(key, new Date(now.getTime() + 90 * MINUTE));
    expect(await cursors.read(key, now)).toMatchObject({
      nextRunAt: new Date(now.getTime() + 90 * MINUTE),
      failures: 1,
      lastErrorKind: 'zone_not_found',
      cursorAt: null,
    });
  });

  it('o recuo padrão: 1 min na primeira falha, dobrando, até 1 h', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map((failures) => backoffDelay(failures) / MINUTE)).toEqual([
      1, 2, 4, 8, 16, 32, 60, 60,
    ]);
    expect(backoffDelay(0)).toBe(DEFAULT_BACKOFF.baseMs);
  });

  it('na hora de rodar: só os cursores vencidos do fluxo, de contas ativas, os mais atrasados primeiro', async () => {
    const name = stream('due');
    const now = new Date('2026-11-03T10:00:00.000Z');
    const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE);
    const late = await newAccount();
    const due = await newAccount();
    const future = await newAccount();
    const inactive = await newAccount('inactive');
    for (const [cloudAccountId, nextRunAt] of [
      [due, at(-1)],
      [late, at(-5)],
      [future, at(1)],
      [inactive, at(-10)],
    ] as const) {
      await prisma.collectorCursor.create({ data: { cloudAccountId, stream: name, nextRunAt } });
    }
    await prisma.collectorCursor.create({
      data: { cloudAccountId: due, stream: stream('outro'), nextRunAt: at(-3) },
    });

    const ready = await cursors.due(name, now);
    expect(ready.map((cursor) => cursor.cloudAccountId)).toEqual([late, due]);
    expect((await cursors.due(name, now, 1)).map((cursor) => cursor.cloudAccountId)).toEqual([late]);
  });

  it('fluxo e região fora do formato são recusados antes do banco', async () => {
    const cloudAccountId = await newAccount();
    await expect(cursors.read({ cloudAccountId, stream: 'AWS CloudTrail' }, new Date())).rejects.toThrow(
      RangeError,
    );
    await expect(cursors.read({ cloudAccountId, stream: 'a'.repeat(33) }, new Date())).rejects.toThrow(
      RangeError,
    );
    await expect(
      cursors.read({ cloudAccountId, stream: 'aws_cloudtrail', region: 'sa east 1' }, new Date()),
    ).rejects.toThrow(RangeError);
  });

  it('o cursor é dado de sistema: o escopo de um cliente não alcança o model', () => {
    expect(() => scopeToTenant(prisma, tenantId).collectorCursor).toThrow(TenantScopeViolation);
    expect(() => prisma.forTenant(tenantId).collectorCursor).toThrow(TenantScopeViolation);
  });
});

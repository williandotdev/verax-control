import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { findingChangeContextSchema, findingDetailSchema, MAX_FINDING_CHANGE_BYTES } from '@verax/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertSync } from '../src/alerts/alert-sync.js';
import { wazuhFindingKey } from '../src/alerts/finding-draft.js';
import { parseWazuhAlert } from '../src/alerts/wazuh-alert.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { cloudTrailAlert } from './alerts/fixtures.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { FakeIndexer, wazuhTime } from './support/fake-indexer.js';

/**
 * A alteração do evento gravada no alerta (`Finding.change`) e a rota `GET /v1/findings/:id/change`: o estado anterior da
 * mesma lista de IPs do WAF, só do mesmo cliente e da mesma conta; nada de documento de política no banco; o teto do CHECK;
 * o isolamento por cliente; e o detalhe de sempre sem campo novo.
 */

const MINUTE = 60_000;
const IP_SET_ID = 'a1b2c3d4-5678-90ab-cdef-000000000001';
const LAMBDA = (account: string) =>
  `arn:aws:sts::${account}:assumed-role/waf-auto-block-role-x1y2/waf-auto-block`;

describe('alteração do evento no alerta', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let tenantA: string;
  let tenantB: string;
  let cookieA: string;
  let cookieB: string;
  const accountA = String(randomInt(100_000_000_000, 999_999_999_999));
  const accountB = String(randomInt(100_000_000_000, 999_999_999_999));
  const trailA = `trilha-mudanca-a-${randomInt(1e6, 9e6)}`;
  const trailB = `trilha-mudanca-b-${randomInt(1e6, 9e6)}`;

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
    tenantA = await createTenant(app, 'Cliente Demo A (alteração)');
    tenantB = await createTenant(app, 'Cliente Demo B (alteração)');
    await prisma.cloudAccount.create({
      data: { tenantId: tenantA, accountId: accountA, regions: ['sa-east-1'], cloudtrailBucket: trailA },
    });
    await prisma.cloudAccount.create({
      data: { tenantId: tenantB, accountId: accountB, regions: ['sa-east-1'], cloudtrailBucket: trailB },
    });
    cookieA = (await createSignedInUser(app, { role: 'leitura', tenantId: tenantA })).cookie;
    cookieB = (await createSignedInUser(app, { role: 'analista_cliente', tenantId: tenantB })).cookie;
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string, cookie = cookieA) => {
    const call = request(app.getHttpServer()).get(path);
    return cookie === '' ? call : call.set('Cookie', cookie);
  };

  /** Um alerta do CloudTrail no bucket da conta, `minutesAgo` minutos atrás. */
  function trailAlert(
    minutesAgo: number,
    fields: { eventSource: string; eventName: string; requestParameters: Record<string, unknown> },
    options: {
      account?: string;
      bucket?: string;
      rule?: { id: string; description: string };
      agent?: string;
    } = {},
  ): Record<string, unknown> {
    const account = options.account ?? accountA;
    const doc = cloudTrailAlert({
      account,
      bucket: options.bucket ?? trailA,
      eventName: fields.eventName,
      level: 7,
      rule: options.rule ?? {
        id: '100323',
        description: 'Verax Control: Regras do WAF alteradas (UpdateIPSet).',
      },
      identity: { type: 'AssumedRole', arn: LAMBDA(account), accountId: account },
      requestParameters: fields.requestParameters,
    });
    const data = doc['data'] as { aws: Record<string, unknown> };
    return {
      ...doc,
      id: `${Date.now()}.${randomInt(1e6, 9e6)}`,
      timestamp: wazuhTime(new Date(Date.now() - minutesAgo * MINUTE)),
      data: {
        ...data,
        aws: {
          ...data.aws,
          eventSource: fields.eventSource,
          userAgent: options.agent ?? 'Boto3/1.34.0 exec-env/AWS_Lambda_python3.12',
        },
      },
    };
  }

  const ipSetAlert = (
    minutesAgo: number,
    addresses: string[],
    options: Parameters<typeof trailAlert>[2] = {},
  ) =>
    trailAlert(
      minutesAgo,
      {
        eventSource: 'wafv2.amazonaws.com',
        eventName: 'UpdateIPSet',
        requestParameters: {
          name: 'blocked-ips',
          scope: 'REGIONAL',
          id: IP_SET_ID,
          addresses,
          lockToken: 'x',
        },
      },
      options,
    );

  async function sync(...docs: Record<string, unknown>[]) {
    const report = await new AlertSync(prisma, new FakeIndexer(docs), {
      name: `teste-${randomUUID().slice(0, 8)}`,
    }).runOnce();
    expect(report).toMatchObject({ status: 'done' });
  }

  async function findingOf(doc: Record<string, unknown>, account = accountA) {
    const parsed = parseWazuhAlert(doc);
    if (!parsed.ok) throw new Error(parsed.reason);
    return prisma.finding.findUniqueOrThrow({
      where: {
        source_sourceEventId: { source: 'wazuh', sourceEventId: wazuhFindingKey(parsed.alert, account) },
      },
    });
  }

  const context = async (id: string, cookie = cookieA) =>
    findingChangeContextSchema.parse((await get(`/v1/findings/${id}/change`, cookie).expect(200)).body);

  it('grava a alteração na chegada e devolve o estado anterior da mesma lista de IPs', async () => {
    const first = ipSetAlert(30, ['198.51.100.1/32', '198.51.100.2/32']);
    const second = ipSetAlert(10, ['198.51.100.1/32', '203.0.113.7/32', '203.0.113.8/32']);
    // A mesma lista de IPs (mesmo id) noutro cliente nunca é o "antes" do cliente A.
    const otherTenant = ipSetAlert(20, ['192.0.2.99/32'], { account: accountB, bucket: trailB });
    await sync(first, second, otherTenant);

    const stored = await findingOf(second);
    expect(stored.change).toMatchObject({
      eventSource: 'wafv2.amazonaws.com',
      eventName: 'UpdateIPSet',
      via: 'lambda',
      target: { kind: 'waf_ip_set', id: IP_SET_ID, name: 'blocked-ips', scope: 'REGIONAL' },
      lists: { addresses: { items: ['198.51.100.1/32', '203.0.113.7/32', '203.0.113.8/32'], total: 3 } },
    });
    expect(stored.changeSubject).toBe(`wafv2.amazonaws.com/waf_ip_set/REGIONAL/sa-east-1/${IP_SET_ID}`);
    expect(JSON.stringify(stored.change)).not.toContain('lockToken');

    const older = await findingOf(first);
    const now = await context(stored.id);
    expect(now.previous).toMatchObject({
      findingId: older.id,
      change: { lists: { addresses: { items: ['198.51.100.1/32', '198.51.100.2/32'], total: 2 } } },
    });
    expect(now.repeats).toEqual({ days: 30, count: 2 });

    // O primeiro não tem anterior; o do cliente B só vê o dele.
    expect((await context(older.id)).previous).toBeNull();
    const fromB = await findingOf(otherTenant, accountB);
    expect((await context(fromB.id, cookieB)).previous).toBeNull();
  });

  it('isolamento: o cliente B não lê a alteração do cliente A; sem sessão, 401; id inválido, 400', async () => {
    const doc = ipSetAlert(40, ['198.51.100.3/32']);
    await sync(doc);
    const finding = await findingOf(doc);
    const denied = await get(`/v1/findings/${finding.id}/change`, cookieB).expect(404);
    expect(denied.text).not.toContain('198.51.100.3');
    await get(`/v1/findings/${randomUUID()}/change`).expect(404);
    await get(`/v1/findings/${finding.id}/change`, '').expect(401);
    await get('/v1/findings/nao-e-um-id/change').expect(400);
  });

  it('nunca grava o documento de política: só o que ele concede', async () => {
    const doc = trailAlert(
      50,
      {
        eventSource: 'iam.amazonaws.com',
        eventName: 'PutUserPolicy',
        requestParameters: {
          userName: 'bruno',
          policyName: 'acesso-total',
          policyDocument: JSON.stringify({
            Statement: [{ Effect: 'Allow', Action: '*', Resource: '*', Sid: 'nao-deve-ser-gravado' }],
          }),
        },
      },
      {
        rule: { id: '100306', description: 'Verax Control: Permissão de administrador concedida.' },
        agent: 'aws-cli/2.17.0',
      },
    );
    await sync(doc);
    const finding = await findingOf(doc);
    expect(finding.change).toEqual({
      version: 1,
      eventSource: 'iam.amazonaws.com',
      eventName: 'PutUserPolicy',
      via: 'cli',
      target: { kind: 'iam_user', name: 'bruno' },
      values: { policyName: 'acesso-total', grantsEverything: true },
    });
    expect(finding.changeSubject).toBeNull();
    expect(JSON.stringify(finding.change)).not.toContain('nao-deve-ser-gravado');
    expect((await context(finding.id)).previous).toBeNull();
  });

  it('alerta sem alteração (de antes da coluna, ou de evento fora da lista) responde null', async () => {
    const doc = trailAlert(60, {
      eventSource: 'ec2.amazonaws.com',
      eventName: 'RunInstances',
      requestParameters: {},
    });
    await sync(doc);
    const finding = await findingOf(doc);
    expect(finding.change).toBeNull();
    const response = await context(finding.id);
    expect(response.change).toBeNull();
    expect(response.previous).toBeNull();
  });

  it('o que está no banco fora do formato desta versão não sai, e o detalhe de sempre não ganha campo', async () => {
    const doc = ipSetAlert(70, ['198.51.100.4/32']);
    await sync(doc);
    const finding = await findingOf(doc);
    await prisma.finding.update({ where: { id: finding.id }, data: { change: { version: 2, novo: true } } });
    expect((await context(finding.id)).change).toBeNull();
    const detail = (await get(`/v1/findings/${finding.id}`).expect(200)).body as object;
    expect(findingDetailSchema.parse(detail)).toMatchObject({ id: finding.id });
    expect(Object.keys(detail)).not.toContain('change');
  });

  it('o CHECK do banco recusa a alteração acima do teto e a chave sem alteração', async () => {
    const doc = ipSetAlert(80, ['198.51.100.5/32']);
    await sync(doc);
    const finding = await findingOf(doc);
    const huge = { version: 1, padding: 'x'.repeat(MAX_FINDING_CHANGE_BYTES) };
    await expect(
      prisma.finding.update({ where: { id: finding.id }, data: { change: huge } }),
    ).rejects.toThrow();
    await expect(
      prisma.finding.update({ where: { id: finding.id }, data: { change: null, changeSubject: 'x' } }),
    ).rejects.toThrow();
  });

  it('a lista grande é cortada no teto e cabe no banco', async () => {
    const many = Array.from(
      { length: 2000 },
      (_, index) => `10.${Math.floor(index / 250)}.${index % 250}.1/32`,
    );
    const doc = ipSetAlert(90, many);
    await sync(doc);
    const finding = await findingOf(doc);
    const addresses = (finding.change as { lists: { addresses: { items: string[]; total: number } } }).lists
      .addresses;
    expect(addresses.total).toBe(2000);
    expect(addresses.items.length).toBeLessThan(2000);
  });
});

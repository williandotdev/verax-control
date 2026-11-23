import 'reflect-metadata';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CloudWatchAlertSync } from '../src/alerts/cloudwatch-alert-sync.js';
import { WazuhConfig, type WazuhConfigReport } from '../src/aws/wazuh-config.js';
import {
  findWazuhSourceRows,
  serializeWazuhSources,
  toWazuhSources,
  wazuhSourcesGeneration,
} from '../src/aws/wazuh-sources.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import type { Prisma } from '../src/generated/prisma/client.js';
import { cloudWatchAlert } from './alerts/fixtures.js';
import { createSignedInUser, createTenant } from './support/auth-helpers.js';
import { createApp } from './support/create-app.js';
import { FakeIndexer, wazuhTime } from './support/fake-indexer.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
const plus = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE);

interface Cloud {
  id: string;
  tenantId: string;
  accountId: string;
}

/**
 * De quem são os alertas do CloudWatch Logs, do começo ao fim: a tarefa `wazuh-config` (a lista planejada e o sinal
 * `applied` do host) grava a prova do dono, e o sync dos alertas só atribui dentro dela (`cloudwatch-ownership.ts`).
 *
 * O evento de um grupo de logs chega ao indexer sem a conta e sem o grupo. O teste que guia este arquivo é o do erro de
 * isolamento que a prova fecha: com dois clientes com grupo autorizado e um deles tirando a autorização, o sync passava
 * a atribuir ao que ficou tudo o que lia, inclusive o que o manager ainda coletava do que saiu.
 *
 * Cada caso é um nó de teste (`node`): um relógio só para a tarefa, o sync e os alertas, a pasta de sinais dele e o
 * registro da prova só dele (os testes dividem o banco).
 */
describe('dono dos alertas do CloudWatch Logs: a prova pela configuração aplicada no manager', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const dirs: string[] = [];

  /** Uma conta AWS já verificada e conectada, com o início da coleta. */
  function account(tenantId: string): Promise<Cloud> {
    return prisma.cloudAccount.create({
      data: {
        tenantId,
        provider: 'aws',
        accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
        regions: ['sa-east-1'],
        connection: 'connected',
        ingestFrom: new Date('2026-11-01T00:00:00.000Z'),
      },
      select: { id: true, tenantId: true, accountId: true },
    });
  }

  /** Um grupo do CloudWatch Logs que o cliente autorizou (o que a rota de autorização grava). */
  function logGroup(cloud: Cloud, data: Partial<Prisma.AwsSourceUncheckedCreateInput> = {}) {
    const now = new Date();
    const name = `/aws/lambda/funcao-${randomInt(1e6, 9e6)}`;
    return prisma.awsSource.create({
      data: {
        tenantId: cloud.tenantId,
        cloudAccountId: cloud.id,
        kind: 'cloudwatch_log_group',
        region: 'sa-east-1',
        resourceId: name,
        name,
        details: { logGroup: name, tagged: true },
        method: 'cloudwatch',
        sensitive: true,
        availability: 'available',
        permission: 'granted',
        permissionCheckedAt: now,
        authorizedAt: now,
        authorizedBy: 'usuario-de-teste',
        collectFrom: new Date(now.toISOString().slice(0, 10)),
        state: 'authorized',
        stateCode: 'awaiting_collector',
        stateSince: now,
        ...data,
      },
    });
  }
  const revoke = (id: string) =>
    prisma.awsSource.update({
      where: { id },
      data: { revokedAt: new Date(), state: 'revoked', stateCode: null },
    });

  const findingsOf = (alerts: readonly { id: string }[]) =>
    prisma.finding.findMany({
      where: { rawEventId: { in: alerts.map((alert) => alert.id) } },
      select: { rawEventId: true, tenantId: true, accountId: true, logSource: true },
      orderBy: { rawEventId: 'asc' },
    });
  /** O motivo de cada alerta na fila sem dono, pelo ID do alerta. */
  const unownedOf = async (alerts: readonly { id: string }[]) => {
    const rows = await prisma.unownedAlert.findMany({
      where: { sourceEventId: { in: alerts.map((alert) => alert.id) } },
      select: { sourceEventId: true, reason: true, accounts: true },
    });
    return Object.fromEntries(
      rows.map((row) => [row.sourceEventId, `${row.reason}:${row.accounts.join(',')}`]),
    );
  };
  const reasons = (alerts: readonly { id: string }[], reason: string) =>
    Object.fromEntries(alerts.map((alert) => [alert.id, `${reason}:`]));

  /**
   * Um nó de teste. O relógio começa 6 horas atrás e só anda quando o teste manda; a tarefa `wazuh-config` confere a
   * cada minuto de `pass` (no nó, a cada 30 s), e os alertas nascem com o horário do relógio (o `timestamp` que o
   * manager grava e o indexer devolve).
   */
  async function node(tenantIds: string[]) {
    const dir = await mkdtemp(join(tmpdir(), 'verax-cloudwatch-ownership-'));
    dirs.push(dir);
    const key = `teste-${randomUUID().slice(0, 8)}`;
    let now = new Date(Math.floor(Date.now() / 1000) * 1000 - 6 * HOUR);
    // O contador de trocas da configuração do manager, que o host guarda em disco (começa na hora dele, em segundos).
    let seq = Math.floor(now.getTime() / 1000);
    let report: WazuhConfigReport | null = null;
    const documents: (Record<string, unknown> & { id: string })[] = [];
    const config = new WazuhConfig(prisma, dir, {
      tenantIds,
      now: () => now,
      startedAt: now,
      cloudWatchOwnershipKey: key,
    });
    const newSync = () => {
      const sync = new CloudWatchAlertSync(prisma, new FakeIndexer(documents), {
        name: `teste-${randomUUID().slice(0, 8)}`,
        tenantIds,
        ownershipKey: key,
      });
      return () => sync.runOnce(now);
    };
    const sync = newSync();
    const generation = async () =>
      wazuhSourcesGeneration(
        serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, tenantIds))),
      );
    const check = async () => {
      // O token do host em dia: os avisos do nó não entram nestes casos.
      await writeFile(join(dir, 'aws-token'), `${JSON.stringify({ tokenAt: iso(now) })}\n`);
      report = await config.runOnce();
      return report;
    };
    return {
      key,
      now: () => now,
      /** A prova depois da última conferência, como a tarefa a relatou. */
      proven: () => report?.cloudWatch,
      record: () => prisma.cloudWatchAlertOwnership.findUnique({ where: { id: key } }),
      /** O relógio anda `minutes` minutos, com uma conferência da tarefa em cada um. */
      async pass(minutes: number) {
        for (let step = 0; step < minutes; step += 1) {
          now = plus(now, 1);
          await check();
        }
      },
      /** O relógio anda sem a tarefa conferir (o worker parado). */
      skip(minutes: number) {
        now = plus(now, minutes);
      },
      check,
      /**
       * O sinal do host: aplicou (ou tentou aplicar) a lista planejada de agora, ou a geração dada (null: a lista nem
       * chegou ao gerador). `changes` é quantas vezes essa execução do host trocou a configuração do manager, somadas
       * ao número de sequência do sinal, como o `wazuh-apply.sh` faz: uma na aplicação que deu certo; duas na que
       * derrubou o manager e voltou à anterior; nenhuma quando a lista nem chegou ao gerador. `'legacy'` é o sinal do
       * script de uma versão anterior, sem o número.
       */
      async applied(
        status: 'ok' | 'error' = 'ok',
        other?: string | null,
        changes: number | 'legacy' = status === 'ok' ? 1 : other === null ? 0 : 2,
      ) {
        if (changes !== 'legacy') seq += changes;
        const signal = {
          generation: other === undefined ? await generation() : other,
          status,
          at: iso(now),
          ...(changes !== 'legacy' && { seq }),
        };
        await writeFile(join(dir, 'applied'), `${JSON.stringify(signal)}\n`);
      },
      /** O nó reiniciou: a pasta de sinais (em memória, no host) voltou vazia. */
      lostSignal: () => rm(join(dir, 'applied'), { force: true }),
      /** Um alerta de um grupo de logs que o manager gerou agora. */
      alert() {
        const document = {
          ...cloudWatchAlert(),
          id: `${now.getTime()}.${randomInt(1e6, 9e6)}`,
          timestamp: wazuhTime(now),
        };
        documents.push(document);
        return document;
      },
      sync,
      /** Outro sync, sem nada lido: relê os alertas das últimas 24 horas. */
      rereadAll: () => newSync()(),
    };
  }

  beforeAll(async () => {
    app = await createApp();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterAll(async () => {
    await app.close();
  });

  it('dois clientes com grupos e um deles revoga: o que o manager ainda coleta do que saiu nunca vira achado do que ficou', async () => {
    const first = await createTenant(app, 'Cliente Demo A (prova do dono)');
    const second = await createTenant(app, 'Cliente Demo B (prova do dono)');
    const cloudA = await account(first);
    const cloudB = await account(second);
    await logGroup(cloudA);
    const groupB = await logGroup(cloudB);
    const n = await node([first, second]);
    await n.applied();
    await n.pass(20);
    // Com grupos de dois clientes na lista, nunca há prova, por mais tempo que passe.
    expect(await n.record()).toBeNull();
    expect(n.proven()).toBe('unproven');
    const both = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0, unowned: 1 });

    // B tira a autorização. O manager ainda roda a lista com o grupo dele: o alerta de agora pode ser de B.
    await revoke(groupB.id);
    const residue = n.alert();
    // O sync roda antes de a tarefa `wazuh-config` ver a mudança. Pelas autorizações de agora, só A tem grupo: era
    // aqui que o alerta de antes (relido na sobreposição) e o de agora viravam achado de A.
    expect(await n.sync()).toMatchObject({ created: 0, unowned: 2 });
    await n.pass(1);
    // A lista planejada já é só de A, mas o host ainda não a aplicou: nenhuma prova.
    expect(await n.record()).toBeNull();
    const lagging = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0 });

    // O host aplica a lista só de A: a prova nasce na conferência seguinte.
    await n.applied();
    await n.pass(1);
    const born = await n.record();
    expect(born).toMatchObject({ ownerTenantId: first, ownerAccountId: cloudA.accountId, since: n.now() });
    const since = n.now();
    // Dentro da margem de 15 min, o alerta ainda pode ser do que a configuração anterior entregou.
    const atBirth = n.alert();
    await n.pass(14);
    const endOfMargin = n.alert();
    await n.pass(1);
    expect(n.now()).toEqual(plus(since, 15));
    const afterMargin = n.alert();
    // Passada a margem, ainda falta a espera: a última conferência (aos 24 min) menos 10 min fica antes do alerta.
    await n.pass(9);
    expect(await n.sync()).toMatchObject({ created: 0, deferred: 1 });
    const all = [both, residue, lagging, atBirth, endOfMargin, afterMargin];
    expect(await findingsOf(all)).toEqual([]);
    await n.pass(1);
    expect(await n.sync()).toMatchObject({ created: 1, deferred: 0 });

    // Só o alerta de depois da margem é de A. Os outros estão na fila sem dono, sem conta nenhuma, e B não tem nada.
    expect(await findingsOf(all)).toEqual([
      {
        rawEventId: afterMargin.id,
        tenantId: first,
        accountId: cloudA.accountId,
        logSource: 'cloudwatch_logs',
      },
    ]);
    const queued = [both, residue, lagging, atBirth, endOfMargin];
    expect(await unownedOf(all)).toEqual(reasons(queued, 'ambiguous_source'));
    expect(await prisma.finding.count({ where: { tenantId: second } })).toBe(0);

    // Outras execuções, e um sync que relê tudo do zero com a prova bem assentada: nada sai da fila.
    await n.pass(30);
    expect(await n.sync()).toMatchObject({ created: 0 });
    expect(await n.rereadAll()).toMatchObject({ created: 0, duplicates: 1, unowned: 5 });
    expect(await findingsOf(all)).toHaveLength(1);
    expect(await unownedOf(all)).toEqual(reasons(queued, 'ambiguous_source'));

    // Pela API: A vê um achado do CloudWatch Logs, o dele; B, nenhum.
    const adminA = await createSignedInUser(app, { role: 'admin_cliente', tenantId: first });
    const adminB = await createSignedInUser(app, { role: 'admin_cliente', tenantId: second });
    const list = async (cookie: string) => {
      const response = await request(app.getHttpServer())
        .get('/v1/findings?source=cloudwatch_logs&pageSize=100')
        .set('Cookie', cookie)
        .expect(200);
      return (response.body as { items: { accountId: string }[] }).items;
    };
    expect((await list(adminA.cookie)).map((item) => item.accountId)).toEqual([cloudA.accountId]);
    expect(await list(adminB.cookie)).toEqual([]);
  });

  it('um só dono desde o começo: o primeiro grupo de um nó já provado sem grupo nenhum não espera a margem de novo', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (primeiro grupo)');
    const cloud = await account(tenant);
    const n = await node([tenant]);
    // O nó no ar, sem nenhuma fonte da AWS: o host aplicou a lista vazia.
    await n.applied();
    await n.pass(1);
    const since = n.now();
    expect(await n.record()).toMatchObject({ ownerTenantId: null, ownerAccountId: null, since });
    expect(n.proven()).toBe('empty');
    await n.pass(30);

    // O cliente autoriza o primeiro grupo. A lista planejada já tem dono, e o manager ainda roda a lista sem grupo
    // nenhum, que a tarefa conferiu: antes deste dono não havia de quem coletar, e o começo da prova é o mesmo.
    await logGroup(cloud);
    await n.pass(1);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, ownerAccountId: cloud.accountId, since });
    expect(n.proven()).toBe('owner');
    await n.applied();
    await n.pass(1);
    // O primeiro alerta do grupo, logo depois da aplicação (a leitura do dia que o módulo faz ao subir).
    const first = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0, deferred: 1 });
    expect(await findingsOf([first])).toEqual([]);
    expect(await unownedOf([first])).toEqual({});
    // Só a espera de 10 min: enquanto isso, nem achado, nem fila.
    await n.pass(9);
    expect(await n.sync()).toMatchObject({ created: 0, deferred: 1 });
    await n.pass(1);
    expect(await n.sync()).toMatchObject({ created: 1, deferred: 0 });
    expect(await findingsOf([first])).toMatchObject([{ tenantId: tenant, accountId: cloud.accountId }]);
    expect(await unownedOf([first])).toEqual({});
  });

  it('sem registro (o estado perdido, o nó reiniciado, o worker parado): nada é atribuído até a prova nascer de novo e a margem passar', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (prova perdida)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const n = await node([tenant]);
    // Sem o sinal do host, a tarefa não prova nada, e o único cliente com grupo fica sem achado.
    await n.pass(3);
    expect(await n.record()).toBeNull();
    const unproven = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0, unowned: 1 });

    // A prova nasce com os grupos já na lista: vale a margem inteira.
    await n.applied();
    await n.pass(1);
    const since = n.now();
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since });
    await n.pass(14);
    const inMargin = n.alert();
    await n.pass(1);
    const proven = n.alert();
    await n.pass(10);
    expect(await n.sync()).toMatchObject({ created: 1 });
    expect(await findingsOf([unproven, inMargin, proven])).toMatchObject([{ rawEventId: proven.id }]);

    // O registro some (o banco restaurado de antes dele): pelas autorizações há um dono só, e mesmo assim nada.
    await prisma.cloudWatchAlertOwnership.deleteMany({ where: { id: n.key } });
    const orphan = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0 });
    // O nó reiniciou: sem o sinal `applied`, a tarefa não sabe o que o manager roda.
    await n.lostSignal();
    await n.pass(1);
    expect(await n.record()).toBeNull();
    expect(n.proven()).toBe('unproven');
    await n.applied();
    await n.pass(1);
    const reborn = n.now();
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: reborn });
    await n.pass(14);
    const inSecondMargin = n.alert();
    await n.pass(1);
    const provenAgain = n.alert();
    await n.pass(10);
    expect(await n.sync()).toMatchObject({ created: 1 });

    // O worker parado por mais de 5 min: a tarefa não viu o que o host aplicou nesse tempo, e a prova recomeça.
    n.skip(6);
    const duringGap = n.alert();
    // O sync roda antes da tarefa: o registro está velho, e o alerta novo não tem por que esperar.
    expect(await n.sync()).toMatchObject({ created: 0, deferred: 0 });
    await n.check();
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: n.now() });
    expect(n.now().getTime()).toBeGreaterThan(reborn.getTime());

    const queued = [unproven, inMargin, orphan, inSecondMargin, duringGap];
    const all = [...queued, proven, provenAgain];
    expect((await findingsOf(all)).map((finding) => finding.rawEventId).sort()).toEqual(
      [proven.id, provenAgain.id].sort(),
    );
    expect(await unownedOf(all)).toEqual(reasons(queued, 'ambiguous_source'));
  });

  it('o segundo cliente autoriza o primeiro grupo: a dúvida começa quando a lista é planejada, antes de chegar ao manager', async () => {
    const first = await createTenant(app, 'Cliente Demo A (segundo cliente chega)');
    const second = await createTenant(app, 'Cliente Demo B (segundo cliente chega)');
    const cloudA = await account(first);
    const cloudB = await account(second);
    await logGroup(cloudA);
    const n = await node([first, second]);
    await n.applied();
    await n.pass(1);
    await n.pass(20);
    const settled = n.alert();
    await n.pass(10);
    const fresh = n.alert();
    // O alerta de 10 min atrás já cabe na prova; o de agora espera.
    expect(await n.sync()).toMatchObject({ created: 1, deferred: 1 });

    // B autoriza o primeiro grupo dele. O manager ainda não sabe disso: segue só com os grupos de A.
    const groupB = await logGroup(cloudB);
    const afterAuthorization = n.alert();
    // Antes de qualquer conferência da tarefa, o sync já vê dois clientes pelas autorizações de agora.
    expect(await n.sync()).toMatchObject({ created: 0, deferred: 0 });
    // A tarefa confere: a lista planejada tem grupos de dois donos, e a prova cai na mesma execução que manda a geração
    // nova para o host, com o manager ainda na lista só de A.
    await n.pass(1);
    expect(await n.record()).toBeNull();
    expect(n.proven()).toBe('unproven');
    const planned = n.alert();
    await n.applied();
    await n.pass(5);
    const underBoth = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0 });

    // B revoga, o host aplica a lista só de A, e a prova nasce de novo: outro começo, outra margem.
    await revoke(groupB.id);
    await n.pass(1);
    expect(await n.record()).toBeNull();
    await n.applied();
    await n.pass(1);
    const since = n.now();
    expect(await n.record()).toMatchObject({ ownerTenantId: first, since });
    const inMargin = n.alert();
    await n.pass(15);
    const proven = n.alert();
    await n.pass(10);
    expect(await n.sync()).toMatchObject({ created: 1 });

    const queued = [fresh, afterAuthorization, planned, underBoth, inMargin];
    const all = [settled, ...queued, proven];
    // De A, só o que cabe inteiro numa prova; o alerta que esperava quando B chegou nunca virou achado.
    expect((await findingsOf(all)).map((finding) => finding.rawEventId).sort()).toEqual(
      [settled.id, proven.id].sort(),
    );
    expect(await findingsOf(queued)).toEqual([]);
    expect(await unownedOf(queued)).toEqual(reasons(queued, 'ambiguous_source'));
    expect(await prisma.finding.count({ where: { tenantId: second } })).toBe(0);
  });

  it('um cliente sai e outro entra depois, sem os dois juntos: nada do que foi coletado para o primeiro passa para o segundo', async () => {
    const first = await createTenant(app, 'Cliente Demo A (troca de dono)');
    const second = await createTenant(app, 'Cliente Demo B (troca de dono)');
    const cloudA = await account(first);
    const cloudB = await account(second);
    const groupA = await logGroup(cloudA);
    const n = await node([first, second]);
    await n.applied();
    await n.pass(1);
    const sinceA = n.now();
    await n.pass(30);

    // A tira o grupo. O manager ainda o coleta: o alerta de agora é do grupo de A, e ninguém tem grupo autorizado.
    await revoke(groupA.id);
    const afterRevoke = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0, unowned: 1 });
    await n.pass(1);
    // A lista planejada ficou sem grupo de logs: o registro segue de A (o que o manager ainda entrega é dele).
    expect(await n.record()).toMatchObject({ ownerTenantId: first, since: sinceA });

    // B autoriza um grupo antes de o host aplicar a lista sem o de A.
    await logGroup(cloudB);
    const beforeCheck = n.alert();
    // Pelas autorizações de agora, B é o único dono; o registro é de A. Sem prova para B, nada é dele.
    expect(await n.sync()).toMatchObject({ created: 0 });
    await n.pass(1);
    // Outro dono na lista planejada: o registro de A cai, e o de B só nasce com a lista de B aplicada.
    expect(await n.record()).toBeNull();
    const lagging = n.alert();
    await n.applied();
    await n.pass(1);
    const sinceB = n.now();
    expect(await n.record()).toMatchObject({ ownerTenantId: second, ownerAccountId: cloudB.accountId });
    expect((await n.record())?.since).toEqual(sinceB);
    expect(sinceB.getTime()).toBeGreaterThan(sinceA.getTime());
    const inMargin = n.alert();
    await n.pass(15);
    const ofSecond = n.alert();
    await n.pass(10);
    expect(await n.sync()).toMatchObject({ created: 1 });

    const queued = [afterRevoke, beforeCheck, lagging, inMargin];
    expect(await findingsOf([...queued, ofSecond])).toEqual([
      {
        rawEventId: ofSecond.id,
        tenantId: second,
        accountId: cloudB.accountId,
        logSource: 'cloudwatch_logs',
      },
    ]);
    expect(await unownedOf(queued)).toEqual({
      [afterRevoke.id]: 'unknown_source:',
      ...reasons([beforeCheck, lagging, inMargin], 'ambiguous_source'),
    });
    expect(await prisma.finding.count({ where: { tenantId: first } })).toBe(0);
  });

  it('a geração aplicada atrás da planejada não derruba a prova; a que a tarefa não conferiu, sim', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (geração aplicada)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const n = await node([tenant]);
    await n.applied();
    await n.pass(1);
    const since = n.now();
    await n.pass(20);

    // Outro grupo do mesmo dono: a lista planejada muda, e o host demora 5 min para aplicar. O manager segue na
    // geração que a tarefa conferiu, só com grupos deste dono.
    const applied = (await n.record())?.generation;
    await logGroup(cloud);
    await n.pass(5);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since, generation: applied });
    const whileLagging = n.alert();
    // O host aplica a lista nova, do mesmo dono: a prova continua, com o mesmo começo.
    await n.applied();
    await n.pass(1);
    const next = await n.record();
    expect(next).toMatchObject({ ownerTenantId: tenant, since });
    expect(next?.generation).not.toBe(applied);
    // Uma tentativa do host que nem chegou ao gerador (o banco fora do ar) não mexeu no manager.
    await n.applied('error', null);
    await n.pass(9);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since });
    expect(await n.sync()).toMatchObject({ created: 1 });
    expect(await findingsOf([whileLagging])).toMatchObject([{ tenantId: tenant }]);

    // O host aplica uma lista que o worker não planejou (uma autorização desfeita entre duas conferências, pega pelo
    // timer do host). O manager já a roda antes de a tarefa ler o sinal.
    await n.applied('ok', 'f'.repeat(64));
    const unverified = n.alert();
    // O sync roda antes da conferência: o registro ainda está de pé, e é a espera que segura o alerta.
    expect(await n.sync()).toMatchObject({ created: 0, deferred: 1 });
    await n.pass(1);
    expect(await n.record()).toBeNull();
    expect(n.proven()).toBe('unproven');
    await n.pass(12);
    expect(await n.sync()).toMatchObject({ created: 0 });

    // Com erro também: a lista não conferida rodou no manager até ele voltar para a anterior.
    await n.applied();
    await n.pass(1);
    expect(await n.record()).not.toBeNull();
    await n.applied('error', 'e'.repeat(64));
    await n.pass(1);
    expect(await n.record()).toBeNull();

    // A lista planejada aplicada de novo: a prova renasce, com outro começo.
    await n.applied();
    await n.pass(1);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: n.now() });
    expect(await findingsOf([unverified])).toEqual([]);
    expect(await unownedOf([unverified])).toEqual(reasons([unverified], 'ambiguous_source'));
  });

  it('duas trocas do host entre duas conferências: a do meio, que a tarefa nunca viu, derruba a prova pelo número de sequência', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (duas trocas sem ver)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const n = await node([tenant]);
    await n.applied();
    await n.pass(1);
    const since = n.now();
    await n.pass(30);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since });

    // Entre duas conferências, o host troca a configuração duas vezes: primeiro uma lista que o worker nunca planejou
    // (uma autorização desfeita em menos de 30 s, pega pelo timer do host), depois a planejada de novo. O sinal só
    // guarda a última tentativa: a tarefa vê ok para a geração conferida, como se nada tivesse acontecido no meio.
    await n.applied('ok', 'f'.repeat(64));
    const hidden = n.alert();
    await n.applied();
    await n.pass(1);
    // O número de sequência andou dois: a prova de antes cai, e a nova nasce agora, com outro começo.
    const reborn = n.now();
    expect(reborn.getTime()).toBeGreaterThan(since.getTime());
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: reborn });
    // O alerta do meio (o que a configuração não conferida entregou) fica dentro da margem da prova nova: vai para a
    // fila sem dono, e nunca vira achado do cliente.
    await n.pass(12);
    expect(await n.sync()).toMatchObject({ created: 0, unowned: 1 });
    expect(await findingsOf([hidden])).toEqual([]);
    expect(await unownedOf([hidden])).toEqual(reasons([hidden], 'ambiguous_source'));

    // Uma troca só, para a lista planejada, não derruba nada: o começo é o mesmo.
    await logGroup(cloud);
    await n.pass(1);
    await n.applied();
    await n.pass(1);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: reborn });
    // A mesma lista aplicada de novo sem troca nenhuma (o timer do host, a cada 15 min) também não.
    await n.applied('ok', undefined, 0);
    await n.pass(1);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: reborn });
  });

  it('a tentativa que derrubou o manager e voltou à configuração anterior derruba a prova, mesmo com a geração conferida', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (volta da configuração)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const n = await node([tenant]);
    await n.applied();
    await n.pass(1);
    await n.pass(20);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant });

    // Outro grupo do mesmo dono; o manager não fica saudável com a lista nova, e o host volta a anterior: duas trocas
    // (a ida e a volta), com erro para a geração planejada.
    await logGroup(cloud);
    await n.pass(1);
    await n.applied('error');
    await n.pass(1);
    expect(await n.record()).toBeNull();
    expect(n.proven()).toBe('unproven');
    // A mesma lista não é tentada de novo (o sinal segue com erro, sem troca): nenhuma prova nasce de um erro.
    await n.applied('error', undefined, 0);
    await n.pass(3);
    expect(await n.record()).toBeNull();
    // Corrigida a lista e aplicada com sucesso, a prova nasce de novo, com outro começo.
    await n.applied();
    await n.pass(1);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: n.now() });
  });

  it('o sinal do host de uma versão anterior, sem o número de sequência, nunca é prova', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (host de versão anterior)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const n = await node([tenant]);
    // Durante a atualização do nó: o worker novo lê o sinal que o script anterior gravou.
    await n.applied('ok', undefined, 'legacy');
    await n.pass(20);
    expect(await n.record()).toBeNull();
    expect(n.proven()).toBe('unproven');
    // O sinal continua valendo para o resto (a lista de agora consta como aplicada): só a prova não nasce dele.
    expect((await n.check()).state).toBe('ok');
    const during = n.alert();
    await n.pass(12);
    expect(await n.sync()).toMatchObject({ created: 0, unowned: 1 });
    expect(await unownedOf([during])).toEqual(reasons([during], 'ambiguous_source'));

    // O script novo grava o número: a prova nasce.
    await n.applied();
    await n.pass(1);
    const since = n.now();
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since });
    // E um sinal sem o número no meio (a volta de versão do nó) a derruba de novo.
    await n.applied('ok', undefined, 'legacy');
    await n.pass(1);
    expect(await n.record()).toBeNull();
    // A linha gravada antes de o número existir (a coluna vazia) também não vale: a tarefa a refaz.
    await n.applied();
    await n.pass(1);
    await prisma.cloudWatchAlertOwnership.update({ where: { id: n.key }, data: { appliedSeq: null } });
    const before = await n.record();
    n.skip(1);
    await n.check();
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant, since: n.now() });
    expect(n.now().getTime()).toBeGreaterThan(before?.since.getTime() ?? 0);
  });

  it('a fila vence: o alerta que já foi para a fila sem dono não vira achado numa releitura, nem cabendo na prova', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (a fila vence)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const n = await node([tenant]);
    await n.applied();
    await n.pass(1);
    await n.pass(30);

    // A conta é desativada e reativada entre duas conferências: a tarefa nunca viu a lista mudar, e a prova segue de
    // pé. No meio, o sync leu um alerta sem ninguém com grupo autorizado.
    await prisma.cloudAccount.update({ where: { id: cloud.id }, data: { status: 'inactive' } });
    const orphan = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0, unowned: 1 });
    await prisma.cloudAccount.update({ where: { id: cloud.id }, data: { status: 'active' } });
    const next = n.alert();
    await n.pass(11);
    expect(await n.record()).toMatchObject({ ownerTenantId: tenant });

    // Relido, o alerta cabe na prova (depois da margem, antes da última conferência assentada), mas a fila vence.
    expect(await n.sync()).toMatchObject({ created: 1, keptUnowned: 1 });
    expect(await findingsOf([orphan, next])).toMatchObject([{ rawEventId: next.id, tenantId: tenant }]);
    expect(await unownedOf([orphan, next])).toEqual({ [orphan.id]: 'unknown_source:' });
    expect(await n.rereadAll()).toMatchObject({ created: 0, duplicates: 1, keptUnowned: 1 });
    expect(await findingsOf([orphan])).toEqual([]);
  });

  it('o achado que já existe não ganha uma linha na fila quando a prova cai e a sobreposição o relê', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (a primeira decisão vale)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const n = await node([tenant]);
    await n.applied();
    await n.pass(1);
    await n.pass(20);
    const mine = n.alert();
    await n.pass(10);
    expect(await n.sync()).toMatchObject({ created: 1 });

    // O nó reinicia logo depois: a prova cai, e a execução seguinte relê o alerta (a sobreposição de 10 min) sem ela.
    await n.lostSignal();
    await n.pass(1);
    expect(await n.record()).toBeNull();
    const afterRestart = n.alert();
    expect(await n.sync()).toMatchObject({ created: 0, duplicates: 1, unowned: 1 });
    expect(await findingsOf([mine, afterRestart])).toMatchObject([{ rawEventId: mine.id, tenantId: tenant }]);
    // Na fila, só o alerta de depois: o que já é achado do cliente não aparece para a equipe da Verax como sem dono.
    expect(await unownedOf([mine, afterRestart])).toEqual(reasons([afterRestart], 'ambiguous_source'));
  });

  it('na célula a tarefa não grava a prova: sem ela, nenhum alerta do CloudWatch Logs é atribuído', async () => {
    const tenant = await createTenant(app, 'Cliente Demo A (célula)');
    const cloud = await account(tenant);
    await logGroup(cloud);
    const dir = await mkdtemp(join(tmpdir(), 'verax-cloudwatch-ownership-'));
    dirs.push(dir);
    const key = `teste-${randomUUID().slice(0, 8)}`;
    const config = new WazuhConfig(prisma, dir, {
      tenantIds: [tenant],
      sourceHealth: false,
      cloudWatchOwnershipKey: key,
    });
    const generation = wazuhSourcesGeneration(
      serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, [tenant]))),
    );
    await writeFile(
      join(dir, 'applied'),
      `${JSON.stringify({ generation, status: 'ok', at: iso(new Date()) })}\n`,
    );
    const report = await config.runOnce();
    expect(report).toMatchObject({ state: 'ok' });
    expect(report.cloudWatch).toBeUndefined();
    expect(await prisma.cloudWatchAlertOwnership.findUnique({ where: { id: key } })).toBeNull();
  });
});

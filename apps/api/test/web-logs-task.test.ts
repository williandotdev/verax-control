import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { findWazuhSourceRows, serializeWazuhSources, toWazuhSources } from '../src/aws/wazuh-sources.js';
import { CaseAssignJob } from '../src/cases/case-assign-job.js';
import { CaseAlertNotices } from '../src/cases/case-notice-regime.js';
import { PrismaService } from '../src/common/prisma/prisma.service.js';
import { MAX_LINE_CHARS } from '../src/weblogs/alb/alb-line.js';
import { albLine, times } from './support/alb-lines.js';
import { awsFault, deliver, gzipLines, linesOf } from './support/fake-alb-s3.js';
import { AUTHORIZED, HOUR, MINUTE, NOON, SLOT, START, webLogsHarness } from './support/web-logs-harness.js';

/** A tarefa `web-logs`: o caminho comum, com S3 falso e Postgres de verdade. */
describe('tarefa web-logs', () => {
  let prisma: PrismaService;
  let h: ReturnType<typeof webLogsHarness>;

  beforeAll(() => {
    prisma = new PrismaService({ DATABASE_URL: inject('testDatabaseUrl') });
    h = webLogsHarness(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const attack = times(30, (i) => ({
    client: '198.51.100.7',
    method: 'POST',
    path: '/login',
    status: 401,
    time: NOON - 4 * MINUTE + i * 1_000,
  }));

  it('lê, analisa, grava o achado, mede o volume e soma o tráfego por país; a segunda passagem não repete nada', async () => {
    const site = await h.newSite('caminho comum');
    const { task, s3, clock, credentials } = h.newTask([site.tenantId]);
    const browse = times(10, () => ({ client: '192.0.2.10', path: '/produtos' }));
    const first = deliver(s3, site.balancer, NOON, [...attack, ...browse]);
    const second = deliver(s3, site.balancer, NOON, [{ client: '2001:db8::5', status: 503 }], {
      node: '10.0.1.6',
    });

    const report = await task.runOnce();
    expect(report).toMatchObject({
      status: 'done',
      sources: 1,
      synced: 1,
      capped: 0,
      failed: 0,
      broken: 0,
      objects: 2,
      replayed: 0,
      lines: 41,
      malformed: 0,
      findings: 1,
      observed: 0,
      transitions: 1,
    });
    expect(credentials.sessions).toEqual([{ accountId: site.balancer.account, region: 'sa-east-1' }]);

    // Só leitura, no bucket e na pasta do balanceador.
    const root = `AWSLogs/${site.balancer.account}/elasticloadbalancing/sa-east-1/2026/11/`;
    expect(new Set(s3.calls.map((call) => call.command))).toEqual(
      new Set(['ListObjectsV2Command', 'GetObjectCommand']),
    );
    for (const call of s3.calls) {
      expect(call.bucket).toBe(site.balancer.bucket);
      expect(call.key.startsWith(root)).toBe(true);
      expect(call.key).toContain(
        `${site.balancer.account}_elasticloadbalancing_sa-east-1_app.loja.0123456789abcdef_`,
      );
      expect(call.region).toBe('sa-east-1');
    }
    expect(s3.gets.map((call) => call.key).sort()).toEqual([first, second].sort());
    expect(s3.open).toBe(0);

    const [finding, ...others] = await h.findings(site);
    expect(others).toEqual([]);
    expect(finding).toMatchObject({
      accountId: site.balancer.account,
      source: 'aws',
      logSource: 'alb',
      ruleId: '990405',
      ruleLevel: 7,
      severity: 'medium',
      sourceIp: '198.51.100.7',
      resource: 'alb:app/loja/0123456789abcdef',
      status: 'new',
    });
    const evidence = await prisma.findingEvidence.findFirstOrThrow({
      where: { findingId: finding?.id ?? '' },
    });
    expect(evidence.data).toMatchObject({ ruleId: '990405', client: '198.51.100.7' });
    // Nível 7 não avisa por e-mail.
    expect(await prisma.notification.count({ where: { tenantId: site.tenantId } })).toBe(0);

    const bytes = [...attack, ...browse].length;
    expect(bytes).toBe(40);
    const rows = await h.ledger(site);
    expect(
      rows.map(({ status, lines, malformed, oversize, foreign }) => ({
        status,
        lines,
        malformed,
        oversize,
        foreign,
      })),
    ).toEqual(
      expect.arrayContaining([
        { status: 'read', lines: 40, malformed: 0, oversize: 0, foreign: 0 },
        { status: 'read', lines: 1, malformed: 0, oversize: 0, foreign: 0 },
      ]),
    );
    expect(rows.every((row) => row.slotStart?.getTime() === NOON - SLOT)).toBe(true);
    const total = rows.reduce((sum, row) => sum + Number(row.bytes), 0);
    expect(await h.usage(site)).toEqual({
      month: { bytes: total, events: 41 },
      day: { bytes: total, events: 41 },
    });
    expect(report.bytes).toBe(total);
    expect(await h.traffic(site)).toEqual([
      {
        slot: -1,
        country: 'BR',
        cls: 'direct',
        requests: 10,
        blocked: 0,
        clientErrors: 0,
        serverErrors: 0,
        flagged: 0,
      },
      {
        slot: -1,
        country: 'DE',
        cls: 'direct',
        requests: 1,
        blocked: 0,
        clientErrors: 0,
        serverErrors: 1,
        flagged: 0,
      },
      {
        slot: -1,
        country: 'US',
        cls: 'direct',
        requests: 30,
        blocked: 0,
        clientErrors: 30,
        serverErrors: 0,
        flagged: 30,
      },
    ]);

    expect(await h.sourceRow(site)).toMatchObject({
      state: 'collecting',
      stateCode: null,
      stateSince: START,
      lastSyncAt: START,
      lastIngestedAt: START,
      lastEventAt: new Date(NOON - MINUTE),
      permission: 'granted',
      eventsLast24h: 41,
      bytesLast24h: BigInt(total),
    });
    // O atraso é até o fim do último intervalo fechado (o das 11:50).
    expect((await h.sourceRow(site)).lagSeconds).toBe((START.getTime() - (NOON - 10 * MINUTE)) / 1000);
    expect((await h.cursor(site)).cursorAt).toEqual(new Date(NOON - 10 * MINUTE));
    const trail = await h.audit(site);
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      actorType: 'system',
      before: { sourceId: site.sourceId, state: 'authorized' },
      after: { sourceId: site.sourceId, state: 'collecting' },
    });
    // O tráfego do ALB não é sinal de vida da conta.
    expect(
      (await prisma.cloudAccount.findUniqueOrThrow({ where: { id: site.accountRow } })).lastEventAt,
    ).toBeNull();
    // O relatório vai para o log: nada do conteúdo.
    expect(JSON.stringify(report)).not.toMatch(/198\.51|login|loja|AWSLogs|log\.gz/);

    // Ainda não está na hora: nenhuma chamada. Na hora: os mesmos objetos não são abertos de novo.
    const before = s3.calls.length;
    clock.advance(2 * MINUTE);
    expect(await task.runOnce()).toMatchObject({ notDue: 1, synced: 0 });
    expect(s3.calls).toHaveLength(before);
    clock.advance(4 * MINUTE);
    expect(await task.runOnce()).toMatchObject({ synced: 1, objects: 0, replayed: 0, findings: 0 });
    expect(s3.gets).toHaveLength(2);
    expect((await h.usage(site)).day?.bytes).toBe(total);
    expect(await h.requests(site)).toBe(41);
    expect(await h.findings(site)).toHaveLength(1);
  });

  it('sem arquivo: aguardando eventos, sem achado, sem volume e sem autorização depender da permissão gravada', async () => {
    const site = await h.newSite('sem arquivo', {
      source: { permission: 'missing', permissionDetail: 'bucket_denied' },
    });
    const { task } = h.newTask([site.tenantId]);
    expect(await task.runOnce()).toMatchObject({ synced: 1, objects: 0 });
    expect(await h.sourceRow(site)).toMatchObject({
      state: 'waiting_events',
      lastSyncAt: START,
      lastIngestedAt: null,
      eventsLast24h: 0,
      // A listagem desmente a falta dela.
      permission: 'granted',
    });
    expect(await h.usage(site)).toEqual({ month: null, day: null });
    expect(await h.state(site)).toMatchObject({ loadBalancer: 'app/loja/0123456789abcdef', version: 1 });
  });

  it('o arquivo de antes da autorização nunca é aberto, nem registrado', async () => {
    const authorizedAt = new Date(NOON - 12 * MINUTE);
    const site = await h.newSite('antes da autorização', { authorizedAt });
    const { task, s3, clock } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON - 10 * MINUTE, attack);
    deliver(s3, site.balancer, NOON - 2 * HOUR, attack);
    const own = deliver(s3, site.balancer, NOON - 5 * MINUTE, [{ client: '192.0.2.10' }]);
    await task.runOnce();
    clock.advance(6 * MINUTE);
    await task.runOnce();
    expect(s3.gets.map((call) => call.key)).toEqual([own]);
    expect(await h.ledger(site)).toHaveLength(1);
    expect(await h.findings(site)).toEqual([]);
  });

  it('linhas tortas, de outro balanceador, grandes demais e o prefixo do bucket: contadas e à vista', async () => {
    const site = await h.newSite('linhas tortas', { prefix: 'logs/producao' });
    const { task, s3 } = h.newTask([site.tenantId]);
    const good = linesOf(
      NOON,
      times(3, () => ({ client: '192.0.2.10' })),
    );
    const foreign = albLine({ time: NOON - MINUTE, lb: 'app/outro/fedcba9876543210' });
    const body = gzipLines([...good, 'isto não é uma linha', foreign, 'x'.repeat(MAX_LINE_CHARS + 1)]);
    const key = deliver(s3, site.balancer, NOON, body);
    expect(key.startsWith('logs/producao/AWSLogs/')).toBe(true);
    expect(await task.runOnce()).toMatchObject({
      objects: 1,
      lines: 6,
      malformed: 1,
      foreign: 1,
      oversize: 1,
    });
    expect(await h.ledger(site)).toMatchObject([
      {
        status: 'read',
        lines: 6,
        malformed: 1,
        foreign: 1,
        oversize: 1,
        bytes: BigInt(gunzipSync(body).length),
      },
    ]);
    expect(await h.requests(site)).toBe(3);
    expect((await h.sourceRow(site)).eventsLast24h).toBe(3);
  });

  it('objetos de outro balanceador, de conexão, de health check, de NLB e plantados não são abertos', async () => {
    const site = await h.newSite('objetos alheios');
    const { task, s3 } = h.newTask([site.tenantId]);
    const own = deliver(s3, site.balancer, NOON, [{ client: '192.0.2.10' }]);
    const twist = (...pairs: [string, string][]) =>
      s3.put(
        site.balancer.bucket,
        pairs.reduce((key, [from, to]) => key.split(from).join(to), own),
        gzipLines(linesOf(NOON, attack)),
      );
    twist(['app.loja.0123456789abcdef', 'app.loja.0123456789abcde0']);
    twist(['app.loja.', 'app.loja2.']);
    twist(['_app.loja', '_net.loja']);
    twist([
      `${site.balancer.account}_elasticloadbalancing`,
      `conn_log_${site.balancer.account}_elasticloadbalancing`,
    ]);
    twist([
      `${site.balancer.account}_elasticloadbalancing`,
      `health_check_log_${site.balancer.account}_elasticloadbalancing`,
    ]);
    // No prefixo do balanceador, mas fora da gramática.
    twist(['_10.0.1.5_abc123', '_10.0.1.5_abc123_extra']);
    twist(['_abc123.log.gz', '_abc123.log.gz.sh']);
    twist(['T1200Z', 'T2500Z']);
    twist(['10.0.1.5', '../../etc']);
    const report = await task.runOnce();
    expect(s3.gets.map((call) => call.key)).toEqual([own]);
    expect(report).toMatchObject({ objects: 1 });
    expect(report.ignored).toBeGreaterThanOrEqual(3);
    expect(await h.ledger(site)).toHaveLength(1);
    expect(await h.findings(site)).toEqual([]);
  });

  it('observando: nenhum achado nem aviso; o que teria virado achado fica contado, uma vez, também depois de um reinício', async () => {
    const site = await h.newSite('observando', { mode: 'observe' });
    const { task, s3, clock, lease } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON, attack);
    expect(await task.runOnce()).toMatchObject({ objects: 1, findings: 0, observed: 1 });
    expect(await h.findings(site)).toEqual([]);
    expect(await prisma.notification.count({ where: { tenantId: site.tenantId } })).toBe(0);
    clock.advance(6 * MINUTE);
    expect(await task.runOnce()).toMatchObject({ observed: 0 });
    const saved = await h.state(site);
    expect(saved?.state.observation).toMatchObject({
      since: AUTHORIZED.toISOString(),
      rules: [{ ruleId: '990405', level: 7, findings: 1 }],
      truncated: false,
    });
    expect(JSON.stringify(saved?.state.observation)).not.toContain('198.51');
    // Um processo novo relê a janela e acha o mesmo: não conta de novo.
    await task.close();
    const again = h.newTask([site.tenantId], { s3, clock, lease });
    clock.advance(6 * MINUTE);
    expect(await again.task.runOnce()).toMatchObject({ replayed: 1, objects: 0, observed: 0 });
    clock.advance(6 * MINUTE);
    await again.task.runOnce();
    expect((await h.state(site))?.state.observation.rules).toMatchObject([{ findings: 1 }]);
    // Nada vira alerta sozinho.
    expect(
      (await prisma.webSourceSettings.findFirstOrThrow({ where: { sourceId: site.sourceId } })).mode,
    ).toBe('observe');
    // A observação que recomeça (nova autorização) começa do zero.
    await prisma.webSourceSettings.updateMany({
      where: { sourceId: site.sourceId },
      data: { observeUntil: new Date(NOON + 80 * HOUR) },
    });
    clock.advance(6 * MINUTE);
    await again.task.runOnce();
    expect((await h.state(site))?.state.observation).toMatchObject({
      since: new Date(NOON + 8 * HOUR).toISOString(),
    });
  });

  it('o modo, o multiplicador, as fontes confiáveis e as rotas mudadas valem na passagem seguinte', async () => {
    const site = await h.newSite('configuração', { mode: 'observe' });
    const { task, s3, clock } = h.newTask([site.tenantId]);
    const now = clock.now();
    await prisma.webTrustedSource.create({
      data: {
        tenantId: site.tenantId,
        sourceId: null,
        cidr: '198.51.100.0/24',
        kind: 'pentest',
        reason: 'teste contratado',
        expiresAt: new Date(now.getTime() + 20 * MINUTE),
      },
    });
    const burst = (endMs: number, path = '/login') =>
      times(30, () => ({ client: '198.51.100.7', method: 'POST', path, status: 401, time: endMs - MINUTE }));
    const next = async (endMs: number, path?: string) => {
      deliver(s3, site.balancer, endMs, burst(endMs, path));
      clock.advance(endMs + MINUTE - clock.now().getTime());
      return task.runOnce();
    };
    // Calado pela fonte confiável, com o contador à vista.
    expect(await next(NOON)).toMatchObject({ observed: 0 });
    expect((await h.state(site))?.state.suppressed).toMatchObject([{ ruleId: '990405', clients: 1 }]);
    await prisma.webSourceSettings.updateMany({
      where: { sourceId: site.sourceId },
      data: { mode: 'alert' },
    });
    expect(await next(NOON + 10 * MINUTE)).toMatchObject({ findings: 0 });
    // Vencida no meio do caminho, sem ninguém mexer em nada: o mesmo endereço vira achado.
    expect(await next(NOON + 25 * MINUTE)).toMatchObject({ findings: 1 });
    expect(await h.findings(site)).toMatchObject([{ ruleId: '990405' }]);
    // Multiplicador 10: as mesmas 30 falhas, noutra rota, ficam abaixo do limite.
    await prisma.webSourceSettings.updateMany({
      where: { sourceId: site.sourceId },
      data: { thresholdMultiplier: 10 },
    });
    expect(await next(NOON + 60 * MINUTE, '/admin/login')).toMatchObject({ findings: 0 });
    // O intervalo fecha com o multiplicador que valia.
    expect(await next(NOON + 80 * MINUTE, '/outra')).toMatchObject({ findings: 0 });
    // A rota declarada, com o multiplicador dela: 10 vezes 0,5 vezes 20 são 100, e 30 ficam abaixo; de volta a 1, passam.
    await prisma.webSourceSettings.updateMany({
      where: { sourceId: site.sourceId },
      data: { thresholdMultiplier: 1 },
    });
    await prisma.webRoute.create({
      data: {
        tenantId: site.tenantId,
        sourceId: site.sourceId,
        host: null,
        method: 'POST',
        path: '/entrar',
        kind: 'login',
        failureCodes: [401],
        successCodes: [200],
        multiplier: 1,
      },
    });
    expect(await next(NOON + 120 * MINUTE, '/entrar')).toMatchObject({ findings: 1 });
    expect((await h.findings(site)).map((row) => row.mitreTechniques)).toContainEqual(['T1110', 'T1110.001']);
  });

  it('a fonte confiável de outro balanceador, ou de outro cliente, não cala nada', async () => {
    const site = await h.newSite('confiável alheia');
    const other = await h.newSite('outro balanceador', {
      tenantId: site.tenantId,
      lb: 'app/outra/00000000000000aa',
    });
    const stranger = await h.newSite('outro cliente');
    for (const [tenantId, sourceId] of [
      [site.tenantId, other.sourceId],
      [stranger.tenantId, null],
    ] as const) {
      await prisma.webTrustedSource.create({
        data: {
          tenantId,
          sourceId,
          cidr: '198.51.100.0/24',
          kind: 'office',
          reason: 'escritório',
          expiresAt: new Date(NOON + 24 * HOUR),
        },
      });
    }
    const { task, s3 } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON, attack);
    expect(await task.runOnce()).toMatchObject({ findings: 1 });
  });

  it('a exceção por regra e IP marca o achado como esperado, sem aviso', async () => {
    const site = await h.newSite('exceção');
    const author = await prisma.user.create({
      data: {
        id: `usuario-${site.tenantId}`,
        name: 'Usuário de teste',
        email: `${site.tenantId}@cliente.example`,
        tenantId: site.tenantId,
        role: 'admin_cliente',
        status: 'active',
      },
      select: { id: true },
    });
    await prisma.alertException.create({
      data: {
        tenantId: site.tenantId,
        ruleId: '990405',
        field: 'ip',
        value: '198.51.100.7',
        reason: 'teste',
        createdById: author.id,
      },
    });
    const { task, s3 } = h.newTask([site.tenantId]);
    deliver(
      s3,
      site.balancer,
      NOON,
      times(120, () => attack[0] ?? {}),
    );
    expect(await task.runOnce()).toMatchObject({ findings: 1, excepted: 1 });
    expect(await h.findings(site)).toMatchObject([{ status: 'legitimate', severity: 'high' }]);
    expect(await prisma.notification.count({ where: { tenantId: site.tenantId } })).toBe(0);
  });

  it('só o achado alto ou crítico avisa por e-mail, uma vez', async () => {
    const site = await h.newSite('aviso');
    const { task, s3, clock } = h.newTask([site.tenantId]);
    deliver(
      s3,
      site.balancer,
      NOON,
      times(120, () => attack[0] ?? {}),
    );
    await task.runOnce();
    clock.advance(6 * MINUTE);
    await task.runOnce();
    expect(await prisma.notification.findMany({ where: { tenantId: site.tenantId } })).toMatchObject([
      { kind: 'high_finding', severity: 'high' },
    ]);
  });

  it('com os avisos por caso, o achado não avisa sozinho, e entra no caso do ataque ao login', async () => {
    const site = await h.newSite('caso do login');
    const { task, s3, lease } = h.newTask([site.tenantId], {
      notices: new CaseAlertNotices({ active: true }),
    });
    deliver(
      s3,
      site.balancer,
      NOON,
      times(120, () => attack[0] ?? {}),
    );
    expect(await task.runOnce()).toMatchObject({ findings: 1 });
    expect(await h.findings(site)).toMatchObject([{ ruleId: '990405', severity: 'high' }]);
    expect(await prisma.notification.count({ where: { tenantId: site.tenantId } })).toBe(0);
    const assign = new CaseAssignJob(prisma, {
      name: `${lease}-caso`,
      tenantIds: [site.tenantId],
      caseNotices: true,
    });
    expect(await assign.runOnce()).toMatchObject({ assigned: 1, opened: 1 });
    expect(await prisma.alertCase.findMany({ where: { tenantId: site.tenantId } })).toMatchObject([
      {
        queue: 'detection',
        family: 'web-login',
        title: 'Ataque ao login da aplicação',
        noticedSeverity: null,
      },
    ]);
  });

  it('o WAF da conta coletando rebaixa o que ele barrou; sem ele, não', async () => {
    const held = await h.newSite('com WAF');
    await prisma.awsSource.create({
      data: {
        tenantId: held.tenantId,
        cloudAccountId: held.accountRow,
        kind: 'waf',
        region: 'sa-east-1',
        resourceId: 'acl',
        name: 'acl',
        method: 's3',
        availability: 'available',
        authorizedAt: AUTHORIZED,
        state: 'collecting',
      },
    });
    // Noutra região, o WAF não diz nada deste balanceador.
    const bare = await h.newSite('sem WAF');
    await prisma.awsSource.create({
      data: {
        tenantId: bare.tenantId,
        cloudAccountId: bare.accountRow,
        kind: 'waf',
        region: 'us-east-1',
        resourceId: 'acl',
        name: 'acl',
        method: 's3',
        availability: 'available',
        authorizedAt: AUTHORIZED,
        state: 'collecting',
      },
    });
    const { task, s3 } = h.newTask([held.tenantId, bare.tenantId]);
    const probes = times(400, (i) => ({
      client: '198.51.100.9',
      path: `/p${i}/.env`,
      status: 403,
      actions: 'waf',
    }));
    deliver(s3, held.balancer, NOON, probes);
    deliver(s3, bare.balancer, NOON, probes);
    await task.runOnce();
    const levels = async (site: typeof held) =>
      (await h.findings(site)).filter((row) => row.ruleId === '990402').map((row) => row.ruleLevel);
    expect(await levels(held)).toEqual([4]);
    expect(await levels(bare)).toEqual([7]);
  });

  it('dois clientes e duas contas na mesma execução: nada cruza', async () => {
    const a = await h.newSite('A');
    const b = await h.newSite('B');
    const { task, s3 } = h.newTask([a.tenantId, b.tenantId]);
    deliver(s3, a.balancer, NOON, attack);
    deliver(
      s3,
      b.balancer,
      NOON,
      times(5, () => ({ client: '203.0.113.200' })),
    );
    // Um objeto da conta B plantado no bucket da A não é da A.
    s3.put(
      a.balancer.bucket,
      deliver(s3, b.balancer, NOON, [{ client: '192.0.2.99' }], { random: 'zzz' }),
      gzipLines([]),
    );
    expect(await task.runOnce()).toMatchObject({ sources: 2, synced: 2, objects: 3 });
    expect((await h.findings(a)).map((row) => row.accountId)).toEqual([a.balancer.account]);
    expect(await h.findings(b)).toEqual([]);
    expect(await h.requests(a)).toBe(30);
    expect(await h.requests(b)).toBe(6);
    expect((await h.usage(a)).day?.events).toBe(30);
    expect((await h.usage(b)).day?.events).toBe(6);
    expect((await h.ledger(a)).every((row) => row.tenantId === a.tenantId)).toBe(true);
    expect((await h.state(b))?.state.observation.rules).toEqual([]);
  });

  it('a fonte fora da seleção não é lida: revogada, sumida, conta inativa, cliente suspenso, sem conexão', async () => {
    const cases: [string, (site: Awaited<ReturnType<typeof h.newSite>>) => Promise<unknown>][] = [
      [
        'revogada',
        (site) =>
          prisma.awsSource.update({
            where: { id: site.sourceId },
            data: { state: 'revoked', revokedAt: new Date(NOON - HOUR) },
          }),
      ],
      [
        'sumida',
        (site) =>
          prisma.awsSource.update({ where: { id: site.sourceId }, data: { state: 'source_missing' } }),
      ],
      [
        'nunca autorizada',
        (site) =>
          prisma.awsSource.update({
            where: { id: site.sourceId },
            data: { state: 'available', authorizedAt: null, authorizedBy: null, collectFrom: null },
          }),
      ],
      [
        'conta inativa',
        (site) =>
          prisma.cloudAccount.update({ where: { id: site.accountRow }, data: { status: 'inactive' } }),
      ],
      [
        'cliente suspenso',
        (site) => prisma.tenant.update({ where: { id: site.tenantId }, data: { status: 'suspended' } }),
      ],
      [
        'conta sem conexão',
        (site) =>
          prisma.cloudAccount.update({ where: { id: site.accountRow }, data: { connection: 'waiting' } }),
      ],
      [
        'conta que não entra no papel',
        (site) =>
          prisma.cloudAccount.update({
            where: { id: site.accountRow },
            data: { connection: 'error', connectionError: 'trust_denied' },
          }),
      ],
    ];
    for (const [name, change] of cases) {
      const site = await h.newSite(name);
      const { task, s3, credentials } = h.newTask([site.tenantId]);
      deliver(s3, site.balancer, NOON, attack);
      await change(site);
      const report = await task.runOnce();
      expect([name, report.synced, s3.calls.length, credentials.sessions.length]).toEqual([name, 0, 0, 0]);
      expect(await h.ledger(site)).toEqual([]);
    }
  });

  it('a lista do Wazuh é a mesma, byte a byte, antes, durante e depois da leitura', async () => {
    const site = await h.newSite('Wazuh intocado');
    await prisma.awsSource.create({
      data: {
        tenantId: site.tenantId,
        cloudAccountId: site.accountRow,
        kind: 'cloudtrail',
        region: 'sa-east-1',
        resourceId: `arn:aws:cloudtrail:sa-east-1:${site.balancer.account}:trail/trilha`,
        name: 'trilha',
        details: { bucket: 'trilha-da-conta' },
        method: 's3',
        availability: 'available',
        permission: 'granted',
        authorizedAt: AUTHORIZED,
        collectFrom: new Date('2026-11-24'),
        state: 'collecting',
      },
    });
    const line = async () =>
      serializeWazuhSources(toWazuhSources(await findWazuhSourceRows(prisma, [site.tenantId])));
    const others = () =>
      prisma.awsSource.findMany({ where: { tenantId: site.tenantId, NOT: { kind: 'elb_logs' } } });
    const before = await line();
    const untouched = await others();
    expect(before).toContain('trilha-da-conta');
    expect(before).not.toContain(site.balancer.bucket);
    const { task, s3, clock } = h.newTask([site.tenantId]);
    deliver(s3, site.balancer, NOON, attack);
    const during: string[] = [];
    s3.onGet = async () => {
      during.push(await line());
      return undefined;
    };
    await task.runOnce();
    s3.onList = () => awsFault('AccessDenied', 403);
    clock.advance(6 * MINUTE);
    await task.runOnce();
    expect(await h.sourceRow(site)).toMatchObject({ state: 'permission_error' });
    expect(during).toEqual([before]);
    expect(await line()).toBe(before);
    expect(await others()).toEqual(untouched);
  });

  it('no máximo 20 balanceadores por conta', async () => {
    const tenantId = await h.newTenant('vinte');
    const account = await h.newAccount(tenantId);
    for (let i = 0; i < 21; i += 1) {
      await h.newSite(`alb ${i}`, {
        account,
        lb: `app/alb-${i}/00000000000000${String(i).padStart(2, '0')}`,
        authorizedAt: new Date(AUTHORIZED.getTime() + i * 1_000),
      });
    }
    const { task, s3 } = h.newTask([tenantId]);
    expect(await task.runOnce()).toMatchObject({ sources: 20, overLimit: 1, synced: 20 });
    expect(s3.lists.some((call) => call.key.includes('app.alb-20.'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type AccountActivity,
  awsLogsStalledSince,
  type CollectionSignals,
  collectionHealth,
  coverage,
  DEFAULT_TOWER_THRESHOLDS,
  hourlyCounts,
  lastDataAt,
  medianTimeToDetect,
  pendingDecisions,
  pulseSince,
  stalledSources,
  trafficLight,
} from '../../src/tower/tower-rules.js';

const none = { critical: 0, high: 0, medium: 0, low: 0 };

describe('semáforo da Torre (T5.10, pendência 9)', () => {
  it('vermelho com incidente crítico aberto, qualquer que seja o resto', () => {
    expect(trafficLight({ openIncidents: { ...none, critical: 1 }, postureScore: 95 })).toEqual({
      light: 'red',
      reasons: ['critical_incident'],
    });
    expect(trafficLight({ openIncidents: { ...none, critical: 2, high: 3 }, postureScore: 40 })).toEqual({
      light: 'red',
      reasons: ['critical_incident', 'high_incident', 'low_posture'],
    });
  });

  it('amarelo com incidente alto aberto ou postura abaixo de 70', () => {
    expect(trafficLight({ openIncidents: { ...none, high: 1 }, postureScore: 90 })).toEqual({
      light: 'yellow',
      reasons: ['high_incident'],
    });
    expect(trafficLight({ openIncidents: none, postureScore: 69 })).toEqual({
      light: 'yellow',
      reasons: ['low_posture'],
    });
  });

  it('verde nos demais casos: médios e baixos não mudam a cor, 70 já é verde, sem nota não pesa', () => {
    expect(trafficLight({ openIncidents: { ...none, medium: 5, low: 9 }, postureScore: 70 })).toEqual({
      light: 'green',
      reasons: [],
    });
    expect(trafficLight({ openIncidents: none, postureScore: null })).toEqual({
      light: 'green',
      reasons: [],
    });
  });

  it('o corte de postura vem da configuração', () => {
    const thresholds = { ...DEFAULT_TOWER_THRESHOLDS, postureWarning: 80 };
    expect(trafficLight({ openIncidents: none, postureScore: 75 }, thresholds).light).toBe('yellow');
  });
});

describe('cobertura da Torre (T5.10 e fase 2)', () => {
  const now = new Date('2026-11-02T12:00:00.000Z');
  const CLOUDFLARE_ID = '0123456789abcdef0123456789abcdef';
  /** Conta AWS (lida pelo Wazuh) por padrão. */
  const account = (accountId: string, activity: Partial<AccountActivity> = {}): AccountActivity => ({
    accountId,
    provider: 'aws',
    connection: 'waiting',
    lastCollectedAt: null,
    lastEventAt: null,
    ...activity,
  });

  it('contas conectadas pelo estado, a coleta e o evento mais recentes e as contas silenciosas', () => {
    expect(
      coverage(
        [
          account('444455556666', {
            connection: 'connected',
            lastCollectedAt: '2026-11-02T11:59:30.000Z',
            lastEventAt: '2026-11-02T11:59:00.000Z',
          }),
          account('111122223333', {
            connection: 'error',
            lastCollectedAt: '2026-11-01T11:00:00.000Z',
            lastEventAt: '2026-11-01T10:00:00.000Z',
          }),
          account('222233334444'),
        ],
        now,
      ),
    ).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: '2026-11-02T11:59:30.000Z',
      lastEventAt: '2026-11-02T11:59:00.000Z',
      silentAccounts: ['111122223333', '222233334444'],
    });
  });

  it('AWS lida pelo Wazuh: o evento recente é o sinal de vida, e a conta conectada pelo evento entra na contagem', () => {
    // Sem coleta por conta: o Wazuh só registra o evento, e o evento conecta a conta (`LastEvents.save`).
    const wazuh = account('222233334444', {
      connection: 'connected',
      lastEventAt: '2026-11-02T10:00:00.000Z',
    });
    expect(coverage([wazuh], now)).toMatchObject({ connectedAccounts: 1, silentAccounts: [] });
  });

  it('GCP (assinatura lida a cada minuto): o projeto calmo, lido sem erro e sem entrada há dias, não fica silencioso', () => {
    // A auditoria de um projeto calmo passa dias sem entrada: a leitura bem-sucedida é o sinal de vida (OP-02).
    const quiet = account('vx-projeto-calmo', {
      provider: 'gcp',
      connection: 'connected',
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
      lastEventAt: '2026-10-30T09:00:00.000Z',
    });
    // Lida sem erro e sem nenhuma entrada ainda: a assinatura funciona.
    const empty = account('vx-projeto-vazio', {
      provider: 'gcp',
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
    });
    // As leituras falham há dois dias (a falha não grava a coleta): silenciosa.
    const failing = account('vx-projeto-sem-acesso', {
      provider: 'gcp',
      connection: 'error',
      lastCollectedAt: '2026-10-31T11:00:00.000Z',
      lastEventAt: '2026-10-31T10:00:00.000Z',
    });
    expect(coverage([quiet, empty, failing], now)).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
      lastEventAt: '2026-10-31T10:00:00.000Z',
      silentAccounts: ['vx-projeto-sem-acesso'],
    });
    // A AWS não tem coleta por conta: a coleta não conta, só o alerta e o andamento no Wazuh.
    const aws = account('111122223333', { lastCollectedAt: '2026-11-02T11:58:00.000Z' });
    expect(coverage([aws], now).silentAccounts).toEqual(['111122223333']);
  });

  it('Cloudflare (coletado por API): coleta recente sem nenhum evento não fica silenciosa; coleta antiga, sim', () => {
    const quiet = account(CLOUDFLARE_ID, {
      provider: 'cloudflare',
      connection: 'connected',
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
    });
    expect(coverage([quiet], now)).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: '2026-11-02T11:58:00.000Z',
      lastEventAt: null,
      silentAccounts: [],
    });
    const stalled = account(CLOUDFLARE_ID, {
      provider: 'cloudflare',
      connection: 'error',
      lastCollectedAt: '2026-11-01T09:00:00.000Z',
    });
    expect(coverage([stalled], now).silentAccounts).toEqual([CLOUDFLARE_ID]);
    // O evento recebido também vale como sinal de vida.
    const withEvent = { ...stalled, lastEventAt: '2026-11-02T11:00:00.000Z' };
    expect(coverage([withEvent], now).silentAccounts).toEqual([]);
  });

  it('sem contas: nada conectado, nenhuma coleta e nenhum evento', () => {
    expect(coverage([], now)).toEqual({
      connectedAccounts: 0,
      lastCollectedAt: null,
      lastEventAt: null,
      silentAccounts: [],
    });
  });

  it('o limite de silêncio vem da configuração', () => {
    const accounts = [
      account('111122223333', { connection: 'connected', lastEventAt: '2026-11-02T09:00:00.000Z' }),
    ];
    expect(coverage(accounts, now).silentAccounts).toEqual([]);
    expect(
      coverage(accounts, now, { ...DEFAULT_TOWER_THRESHOLDS, silentAfterHours: 2 }).silentAccounts,
    ).toEqual(['111122223333']);
  });
});

describe('decisões pendentes da Torre (T5.10)', () => {
  it('só as que existem, em ordem de prioridade; alertas sem dono só para admin_verax', () => {
    const counts = { unassignedIncidents: 2, untriagedFindings: 0, unownedAlerts: 5 };
    expect(pendingDecisions(counts, { includeUnowned: false })).toEqual([
      { kind: 'unassigned_incident', count: 2 },
    ]);
    expect(pendingDecisions(counts, { includeUnowned: true })).toEqual([
      { kind: 'unassigned_incident', count: 2 },
      { kind: 'unowned_alert', count: 5 },
    ]);
  });
});

describe('saúde da ingestão da AWS na Torre (fase 2, PR-V6)', () => {
  const now = new Date('2026-11-09T12:00:00.000Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

  it('com conta conectada, parada há mais de 2 h: desde a última vez que os eventos andaram', () => {
    expect(DEFAULT_TOWER_THRESHOLDS.awsStalledAfterHours).toBe(2);
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(3) }, now)).toEqual(
      hoursAgo(3),
    );
    expect(
      awsLogsStalledSince({ awsConnected: true, lastProgressAt: new Date(hoursAgo(2).getTime() - 1) }, now),
    ).toEqual(new Date(hoursAgo(2).getTime() - 1));
  });

  it('até 2 h exatas, sem conta conectada ou sem observação: nada a mostrar', () => {
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(2) }, now)).toBeNull();
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(1) }, now)).toBeNull();
    expect(awsLogsStalledSince({ awsConnected: false, lastProgressAt: hoursAgo(5) }, now)).toBeNull();
    expect(awsLogsStalledSince({ awsConnected: true, lastProgressAt: null }, now)).toBeNull();
  });

  it('o prazo vem da configuração', () => {
    const thresholds = { ...DEFAULT_TOWER_THRESHOLDS, awsStalledAfterHours: 6 };
    expect(
      awsLogsStalledSince({ awsConnected: true, lastProgressAt: hoursAgo(3) }, now, thresholds),
    ).toBeNull();
  });
});

describe('sinal de vida da AWS na cobertura (OP-01)', () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
  const aws = (activity: Partial<AccountActivity> = {}): AccountActivity => ({
    accountId: '111122223333',
    provider: 'aws',
    connection: 'connected',
    lastCollectedAt: null,
    lastEventAt: null,
    ...activity,
  });

  it('conta AWS calma (nenhum alerta de nível 5 ou mais), com os eventos andando no Wazuh: não é silenciosa', () => {
    // Antes do OP-01, só o alerta contava: a conta saudável aparecia "sem eventos há mais de 24 horas".
    expect(coverage([aws()], now).silentAccounts).toEqual(['111122223333']);
    expect(
      coverage([aws({ lastEventAt: hoursAgo(72) })], now, DEFAULT_TOWER_THRESHOLDS, hoursAgo(0.1)),
    ).toEqual({
      connectedAccounts: 1,
      lastCollectedAt: null,
      // O último alerta continua o que era: só o sinal de vida mudou.
      lastEventAt: hoursAgo(72),
      silentAccounts: [],
    });
  });

  it('o andamento antigo não salva a conta; a conta com erro de conexão depende do próprio alerta', () => {
    expect(coverage([aws()], now, DEFAULT_TOWER_THRESHOLDS, hoursAgo(25)).silentAccounts).toEqual([
      '111122223333',
    ]);
    // O contador é do nó: a conta com a entrada recusada não ganha o andamento das outras.
    const refused = aws({ accountId: '444455556666', connection: 'error', lastEventAt: hoursAgo(30) });
    expect(coverage([aws(), refused], now, DEFAULT_TOWER_THRESHOLDS, hoursAgo(0.1)).silentAccounts).toEqual([
      '444455556666',
    ]);
    // O andamento não vale para a GCP.
    const gcp = aws({ accountId: 'vx-projeto', provider: 'gcp' });
    expect(coverage([gcp], now, DEFAULT_TOWER_THRESHOLDS, hoursAgo(0.1)).silentAccounts).toEqual([
      'vx-projeto',
    ]);
  });
});

describe('semáforo com a coleta parada (OP-02, decisão de 05/11/2026)', () => {
  it('fonte parada deixa amarelo, junto dos outros motivos; o crítico continua vermelho', () => {
    expect(trafficLight({ openIncidents: none, postureScore: 90, stalledSources: ['cloudflare'] })).toEqual({
      light: 'yellow',
      reasons: ['collection_stalled'],
    });
    expect(
      trafficLight({
        openIncidents: { ...none, critical: 1 },
        postureScore: 50,
        stalledSources: ['aws', 'gcp'],
      }),
    ).toEqual({ light: 'red', reasons: ['critical_incident', 'low_posture', 'collection_stalled'] });
    expect(trafficLight({ openIncidents: none, postureScore: 90, stalledSources: [] })).toEqual({
      light: 'green',
      reasons: [],
    });
  });
});

describe('saúde da coleta por fonte (OP-02)', () => {
  const now = new Date('2026-11-05T12:00:00.000Z');
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const account = (
    provider: AccountActivity['provider'],
    activity: Partial<AccountActivity> = {},
  ): AccountActivity => ({
    accountId: provider === 'aws' ? '111122223333' : provider === 'gcp' ? 'vx-projeto' : 'a'.repeat(32),
    provider,
    connection: 'connected',
    lastCollectedAt: null,
    lastEventAt: null,
    ...activity,
  });
  const noSignals: CollectionSignals = {
    accounts: [],
    awsLastProgressAt: null,
    agents: { registered: 0, lastKeepAliveAt: null },
    lastPostureScanAt: null,
    lastInventoryAt: null,
  };
  const health = (signals: Partial<CollectionSignals>, thresholds = DEFAULT_TOWER_THRESHOLDS) =>
    Object.fromEntries(
      collectionHealth({ ...noSignals, ...signals }, now, thresholds).map((item) => [item.source, item]),
    );

  it('cliente sem nada: as cinco fontes, na ordem da tela, não configuradas e sem dado (nunca paradas)', () => {
    const sources = collectionHealth(noSignals, now);
    expect(sources.map((item) => [item.source, item.state, item.lastDataAt])).toEqual([
      ['aws', 'not_configured', null],
      ['gcp', 'not_configured', null],
      ['cloudflare', 'not_configured', null],
      ['agents', 'not_configured', null],
      ['posture', 'not_configured', null],
    ]);
    expect(stalledSources(sources)).toEqual([]);
    expect(lastDataAt(sources)).toBeNull();
  });

  it('AWS: o andamento no Wazuh é o dado, o último alerta vai à parte; os prazos de 30 min e 2 h', () => {
    const calm = health({
      accounts: [account('aws', { lastEventAt: minutesAgo(3 * 24 * 60) })],
      awsLastProgressAt: minutesAgo(4),
    });
    expect(calm['aws']).toEqual({
      source: 'aws',
      state: 'collecting',
      lastDataAt: minutesAgo(4),
      lastEventAt: minutesAgo(3 * 24 * 60),
      delayedAfterMinutes: 30,
      stalledAfterMinutes: 120,
    });
    // Configurada, a AWS traz também a postura e o inventário (só AWS), aguardando a primeira leitura.
    expect(calm['posture']).toMatchObject({ state: 'waiting', lastDataAt: null });
    const accounts = [account('aws')];
    expect(health({ accounts, awsLastProgressAt: minutesAgo(31) })['aws']?.state).toBe('delayed');
    expect(health({ accounts, awsLastProgressAt: minutesAgo(120) })['aws']?.state).toBe('delayed');
    expect(health({ accounts, awsLastProgressAt: minutesAgo(121) })['aws']?.state).toBe('stalled');
    // O alerta recente também prova que os logs chegaram (o nó sem a observação, por exemplo).
    expect(health({ accounts: [account('aws', { lastEventAt: minutesAgo(2) })] })['aws']).toMatchObject({
      state: 'collecting',
      lastDataAt: minutesAgo(2),
    });
    // Conta cadastrada que ainda não deu dado nenhum: aguarda, sem parar a Torre.
    expect(health({ accounts: [account('aws', { connection: 'waiting' })] })['aws']).toMatchObject({
      state: 'waiting',
      lastDataAt: null,
      lastEventAt: null,
    });
  });

  it('o prazo de parada da AWS é o mesmo de "Sem logs novos da AWS" (PR-V6) e do aviso por e-mail', () => {
    expect(DEFAULT_TOWER_THRESHOLDS.collection.aws.stalledAfterMinutes).toBe(
      DEFAULT_TOWER_THRESHOLDS.awsStalledAfterHours * 60,
    );
  });

  it('GCP pela leitura bem-sucedida da assinatura (15 min e 1 h), com a última entrada à parte', () => {
    // Projeto calmo: a assinatura lida há 1 min, sem entrada nenhuma há 3 dias. Continua coletando.
    const quiet = health({
      accounts: [account('gcp', { lastCollectedAt: minutesAgo(1), lastEventAt: minutesAgo(3 * 24 * 60) })],
    })['gcp'];
    expect(quiet).toEqual({
      source: 'gcp',
      state: 'collecting',
      lastDataAt: minutesAgo(1),
      lastEventAt: minutesAgo(3 * 24 * 60),
      delayedAfterMinutes: 15,
      stalledAfterMinutes: 60,
    });
    // Nunca recebeu entrada, mas a assinatura é lida: coletando, sem último evento.
    expect(health({ accounts: [account('gcp', { lastCollectedAt: minutesAgo(1) })] })['gcp']).toMatchObject({
      state: 'collecting',
      lastEventAt: null,
    });
    // As leituras deixam de dar certo (a falha não grava `lastCollectedAt`): atrasada, depois parada.
    const failing = (minutes: number) =>
      health({
        accounts: [
          account('gcp', {
            connection: 'error',
            lastCollectedAt: minutesAgo(minutes),
            lastEventAt: minutesAgo(3 * 24 * 60),
          }),
        ],
      })['gcp']?.state;
    expect([failing(14), failing(16), failing(60), failing(61)]).toEqual([
      'collecting',
      'delayed',
      'delayed',
      'stalled',
    ]);
    // Nunca lida com sucesso: aguardando.
    expect(health({ accounts: [account('gcp', { connection: 'waiting' })] })['gcp']?.state).toBe('waiting');

    const cloudflare = (collected: number | null, event: number | null) =>
      health({
        accounts: [
          account('cloudflare', {
            lastCollectedAt: collected === null ? null : minutesAgo(collected),
            lastEventAt: event === null ? null : minutesAgo(event),
          }),
        ],
      })['cloudflare'];
    expect(cloudflare(4, null)).toMatchObject({
      state: 'collecting',
      lastDataAt: minutesAgo(4),
      lastEventAt: null,
    });
    expect(cloudflare(45, null)?.state).toBe('delayed');
    expect(cloudflare(200, 10)).toMatchObject({ state: 'collecting', lastDataAt: minutesAgo(10) });
    expect(cloudflare(200, null)?.state).toBe('stalled');
    expect(cloudflare(null, null)?.state).toBe('waiting');
  });

  it('o estado é da fonte: uma conta entregando basta, e a conta com problema fica na conexão e nas silenciosas', () => {
    const working = account('cloudflare', { lastCollectedAt: minutesAgo(5) });
    const revoked = account('cloudflare', {
      accountId: 'b'.repeat(32),
      connection: 'error',
      lastCollectedAt: minutesAgo(3 * 24 * 60),
    });
    expect(health({ accounts: [working, revoked] })['cloudflare']?.state).toBe('collecting');
    expect(health({ accounts: [revoked] })['cloudflare']?.state).toBe('stalled');
  });

  it('agentes pelo keepalive mais recente (15 min e 1 h); sem agente registrado, não configurados', () => {
    const agents = (minutes: number | null) =>
      health({
        agents: { registered: 3, lastKeepAliveAt: minutes === null ? null : minutesAgo(minutes) },
      })['agents']?.state;
    expect([agents(1), agents(16), agents(61), agents(null)]).toEqual([
      'collecting',
      'delayed',
      'stalled',
      'waiting',
    ]);
    // Um keepalive sem agente registrado (não acontece) não vira dado.
    expect(health({ agents: { registered: 0, lastKeepAliveAt: minutesAgo(1) } })['agents']).toMatchObject({
      state: 'not_configured',
      lastDataAt: null,
    });
  });

  it('postura e inventário: o mais antigo dos dois, ou o que existir (26 h e 50 h)', () => {
    const accounts = [account('aws', { lastEventAt: minutesAgo(1) })];
    expect(
      health({ accounts, lastPostureScanAt: minutesAgo(60), lastInventoryAt: minutesAgo(27 * 60) })[
        'posture'
      ],
    ).toMatchObject({ state: 'delayed', lastDataAt: minutesAgo(27 * 60) });
    expect(health({ accounts, lastPostureScanAt: minutesAgo(51 * 60) })['posture']?.state).toBe('stalled');
    expect(health({ accounts, lastInventoryAt: minutesAgo(60) })['posture']?.state).toBe('collecting');
    // Sem conta AWS ativa, o retrato de uma conta já desativada não aparece.
    expect(health({ lastPostureScanAt: minutesAgo(60) })['posture']).toMatchObject({
      state: 'not_configured',
      lastDataAt: null,
    });
  });

  it('as fontes paradas e o último dado entre todas', () => {
    const sources = collectionHealth(
      {
        accounts: [account('aws'), account('gcp', { lastEventAt: minutesAgo(30 * 60) })],
        awsLastProgressAt: minutesAgo(3),
        agents: { registered: 2, lastKeepAliveAt: minutesAgo(90) },
        lastPostureScanAt: minutesAgo(60),
        lastInventoryAt: minutesAgo(61),
      },
      now,
    );
    expect(stalledSources(sources)).toEqual(['gcp', 'agents']);
    expect(lastDataAt(sources)).toBe(minutesAgo(3));
  });

  it('os prazos vêm da configuração', () => {
    const thresholds = {
      ...DEFAULT_TOWER_THRESHOLDS,
      collection: {
        ...DEFAULT_TOWER_THRESHOLDS.collection,
        cloudflare: { delayedAfterMinutes: 5, stalledAfterMinutes: 10 },
      },
    };
    const accounts = [account('cloudflare', { lastCollectedAt: minutesAgo(11) })];
    expect(health({ accounts })['cloudflare']?.state).toBe('collecting');
    expect(health({ accounts }, thresholds)['cloudflare']).toMatchObject({
      state: 'stalled',
      delayedAfterMinutes: 5,
      stalledAfterMinutes: 10,
    });
  });
});

describe('pulso da operação (OP-02)', () => {
  const now = new Date('2026-11-05T12:34:56.000Z');
  const since = pulseSince(now);

  it('24 horas cheias, a última em curso', () => {
    expect(since.toISOString()).toBe('2026-11-04T13:00:00.000Z');
    expect(pulseSince(new Date('2026-11-05T12:00:00.000Z')).toISOString()).toBe('2026-11-04T13:00:00.000Z');
  });

  it('achados por hora, da mais antiga à atual; fora da janela não conta', () => {
    const hourly = hourlyCounts(
      [
        new Date('2026-11-04T13:00:00.000Z'),
        new Date('2026-11-04T13:59:59.999Z'),
        new Date('2026-11-05T12:30:00.000Z'),
        new Date('2026-11-04T12:59:59.999Z'),
        new Date('2026-11-05T13:00:00.000Z'),
      ],
      since,
    );
    expect(hourly).toHaveLength(24);
    expect(hourly[0]).toBe(2);
    expect(hourly[23]).toBe(1);
    expect(hourly.reduce((sum, value) => sum + value, 0)).toBe(3);
  });

  it('mediana do tempo até detectar em segundos; relógio adiantado conta zero; sem achado, null', () => {
    const finding = (occurred: string, created: string) => ({
      occurredAt: new Date(occurred),
      createdAt: new Date(created),
    });
    expect(medianTimeToDetect([])).toBeNull();
    expect(
      medianTimeToDetect([
        finding('2026-11-05T10:00:00Z', '2026-11-05T10:02:00Z'),
        finding('2026-11-05T10:00:00Z', '2026-11-05T10:10:00Z'),
        finding('2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z'),
      ]),
    ).toBe(600);
    expect(
      medianTimeToDetect([
        finding('2026-11-05T10:00:00Z', '2026-11-05T10:01:00Z'),
        finding('2026-11-05T10:00:05Z', '2026-11-05T10:00:00Z'),
      ]),
    ).toBe(30);
  });
});

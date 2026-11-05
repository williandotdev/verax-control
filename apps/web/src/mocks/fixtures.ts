import {
  type CollectionSource,
  type CollectionSourceHealth,
  type Me,
  meSchema,
  mitreTactics,
  PULSE_HOURS,
  permissionsOf,
  type Role,
  type TenantSummary,
  tenantSummarySchema,
  type TowerPulse,
  type TowerSummary,
  towerSummarySchema,
} from '@verax/shared';

/**
 * Dados fictícios do modo `dev:mock` e dos testes do painel. Tipados e validados pelos schemas de
 * `packages/shared`: se o contrato da API mudar, estes dados quebram no carregamento, não na tela.
 * Nenhum nome de cliente real.
 */
export const DEMO_TENANTS: TenantSummary[] = [
  { id: '018f2c1e-0000-7000-8000-00000000a1fa', name: 'Cliente Demo Alfa', status: 'active' },
  { id: '018f2c1e-0000-7000-8000-00000000be7a', name: 'Cliente Demo Beta', status: 'active' },
  { id: '018f2c1e-0000-7000-8000-0000000c0ffe', name: 'Cliente Demo Inativo', status: 'inactive' },
].map((tenant) => tenantSummarySchema.parse(tenant));

const ALFA = DEMO_TENANTS[0]?.id ?? '';

export function demoMe(role: Role, overrides: Partial<Me> = {}): Me {
  const tenantId = role === 'admin_verax' ? null : ALFA;
  return meSchema.parse({
    userId: `demo-${role}`,
    email: `${role.replace('_', '.')}@demo.verax.local`,
    role,
    tenantId,
    activeTenantId: null,
    scopeTenantId: tenantId,
    mfaEnabled: true,
    mustChangePassword: false,
    permissions: permissionsOf(role),
    ...overrides,
  });
}

/** Contas fictícias: AWS (os IDs de exemplo da documentação da AWS), um projeto da GCP e uma conta do Cloudflare. */
export const DEMO_ACCOUNTS = {
  alfaProducao: '111122223333',
  alfaHomologacao: '444455556666',
  beta: '777788889999',
  alfaGcp: 'loja-alfa-demo',
  alfaCloudflare: 'd0e0000000000000000000000000a1fa',
} as const;

/**
 * Os buckets do GuardDuty e do WAF da conta AWS de produção da demonstração, além da trilha (`trilha-<conta>`, que toda
 * conta AWS da demonstração tem). Nomes fictícios.
 */
export const DEMO_ALFA_MORE_BUCKETS = {
  guardduty: `guardduty-${DEMO_ACCOUNTS.alfaProducao}`,
  waf: 'aws-waf-logs-loja-alfa',
} as const;

/**
 * Tópico do nó da demonstração para o sink de projeto GCP de cliente, sem o projeto no fim (o que o start.sh informa à
 * API no nó). Projeto e prefixo fictícios.
 */
export const DEMO_SINK_TOPIC_PREFIX = 'projects/verax-nos-demo/topics/verax-demo-security-';

/** IP de saída do nó da demonstração (faixa reservada para documentação, RFC 5737). */
export const DEMO_EGRESS_IPS = ['203.0.113.10/32'];
/**
 * O link vencido da demonstração (D8): nas páginas públicas do contato de escalonamento, este token recebe a recusa da
 * API; qualquer outro no formato confirma ou descadastra (a demonstração não manda e-mail).
 */
export const DEMO_EXPIRED_LINK_TOKEN = 'A'.repeat(43);

/** ID único da conta de serviço do nó da demonstração (fictício, 21 dígitos): o `NodeServiceAccountId` da pilha. */
export const DEMO_NODE_SERVICE_ACCOUNT_ID = '123456789012345678901';

/**
 * Quanto o "worker" da demonstração leva para responder o "Verificar" da AWS: a tela mostra "Verificando…" e relê a
 * conta até a resposta.
 */
export const DEMO_AWS_CHECK_DELAY_MS = 1_500;

/** Fim do ID do token do Cloudflare guardado na demonstração (fictício). */
export const DEMO_CLOUDFLARE_TOKEN_SUFFIX = 'c0de';

const minutesAgo = (now: Date, minutes: number): string =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

/** Prazos de cada fonte da "Saúde da coleta", os mesmos da API (`DEFAULT_TOWER_THRESHOLDS.collection`). */
const COLLECTION_WINDOWS: Readonly<
  Record<CollectionSource, { delayedAfterMinutes: number; stalledAfterMinutes: number }>
> = {
  aws: { delayedAfterMinutes: 30, stalledAfterMinutes: 120 },
  gcp: { delayedAfterMinutes: 15, stalledAfterMinutes: 60 },
  cloudflare: { delayedAfterMinutes: 30, stalledAfterMinutes: 120 },
  agents: { delayedAfterMinutes: 15, stalledAfterMinutes: 60 },
  posture: { delayedAfterMinutes: 26 * 60, stalledAfterMinutes: 50 * 60 },
};

/**
 * Há quantos minutos as leituras da assinatura da GCP da Alfa falham na demonstração (a permissão de leitura foi tirada
 * no projeto do nó): a conta está com erro, e a última leitura bem-sucedida foi há esse tempo (`mocks/admin.ts`).
 */
export const DEMO_GCP_FAILING_MINUTES = 3 * 60;

/**
 * Os agentes da Alfa na demonstração (`demoAgents`, em `mocks/agents-handlers.ts`): 3 ativos de 5 registrados, o
 * keepalive mais recente há 0,4 min. O teste da Torre confere que batem.
 */
export const DEMO_TOWER_AGENTS = { online: 3, total: 5, lastKeepAliveMinutes: 0.4 } as const;

/**
 * A saúde da coleta de cada cliente fictício, como as contas da demonstração (`mocks/admin.ts`). Na Alfa, a AWS anda no
 * Wazuh há 2 min (o último alerta é o da produção, há 3 min), as leituras da assinatura da GCP falham há 3 horas
 * (parada: a última leitura bem-sucedida foi há 3 horas, e a última entrada, pouco antes), o Cloudflare aguarda a
 * primeira leitura e os agentes e a postura coletam. Na Beta, tudo o que ela tem coleta: a AWS (calma, o último alerta
 * há quase 7 horas) e a postura; GCP, Cloudflare e agentes ela não tem.
 */
function demoSources(alfa: boolean, now: Date): CollectionSourceHealth[] {
  const at = (minutes: number | null) => (minutes === null ? null : minutesAgo(now, minutes));
  const source = (
    name: CollectionSource,
    state: CollectionSourceHealth['state'],
    lastDataMinutes: number | null,
    extra: Partial<CollectionSourceHealth> = {},
  ): CollectionSourceHealth => ({
    source: name,
    state,
    lastDataAt: at(lastDataMinutes),
    ...extra,
    ...COLLECTION_WINDOWS[name],
  });
  return alfa
    ? [
        source('aws', 'collecting', 2, { lastEventAt: at(3) }),
        source('gcp', 'stalled', DEMO_GCP_FAILING_MINUTES, {
          lastEventAt: at(DEMO_GCP_FAILING_MINUTES + 10),
        }),
        source('cloudflare', 'waiting', null, { lastEventAt: null }),
        source('agents', 'collecting', DEMO_TOWER_AGENTS.lastKeepAliveMinutes),
        source('posture', 'collecting', 6 * 60),
      ]
    : [
        source('aws', 'collecting', 2, { lastEventAt: at(400) }),
        source('gcp', 'not_configured', null),
        source('cloudflare', 'not_configured', null),
        source('agents', 'not_configured', null),
        source('posture', 'collecting', 7 * 60),
      ];
}

const HOUR_MS = 3_600_000;

/**
 * O "Pulso da operação" da demonstração: os achados das últimas 24 horas cheias saem dos achados do mock (os legítimos
 * fazem o papel dos esperados por exceção, que o mock não tem); o tempo até detectar, os agentes e os eventos do mês
 * são fixos.
 */
function demoPulse(
  alfa: boolean,
  findings: readonly { occurredAt: string; status: string }[],
  now: Date,
): TowerPulse {
  const since = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS - (PULSE_HOURS - 1) * HOUR_MS;
  const hourly = Array.from({ length: PULSE_HOURS }, () => 0);
  let expected = 0;
  for (const finding of findings) {
    const index = Math.floor((Date.parse(finding.occurredAt) - since) / HOUR_MS);
    if (index < 0 || index >= PULSE_HOURS || Date.parse(finding.occurredAt) > now.getTime()) continue;
    hourly[index] = (hourly[index] ?? 0) + 1;
    if (finding.status === 'legitimate') expected += 1;
  }
  const total = hourly.reduce((sum, value) => sum + value, 0);
  return {
    since: new Date(since).toISOString(),
    findings: { total, expected, hourly },
    timeToDetectSeconds: total === 0 ? null : alfa ? 4 * 60 : 3 * 60,
    agents: alfa ? { online: DEMO_TOWER_AGENTS.online, total: DEMO_TOWER_AGENTS.total } : null,
    monthEvents: {
      month: usageMonthOf(now),
      sources: alfa
        ? [
            { source: 'aws', events: 1_204_331 },
            { source: 'gcp', events: 80_120 },
          ]
        : [{ source: 'aws', events: 412_906 }],
    },
  };
}

/** O mês do medidor no calendário de Brasília (UTC-3 o ano todo): `AAAA-MM`. */
function usageMonthOf(now: Date): string {
  return new Date(now.getTime() - 3 * HOUR_MS).toISOString().slice(0, 7);
}

/**
 * Torre de cada cliente fictício. A Alfa tem o que mostrar numa apresentação (incidente crítico, decisões
 * pendentes, postura baixa, contas silenciosas e a coleta da GCP parada); a Beta está tranquila, para comparar ("Tudo
 * calmo", com a prova da coleta). As contagens de achados e incidentes vêm do estado do mock, para a Torre acompanhar a
 * triagem feita nas outras telas; o semáforo segue a regra da API (vermelho com incidente crítico aberto; amarelo com
 * alto aberto, postura abaixo de 70 ou coleta parada).
 */
export function demoTower(
  tenantId: string,
  options: {
    includeUnowned: boolean;
    /** Alertas sem dono dos últimos 7 dias (só para a equipe da Verax). */
    unownedAlerts?: number;
    untriagedFindings?: number;
    openIncidents?: TowerSummary['openIncidents'];
    unassignedIncidents?: number;
    mitre?: TowerSummary['mitre'];
    /** Os achados do cliente no mock, para o pulso das últimas 24 horas. */
    findings?: readonly { occurredAt: string; status: string }[];
    now?: Date;
  },
): TowerSummary {
  const now = options.now ?? new Date();
  const alfa = tenantId === ALFA;
  const open =
    options.openIncidents ??
    (alfa ? { critical: 1, high: 2, medium: 3, low: 0 } : { critical: 0, high: 0, medium: 1, low: 0 });
  // A mesma nota da postura da demonstração (`mocks/posture.ts`, o teste da tela de postura confere).
  const score = alfa ? 69 : 92;
  const warningBelow = 70;
  const sources = demoSources(alfa, now);
  const reasons = [
    ...(open.critical > 0 ? ['critical_incident' as const] : []),
    ...(open.high > 0 ? ['high_incident' as const] : []),
    ...(score < warningBelow ? ['low_posture' as const] : []),
    ...(sources.some((source) => source.state === 'stalled') ? ['collection_stalled' as const] : []),
  ];
  return towerSummarySchema.parse({
    light: reasons.includes('critical_incident') ? 'red' : reasons.length > 0 ? 'yellow' : 'green',
    reasons,
    pendingDecisions: [
      { kind: 'unassigned_incident', count: options.unassignedIncidents ?? (alfa ? 2 : 0) },
      { kind: 'untriaged_finding', count: options.untriagedFindings ?? (alfa ? 5 : 0) },
      { kind: 'unowned_alert', count: options.includeUnowned ? (options.unownedAlerts ?? 3) : 0 },
    ].filter((decision) => decision.count > 0),
    openIncidents: open,
    posture: { score, scannedAt: minutesAgo(now, alfa ? 6 * 60 : 7 * 60), warningBelow },
    // Como as contas da demonstração (`mocks/admin.ts`): na Alfa, a produção conectada, a homologação com erro há 30
    // horas, a GCP com as leituras falhando há 3 horas (não é silenciosa ainda: o prazo é de 24 horas) e o Cloudflare
    // aguardando a primeira leitura.
    coverage: {
      ...(alfa
        ? {
            connectedAccounts: 1,
            lastCollectedAt: minutesAgo(now, 1),
            lastEventAt: minutesAgo(now, 3),
            silentAccounts: [DEMO_ACCOUNTS.alfaHomologacao, DEMO_ACCOUNTS.alfaCloudflare],
          }
        : {
            connectedAccounts: 1,
            lastCollectedAt: minutesAgo(now, 1),
            lastEventAt: minutesAgo(now, 400),
            silentAccounts: [],
          }),
      silentAfterHours: 24,
      awsLogsStalledSince: null,
      awsStalledAfterHours: 2,
      lastDataAt: minutesAgo(now, alfa ? DEMO_TOWER_AGENTS.lastKeepAliveMinutes : 2),
      sources,
    },
    pulse: demoPulse(alfa, options.findings ?? [], now),
    mitre: options.mitre ?? { periodDays: 30, tactics: mitreTactics([], []) },
    generatedAt: now.toISOString(),
  });
}

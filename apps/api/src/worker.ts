import { AWS_READER_AUDIENCE } from '@verax/shared';
import { type Logger, pino } from 'pino';
import { WazuhAgentsSync } from './agents/agents-sync.js';
import { AgentAlertSync } from './alerts/agent-alert-sync.js';
import { AlertSync } from './alerts/alert-sync.js';
import { CLOUDWATCH_ALERT_SYNC, CloudWatchAlertSync } from './alerts/cloudwatch-alert-sync.js';
import { AWS_CHECK_INTERVAL_MS, AwsCheck } from './aws/aws-check.js';
import { type AwsConnectionChecker, UnavailableAwsConnectionChecker } from './aws/aws-connection-check.js';
import type { AwsReaderCredentials } from './aws/web-identity.js';
import { WAZUH_CONFIG_INTERVAL_MS, WazuhConfig } from './aws/wazuh-config.js';
import type { WazuhStallProbe } from './aws/wazuh-source-health.js';
import { CELL_COMMANDS_INTERVAL_MS, CELL_COMMANDS_TASK, CellCommands } from './cell/cell-commands.js';
import { CellReportOutbox } from './cell/cell-report-outbox.js';
import {
  CELL_REPORTS_INTERVAL_MS,
  CELL_REPORTS_TASK,
  CellReportPublisher,
} from './cell/cell-report-publisher.js';
import {
  CELL_TENANT_STATUS_INTERVAL_MS,
  CELL_TENANT_STATUS_TASK,
  CellTenantStatusReporter,
} from './cell/cell-tenant-status.js';
import { CellTenantBootstraps, FileTenantBootstrapSignal } from './cell/tenant-bootstrap-signal.js';
import {
  CELL_USAGE_REPORTS_INTERVAL_MS,
  CELL_USAGE_REPORTS_TASK,
  CellUsageReports,
} from './cell/cell-usage-reports.js';
import { CloudflareAuditSync } from './cloudflare/cloudflare-audit-sync.js';
import { CloudflareClient } from './cloudflare/cloudflare.client.js';
import {
  announcesCloudflareOauth,
  controlPlaneSyncTask,
} from './control-plane-sync/control-plane-sync-task.js';
import { nodePlan, type WorkerEnv } from './common/config/env.schema.js';
import { loadWorkerConfig } from './common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from './common/config/load-env-file.js';
import { buildPinoOptions } from './common/logger/logger.options.js';
import { PrismaService } from './common/prisma/prisma.service.js';
import {
  CONNECT_ATTEMPTS_PURGE_INTERVAL_MS,
  CONNECT_ATTEMPTS_PURGE_TASK,
  ConnectAttemptsPurge,
} from './cloudflare/oauth/connect-attempts.js';
import {
  CLOUDFLARE_CONNECT_BUDGET_MS,
  CLOUDFLARE_CONNECT_POLL_MS,
  CLOUDFLARE_CONNECT_TASK,
  CloudflareConnectJob,
} from './cloudflare/oauth/connect-job.js';
import { PublicClientTokens } from './cloudflare/oauth/oauth-tokens.js';
import { CREDENTIAL_REKEY_INTERVAL_MS, CredentialRekey } from './credentials/credential-rekey.js';
import { GcpAuditSync } from './gcp/gcp-audit-sync.js';
import {
  MetadataTokenProvider,
  type PubsubReader,
  PubsubRestPublisher,
  PubsubRestReader,
} from './gcp/pubsub.client.js';
import { VaultPubsubReader } from './gcp/vault-pubsub-reader.js';
import { IndexerClient } from './indexer/indexer.client.js';
import { loadIndexerConfig } from './indexer/indexer.config.js';
import { indexerSecretsFor } from './indexer/indexer-secrets.js';
import { mailTransport } from './mail/mail.module.js';
import {
  NODE_STATUS_BUDGET_MS,
  NODE_STATUS_INTERVAL_MS,
  NodeStatusReporter,
} from './node-status/node-status.js';
import {
  NOTIFICATIONS_INTERVAL_MS,
  NOTIFICATIONS_TASK,
  NotificationDispatcher,
} from './notifications/notification-dispatcher.js';
import { UsageNotices } from './notifications/usage-notices.js';
import { TenantPlanResolver } from './plan/tenant-plan.js';
import {
  RETENTION_BUDGET_MS,
  RETENTION_CHECK_INTERVAL_MS,
  RETENTION_TASK,
  RetentionJob,
} from './retention/retention-job.js';
import {
  AWS_VOLUME_BUDGET_MS,
  AWS_VOLUME_TASK,
  AWS_VOLUME_TICK_MS,
  AwsVolumeAudit,
  tenantAwsIdentityFor,
} from './usage/aws-volume.js';
import { WazuhStatsClient } from './usage/wazuh-stats.js';
import { WAZUH_USAGE_INTERVAL_MS, WAZUH_USAGE_TASK, WazuhUsage } from './usage/wazuh-usage.js';
import { type ScheduledTask, Scheduler } from './worker/scheduler.js';

/**
 * Orçamento de uma execução dos syncs de alertas: a validade da concessão no banco, renovada a cada lote. Uma
 * execução mais longa que isso vai para o log como estouro. Os syncs não interrompem no meio: a próxima execução só
 * começa depois que a atual termina, como antes.
 */
const SYNC_BUDGET_MS = 5 * 60 * 1000;

/** A conferência da conexão da AWS e o que roda na partida (a conferência da identidade do nó). */
interface AwsConnectionSetup {
  checker: AwsConnectionChecker;
  /**
   * As sessões no papel de leitura, ou as chaves do cofre na VM própria (null sem a identidade do nó nem o cofre): a
   * conferência e o inventário dividem as mesmas.
   */
  credentials: AwsReaderCredentials | null;
  start(): Promise<void>;
}

/**
 * Com o ID da conta de serviço do nó (`NODE_SA_UNIQUE_ID`), a conferência real (PR-V5'): o token do Google pelo
 * metadata, o STS e os buckets. Só então o SDK da AWS é carregado: o nó sem a linha (o da Verax, o ambiente local) não
 * paga a memória dele e responde `check_unavailable`, sem chamar a AWS nem o metadata. Na partida, o `sub` do token
 * do nó é conferido com o ID (sem o token no log); sem `NODE_EGRESS_IPS`, a simulação da permissão demais fica de
 * fora, e o log diz isso.
 */
async function awsConnectionSetup(
  config: Readonly<WorkerEnv>,
  prisma: PrismaService,
  logger: Logger,
): Promise<AwsConnectionSetup> {
  // VM própria do cliente: sem identidade do Google, a conta é lida com a chave do usuário IAM de leitura que o admin
  // colou no painel, aberta do cofre só aqui. Sem o cofre, nada a conferir.
  if (config.NODE_PLATFORM === 'vm') {
    const keyring = config.credentialsKeyring;
    if (keyring === null) {
      return {
        checker: new UnavailableAwsConnectionChecker(),
        credentials: null,
        start: () => Promise.resolve(),
      };
    }
    const [{ VaultKeyCredentials }, { WebIdentityAwsConnectionChecker }] = await Promise.all([
      import('./aws/vault-key-credentials.js'),
      import('./aws/web-identity-checker.js'),
    ]);
    const credentials = new VaultKeyCredentials(prisma, keyring, logger);
    const checker = new WebIdentityAwsConnectionChecker({
      credentials,
      egressIps: config.NODE_EGRESS_IPS ?? [],
      logger,
    });
    return { checker, credentials, start: () => Promise.resolve() };
  }
  const serviceAccountId = config.NODE_SA_UNIQUE_ID;
  if (serviceAccountId === undefined) {
    return {
      checker: new UnavailableAwsConnectionChecker(),
      credentials: null,
      start: () => Promise.resolve(),
    };
  }
  const [identity, { WebIdentityAwsConnectionChecker }] = await Promise.all([
    import('./aws/web-identity.js'),
    import('./aws/web-identity-checker.js'),
  ]);
  const audience = config.AWS_WEB_IDENTITY_AUDIENCE ?? AWS_READER_AUDIENCE;
  const idToken = (signal?: AbortSignal) => identity.fetchGoogleIdToken(audience, signal);
  const credentials = new identity.WebIdentityCredentials({ audience, idToken, logger });
  const checker = new WebIdentityAwsConnectionChecker({
    credentials,
    egressIps: config.NODE_EGRESS_IPS ?? [],
    logger,
  });
  return {
    checker,
    credentials,
    start: async () => {
      if (!checker.simulatesPermissions) {
        logger.warn(
          {},
          'sem NODE_EGRESS_IPS no worker: a simulação da permissão demais da AWS fica de fora (o Deny de IP da pilha negaria tudo)',
        );
      }
      identity.reportNodeIdentity(await identity.checkNodeIdentity(serviceAccountId, idToken), logger);
    },
  };
}

/**
 * Worker do Verax Control: o mesmo código da API num processo à parte, sem porta aberta. Cada fonte de `SYNC_SOURCES`
 * vira uma tarefa do agendador, a cada `SYNC_INTERVAL_SECONDS`; as tarefas rodam ao mesmo tempo, cada uma no próprio
 * laço. A concessão no banco garante um worker por vez em cada fonte, mesmo com mais de uma réplica. SIGTERM ou SIGINT
 * esperam as execuções em curso terminarem, e elas liberam a concessão.
 *
 * A fonte `wazuh` vira duas tarefas, cada uma com estado e concessão próprios: `wazuh` (os alertas do manager, das
 * contas AWS) e `wazuh-agent-alerts` (os dos agentes nas instâncias do cliente, atribuídos ao cliente do nó só com os
 * agentes ligados; desligados, vão para a fila sem dono). Fora da célula, entra a terceira,
 * `wazuh-cloudwatch-alerts`: os alertas dos grupos do CloudWatch Logs autorizados no onboarding self-service da AWS.
 *
 * A fonte `cloudflare` (auditoria das contas do Cloudflare e, pelo GraphQL, os eventos de segurança das zonas) roda no
 * mesmo intervalo: a auditoria de cada conta a cada `CLOUDFLARE_AUDIT_INTERVAL_SECONDS`, e os eventos em janelas de
 * 15 min, cada uma lida 5 min depois de fechar (o cursor de cada fluxo guarda a próxima leitura). Ela exige o cofre.
 *
 * Com os agentes do Wazuh ligados no nó, entra a tarefa `wazuh-agents`, que grava a lista dos agentes exportada pelo host.
 *
 * Com o cofre de credenciais (as chaves privadas num arquivo do tmpfs do nó, só no nó de cliente), entra também a tarefa diária
 * `credential-rekey`, que recifra com a versão corrente as credenciais (e as concessões do Cloudflare) guardadas com uma
 * versão antiga da chave. A tarefa `cloudflare-oauth-purge`, de hora em hora, vence e apaga as tentativas de conectar o
 * Cloudflare por OAuth. No nó gerenciado, com o cofre, a tarefa `cloudflare-oauth` troca o código de quem conecta, descobre
 * e liga as contas e revoga as autorizações soltas.
 *
 * A tarefa `aws-check` (a cada 30 s) responde o "Verificar" das contas AWS e, sem pedido, confere de novo cada conta já
 * verificada a cada 15 min, com a trilha, o export do GuardDuty e a permissão demais uma vez por dia (PR-V5'). A
 * conferência real só liga com `NODE_SA_UNIQUE_ID` (`awsConnectionSetup`), e com ela entra a tarefa `aws-inventory`
 * (a cada 5 min olha as contas; cada conta já verificada é inventariada uma vez por dia, PR-14', e a postura nativa sai
 * da mesma coleta, PR-15'). Com ela, no nó dedicado, entra também a tarefa `aws-discovery` (onboarding self-service): a
 * cada 30 s executa as descobertas pedidas (pelo "Conectar", pelo painel e uma por dia por conta) e responde as
 * sondagens de permissão das fontes. Na célula, a descoberta fica de fora até a coleta da AWS existir lá. Junto com ela
 * entra a tarefa `aws-findings`: a cada 5 min lê, pela API de cada serviço, os achados das fontes autorizadas do
 * GuardDuty, do Security Hub, do Inspector e do Access Analyzer (`aws/findings/`).
 *
 * A tarefa `notifications` (a cada 60 s) entrega os avisos por e-mail da fila de saída, com o mesmo transporte da API
 * (`MAIL_TRANSPORT`), e grava os avisos de 80% e 100% do volume mensal do plano. Sem e-mail no nó (`none`), os avisos
 * ficam `skipped`.
 *
 * No nó com o Wazuh (`WAZUH_SIGNAL_DIR`), a tarefa `wazuh-config` (a cada 30 s) avisa o host quando as contas AWS que o
 * manager lê mudam e mostra nas contas o que o host devolve: a aplicação no manager e o token do Google. Com a API do
 * manager (`WAZUH_API_URL`, a CA e a senha do verax_stats), a tarefa `wazuh-usage` (a cada 5 min) mede o volume da AWS
 * pelos contadores do analysisd e acompanha a saúde da ingestão (a Torre e o aviso `aws_ingestion_stalled`). Na célula
 * (CE-09), o analysisd é só o contador do nó (a conferência), e a tarefa `aws-volume` mede o volume da AWS de cada
 * cliente nos buckets dele, com a identidade dele (até o CE-11, sem identidade de cliente, não chama a AWS).
 *
 * No nó de cliente (`NODE_STATUS=true`, do modo cliente do node.conf), entra a tarefa `node-status`, que a cada 5 min
 * publica o estado do nó nos guest attributes da VM para o plano de controle.
 *
 * No nó dedicado de cliente (`CONTROL_PLANE_SYNC=true`, do modo cliente do node.conf, nas duas plataformas), entra a
 * tarefa `control-plane-sync`, que a cada 5 min conta ao plano de controle o que o nó aplicou e traz as fontes de log
 * que a Verax cadastrou no console (`control-plane-sync/`).
 *
 * A tarefa `retention` (PR-19) é o expurgo diário do histórico no banco do nó, pelo prazo do plano de cada cliente
 * (CE-02: no nó dedicado, o `PLAN` e o `PLAN_HISTORY_DAYS`; na célula, o `TenantPlan`): confere a cada 15 min e roda
 * uma vez por dia, depois das 04:00 UTC, por no máximo 10 min.
 *
 * Na célula (`NODE_MODE=cell`, com `CELL_ID`, `CELL_COMMANDS_SUBSCRIPTION` e `CELL_REPORTS_TOPIC`), o canal com o plano
 * de controle (CE-05): `cell-commands` (a cada 10 s) lê os comandos e aplica cada um numa transação, com o relatório na
 * caixa de saída; `cell-reports` (a cada 10 s) publica a caixa de saída no tópico de relatórios; `cell-tenant-status`
 * (a cada 5 min) relata as contas conectadas e o último evento de cada cliente; `cell-usage-reports` (a cada hora)
 * manda o volume de hoje e de ontem de cada cliente (`usage.daily`, CE-09), só quando mudou. O token é o da VM, como o da GCP. A
 * pedido do primeiro administrador de cada cliente novo vai ao host pelas pastas do CE-04 (`TENANT_BOOTSTRAP_DIR` e
 * `TENANT_BOOTSTRAP_STATUS_DIR`), a cada passagem do `cell-commands` até a confirmação. A exportação e o expurgo
 * (CE-16) ainda não estão ligados: os pedidos voltam recusados (`export_unavailable`, `purge_unavailable`), depois das
 * guardas.
 *
 * O pool do banco tem 10 conexões (`PrismaService`): uma por tarefa em curso, com folga para as transações.
 */
async function main(): Promise<void> {
  loadEnvFileForLocalDevelopment();

  let config;
  let tasks: ScheduledTask[];
  let prisma: PrismaService;
  let logger: Logger;
  let aws: AwsConnectionSetup;
  try {
    const loaded = loadWorkerConfig();
    config = loaded;
    logger = pino(buildPinoOptions(config));
    prisma = new PrismaService(config);
    // O plano de cada cliente (CE-02): no nó dedicado, o do node.conf, que semeia o TenantPlan; na célula, o TenantPlan.
    const plans = new TenantPlanResolver(prisma, config.NODE_MODE, nodePlan(config));
    const intervalMs = config.SYNC_INTERVAL_SECONDS * 1000;
    const agentsTenantId = config.wazuhAgents?.tenantId ?? null;
    tasks = config.SYNC_SOURCES.flatMap((source): ScheduledTask[] => {
      if (source === 'wazuh') {
        const indexerConfig = loadIndexerConfig();
        const indexer = new IndexerClient(indexerConfig, indexerSecretsFor(indexerConfig));
        return [
          {
            name: 'wazuh',
            intervalMs,
            budgetMs: SYNC_BUDGET_MS,
            run: () => new AlertSync(prisma, indexer).runOnce(),
          },
          {
            name: 'wazuh-agent-alerts',
            intervalMs,
            budgetMs: SYNC_BUDGET_MS,
            run: () => new AgentAlertSync(prisma, indexer, agentsTenantId).runOnce(),
          },
          // Os alertas dos grupos do CloudWatch Logs que o cliente autorizou (onboarding self-service da AWS). Fora da
          // célula: lá, vários clientes dividem o manager, e o evento não diz de quem é.
          ...(loaded.NODE_MODE === 'cell'
            ? []
            : [
                {
                  name: CLOUDWATCH_ALERT_SYNC,
                  intervalMs,
                  budgetMs: SYNC_BUDGET_MS,
                  run: () => new CloudWatchAlertSync(prisma, indexer).runOnce(),
                },
              ]),
        ];
      }
      if (source === 'cloudflare') {
        // Auditoria e eventos de segurança do Cloudflare: o token de cada conta vem do cofre do nó, aberto só aqui (a
        // configuração exige as chaves privadas para esta fonte).
        const keyring = loaded.credentialsKeyring;
        if (keyring === null)
          throw new Error('SYNC_SOURCES: a fonte cloudflare exige o cofre de credenciais');
        const cloudflare = new CloudflareAuditSync(prisma, keyring, {
          auditIntervalMs: loaded.CLOUDFLARE_AUDIT_INTERVAL_SECONDS * 1000,
          logger,
        });
        return [
          {
            name: 'cloudflare',
            intervalMs,
            budgetMs: SYNC_BUDGET_MS,
            run: (signal) => cloudflare.runOnce(new Date(), signal),
          },
        ];
      }
      // Auditoria da GCP: o token vem da identidade da VM do nó, sem chave. Na VM própria do cliente, da chave da conta
      // de serviço de leitura de cada conta, aberta do cofre só aqui (a configuração exige as chaves privadas).
      let reader: PubsubReader;
      if (loaded.NODE_PLATFORM === 'vm') {
        const keyring = loaded.credentialsKeyring;
        if (keyring === null)
          throw new Error('SYNC_SOURCES: a fonte gcp na VM própria exige o cofre de credenciais');
        reader = new VaultPubsubReader(prisma, keyring);
      } else {
        reader = new PubsubRestReader(new MetadataTokenProvider());
      }
      const sync = new GcpAuditSync(prisma, reader);
      return [{ name: 'gcp', intervalMs, budgetMs: SYNC_BUDGET_MS, run: () => sync.runOnce() }];
    });
    // Agentes do Wazuh nas instâncias do cliente (WAZUH_AGENTS=true no node.conf): a lista que o host exporta do
    // manager, no mesmo intervalo das fontes.
    if (config.wazuhAgents !== null) {
      const agents = new WazuhAgentsSync(prisma, config.wazuhAgents);
      tasks.push({ name: 'wazuh-agents', intervalMs, budgetMs: SYNC_BUDGET_MS, run: () => agents.runOnce() });
    }
    // Conexão da AWS: a API só grava o pedido do "Verificar"; o worker, o único contêiner com o metadata, responde e,
    // sem pedido, confere de novo as contas já verificadas.
    aws = await awsConnectionSetup(loaded, prisma, logger);
    // Onboarding self-service: as tags do papel e a descoberta das fontes só no nó dedicado. Na célula compartilhada, a
    // coleta da AWS ainda não foi construída (CE-11/CE-12), e a conferência segue como antes.
    const awsOnboarding = config.NODE_MODE !== 'cell';
    const awsCheck = new AwsCheck(prisma, aws.checker, { onboarding: awsOnboarding });
    tasks.push({
      name: 'aws-check',
      intervalMs: AWS_CHECK_INTERVAL_MS,
      budgetMs: SYNC_BUDGET_MS,
      run: async (signal) => ({
        requests: await awsCheck.runOnce(signal),
        periodic: await awsCheck.recheck(signal),
      }),
    });
    // Avisos por e-mail: o transporte da mesma fábrica da API. A configuração já exigiu o remetente e a origem do painel
    // com o e-mail ligado.
    const mailer =
      config.MAIL_TRANSPORT === 'none'
        ? null
        : { transport: mailTransport(config), webOrigin: config.WEB_ORIGIN as string };
    const notifications = new NotificationDispatcher(prisma, mailer, {
      usage: new UsageNotices(prisma, plans),
    });
    tasks.push({
      name: NOTIFICATIONS_TASK,
      intervalMs: NOTIFICATIONS_INTERVAL_MS,
      budgetMs: SYNC_BUDGET_MS,
      run: (signal) => notifications.runOnce(signal),
    });
    // Inventário e postura da AWS (Ativos e Postura): só com a identidade do nó, pela mesma sessão da conferência. Os
    // clientes do IAM, do EC2, do S3, do S3 Control, do CloudTrail e do GuardDuty só são carregados aqui.
    if (aws.credentials !== null) {
      const inventory = await import('./inventory/inventory-job.js');
      const { sdkInventoryClients } = await import('./inventory/inventory.js');
      const sync = new inventory.AwsInventorySync(prisma, aws.credentials, sdkInventoryClients);
      tasks.push({
        name: 'aws-inventory',
        intervalMs: inventory.AWS_INVENTORY_TICK_MS,
        budgetMs: inventory.AWS_INVENTORY_BUDGET_MS,
        run: (signal) => sync.runOnce(signal),
      });
      // Descoberta das fontes de log (onboarding self-service): pela mesma sessão, só com chamadas de leitura. Os
      // clientes dos serviços que ela lê (CloudWatch Logs, WAF, Security Hub, Inspector...) só são carregados aqui.
      if (awsOnboarding) {
        const discovery = await import('./aws/discovery/discovery-job.js');
        const { sdkDiscoveryClients } = await import('./aws/discovery/sdk-clients.js');
        const discover = new discovery.AwsDiscovery(prisma, aws.credentials, sdkDiscoveryClients);
        tasks.push({
          name: 'aws-discovery',
          intervalMs: discovery.AWS_DISCOVERY_TICK_MS,
          budgetMs: discovery.AWS_DISCOVERY_BUDGET_MS,
          run: (signal) => discover.runOnce(signal),
        });
        // Achados das fontes autorizadas lidas por API (GuardDuty, Security Hub, Inspector e Access Analyzer): a mesma
        // sessão e os mesmos clientes com a trava de só leitura. Fora da célula, como a descoberta.
        const findings = await import('./aws/findings/findings-job.js');
        const collect = new findings.AwsFindings(prisma, aws.credentials, sdkDiscoveryClients);
        tasks.push({
          name: findings.AWS_FINDINGS_SYNC,
          intervalMs: findings.AWS_FINDINGS_TICK_MS,
          budgetMs: findings.AWS_FINDINGS_BUDGET_MS,
          run: (signal) => collect.runOnce(signal),
        });
      }
    }

    // Wazuh do nó (perfil standard): a geração das contas AWS para o host aplicar no manager, e o estado da coleta que o
    // host devolve, pela pasta dos sinais (sem segredo; quem escreve a configuração do manager é só o gerador).
    if (config.WAZUH_SIGNAL_DIR !== undefined) {
      // Onboarding self-service (só no nó dedicado): a tarefa também grava a saúde de cada fonte lida pelo Wazuh, pelo
      // sinal `progress` do host. Com a sessão de leitura das contas, confere na origem a fonte contínua que parou de
      // andar (uma listagem do bucket, só leitura); sem ela, nenhuma fonte é marcada como parada.
      let stallProbe: WazuhStallProbe | null = null;
      if (awsOnboarding && aws.credentials !== null) {
        const [{ S3StallProbe }, { sdkDiscoveryClients }] = await Promise.all([
          import('./aws/wazuh-stall-probe.js'),
          import('./aws/discovery/sdk-clients.js'),
        ]);
        stallProbe = new S3StallProbe(aws.credentials, sdkDiscoveryClients);
      }
      const wazuhConfig = new WazuhConfig(prisma, config.WAZUH_SIGNAL_DIR, {
        sourceHealth: awsOnboarding,
        stallProbe,
      });
      tasks.push({
        name: 'wazuh-config',
        intervalMs: WAZUH_CONFIG_INTERVAL_MS,
        budgetMs: SYNC_BUDGET_MS,
        run: (signal) => wazuhConfig.runOnce(signal),
      });
    }
    // Medidor da AWS e saúde da ingestão (perfil standard, PR-V6): os contadores do analysisd pela API do manager, com o
    // usuário verax_stats (só manager:read) e o TLS conferido com a CA do nó.
    if (config.wazuhApi !== null) {
      const stats = new WazuhStatsClient({
        url: config.wazuhApi.url,
        caFile: config.wazuhApi.caFile,
        password: config.wazuhApi.password(),
      });
      const usage = new WazuhUsage(prisma, stats, {
        // Na célula (CE-09), o analysisd é só o contador do nó: o volume de cada cliente vem da medição na origem.
        mode: config.NODE_MODE,
        logger,
        agentsTenantId: config.wazuhAgents?.tenantId ?? null,
      });
      tasks.push({
        name: WAZUH_USAGE_TASK,
        intervalMs: WAZUH_USAGE_INTERVAL_MS,
        budgetMs: SYNC_BUDGET_MS,
        run: (signal) => usage.runOnce(signal),
      });
    }

    // Medição do volume da AWS na origem (CE-09), só na célula: cada cliente com a própria identidade. Até o CE-11, a
    // célula não tem identidade de cliente nenhum, e a tarefa não chama a AWS (conta as contas em identityUnavailable).
    // O cliente do S3 só é carregado aqui.
    if (config.NODE_MODE === 'cell') {
      const { sdkVolumeS3 } = await import('./usage/aws-volume-sdk.js');
      const volume = new AwsVolumeAudit(
        prisma,
        tenantAwsIdentityFor(config.NODE_MODE, aws.credentials),
        sdkVolumeS3,
        { logger },
      );
      tasks.push({
        name: AWS_VOLUME_TASK,
        intervalMs: AWS_VOLUME_TICK_MS,
        budgetMs: AWS_VOLUME_BUDGET_MS,
        run: (signal) => volume.runOnce(signal),
      });
    }

    // Expurgo diário do histórico (só o banco do nó; o índice do Wazuh tem a retenção própria).
    const retention = new RetentionJob(prisma, { plans });
    tasks.push({
      name: RETENTION_TASK,
      intervalMs: RETENTION_CHECK_INTERVAL_MS,
      budgetMs: RETENTION_BUDGET_MS,
      run: (signal) => retention.maybeRun(new Date(), signal),
    });
    // Faxina das tentativas de conectar o Cloudflare por OAuth (só o banco do nó).
    const connectsCloudflare = config.controlPlaneSync !== null && announcesCloudflareOauth(config);
    const connectAttempts = new ConnectAttemptsPurge(prisma, undefined, connectsCloudflare);
    tasks.push({
      name: CONNECT_ATTEMPTS_PURGE_TASK,
      intervalMs: CONNECT_ATTEMPTS_PURGE_INTERVAL_MS,
      budgetMs: SYNC_BUDGET_MS,
      run: (signal) => connectAttempts.runOnce(new Date(), signal),
    });
    const keyring = config.credentialsKeyring;
    if (keyring !== null) {
      const rekey = new CredentialRekey(prisma, keyring);
      tasks.push({
        name: 'credential-rekey',
        intervalMs: CREDENTIAL_REKEY_INTERVAL_MS,
        budgetMs: SYNC_BUDGET_MS,
        run: (signal) => rekey.runOnce(signal),
      });
    }
    // Conexão do Cloudflare por OAuth (CF-4), só no nó gerenciado: a troca do código, a descoberta, a ligação das contas e a
    // revogação. Roda mesmo com o OAuth desligado: as autorizações soltas ainda são revogadas. Sem o coletor do Cloudflare
    // (ou sem a sincronização), nenhuma conta nova é ligada.
    if (keyring !== null && config.NODE_MODE === 'dedicated' && config.NODE_PLATFORM === 'gcp') {
      const connect = new CloudflareConnectJob(prisma, keyring, plans, {
        oauth: new PublicClientTokens(),
        // As provas são uma leitura pequena por conta: sem novas tentativas dentro da chamada, e com prazo curto.
        client: new CloudflareClient({ timeoutMs: 10_000, retryDelaysMs: [] }),
        connect: connectsCloudflare,
        logger,
      });
      tasks.push({
        name: CLOUDFLARE_CONNECT_TASK,
        intervalMs: CLOUDFLARE_CONNECT_POLL_MS,
        budgetMs: CLOUDFLARE_CONNECT_BUDGET_MS,
        run: (signal) => connect.watch(signal),
      });
    }
    // Canal da célula com o plano de controle (CE-05): os comandos, a caixa de saída dos relatórios e o estado de cada
    // cliente. O token é o da VM, que só lê a assinatura de comandos e só publica no tópico de relatórios desta célula.
    if (config.cellChannel !== null) {
      const channel = config.cellChannel;
      const tokens = new MetadataTokenProvider();
      const outbox = new CellReportOutbox(channel.cellId);
      const commands = new CellCommands(prisma, {
        cellId: channel.cellId,
        subscription: channel.commandsSubscription,
        reader: new PubsubRestReader(tokens),
        outbox,
        logger,
        // O pedido do primeiro administrador ao host (CE-04), repetido a cada passagem até a confirmação. Sem as pastas,
        // os pedidos ficam no banco esperando.
        bootstraps: new CellTenantBootstraps(
          prisma,
          config.tenantBootstrap === null
            ? null
            : new FileTenantBootstrapSignal(
                config.tenantBootstrap.requestsDir,
                config.tenantBootstrap.statusDir,
              ),
        ),
      });
      const publisher = new CellReportPublisher(
        prisma,
        new PubsubRestPublisher(tokens),
        channel.reportsTopic,
        logger,
      );
      const tenantStatus = new CellTenantStatusReporter(prisma, outbox);
      const usageReports = new CellUsageReports(prisma, outbox);
      tasks.push(
        {
          name: CELL_COMMANDS_TASK,
          intervalMs: CELL_COMMANDS_INTERVAL_MS,
          budgetMs: SYNC_BUDGET_MS,
          run: (signal) => commands.runOnce(signal),
        },
        {
          name: CELL_REPORTS_TASK,
          intervalMs: CELL_REPORTS_INTERVAL_MS,
          budgetMs: SYNC_BUDGET_MS,
          run: (signal) => publisher.runOnce(signal),
        },
        {
          name: CELL_TENANT_STATUS_TASK,
          intervalMs: CELL_TENANT_STATUS_INTERVAL_MS,
          budgetMs: SYNC_BUDGET_MS,
          run: (signal) => tenantStatus.runOnce(signal),
        },
        {
          name: CELL_USAGE_REPORTS_TASK,
          intervalMs: CELL_USAGE_REPORTS_INTERVAL_MS,
          budgetMs: SYNC_BUDGET_MS,
          run: (signal) => usageReports.runOnce(signal),
        },
      );
    }
    // Estado do nó nos guest attributes (nó de cliente): o worker é o único contêiner que alcança o servidor de
    // metadados.
    if (config.nodeStatus !== null) {
      const reporter = new NodeStatusReporter(prisma, { version: config.nodeStatus.version, logger });
      tasks.push({
        name: 'node-status',
        intervalMs: NODE_STATUS_INTERVAL_MS,
        budgetMs: NODE_STATUS_BUDGET_MS,
        run: (signal) => reporter.runOnce(signal),
      });
    }
    // Sincronização com o plano de controle (nó dedicado de cliente): as fontes de log do console. Na GCP, o worker é o
    // único contêiner que alcança o metadata (o token do nó); na VM própria, a chave do nó vem do tmpfs.
    const controlPlane = await controlPlaneSyncTask(config, { prisma, plans, logger });
    if (controlPlane !== null) tasks.push(controlPlane);
  } catch (error) {
    // Só nomes de variáveis e o problema; nenhum valor é impresso.
    console.error((error as Error).message);
    process.exit(1);
  }

  const scheduler = new Scheduler(tasks, logger);
  const stopRequested = new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  });

  logger.info(
    {
      intervalSeconds: config.SYNC_INTERVAL_SECONDS,
      tasks: tasks.map((task) => task.name),
      nodeMode: config.NODE_MODE,
      // Só o id da célula (null fora dela ou sem o canal), nunca a assinatura nem o tópico.
      cellId: config.cellChannel?.cellId ?? null,
      // Na célula, o plano é de cada cliente: o do ambiente não vale.
      plan: config.NODE_MODE === 'cell' ? null : config.PLAN,
      // Só o tipo do transporte dos avisos, nunca o servidor, o usuário ou o remetente.
      mailTransport: config.MAIL_TRANSPORT,
      // Só a versão corrente da chave do cofre (null sem o cofre), nunca a chave.
      vaultKeyVersion: config.credentialsKeyring?.current ?? null,
      // Só a origem do plano de controle (null com a sincronização desligada), nunca a chave do nó.
      controlPlaneOrigin: config.controlPlaneSync?.origin ?? null,
    },
    'worker iniciado',
  );
  if (config.cellChannel !== null && config.tenantBootstrap === null) {
    logger.warn(
      {},
      'célula sem TENANT_BOOTSTRAP_DIR e TENANT_BOOTSTRAP_STATUS_DIR: o primeiro administrador dos clientes novos fica esperando',
    );
  }
  if (config.NODE_MODE === 'cell' && config.cellChannel === null) {
    logger.warn(
      {},
      'célula sem CELL_ID, CELL_COMMANDS_SUBSCRIPTION e CELL_REPORTS_TOPIC: o canal com o plano de controle fica desligado',
    );
  }
  await aws.start();
  scheduler.start();
  await stopRequested;
  await scheduler.stop();
  await prisma.$disconnect();
  logger.info('worker encerrado');
}

void main();

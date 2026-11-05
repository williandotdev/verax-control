import { AWS_READER_AUDIENCE } from '@verax/shared';
import { type Logger, pino } from 'pino';
import { WazuhAgentsSync } from './agents/agents-sync.js';
import { AgentAlertSync } from './alerts/agent-alert-sync.js';
import { AlertSync } from './alerts/alert-sync.js';
import { AWS_CHECK_INTERVAL_MS, AwsCheck } from './aws/aws-check.js';
import { type AwsConnectionChecker, UnavailableAwsConnectionChecker } from './aws/aws-connection-check.js';
import { WAZUH_CONFIG_INTERVAL_MS, WazuhConfig } from './aws/wazuh-config.js';
import { CloudflareAuditSync } from './cloudflare/cloudflare-audit-sync.js';
import type { WorkerEnv } from './common/config/env.schema.js';
import { loadWorkerConfig } from './common/config/load-config.js';
import { loadEnvFileForLocalDevelopment } from './common/config/load-env-file.js';
import { buildPinoOptions } from './common/logger/logger.options.js';
import { PrismaService } from './common/prisma/prisma.service.js';
import { CREDENTIAL_REKEY_INTERVAL_MS, CredentialRekey } from './credentials/credential-rekey.js';
import { GcpAuditSync } from './gcp/gcp-audit-sync.js';
import { MetadataTokenProvider, PubsubRestReader } from './gcp/pubsub.client.js';
import { IndexerClient } from './indexer/indexer.client.js';
import { loadIndexerConfig } from './indexer/indexer.config.js';
import { indexerSecretsFor } from './indexer/indexer-secrets.js';
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
  start(): Promise<void>;
}

/**
 * Com o ID da conta de serviço do nó (`NODE_SA_UNIQUE_ID`), a conferência real (PR-V5'): o token do Google pelo
 * metadata, o STS e os buckets. Só então o SDK da AWS é carregado: o nó sem a linha (o da Verax, o ambiente local) não
 * paga a memória dele e responde `check_unavailable`, sem chamar a AWS nem o metadata. Na partida, o `sub` do token
 * do nó é conferido com o ID (sem o token no log); sem `NODE_EGRESS_IPS`, a simulação da permissão demais fica de
 * fora, e o log diz isso.
 */
async function awsConnectionSetup(config: Readonly<WorkerEnv>, logger: Logger): Promise<AwsConnectionSetup> {
  const serviceAccountId = config.NODE_SA_UNIQUE_ID;
  if (serviceAccountId === undefined) {
    return { checker: new UnavailableAwsConnectionChecker(), start: () => Promise.resolve() };
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
 * agentes ligados; desligados, vão para a fila sem dono).
 *
 * A fonte `cloudflare` (auditoria das contas do Cloudflare) roda no mesmo intervalo, e cada conta é lida a cada
 * `CLOUDFLARE_AUDIT_INTERVAL_SECONDS` (o cursor de cada conta guarda a próxima leitura). Ela exige o cofre.
 *
 * Com os agentes do Wazuh ligados no nó, entra a tarefa `wazuh-agents`, que grava a lista dos agentes exportada pelo host.
 *
 * Com o cofre de credenciais (as chaves privadas num arquivo do tmpfs do nó, só no nó de cliente), entra também a tarefa diária
 * `credential-rekey`, que recifra com a versão corrente as credenciais guardadas com uma versão antiga da chave.
 *
 * A tarefa `aws-check` (a cada 30 s) responde o "Verificar" das contas AWS e, sem pedido, confere de novo cada conta já
 * verificada a cada 15 min, com a trilha, o export do GuardDuty e a permissão demais uma vez por dia (PR-V5'). A
 * conferência real só liga com `NODE_SA_UNIQUE_ID` (`awsConnectionSetup`).
 *
 * No nó com o Wazuh (`WAZUH_SIGNAL_DIR`), a tarefa `wazuh-config` (a cada 30 s) avisa o host quando as contas AWS que o
 * manager lê mudam e mostra nas contas o que o host devolve: a aplicação no manager e o token do Google.
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
        ];
      }
      if (source === 'cloudflare') {
        // Auditoria do Cloudflare: o token de cada conta vem do cofre do nó, aberto só aqui (a configuração exige as
        // chaves privadas para esta fonte).
        const keyring = loaded.credentialsKeyring;
        if (keyring === null)
          throw new Error('SYNC_SOURCES: a fonte cloudflare exige o cofre de credenciais');
        const cloudflare = new CloudflareAuditSync(prisma, keyring, {
          auditIntervalMs: loaded.CLOUDFLARE_AUDIT_INTERVAL_SECONDS * 1000,
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
      // Auditoria da GCP: o token vem da identidade da VM do nó, sem chave.
      const sync = new GcpAuditSync(prisma, new PubsubRestReader(new MetadataTokenProvider()));
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
    aws = await awsConnectionSetup(loaded, logger);
    const awsCheck = new AwsCheck(prisma, aws.checker);
    tasks.push({
      name: 'aws-check',
      intervalMs: AWS_CHECK_INTERVAL_MS,
      budgetMs: SYNC_BUDGET_MS,
      run: async (signal) => ({
        requests: await awsCheck.runOnce(signal),
        periodic: await awsCheck.recheck(signal),
      }),
    });
    // Wazuh do nó (perfil standard): a geração das contas AWS para o host aplicar no manager, e o estado da coleta que o
    // host devolve, pela pasta dos sinais (sem segredo; quem escreve a configuração do manager é só o gerador).
    if (config.WAZUH_SIGNAL_DIR !== undefined) {
      const wazuhConfig = new WazuhConfig(prisma, config.WAZUH_SIGNAL_DIR);
      tasks.push({
        name: 'wazuh-config',
        intervalMs: WAZUH_CONFIG_INTERVAL_MS,
        budgetMs: SYNC_BUDGET_MS,
        run: (signal) => wazuhConfig.runOnce(signal),
      });
    }
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
      plan: config.PLAN,
      // Só a versão corrente da chave do cofre (null sem o cofre), nunca a chave.
      vaultKeyVersion: config.credentialsKeyring?.current ?? null,
    },
    'worker iniciado',
  );
  await aws.start();
  scheduler.start();
  await stopRequested;
  await scheduler.stop();
  await prisma.$disconnect();
  logger.info('worker encerrado');
}

void main();

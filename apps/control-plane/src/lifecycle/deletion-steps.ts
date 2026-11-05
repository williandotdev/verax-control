import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import type { StepContext, StepInput } from '../internal/step-handler.js';
import { MAIL_SENDER, type MailSender, MailUnavailableError } from '../mail/mail-sender.js';
import { executorEnv, purgeExecutorEnv } from '../provisioning/executor-env.js';
import { COMPANY_NAME_MAX_LENGTH } from '../tenants/tenant.schema.js';
import { isExecutionName } from '../provisioning/google-apis.js';
import { DefinitiveStepError, MAX_TASK_ATTEMPTS } from '../provisioning/provisioning-engine.js';
import {
  PROVISIONING_APIS,
  type ProvisioningApis,
  type ProvisioningSettings,
  resolveProvisioningSettings,
} from '../provisioning/provisioning-settings.js';
import { tenantHosts, WAITS } from '../provisioning/provisioning-steps.js';
import { ProvisioningStore } from '../provisioning/provisioning-store.js';
import { readReleaseManifest } from '../provisioning/release-manifest.js';
import type { LifecycleRunKind, Tenant, TenantRecord } from '../tenants/tenant.schema.js';
import {
  DeletionEngine,
  type DeletionOutcome,
  type DeletionStep,
  type DeletionStepRun,
} from './deletion-engine.js';
import { buildDeletionRecord } from './deletion-record.js';
import { afterDeletion, minimalRecord } from './lifecycle-rules.js';

const DAY_MS = 24 * 60 * 60_000;

/** A Exclusão 2 espera o bucket de backups esvaziar pela retenção (uma nova tentativa por dia, por até 14 dias). */
/**
 * O nome do cliente nas variáveis do `destroy`. O `envs/tenant` recusa mais de 120 caracteres, e um cliente gravado antes
 * do limite (até 200) ainda tem de poder ser excluído: aqui o nome é cortado em 120, sem partir um caractere, porque no
 * `destroy` ele só preenche a variável (nenhum recurso novo recebe o nome).
 */
export function deletionTenantName(legalName: string): string {
  let name = '';
  for (const char of legalName) {
    if (name.length + char.length > COMPANY_NAME_MAX_LENGTH) break;
    name += char;
  }
  return name.trimEnd();
}

export const PURGE_RETRY = { everyMs: DAY_MS, maxDays: 14 } as const;

/** Códigos de recusa do executor que não mudam numa nova execução (`result.json`). */
const EXECUTOR_REFUSALS = new Set([
  'input_invalid',
  'action_refused',
  'plan_unreadable',
  'state_not_empty',
  'destroy_plan_unexpected',
]);
const executorResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'refused', 'invalid']),
  code: z.string().regex(/^[a-z][a-z_]{0,39}$/),
});

function settingsOrFail(config: AppConfig): ProvisioningSettings {
  const result = resolveProvisioningSettings(config);
  if (!result.ready) throw new DefinitiveStepError('provisioning_disabled');
  return result.settings;
}

/** O `apply` do Terraform deste cliente começou alguma vez (a versão presa) ou a VM foi registrada (CP-07). */
export function terraformStarted(tenant: Tenant): boolean {
  return (
    tenant.provisioning?.nodeVersionPinnedAt !== undefined || tenant.resources?.instanceName !== undefined
  );
}

function tryJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** A base de cada passo: o motor faz a conferência, a trava, a fila e a falha. */
abstract class BaseDeletionStep implements DeletionStep {
  abstract readonly name: string;
  abstract readonly kind: LifecycleRunKind;
  abstract readonly external: boolean;

  protected constructor(protected readonly engine: DeletionEngine) {}

  run(input: StepInput, context: StepContext): Promise<string> {
    return this.engine.run(this, input, context);
  }

  abstract execute(run: DeletionStepRun): Promise<DeletionOutcome>;
}

/**
 * Dispara o Job do executor uma vez por entrega (a execução fica no documento do passo antes de avançar) e devolve o
 * nome da execução.
 */
async function startJob(
  apis: ProvisioningApis,
  settings: ProvisioningSettings,
  env: { name: string; value: string }[],
): Promise<string> {
  return apis.runJobs.run(settings.job, env);
}

/** As variáveis da Exclusão 1: as mesmas do `apply` do cliente (o `destroy` avalia o mesmo `envs/tenant`). */
async function destroyEnv(
  config: AppConfig,
  apis: ProvisioningApis,
  settings: ProvisioningSettings,
  { tenant, runId }: DeletionStepRun,
): Promise<{ name: string; value: string }[]> {
  const nodeVersion = tenant.provisioning?.nodeVersion;
  if (nodeVersion === undefined) throw new DefinitiveStepError('node_version_unknown');
  const release = await readReleaseManifest(
    apis.storage,
    settings.releaseBucket,
    nodeVersion,
    apis.releaseKeys,
  );
  const hosts = tenantHosts(tenant.slug, settings);
  const subnetCidr = tenant.resources?.subnetCidr;
  const adminEmail = tenant.adminEmail;
  if (subnetCidr === undefined || adminEmail === undefined)
    throw new DefinitiveStepError('run_state_invalid');
  return executorEnv({
    action: 'destroy',
    kind: 'delete',
    runId,
    slug: tenant.slug,
    plan: 'enterprise',
    limits: {
      maxCloudAccounts: tenant.limits.maxCloudAccounts,
      maxUsers: tenant.limits.maxUsers,
      monthlyGib: tenant.limits.monthlyGib,
      historyDays: tenant.limits.historyDays,
    },
    nodeVersion: release.release,
    nodePackageSha256: release.packageSha256,
    webOrigin: hosts.webOrigin,
    apiOrigin: hosts.apiOrigin,
    mailFrom: settings.mailFromNodes,
    subnetCidr,
    adminEmail,
    tenantName: deletionTenantName(tenant.company.legalName),
    supportEmail: settings.supportEmail,
    imagesRepository: settings.imagesRepository,
  });
}

type ExecutionResult =
  { state: 'running' } | { state: 'succeeded' } | { state: 'failed'; code: string | undefined };

/** Consulta a execução; concluída com falha, lê o código do `result.json` (em `runs/<slug>/<runId>/<execução>/`). */
async function executionResult(
  apis: ProvisioningApis,
  settings: ProvisioningSettings,
  slug: string,
  runId: string,
  execution: string,
  since: number,
  now: Date,
): Promise<ExecutionResult> {
  let state = await apis.runJobs.executionState(settings.job, execution);
  if (state === 'running' && now.getTime() - since >= WAITS.terraform.limitMs) state = 'failed';
  if (state === 'running') return { state };
  if (state === 'succeeded') return { state };
  const raw = await apis.storage.read(
    settings.tfstateBucket,
    `runs/${slug}/${runId}/${execution}/result.json`,
    4 * 1024,
  );
  const code = raw === undefined ? undefined : executorResultSchema.safeParse(tryJson(raw)).data?.code;
  return { state: 'failed', code };
}

/** A execução gravada no documento do passo (`outputs`) ou no do passo que a disparou. */
async function recordedExecution(
  runs: ProvisioningStore,
  run: DeletionStepRun,
  startStep: string,
): Promise<{ execution: string; since: number; executions: number }> {
  const own = run.step.outputs ?? {};
  const started = (await runs.getStep(run.runId, startStep))?.outputs ?? {};
  const execution = typeof own.execution === 'string' ? own.execution : started.execution;
  const since = typeof own.executionSince === 'number' ? own.executionSince : started.executionSince;
  const executions = typeof own.executions === 'number' ? own.executions : 1;
  if (typeof execution !== 'string' || !isExecutionName(execution) || typeof since !== 'number') {
    throw new DefinitiveStepError('run_state_invalid');
  }
  return { execution, since, executions };
}

// --- Exclusão 1 -----------------------------------------------------------------------------------------------------

/**
 * `deletion.terraform`: dispara o executor com `EXECUTOR_ACTION=destroy` e `RUN_KIND=delete`. O executor tira a
 * proteção da VM pela API, tira do estado o disco, o IP do NAT, o bucket de backups, o cofre `credentials-key` e a
 * permissão do cp-worker nele, destrói o resto do `envs/tenant` (a conta de serviço do nó inclusive: só esta execução
 * pode) e apaga pela API o disco, os snapshots e o IP do NAT. Um cliente cujo `apply` nunca começou não tem estado: o
 * passo segue sem Job.
 */
@Injectable()
export class DeletionTerraformStep extends BaseDeletionStep {
  readonly name = 'deletion.terraform';
  readonly kind = 'delete' as const;
  readonly external = true;

  constructor(
    engine: DeletionEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    private readonly runs: ProvisioningStore,
  ) {
    super(engine);
  }

  async execute(run: DeletionStepRun): Promise<DeletionOutcome> {
    if (!terraformStarted(run.tenant)) return { kind: 'next', outputs: { skipped: true } };
    if (typeof run.step.outputs?.execution !== 'string') {
      const settings = settingsOrFail(this.config);
      const execution = await startJob(
        this.apis,
        settings,
        await destroyEnv(this.config, this.apis, settings, run),
      );
      await this.runs.updateStep(run.runId, this.name, (current, now) => ({
        ...(current ?? this.runs.newStep(now)),
        outputs: { ...current?.outputs, execution, executionSince: now.getTime(), executions: 1 },
        updatedAt: now,
      }));
    }
    return { kind: 'next', delayMs: WAITS.terraform.everyMs };
  }
}

/** `deletion.terraform_wait`: como o `terraform.wait` do provisionamento; uma falha comum repete o Job uma vez. */
@Injectable()
export class DeletionTerraformWaitStep extends BaseDeletionStep {
  readonly name = 'deletion.terraform_wait';
  readonly kind = 'delete' as const;
  readonly external = true;

  constructor(
    engine: DeletionEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    private readonly runs: ProvisioningStore,
    @InjectPinoLogger(DeletionTerraformWaitStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine);
  }

  async execute(run: DeletionStepRun): Promise<DeletionOutcome> {
    const started = await this.runs.getStep(run.runId, 'deletion.terraform');
    if (started?.outputs?.skipped === true) return { kind: 'next' };
    const settings = settingsOrFail(this.config);
    const { execution, since, executions } = await recordedExecution(this.runs, run, 'deletion.terraform');
    const result = await executionResult(
      this.apis,
      settings,
      run.tenant.slug,
      run.runId,
      execution,
      since,
      run.now,
    );
    if (result.state === 'running') return { kind: 'wait', delayMs: WAITS.terraform.everyMs };
    if (result.state === 'succeeded') return { kind: 'next', outputs: { execution, executions } };
    this.logger.warn(
      {
        event: 'deletion_execution_failed',
        tenantId: run.tenant.id,
        execution,
        code: result.code ?? 'unknown',
      },
      'execução do destroy falhou',
    );
    if (result.code !== undefined && EXECUTOR_REFUSALS.has(result.code)) {
      throw new DefinitiveStepError(`terraform_refused:${result.code}`);
    }
    if (executions >= 2) throw new DefinitiveStepError('terraform_failed');
    const retried = await startJob(
      this.apis,
      settings,
      await destroyEnv(this.config, this.apis, settings, run),
    );
    return {
      kind: 'wait',
      delayMs: WAITS.terraform.everyMs,
      outputs: { execution: retried, executionSince: run.now.getTime(), executions: executions + 1 },
    };
  }
}

/**
 * `deletion.cloudflare`: o túnel `vx-<slug>` (o gravado e o achado pelo nome) e os registros de DNS deste cliente. Um
 * registro só é apagado se o nome dele for a API (`api-<slug>.<zona>`) ou o painel (`<slug>.control...` e o que estiver
 * abaixo dele) deste cliente: um id gravado por engano que aponte para outro nome da zona fica, com o aviso.
 */
@Injectable()
export class DeletionCloudflareStep extends BaseDeletionStep {
  readonly name = 'deletion.cloudflare';
  readonly kind = 'delete' as const;
  readonly external = true;

  constructor(
    engine: DeletionEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    @InjectPinoLogger(DeletionCloudflareStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine);
  }

  async execute({ tenant }: DeletionStepRun): Promise<DeletionOutcome> {
    const settings = settingsOrFail(this.config);
    const cloudflare = this.apis.cloudflare(settings);
    const tunnels = new Set<string>();
    if (tenant.resources?.tunnelId !== undefined) tunnels.add(tenant.resources.tunnelId);
    const found = await cloudflare.findTunnel(`vx-${tenant.slug}`);
    if (found !== undefined) tunnels.add(found.id);
    for (const id of tunnels) await cloudflare.deleteTunnel(id);

    const { apiHost, panelHost } = tenantHosts(tenant.slug, settings);
    const ours = (name: string): boolean => {
      const host = name.replace(/\.$/, '').toLowerCase();
      return host === apiHost || host === panelHost || host.endsWith(`.${panelHost}`);
    };
    const ids = new Set(tenant.resources?.dnsRecordIds ?? []);
    for (const host of [apiHost, panelHost]) {
      for (const record of await cloudflare.listDnsRecordsByName(host)) ids.add(record.id);
    }
    let records = 0;
    let skipped = 0;
    for (const id of ids) {
      const record = await cloudflare.getDnsRecord(id);
      if (record === undefined) continue;
      if (!ours(record.name)) {
        skipped += 1;
        this.logger.warn(
          { event: 'deletion_dns_record_skipped', tenantId: tenant.id, type: record.type },
          'registro de outro nome: fica',
        );
        continue;
      }
      await cloudflare.deleteDnsRecord(id);
      records += 1;
    }
    return { kind: 'next', outputs: { tunnels: tunnels.size, records, skipped } };
  }
}

/**
 * `deletion.firebase`: o domínio do painel e o site (`vxc-<slug>-<hex>`) do cliente, no projeto do pool em que foi
 * criado. Um id de site fora do formato deste cliente, ou num projeto fora do pool, para a exclusão (nada é apagado).
 */
@Injectable()
export class DeletionFirebaseStep extends BaseDeletionStep {
  readonly name = 'deletion.firebase';
  readonly kind = 'delete' as const;
  readonly external = true;

  constructor(
    engine: DeletionEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
  ) {
    super(engine);
  }

  async execute({ tenant }: DeletionStepRun): Promise<DeletionOutcome> {
    const siteId = tenant.resources?.siteId;
    const project = tenant.resources?.firebaseProject;
    if (siteId === undefined || project === undefined) return { kind: 'next', outputs: { skipped: true } };
    const settings = settingsOrFail(this.config);
    const prefix = `vxc-${tenant.slug}-`;
    const suffix = siteId.slice(prefix.length);
    if (
      !siteId.startsWith(prefix) ||
      !/^[0-9a-f]{6}$/.test(suffix) ||
      !settings.firebaseProjects.includes(project)
    ) {
      throw new DefinitiveStepError('firebase_site_not_owned');
    }
    const { panelHost } = tenantHosts(tenant.slug, settings);
    const domain = await this.apis.firebase.deleteCustomDomain(project, siteId, panelHost);
    const site = await this.apis.firebase.deleteSite(project, siteId);
    return { kind: 'next', outputs: { domain, site } };
  }
}

/**
 * `deletion.record`: o registro de exclusão por e-mail ao admin do cliente, depois o cliente perde o e-mail, o acesso e
 * os recursos que a Exclusão 2 não usa (`afterDeletion`). Sem SMTP configurado, ou com o envio falhando até a última
 * tentativa da fila, a exclusão segue sem o e-mail (a linha `event=deletion_record_unsent` avisa a Verax): apagar o dado
 * pessoal vem antes de avisar.
 */
@Injectable()
export class DeletionRecordStep extends BaseDeletionStep {
  readonly name = 'deletion.record';
  readonly kind = 'delete' as const;
  readonly external = false;

  constructor(
    engine: DeletionEngine,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @InjectPinoLogger(DeletionRecordStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine);
  }

  async execute({ tenant, now, retryCount }: DeletionStepRun): Promise<DeletionOutcome> {
    const sent = await this.send(tenant, now, retryCount);
    return {
      kind: 'finish',
      patch: (current) => afterDeletion(current, now, sent),
      action: 'tenant.deletion_completed',
      details: {
        kind: 'delete',
        requestedBy: tenant.lifecycle?.deletionRequestedBy,
        recordSent: sent,
        provisioned: tenant.provisioning?.runId !== undefined,
      },
    };
  }

  private async send(tenant: TenantRecord, now: Date, retryCount: number | undefined): Promise<boolean> {
    if (tenant.adminEmail === undefined) return false;
    try {
      await this.mail.send(
        buildDeletionRecord({
          to: tenant.adminEmail,
          slug: tenant.slug,
          canceledAt: tenant.lifecycle?.canceledAt,
          deletedAt: now,
          cryptoDestroyAfter: tenant.lifecycle?.cryptoDestroyAfter,
        }),
      );
      return true;
    } catch (error) {
      const last = retryCount !== undefined && retryCount >= MAX_TASK_ATTEMPTS - 1;
      if (!(error instanceof MailUnavailableError) && !last) throw error;
      this.logger.warn(
        {
          event: 'deletion_record_unsent',
          tenantId: tenant.id,
          reason: error instanceof MailUnavailableError ? 'mail_unconfigured' : 'mail_failed',
        },
        'registro de exclusão sem e-mail',
      );
      return false;
    }
  }
}

// --- Exclusão 2 -----------------------------------------------------------------------------------------------------

/**
 * `crypto.destroy_key` (D+97): destrói todas as versões de `vx-<slug>-credentials-key` com o `cpSecretVersionDestroyer`
 * do cp-worker (listar e destruir, sem ler). Sem a chave, o que o cofre de credenciais guardou nos backups (a chave da
 * AWS e o token do Cloudflare do cliente, cifrados) não se abre mais. Confere que nenhuma versão ficou viva antes de
 * seguir; o cofre vazio é apagado pelo executor no passo seguinte.
 */
@Injectable()
export class CryptoDestroyKeyStep extends BaseDeletionStep {
  readonly name = 'crypto.destroy_key';
  readonly kind = 'crypto_destroy' as const;
  readonly external = true;

  constructor(
    engine: DeletionEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    private readonly audit: AuditService,
    @InjectPinoLogger(CryptoDestroyKeyStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine);
  }

  async execute({ tenant, now, requestId }: DeletionStepRun): Promise<DeletionOutcome> {
    const project = tenant.resources?.nodesProject ?? this.config.NODES_PROJECT_ID;
    if (project === undefined) throw new DefinitiveStepError('nodes_project_unknown');
    const secretId = `vx-${tenant.slug}-credentials-key`;
    const versions = await this.apis.secrets.listVersions(project, secretId);
    let destroyed = 0;
    for (const version of versions ?? []) {
      if (version.state === 'DESTROYED') continue;
      await this.apis.secrets.destroyVersion(project, secretId, version.id);
      destroyed += 1;
    }
    const remaining = (await this.apis.secrets.listVersions(project, secretId)) ?? [];
    if (remaining.some((version) => version.state !== 'DESTROYED')) {
      // Uma versão nova apareceu entre a lista e a destruição (não deveria: a VM já não existe). Repete.
      throw new Error('versões vivas depois da destruição');
    }
    if (tenant.lifecycle?.cryptoDestroyedAt === undefined) {
      await this.audit.write({
        actor: 'system',
        action: 'tenant.crypto_destroyed',
        tenantId: tenant.id,
        details: { versions: remaining.length, destroyedNow: destroyed, secretFound: versions !== undefined },
        requestId,
      });
      this.logger.info(
        { event: 'credentials_key_destroyed', tenantId: tenant.id, versions: remaining.length },
        'chave do cofre de credenciais destruída',
      );
    }
    return {
      kind: 'next',
      outputs: { versions: remaining.length, destroyed },
      patch: (current) => ({
        ...current,
        lifecycle: { ...current.lifecycle, cryptoDestroyedAt: current.lifecycle?.cryptoDestroyedAt ?? now },
      }),
    };
  }
}

/** `crypto.purge`: o executor com `EXECUTOR_ACTION=purge` apaga o cofre, o bucket de backups e o estado do cliente. */
@Injectable()
export class CryptoPurgeStep extends BaseDeletionStep {
  readonly name = 'crypto.purge';
  readonly kind = 'crypto_destroy' as const;
  readonly external = true;

  constructor(
    engine: DeletionEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    private readonly runs: ProvisioningStore,
  ) {
    super(engine);
  }

  async execute(run: DeletionStepRun): Promise<DeletionOutcome> {
    if (typeof run.step.outputs?.execution !== 'string') {
      const settings = settingsOrFail(this.config);
      const execution = await startJob(
        this.apis,
        settings,
        purgeExecutorEnv({ runId: run.runId, slug: run.tenant.slug }),
      );
      await this.runs.updateStep(run.runId, this.name, (current, now) => ({
        ...(current ?? this.runs.newStep(now)),
        outputs: { ...current?.outputs, execution, executionSince: now.getTime(), executions: 1 },
        updatedAt: now,
      }));
    }
    return { kind: 'next', delayMs: WAITS.terraform.everyMs };
  }
}

/**
 * `crypto.purge_wait`: a execução do `purge`. O bucket de backups só é apagado vazio (o executor não apaga objeto):
 * com objetos ainda lá (`backups_bucket_not_empty`, a retenção do bucket atrasada), o passo espera um dia e dispara de
 * novo, por até 14 dias; depois, para e avisa. Outra falha repete o Job uma vez.
 */
@Injectable()
export class CryptoPurgeWaitStep extends BaseDeletionStep {
  readonly name = 'crypto.purge_wait';
  readonly kind = 'crypto_destroy' as const;
  readonly external = true;

  constructor(
    engine: DeletionEngine,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    private readonly runs: ProvisioningStore,
    @InjectPinoLogger(CryptoPurgeWaitStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine);
  }

  async execute(run: DeletionStepRun): Promise<DeletionOutcome> {
    const settings = settingsOrFail(this.config);
    const env = purgeExecutorEnv({ runId: run.runId, slug: run.tenant.slug });
    if (run.step.outputs?.rerun === true) {
      // O dia de espera passou: outra execução do `purge`, com uma repetição comum de novo disponível.
      const execution = await startJob(this.apis, settings, env);
      return {
        kind: 'wait',
        delayMs: WAITS.terraform.everyMs,
        outputs: { execution, executionSince: run.now.getTime(), executions: 1, rerun: false },
      };
    }
    const { execution, since, executions } = await recordedExecution(this.runs, run, 'crypto.purge');
    const notEmptyDays =
      typeof run.step.outputs?.notEmptyDays === 'number' ? run.step.outputs.notEmptyDays : 0;
    const result = await executionResult(
      this.apis,
      settings,
      run.tenant.slug,
      run.runId,
      execution,
      since,
      run.now,
    );
    if (result.state === 'running') return { kind: 'wait', delayMs: WAITS.terraform.everyMs };
    if (result.state === 'succeeded') return { kind: 'next', outputs: { execution, executions } };
    if (result.code === 'backups_bucket_not_empty') {
      if (notEmptyDays >= PURGE_RETRY.maxDays) throw new DefinitiveStepError('backups_bucket_not_empty');
      this.logger.info(
        { event: 'backups_bucket_not_empty', tenantId: run.tenant.id, days: notEmptyDays + 1 },
        'o bucket de backups ainda tem objetos: nova tentativa amanhã',
      );
      // O Job seguinte só sai na consulta de amanhã: aqui fica gravado que é para disparar de novo.
      return {
        kind: 'wait',
        delayMs: PURGE_RETRY.everyMs,
        outputs: { notEmptyDays: notEmptyDays + 1, rerun: true },
      };
    }
    this.logger.warn(
      {
        event: 'deletion_execution_failed',
        tenantId: run.tenant.id,
        execution,
        code: result.code ?? 'unknown',
      },
      'execução do purge falhou',
    );
    if (result.code !== undefined && EXECUTOR_REFUSALS.has(result.code)) {
      throw new DefinitiveStepError(`terraform_refused:${result.code}`);
    }
    if (executions >= 2) throw new DefinitiveStepError('terraform_failed');
    const retried = await startJob(this.apis, settings, env);
    return {
      kind: 'wait',
      delayMs: WAITS.terraform.everyMs,
      outputs: { execution: retried, executionSince: run.now.getTime(), executions: executions + 1 },
    };
  }
}

/** `crypto.finish`: o cliente vira o registro mínimo (plano §3). */
@Injectable()
export class CryptoFinishStep extends BaseDeletionStep {
  readonly name = 'crypto.finish';
  readonly kind = 'crypto_destroy' as const;
  readonly external = false;

  constructor(engine: DeletionEngine) {
    super(engine);
  }

  execute({ now, tenant }: DeletionStepRun): Promise<DeletionOutcome> {
    return Promise.resolve({
      kind: 'finish',
      patch: (current) => minimalRecord(current, now),
      action: 'tenant.purged',
      details: { kind: 'crypto_destroy', provisioned: tenant.provisioning?.runId !== undefined },
    });
  }
}

/** Os passos da exclusão, para a lista `STEP_HANDLERS` do cp-worker. */
export const DELETION_STEP_CLASSES = [
  DeletionTerraformStep,
  DeletionTerraformWaitStep,
  DeletionCloudflareStep,
  DeletionFirebaseStep,
  DeletionRecordStep,
  CryptoDestroyKeyStep,
  CryptoPurgeStep,
  CryptoPurgeWaitStep,
  CryptoFinishStep,
] as const;

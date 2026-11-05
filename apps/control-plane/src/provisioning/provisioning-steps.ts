import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import type { StepContext, StepInput } from '../internal/step-handler.js';
import type { Tenant, TenantRecord } from '../tenants/tenant.schema.js';
import type { DesiredDnsRecord } from './cloudflare-api.js';
import {
  executorEnv,
  isTenantEmail,
  isTenantName,
  limitsFitNode,
  nodeTenantName,
  type RunKind,
} from './executor-env.js';
import { isExecutionName } from './google-apis.js';
import { MAX_BUNDLE_BYTES, openPanelBundle, siteHostingConfig } from './panel-bundle.js';
import {
  DefinitiveStepError,
  ProvisioningEngine,
  type ProvisioningStep,
  type ProvisioningStepName,
  type StepOutcome,
  type StepRun,
} from './provisioning-engine.js';
import {
  PROVISIONING_APIS,
  type ProvisioningApis,
  type ProvisioningSettings,
  resolveProvisioningSettings,
} from './provisioning-settings.js';
import { ProvisioningStore, type RunDocument, subnetCidrOf } from './provisioning-store.js';
import { readReleaseManifest, type ReleaseInfo } from './release-manifest.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/** Prazos de cada espera (plano §4c, com o que o PR-N7 mostrou sobre a instalação). */
export const WAITS = {
  /** O `apply` no Job: consulta a cada 30 s; o Job tem 30 min de prazo, e a espera, 35 min por execução. */
  terraform: { everyMs: 30 * SECOND_MS, limitMs: 35 * MINUTE_MS },
  /**
   * A VM instalando: a cada 60 s. O plano previa 40 min, mas a instalação lê o cofre do túnel por até 60 min e o Wazuh
   * tem até 40 min de partida (PR-N7): depois de 40 min a espera só avisa (`node_ready_slow`) e continua até 90 min.
   */
  nodeReady: { everyMs: MINUTE_MS, slowMs: 40 * MINUTE_MS, limitMs: 90 * MINUTE_MS },
  /** A API pelo túnel e o painel no endereço do Firebase: 10 tentativas a cada 30 s. */
  health: { everyMs: 30 * SECOND_MS, tries: 10 },
  /** O certificado do domínio do painel: a cada 2 min, aviso em 2 h, até 24 h. */
  domain: { everyMs: 2 * MINUTE_MS, slowMs: 2 * HOUR_MS, limitMs: 24 * HOUR_MS },
  /** A senha do primeiro admin no cofre (o nó a grava antes do `verax/ready`): a cada 60 s, 15 vezes. */
  bootstrap: { everyMs: MINUTE_MS, tries: 15 },
} as const;

/** Limite do Firebase: 36 sites por projeto (o padrão conta). */
const SITES_PER_PROJECT = 36;
/** O serviço da API do nó na rede do Compose (o `cloudflared` a alcança pelo nome). */
const NODE_API_SERVICE = 'http://api:3000';
/** Códigos de recusa do `entrypoint.sh` que não mudam numa nova execução (`result.json`). */
const EXECUTOR_REFUSALS = new Set([
  'input_invalid',
  'node_sa_replacement',
  'action_refused',
  'plan_unreadable',
]);
const NODE_ERROR_PATTERN = /^[a-z][a-z_]{0,39}$/;

/** Os endereços do cliente (plano §4c, passo 1): o painel no Firebase e a API pelo túnel. */
export interface TenantHosts {
  panelHost: string;
  apiHost: string;
  webOrigin: string;
  apiOrigin: string;
}

export function tenantHosts(slug: string, settings: ProvisioningSettings): TenantHosts {
  const panelHost = `${slug}.${settings.panelDomainSuffix}`;
  const apiHost = `${settings.apiDomainPrefix}${slug}.${settings.cloudflare.zoneName}`;
  return { panelHost, apiHost, webOrigin: `https://${panelHost}`, apiOrigin: `https://${apiHost}` };
}

/** Id de site do Firebase (global entre todos os projetos): `vxc-<slug>-<6 hexadecimais>`. */
export function newSiteId(slug: string): string {
  return `vxc-${slug}-${randomBytes(3).toString('hex')}`;
}

/** Os recursos do cliente com algo a mais (os outros campos ficam). */
function withResources(patch: NonNullable<Tenant['resources']>): (tenant: Tenant) => Tenant {
  return (tenant) => ({ ...tenant, resources: { ...tenant.resources, ...patch } });
}

function unionIds(existing: readonly string[] | undefined, added: readonly string[]): string[] {
  return [...new Set([...(existing ?? []), ...added])];
}

/** O que todo passo depois do `preflight` precisa: a configuração (que pode ter sido desligada) e a versão lida. */
function settingsOrFail(config: AppConfig): ProvisioningSettings {
  const result = resolveProvisioningSettings(config);
  if (!result.ready) throw new DefinitiveStepError('provisioning_disabled');
  return result.settings;
}

function releaseOf(run: RunDocument | undefined): ReleaseInfo {
  if (run?.release === undefined) throw new DefinitiveStepError('run_state_invalid');
  return run.release;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new DefinitiveStepError('run_state_invalid');
  return value;
}

/** A base de cada passo: o motor faz a conferência, a trava, a fila e a falha; o passo só faz o trabalho. */
abstract class BaseStep implements ProvisioningStep {
  abstract readonly name: ProvisioningStepName;

  protected constructor(
    protected readonly engine: ProvisioningEngine,
    protected readonly config: AppConfig,
    protected readonly apis: ProvisioningApis,
  ) {}

  run(input: StepInput, context: StepContext): Promise<string> {
    return this.engine.run(this, input, context);
  }

  abstract execute(run: StepRun): Promise<StepOutcome>;
}

// --- 1. preflight -----------------------------------------------------------------------------------------------

/**
 * Configuração completa (senão `provisioning_disabled`, sem enfileirar nada), o que foi vendido cabe no nó, o manifesto
 * da versão conferido (assinatura e campos), a faixa de rede, o projeto do Firebase com vaga e os nomes. Nada é criado
 * fora do Firestore. Num `resume` depois de a VM existir, a versão é a que o nó já tem (uma versão nova nos metadados
 * não é instalada, PR-N7, e o `node.wait_ready` esperaria para sempre).
 */
@Injectable()
export class PreflightStep extends BaseStep {
  readonly name = 'preflight';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    private readonly store: ProvisioningStore,
    @InjectPinoLogger(PreflightStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant, runId }: StepRun): Promise<StepOutcome> {
    const resolved = resolveProvisioningSettings(this.config);
    if (!resolved.ready) {
      this.logger.warn(
        { event: 'provisioning_unconfigured', tenantId: tenant.id, missing: resolved.missing },
        'provisionamento sem configuração',
      );
      throw new DefinitiveStepError('provisioning_disabled');
    }
    const settings = resolved.settings;
    if (!configurationFitsNode(tenant)) throw new DefinitiveStepError('configuration_unsupported');
    const adminEmail = tenant.adminEmail;
    if (
      adminEmail === undefined ||
      !isTenantEmail(adminEmail) ||
      adminEmail.toLowerCase() === settings.supportEmail.toLowerCase()
    ) {
      throw new DefinitiveStepError('admin_email_invalid');
    }
    if (!isTenantName(nodeTenantName(tenant.company.legalName)))
      throw new DefinitiveStepError('tenant_name_invalid');

    const kind: RunKind = (tenant.provisioning?.attempts ?? 0) > 0 ? 'resume' : 'provision';
    await this.store.ensureRun(runId, tenant.id, kind);
    const nodeCreated = tenant.resources?.instanceName !== undefined;
    const nodeVersion =
      nodeCreated && tenant.provisioning?.nodeVersion !== undefined
        ? tenant.provisioning.nodeVersion
        : settings.nodeRelease;
    const release = await readReleaseManifest(
      this.apis.storage,
      settings.releaseBucket,
      nodeVersion,
      this.apis.releaseKeys,
    );
    await this.store.updateRun(runId, (run) => ({ ...run, release }));

    const subnetCidr = tenant.resources?.subnetCidr ?? subnetCidrOf(await this.store.allocateSubnetNumber());
    const firebaseProject = tenant.resources?.firebaseProject ?? (await this.pickFirebaseProject(settings));
    const siteId = tenant.resources?.siteId ?? newSiteId(tenant.slug);
    return {
      kind: 'next',
      outputs: { nodeVersion, commit: release.commit, panelBundle: release.panel !== undefined },
      patch: (current) => ({
        ...withResources({
          nodesProject: settings.nodesProject,
          zone: settings.nodesZone,
          namePrefix: `vx-${current.slug}`,
          subnetCidr,
          firebaseProject,
          siteId,
          tfstatePrefix: `tenants/${current.slug}`,
        })(current),
        provisioning: { ...(current.provisioning ?? { attempts: 0 }), nodeVersion },
      }),
    };
  }

  /** O primeiro projeto do pool (na ordem da configuração) com menos de 36 sites. */
  private async pickFirebaseProject(settings: ProvisioningSettings): Promise<string> {
    for (const project of settings.firebaseProjects) {
      if ((await this.apis.firebase.countSites(project)) < SITES_PER_PROJECT) return project;
    }
    throw new DefinitiveStepError('firebase_pool_full');
  }
}

/**
 * O que o `envs/tenant` sabe criar hoje: o modo gerenciado, o porte P (perfil `standard`), sem agentes do Wazuh nas
 * instâncias do cliente (fora do CP-06) e com os limites nas faixas do nó. O resto para com `configuration_unsupported`
 * para o responsável decidir, em vez de entregar menos do que foi vendido.
 */
export function configurationFitsNode(tenant: Tenant): boolean {
  const { mode, size } = tenant.configuration;
  return mode === 'managed' && size === 'P' && tenant.limits.maxAgents === 0 && limitsFitNode(tenant.limits);
}

// --- 2. cloudflare.tunnel -----------------------------------------------------------------------------------------

/**
 * O túnel `vx-<slug>` (gerenciado pelo Cloudflare), o ingresso `api-<slug>` → `http://api:3000` e o CNAME com proxy
 * para `<id>.cfargotunnel.com` (um nível de subdomínio, dentro do certificado gratuito). Idempotente: procura pelo nome
 * antes de criar; o token não é lido aqui.
 */
@Injectable()
export class CloudflareTunnelStep extends BaseStep {
  readonly name = 'cloudflare.tunnel';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant }: StepRun): Promise<StepOutcome> {
    const settings = settingsOrFail(this.config);
    const cloudflare = this.apis.cloudflare(settings);
    const name = `vx-${tenant.slug}`;
    const tunnel =
      (await cloudflare.findTunnel(name)) ??
      (await cloudflare.createTunnel(name)) ??
      (await cloudflare.findTunnel(name));
    if (tunnel === undefined) throw new DefinitiveStepError('cloudflare_tunnel_conflict');
    const { apiHost } = tenantHosts(tenant.slug, settings);
    await cloudflare.putTunnelIngress(tunnel.id, apiHost, NODE_API_SERVICE);
    const recordId = await cloudflare.ensureDnsRecord(
      { type: 'CNAME', name: apiHost, content: `${tunnel.id}.cfargotunnel.com`, proxied: true },
      `verax-control: API do cliente ${tenant.slug}`,
    );
    return {
      kind: 'next',
      patch: (current) =>
        withResources({
          tunnelId: tunnel.id,
          dnsRecordIds: unionIds(current.resources?.dnsRecordIds, [recordId]),
        })(current),
    };
  }
}

// --- DNS do domínio do painel (passos 3 e 8) ---------------------------------------------------------------------

const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT']);
// eslint-disable-next-line no-control-regex -- recusa caractere de controle no conteúdo de um registro
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * Cria no Cloudflare (sem proxy) os registros que o Firebase pede para o domínio do painel: os de
 * `requiredDnsUpdates.desired` e os da verificação do certificado. Só nomes dentro do domínio do painel deste cliente;
 * qualquer outro nome que a resposta trouxesse fica de fora (um nome da zona inteira não é do Firebase decidir).
 */
async function syncPanelDns(
  apis: ProvisioningApis,
  settings: ProvisioningSettings,
  tenant: TenantRecord,
  siteId: string,
  logger: PinoLogger,
): Promise<{
  recordIds: string[];
  status: Awaited<ReturnType<ProvisioningApis['firebase']['getCustomDomain']>>;
}> {
  const project = required(tenant.resources?.firebaseProject);
  const { panelHost } = tenantHosts(tenant.slug, settings);
  const status = await apis.firebase.getCustomDomain(project, siteId, panelHost);
  const recordIds: string[] = [];
  const cloudflare = apis.cloudflare(settings);
  for (const record of status?.desiredRecords ?? []) {
    if (
      record.requiredAction !== undefined &&
      record.requiredAction !== 'ADD' &&
      record.requiredAction !== 'NONE'
    )
      continue;
    const name = record.domainName.replace(/\.$/, '').toLowerCase();
    const inside = name === panelHost || name.endsWith(`.${panelHost}`);
    if (!inside || !RECORD_TYPES.has(record.type) || record.rdata === '' || CONTROL.test(record.rdata)) {
      logger.warn(
        { event: 'panel_dns_record_skipped', tenantId: tenant.id, type: record.type },
        'registro ignorado',
      );
      continue;
    }
    const desired: DesiredDnsRecord = {
      type: record.type as DesiredDnsRecord['type'],
      name,
      // O ponto final de um nome (o destino de um CNAME) sai; o texto de um TXT vai como veio.
      content: record.type === 'CNAME' ? record.rdata.replace(/\.$/, '') : record.rdata,
      proxied: false,
    };
    recordIds.push(
      await cloudflare.ensureDnsRecord(desired, `verax-control: painel do cliente ${tenant.slug}`),
    );
  }
  return { recordIds, status };
}

// --- 3. firebase.site -------------------------------------------------------------------------------------------

/**
 * O site do painel (`vxc-<slug>-<hex>`) no projeto escolhido, o bundle da versão publicado com a CSP do cliente, o
 * domínio `<slug>.control...` e os registros que o Firebase pede. Sem o bundle no manifesto (o CP-09 ainda não o
 * publica), para com `panel_bundle_missing` antes de criar qualquer coisa no Firebase: o painel é o que o cliente abre
 * com a senha, e só uma versão nova resolve (decisão do CP-07, abaixo no STATUS).
 */
@Injectable()
export class FirebaseSiteStep extends BaseStep {
  readonly name = 'firebase.site';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    @InjectPinoLogger(FirebaseSiteStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant, run }: StepRun): Promise<StepOutcome> {
    const settings = settingsOrFail(this.config);
    const release = releaseOf(run);
    const panel = release.panel;
    if (panel === undefined) throw new DefinitiveStepError('panel_bundle_missing');
    const project = required(tenant.resources?.firebaseProject);
    let siteId = required(tenant.resources?.siteId);

    // O id do site é global no Firebase: um 409 de um site que não é deste projeto é de outro dono.
    for (let attempt = 0; ; attempt += 1) {
      const { created } = await this.apis.firebase.createSite(project, siteId);
      if (created || (await this.apis.firebase.siteExists(project, siteId))) break;
      if (attempt >= 2) throw new DefinitiveStepError('firebase_site_conflict');
      siteId = newSiteId(tenant.slug);
    }

    const { apiOrigin, panelHost } = tenantHosts(tenant.slug, settings);
    const labels = {
      'verax-release': release.release.replaceAll('.', '-'),
      'verax-panel': panel.sha256.slice(0, 16),
    };
    const latest = await this.apis.firebase.latestReleaseLabels(siteId);
    if (
      latest?.['verax-release'] !== labels['verax-release'] ||
      latest['verax-panel'] !== labels['verax-panel']
    ) {
      const archive = await this.apis.storage.read(settings.releaseBucket, panel.object, MAX_BUNDLE_BYTES);
      if (archive === undefined) throw new DefinitiveStepError('panel_bundle_missing');
      const bundle = openPanelBundle(archive, panel.sha256);
      const hosting = siteHostingConfig(bundle.template, tenant.slug, apiOrigin);
      const { uploaded } = await this.apis.firebase.publish(siteId, bundle.files, hosting, labels);
      this.logger.info(
        { event: 'panel_published', tenantId: tenant.id, files: bundle.files.size, uploaded },
        'painel publicado',
      );
    }
    await this.apis.firebase.createCustomDomain(project, siteId, panelHost);
    const { recordIds } = await syncPanelDns(
      this.apis,
      settings,
      { ...tenant, resources: { ...tenant.resources, siteId } },
      siteId,
      this.logger,
    );
    return {
      kind: 'next',
      patch: (current) =>
        withResources({ siteId, dnsRecordIds: unionIds(current.resources?.dnsRecordIds, recordIds) })(
          current,
        ),
    };
  }
}

// --- 4. terraform.apply -----------------------------------------------------------------------------------------

/**
 * Dispara o Job `cp-terraform` com as variáveis deste cliente (`executor-env.ts`, conferidas aqui e de novo no
 * `entrypoint.sh`). A execução fica gravada no documento do passo antes de avançar: uma entrega repetida não dispara
 * outra (um `apply` em dobro esperaria a trava do estado no bucket e não mudaria nada, mas gastaria minutos de Job).
 */
@Injectable()
export class TerraformApplyStep extends BaseStep {
  readonly name = 'terraform.apply';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    private readonly store: ProvisioningStore,
  ) {
    super(engine, config, apis);
  }

  async execute(stepRun: StepRun): Promise<StepOutcome> {
    const recorded = stepRun.step.outputs?.execution;
    if (typeof recorded !== 'string') {
      const execution = await startApply(this.config, this.apis, stepRun);
      await this.store.updateStep(stepRun.runId, this.name, (current, now) => ({
        ...(current ?? this.store.newStep(now)),
        outputs: { ...current?.outputs, execution, executionSince: now.getTime(), executions: 1 },
        updatedAt: now,
      }));
    }
    return { kind: 'next', delayMs: WAITS.terraform.everyMs };
  }
}

/** Monta as variáveis da execução e dispara o Job; devolve o nome curto da execução. */
async function startApply(
  config: AppConfig,
  apis: ProvisioningApis,
  { tenant, run, runId }: StepRun,
): Promise<string> {
  const settings = settingsOrFail(config);
  const release = releaseOf(run);
  const hosts = tenantHosts(tenant.slug, settings);
  const env = executorEnv({
    action: 'apply',
    kind: run?.kind ?? 'provision',
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
    subnetCidr: required(tenant.resources?.subnetCidr),
    adminEmail: required(tenant.adminEmail),
    tenantName: nodeTenantName(tenant.company.legalName),
    supportEmail: settings.supportEmail,
    imagesRepository: settings.imagesRepository,
  });
  return apis.runJobs.run(settings.job, env);
}

// --- 5. terraform.wait ------------------------------------------------------------------------------------------

/** As saídas do `envs/tenant` que o executor grava em `outputs.json` (nada de segredo nem dado pessoal). */
const terraformOutputsSchema = z.object({
  name_prefix: z.string().max(64),
  instance_name: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/),
  zone: z.string().regex(/^[a-z]+-[a-z]+[0-9]-[a-z]$/),
  nat_ip: z.ipv4(),
  service_account_email: z.string().max(120),
  service_account_unique_id: z.string().regex(/^[0-9]{1,32}$/),
  secrets: z.record(z.string().max(40), z.string().max(80)),
  backups_bucket: z.string().max(80),
});
const executorResultSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'refused', 'invalid']),
  code: z.string().regex(/^[a-z][a-z_]{0,39}$/),
});

/**
 * Consulta a execução a cada 30 s. Concluída: lê `runs/<slug>/<runId>/<execução>/outputs.json` (o cp-worker só lê
 * `runs/`) e guarda os recursos. Falhou: uma recusa do executor (`result.json`: variável fora do formato, a conta de
 * serviço do nó sendo recriada) para de vez; outra falha dispara o `apply` mais uma vez (o Terraform é idempotente) e,
 * na segunda, para com `terraform_failed`. Passou de 35 min, também conta como falha.
 */
@Injectable()
export class TerraformWaitStep extends BaseStep {
  readonly name = 'terraform.wait';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    private readonly store: ProvisioningStore,
    @InjectPinoLogger(TerraformWaitStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine, config, apis);
  }

  async execute(stepRun: StepRun): Promise<StepOutcome> {
    const { tenant, runId, now } = stepRun;
    const settings = settingsOrFail(this.config);
    const own = stepRun.step.outputs ?? {};
    const applied = (await this.store.getStep(runId, 'terraform.apply'))?.outputs ?? {};
    const execution = typeof own.execution === 'string' ? own.execution : applied.execution;
    const since = typeof own.executionSince === 'number' ? own.executionSince : applied.executionSince;
    const executions = typeof own.executions === 'number' ? own.executions : 1;
    if (typeof execution !== 'string' || !isExecutionName(execution) || typeof since !== 'number') {
      throw new DefinitiveStepError('run_state_invalid');
    }
    let state = await this.apis.runJobs.executionState(settings.job, execution);
    if (state === 'running' && now.getTime() - since >= WAITS.terraform.limitMs) state = 'failed';
    if (state === 'running') return { kind: 'wait', delayMs: WAITS.terraform.everyMs };

    const prefix = `runs/${tenant.slug}/${runId}/${execution}`;
    if (state === 'succeeded') {
      const raw = await this.apis.storage.read(settings.tfstateBucket, `${prefix}/outputs.json`, 64 * 1024);
      if (raw === undefined) throw new DefinitiveStepError('terraform_outputs_missing');
      const outputs = parseOutputs(raw, tenant.slug);
      return {
        kind: 'next',
        outputs: { execution, executions },
        patch: withResources({
          instanceName: outputs.instance_name,
          zone: outputs.zone,
          natIp: outputs.nat_ip,
          serviceAccountUniqueId: outputs.service_account_unique_id,
          backupsBucket: outputs.backups_bucket,
        }),
      };
    }
    const result = await this.apis.storage.read(settings.tfstateBucket, `${prefix}/result.json`, 4 * 1024);
    const code =
      result === undefined ? undefined : executorResultSchema.safeParse(tryJson(result)).data?.code;
    this.logger.warn(
      {
        event: 'terraform_execution_failed',
        tenantId: tenant.id,
        execution,
        executions,
        code: code ?? 'unknown',
      },
      'execução do Terraform falhou',
    );
    if (code !== undefined && EXECUTOR_REFUSALS.has(code))
      throw new DefinitiveStepError(`terraform_refused:${code}`);
    if (executions >= 2) throw new DefinitiveStepError('terraform_failed');
    const retried = await startApply(this.config, this.apis, stepRun);
    return {
      kind: 'wait',
      delayMs: WAITS.terraform.everyMs,
      outputs: { execution: retried, executionSince: now.getTime(), executions: executions + 1 },
    };
  }
}

function tryJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** As saídas conferidas: o prefixo tem de ser o deste cliente, e o cofre do túnel, o dele. */
function parseOutputs(raw: Buffer, slug: string): z.infer<typeof terraformOutputsSchema> {
  const parsed = terraformOutputsSchema.safeParse(tryJson(raw));
  if (
    !parsed.success ||
    parsed.data.name_prefix !== `vx-${slug}` ||
    parsed.data.secrets['cloudflare-tunnel-token'] !== `vx-${slug}-cloudflare-tunnel-token`
  ) {
    throw new DefinitiveStepError('terraform_outputs_invalid');
  }
  return parsed.data;
}

// --- 6. secrets.tunnel_token ------------------------------------------------------------------------------------

/**
 * Lê o token do túnel no Cloudflare e o grava como versão nova de `vx-<slug>-cloudflare-tunnel-token`
 * (`secretVersionAdder`, a única permissão do cp-worker nesse cofre). O token vive só na memória deste passo, na máscara
 * do logger. Sem `versions.list` no cofre, o passo não sabe se já gravou: uma repetição depois de gravar e antes de
 * avançar grava o mesmo token de novo (uma versão a mais, inofensiva; decisão do CP-06).
 */
@Injectable()
export class TunnelTokenStep extends BaseStep {
  readonly name = 'secrets.tunnel_token';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant }: StepRun): Promise<StepOutcome> {
    const settings = settingsOrFail(this.config);
    const tunnelId = required(tenant.resources?.tunnelId);
    const cloudflare = this.apis.cloudflare(settings);
    const token = await cloudflare.tunnelToken(tunnelId);
    try {
      await this.apis.secrets.addVersion(
        settings.nodesProject,
        `vx-${tenant.slug}-cloudflare-tunnel-token`,
        token,
      );
    } finally {
      cloudflare.forgetTunnelToken(token);
    }
    return { kind: 'next', delayMs: WAITS.nodeReady.everyMs };
  }
}

// --- 7. node.wait_ready -----------------------------------------------------------------------------------------

/**
 * Lê os guest attributes da VM a cada 60 s: `verax/ready` igual à versão pedida → pronto (mesmo com um `verax/error`
 * antigo, se o `DELETE` do boot não o apagou, risco do PR-N7); `verax/error=<código>` → `node_error:<código>`. Depois de
 * 40 min só avisa; para com `ready_timeout` em 90 min.
 */
@Injectable()
export class NodeWaitReadyStep extends BaseStep {
  readonly name = 'node.wait_ready';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    @InjectPinoLogger(NodeWaitReadyStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant, step, waitedMs }: StepRun): Promise<StepOutcome> {
    const settings = settingsOrFail(this.config);
    const version = required(tenant.provisioning?.nodeVersion);
    const attributes = await this.apis.compute.guestAttributes(
      settings.nodesProject,
      required(tenant.resources?.zone),
      required(tenant.resources?.instanceName),
    );
    if (attributes.get('ready') === version) return { kind: 'next' };
    const error = attributes.get('error');
    if (error !== undefined) {
      throw new DefinitiveStepError(`node_error:${NODE_ERROR_PATTERN.test(error) ? error : 'unknown'}`);
    }
    if (waitedMs >= WAITS.nodeReady.limitMs) throw new DefinitiveStepError('ready_timeout');
    if (waitedMs >= WAITS.nodeReady.slowMs && step.outputs?.slowWarned !== true) {
      this.logger.warn({ event: 'node_ready_slow', tenantId: tenant.id }, 'nó ainda instalando');
      return { kind: 'wait', delayMs: WAITS.nodeReady.everyMs, outputs: { slowWarned: true } };
    }
    return { kind: 'wait', delayMs: WAITS.nodeReady.everyMs };
  }
}

// --- 8. node.health ---------------------------------------------------------------------------------------------

/** A API pelo túnel (`/health` e `/health/ready`) e o painel no endereço do Firebase com HSTS: 10 tentativas de 30 s. */
@Injectable()
export class NodeHealthStep extends BaseStep {
  readonly name = 'node.health';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant, poll }: StepRun): Promise<StepOutcome> {
    const settings = settingsOrFail(this.config);
    const { apiOrigin } = tenantHosts(tenant.slug, settings);
    const siteOrigin = `https://${required(tenant.resources?.siteId)}.web.app`;
    if (
      (await this.apis.probe.apiHealthy(apiOrigin)) &&
      (await this.apis.probe.panelServesHsts(siteOrigin))
    ) {
      return { kind: 'next' };
    }
    if (poll + 1 >= WAITS.health.tries) throw new DefinitiveStepError('health_failed');
    return { kind: 'wait', delayMs: WAITS.health.everyMs };
  }
}

// --- 9. panel.domain_wait ---------------------------------------------------------------------------------------

/**
 * O domínio do painel a cada 2 min até o certificado e o host ficarem ativos (`CERT_ACTIVE` e `HOST_ACTIVE`), criando
 * no Cloudflare os registros que o Firebase passar a pedir. Em 2 h, avisa (`panel_domain_slow`; a página de status já
 * diz "o endereço está sendo emitido"); em 24 h, para com `domain_timeout`.
 */
@Injectable()
export class PanelDomainWaitStep extends BaseStep {
  readonly name = 'panel.domain_wait';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
    @InjectPinoLogger(PanelDomainWaitStep.name) private readonly logger: PinoLogger,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant, step, waitedMs }: StepRun): Promise<StepOutcome> {
    const settings = settingsOrFail(this.config);
    const siteId = required(tenant.resources?.siteId);
    const { recordIds, status } = await syncPanelDns(this.apis, settings, tenant, siteId, this.logger);
    const patch = (current: Tenant): Tenant =>
      withResources({ dnsRecordIds: unionIds(current.resources?.dnsRecordIds, recordIds) })(current);
    if (status === undefined) {
      // O domínio sumiu do site (apagado à mão): cria de novo e espera.
      const { panelHost } = tenantHosts(tenant.slug, settings);
      await this.apis.firebase.createCustomDomain(
        required(tenant.resources?.firebaseProject),
        siteId,
        panelHost,
      );
    } else if (status.certState === 'CERT_ACTIVE' && status.hostState === 'HOST_ACTIVE') {
      return {
        kind: 'next',
        patch: (current) => withResources({ panelDomainActive: true })(patch(current)),
      };
    }
    if (waitedMs >= WAITS.domain.limitMs) throw new DefinitiveStepError('domain_timeout');
    if (waitedMs >= WAITS.domain.slowMs && step.outputs?.slowWarned !== true) {
      this.logger.warn(
        { event: 'panel_domain_slow', tenantId: tenant.id },
        'certificado do painel demorando',
      );
      return { kind: 'wait', delayMs: WAITS.domain.everyMs, patch, outputs: { slowWarned: true } };
    }
    return { kind: 'wait', delayMs: WAITS.domain.everyMs, patch };
  }
}

// --- 10. access.ready -------------------------------------------------------------------------------------------

/**
 * Confirma que a senha temporária do primeiro admin está no cofre (`vx-<slug>-admin-bootstrap`, versão `latest`
 * habilitada; o estado, sem ler o conteúdo) e leva o cliente a `waiting_customer_connection`: a página de status passa a
 * oferecer "Mostrar acesso" (CP-05). O e-mail "ambiente pronto" é o plano B do CP-05 (48 h, pelo `tick`).
 */
@Injectable()
export class AccessReadyStep extends BaseStep {
  readonly name = 'access.ready';

  constructor(
    engine: ProvisioningEngine,
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(PROVISIONING_APIS) apis: ProvisioningApis,
  ) {
    super(engine, config, apis);
  }

  async execute({ tenant, poll }: StepRun): Promise<StepOutcome> {
    const settings = settingsOrFail(this.config);
    const state = await this.apis.secrets.latestVersionState(
      settings.nodesProject,
      `vx-${tenant.slug}-admin-bootstrap`,
    );
    if (state === 'ENABLED') return { kind: 'finish' };
    if (poll + 1 >= WAITS.bootstrap.tries) throw new DefinitiveStepError('bootstrap_missing');
    return { kind: 'wait', delayMs: WAITS.bootstrap.everyMs };
  }
}

/** Os dez passos, na ordem do plano. */
export const PROVISIONING_STEP_CLASSES = [
  PreflightStep,
  CloudflareTunnelStep,
  FirebaseSiteStep,
  TerraformApplyStep,
  TerraformWaitStep,
  TunnelTokenStep,
  NodeWaitReadyStep,
  NodeHealthStep,
  PanelDomainWaitStep,
  AccessReadyStep,
] as const;

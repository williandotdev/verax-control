import { Inject, Injectable } from '@nestjs/common';
import { TEMPORARY_PASSWORD_HOURS } from '@verax/shared';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { REVEAL_EMAIL_STEP } from '../access/reveal-email.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CLOCK, type Clock } from '../common/clock.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { forgetLiveSecret, registerLiveSecret } from '../common/logger/sanitize.js';
import { newUlid } from '../common/ulid.js';
import { nodeLimitsEnv } from '../pricing/node-limits.js';
import { CloudApiError } from '../provisioning/cloud-http.js';
import { readNodeSmtpPassword } from '../provisioning/node-mail.js';
import { DefinitiveStepError } from '../provisioning/provisioning-engine.js';
import {
  PROVISIONING_APIS,
  type ProvisioningApis,
  type ProvisioningSettings,
  resolveProvisioningSettings,
} from '../provisioning/provisioning-settings.js';
import { ensureTenantTunnel, tenantHosts } from '../provisioning/provisioning-steps.js';
import { FIRST_PROVISIONING_STEP, STEP_QUEUE, type StepQueue } from '../queue/step-queue.js';
import { LockNotHeldError, TenantNotFoundError, TenantStore } from '../tenants/tenant-store.js';
import { hostingOf, type Tenant, type TenantRecord } from '../tenants/tenant.schema.js';
import {
  adminBootstrapSecret,
  type ClaimRequest,
  type ClaimResponse,
  codeClaimable,
  ENROLLMENT_CODE_STATES,
  ENROLLMENT_CODE_TTL_MS,
  enrollmentHash,
  newEnrollmentSecret,
  nodeKeyValid,
  type ReportRequest,
} from './enrollment.js';

export type IssueOutcome =
  | {
      issued: true;
      code: string;
      expiresAt: Date;
      /** Já houve um `claim` antes: o código novo é uma reinstalação, e a chave do nó anterior deixou de valer. */
      reinstall: boolean;
      /** A execução do provisionamento em andamento (a que este código começou, ou a que já corria). */
      run?: { runId: string; step: string };
    }
  | { issued: false; reason: 'not_found' | 'confirmation_mismatch' | 'not_customer_hosted' | 'not_allowed' };

export type ClaimOutcome =
  | {
      ok: true;
      response: ClaimResponse;
      /** O que a resposta leva de segredo e sai da máscara do logger quando ela termina (o token e a chave do nó). */
      transient: string[];
    }
  | { ok: false; reason: 'not_found' | 'release_mismatch' | 'unavailable' };

export type ReportOutcome = { ok: true } | { ok: false; reason: 'unauthorized' | 'unavailable' };

/** A janela da senha temporária do primeiro admin (a mesma da API do nó, `TEMPORARY_PASSWORD_HOURS`). */
const BOOTSTRAP_TTL_MS = TEMPORARY_PASSWORD_HOURS * 60 * 60_000;

/**
 * O registro da VM do cliente, no cp-worker (contrato de 18/11/2026; o cp-public só repassa):
 *
 * - `issueCode`: o responsável gera o código de uso único (7 dias). Fica só o SHA-256 no cliente; gerar outro revoga o
 *   anterior e, depois de um `claim`, também a chave do nó (reinstalar). Na espera da instalação ou com o
 *   provisionamento parado, começa a execução reduzida (`CUSTOMER_PROVISIONING_STEPS`) com o `preflight` na fila;
 * - `claim`: a VM troca o código (uma vez) pelo que o nó precisa: o contrato, os endereços, o token do túnel (lido do
 *   Cloudflare na hora e esquecido depois), a senha da caixa de envio dos nós (a do `secrets.smtp_password`) e a chave
 *   do nó, guardada só como hash. O token e a senha são lidos antes de o código ser gasto: uma falha do Cloudflare
 *   deixa o código valendo;
 * - `report`: com a chave do nó, `ready` grava a senha temporária do primeiro admin como versão nova de
 *   `vx-<slug>-admin-bootstrap` (o cofre do gerenciado, que a revelação e o `access.ready` já leem; criado se faltar) e
 *   marca `readyAt`, que solta o `enrollment.wait`; `error` grava o código, que para a execução com `node_error:<código>`.
 *
 * Nada de segredo vai a log, auditoria ou Firestore: o código, a chave do nó, o token e as senhas entram na máscara do
 * logger antes de qualquer `await`.
 */
@Injectable()
export class EnrollmentService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly audit: AuditService,
    @Inject(PROVISIONING_APIS) private readonly apis: ProvisioningApis,
    @Inject(STEP_QUEUE) private readonly queue: StepQueue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @InjectPinoLogger(EnrollmentService.name) private readonly logger: PinoLogger,
  ) {}

  async issueCode(
    tenantId: string,
    confirmSlug: string,
    actor: string,
    requestId?: string,
  ): Promise<IssueOutcome> {
    const now = this.clock.now();
    const code = newEnrollmentSecret();
    registerLiveSecret(code);
    const codeHash = enrollmentHash(code);
    const expiresAt = new Date(now.getTime() + ENROLLMENT_CODE_TTL_MS);
    const runId = newUlid(now.getTime());
    const previous = await this.tenants.get(tenantId);
    let refusal: 'confirmation_mismatch' | 'not_customer_hosted' | 'not_allowed' | undefined;
    let reinstall = false;
    let result;
    try {
      // A trava de uma execução parada fica com ela até vencer: solta antes, como o `resume`.
      const stale = previous?.state === 'provisioning_failed' ? previous.provisioning?.runId : undefined;
      if (stale !== undefined && previous?.lock?.owner === stale) {
        await this.tenants.releaseLock(tenantId, stale).catch((error: unknown) => {
          if (!(error instanceof LockNotHeldError)) throw error;
        });
      }
      result = await this.tenants.change(tenantId, (current) => {
        refusal =
          current.slug !== confirmSlug
            ? 'confirmation_mismatch'
            : hostingOf(current) !== 'customer'
              ? 'not_customer_hosted'
              : !ENROLLMENT_CODE_STATES.includes(current.state)
                ? 'not_allowed'
                : undefined;
        if (refusal !== undefined) return undefined;
        reinstall = current.enrollment?.claimedAt !== undefined;
        // Tudo do registro anterior sai junto: a chave do nó, o pronto e o erro (uma reinstalação começa do zero).
        const enrollment: NonNullable<Tenant['enrollment']> = {
          codeHash,
          codeExpiresAt: expiresAt,
          codeCreatedAt: now,
          codeCreatedBy: actor,
        };
        const start = current.state === 'waiting_customer_install' || current.state === 'provisioning_failed';
        if (!start) {
          return {
            reason: reinstall ? 'enrollment_reinstall_code_issued' : 'enrollment_code_issued',
            audit: { actor, requestId },
            mutate: (tenant) => ({ ...tenant, enrollment }),
          };
        }
        return {
          to: 'provisioning',
          reason: 'enrollment_provisioning_started',
          audit: { actor, requestId },
          mutate: (tenant) => {
            const { lastError: _cleared, ...provisioning } = tenant.provisioning ?? { attempts: 0 };
            return {
              ...tenant,
              enrollment,
              provisioning: {
                ...provisioning,
                runId,
                step: FIRST_PROVISIONING_STEP,
                attempts: tenant.state === 'provisioning_failed' ? provisioning.attempts + 1 : 0,
              },
            };
          },
        };
      });
    } catch (error) {
      forgetLiveSecret(code);
      if (error instanceof TenantNotFoundError) return { issued: false, reason: 'not_found' };
      throw error;
    }
    if (refusal !== undefined) {
      forgetLiveSecret(code);
      return { issued: false, reason: refusal };
    }
    const tenant = result.tenant;
    // Com a execução ainda no `preflight`, garante a task pela execução gravada (o id é determinístico): é o que completa
    // um pedido anterior que mudou o estado e falhou ao enfileirar, como no `ProvisioningStartService`. Sem isso, o
    // cliente ficaria em `provisioning` sem task nenhuma, e um código novo não mudaria o estado de novo.
    const persistedRun = tenant.provisioning?.runId;
    if (
      tenant.state === 'provisioning' &&
      persistedRun !== undefined &&
      (tenant.provisioning?.step ?? FIRST_PROVISIONING_STEP) === FIRST_PROVISIONING_STEP
    ) {
      try {
        await this.queue.enqueue({
          queue: 'provisioning',
          step: FIRST_PROVISIONING_STEP,
          tenantId,
          runId: persistedRun,
        });
      } catch (error) {
        forgetLiveSecret(code);
        throw error;
      }
      if (result.transitioned) {
        this.logger.info(
          { event: 'enrollment_provisioning_started', tenantId, runId: persistedRun },
          'provisionamento reduzido da VM do cliente iniciado',
        );
      }
    }
    await this.audit.write({
      actor,
      action: 'tenant.enrollment_code_issued',
      tenantId,
      details: { reinstall, expiresAt: expiresAt.toISOString(), runStarted: result.transitioned },
      requestId,
    });
    this.logger.info({ event: 'enrollment_code_issued', tenantId, reinstall }, 'código de instalação gerado');
    const run =
      tenant.state === 'provisioning' && tenant.provisioning?.runId !== undefined
        ? { runId: tenant.provisioning.runId, step: tenant.provisioning.step ?? FIRST_PROVISIONING_STEP }
        : undefined;
    return { issued: true, code, expiresAt, reinstall, ...(run === undefined ? {} : { run }) };
  }

  async claim(request: ClaimRequest, requestId?: string): Promise<ClaimOutcome> {
    registerLiveSecret(request.code);
    try {
      return await this.claimRegistered(request, requestId);
    } finally {
      forgetLiveSecret(request.code);
    }
  }

  private async claimRegistered(request: ClaimRequest, requestId?: string): Promise<ClaimOutcome> {
    const now = this.clock.now();
    const codeHash = enrollmentHash(request.code);
    const tenant = await this.tenants.findByEnrollmentCodeHash(codeHash);
    if (tenant === undefined || !codeClaimable(tenant, codeHash, now))
      return { ok: false, reason: 'not_found' };
    const resolved = resolveProvisioningSettings(this.config);
    if (!resolved.ready) {
      this.logger.warn(
        { event: 'enrollment_unconfigured', tenantId: tenant.id, missing: resolved.missing },
        'registro da VM sem a configuração do provisionamento',
      );
      return { ok: false, reason: 'unavailable' };
    }
    const settings = resolved.settings;
    const expected = tenant.provisioning?.nodeVersion ?? settings.nodeRelease;
    if (request.release !== expected) {
      this.logger.info(
        { event: 'enrollment_release_mismatch', tenantId: tenant.id, release: request.release, expected },
        'a VM baixou outra versão',
      );
      return { ok: false, reason: 'release_mismatch' };
    }
    const adminEmail = tenant.adminEmail;
    if (adminEmail === undefined) return { ok: false, reason: 'unavailable' };

    let external: { mail: ClaimResponse['mail']; tunnelToken: string };
    try {
      external = await this.externalSecrets(tenant, settings);
    } catch (error) {
      this.logger.warn(
        { event: 'enrollment_claim_unavailable', tenantId: tenant.id, reason: reasonOf(error) },
        'o token do túnel ou a senha do e-mail não saíram',
      );
      return { ok: false, reason: 'unavailable' };
    }
    const forget = (): void => this.apis.cloudflare(settings).forgetTunnelToken(external.tunnelToken);
    const nodeKey = newEnrollmentSecret();
    registerLiveSecret(nodeKey);
    const nodeKeyHash = enrollmentHash(nodeKey);
    let claimed: TenantRecord | undefined;
    try {
      const result = await this.tenants.change(tenant.id, (current) => {
        // Relido na transação: dois `claim` ao mesmo tempo, um só leva. A versão também, de novo: a resposta sai do
        // cliente relido aqui, não da primeira leitura.
        if (!codeClaimable(current, codeHash, now) || current.enrollment === undefined) return undefined;
        if ((current.provisioning?.nodeVersion ?? settings.nodeRelease) !== expected) return undefined;
        const enrollment = current.enrollment;
        return {
          reason: 'enrollment_claimed',
          audit: { actor: 'system', requestId },
          mutate: (t) => ({ ...t, enrollment: { ...enrollment, claimedAt: now, nodeKeyHash } }),
        };
      });
      claimed = result.changed ? result.tenant : undefined;
    } catch (error) {
      forget();
      forgetLiveSecret(nodeKey);
      throw error;
    }
    if (claimed === undefined) {
      forget();
      forgetLiveSecret(nodeKey);
      return { ok: false, reason: 'not_found' };
    }
    const host = request.host;
    await this.audit.write({
      actor: 'system',
      action: 'tenant.enrollment_claimed',
      tenantId: tenant.id,
      details: {
        release: request.release,
        host: { cpus: host.cpus, memoryMb: host.memoryMb, diskGb: host.diskGb, os: host.os, arch: host.arch },
      },
      requestId,
    });
    this.logger.info(
      {
        event: 'enrollment_claimed',
        tenantId: tenant.id,
        release: request.release,
        cpus: host.cpus,
        memoryMb: host.memoryMb,
        diskGb: host.diskGb,
        arch: host.arch,
      },
      'VM do cliente registrada',
    );
    // O contrato que vai à VM sai do cliente gravado junto com o `claimedAt` (a mesma transação): um aditivo gravado
    // entre a primeira leitura e o registro já vale aqui, e um aditivo depois dele vê o `claimedAt` e marca os limites
    // como pendentes no nó (`nodeLimitsPending`).
    const { apiOrigin, webOrigin } = tenantHosts(claimed.slug, settings);
    return {
      ok: true,
      transient: [external.tunnelToken, nodeKey],
      response: {
        tenantId: claimed.id,
        slug: claimed.slug,
        apiOrigin,
        webOrigin,
        release: expected,
        size: claimed.configuration.size,
        nodeConf: Object.entries(nodeLimitsEnv(claimed.limits)).map(([name, value]) => ({ name, value })),
        tenantName: claimed.company.legalName,
        adminEmail: claimed.adminEmail ?? adminEmail,
        supportEmail: settings.supportEmail,
        mail: external.mail,
        tunnelToken: external.tunnelToken,
        nodeKey,
      },
    };
  }

  /**
   * O que é da Verax e vai para a VM: a senha da caixa de envio dos nós (lida e conferida como no
   * `secrets.smtp_password`; sem `SMTP_HOST_NODES`, `null`: o nó sobe sem e-mail, como o gerenciado) e o token do túnel
   * `vx-<slug>` (o do passo `cloudflare.tunnel`, ou o mesmo túnel criado aqui se o `claim` chegou antes do passo).
   */
  private async externalSecrets(
    tenant: TenantRecord,
    settings: ProvisioningSettings,
  ): Promise<{ mail: ClaimResponse['mail']; tunnelToken: string }> {
    let mail: ClaimResponse['mail'] = null;
    if (settings.nodeMail !== undefined) {
      const read = await readNodeSmtpPassword(this.apis.secrets, settings.controlPlaneProject);
      if (!read.ok) throw new DefinitiveStepError(read.reason);
      mail = {
        host: settings.nodeMail.host,
        port: settings.nodeMail.port,
        user: settings.nodeMail.user,
        from: settings.mailFromNodes,
        password: read.password,
      };
    }
    const cloudflare = this.apis.cloudflare(settings);
    const tunnelId = tenant.resources?.tunnelId ?? (await ensureTenantTunnel(cloudflare, tenant.slug)).id;
    const tunnelToken = await cloudflare.tunnelToken(tunnelId);
    return { mail, tunnelToken };
  }

  async report(nodeKey: string, report: ReportRequest, requestId?: string): Promise<ReportOutcome> {
    const secrets = report.status === 'ready' ? [nodeKey, report.adminBootstrapPassword] : [nodeKey];
    for (const secret of secrets) registerLiveSecret(secret);
    try {
      return await this.reportRegistered(nodeKey, report, requestId);
    } finally {
      for (const secret of secrets) forgetLiveSecret(secret);
    }
  }

  private async reportRegistered(
    nodeKey: string,
    report: ReportRequest,
    requestId?: string,
  ): Promise<ReportOutcome> {
    const nodeKeyHash = enrollmentHash(nodeKey);
    const tenant = await this.tenants.findByNodeKeyHash(nodeKeyHash);
    if (tenant === undefined || !nodeKeyValid(tenant, nodeKeyHash))
      return { ok: false, reason: 'unauthorized' };
    const now = this.clock.now();
    if (report.status === 'error') {
      const result = await this.tenants.change(tenant.id, (current) => {
        if (!nodeKeyValid(current, nodeKeyHash) || current.enrollment === undefined) return undefined;
        const enrollment = current.enrollment;
        if (enrollment.lastError?.code === report.code) return undefined;
        return {
          reason: 'enrollment_error_reported',
          audit: { actor: 'system', requestId },
          mutate: (t) => ({ ...t, enrollment: { ...enrollment, lastError: { code: report.code, at: now } } }),
        };
      });
      if (result.changed) {
        this.logger.warn(
          { event: 'enrollment_error', tenantId: tenant.id, code: report.code },
          'a VM do cliente avisou uma falha na instalação',
        );
      }
      return { ok: true };
    }
    // Idempotente: um `ready` repetido da mesma instalação não grava outra versão no cofre (só garante o e-mail de uma
    // reinstalação, se a fila falhou no primeiro).
    if (tenant.enrollment?.readyAt !== undefined) {
      if (reissuePending(tenant)) await this.enqueueReissueEmail(tenant.id);
      return { ok: true };
    }
    const resolved = resolveProvisioningSettings(this.config);
    const adminEmail = tenant.adminEmail;
    if (!resolved.ready || adminEmail === undefined) {
      this.logger.warn(
        { event: 'enrollment_report_unavailable', tenantId: tenant.id, reason: 'unconfigured' },
        'o pronto da VM não pôde ser gravado',
      );
      return { ok: false, reason: 'unavailable' };
    }
    const settings = resolved.settings;
    const project = tenant.resources?.nodesProject ?? settings.nodesProject;
    const secretId = adminBootstrapSecret(tenant.slug);
    // O formato do cofre é o do `admin-bootstrap` do gerenciado (`bootstrap-secrets.ts`): o e-mail, a senha e o
    // vencimento, contado de agora (a VM a criou há instantes, com a mesma janela).
    const payload = JSON.stringify({
      email: adminEmail,
      password: report.adminBootstrapPassword,
      expiresAt: new Date(now.getTime() + BOOTSTRAP_TTL_MS).toISOString(),
    });
    try {
      await this.apis.secrets.createSecret(project, secretId, settings.nodesRegion, {
        purpose: 'admin_bootstrap',
      });
      await this.apis.secrets.addVersion(project, secretId, payload);
    } catch (error) {
      this.logger.warn(
        { event: 'enrollment_report_unavailable', tenantId: tenant.id, reason: reasonOf(error) },
        'a senha do primeiro admin não foi gravada no cofre',
      );
      return { ok: false, reason: 'unavailable' };
    }
    const marked = await this.tenants.change(tenant.id, (current) => {
      if (!nodeKeyValid(current, nodeKeyHash) || current.enrollment === undefined) return undefined;
      if (current.enrollment.readyAt !== undefined) return undefined;
      const { lastError: _cleared, ...enrollment } = current.enrollment;
      const ready = { ...enrollment, readyAt: now, readyVersion: report.version };
      if (!REISSUE_STATES.has(current.state)) {
        return {
          reason: 'enrollment_ready',
          audit: { actor: 'system', requestId },
          mutate: (t) => ({ ...t, enrollment: ready }),
        };
      }
      // Uma reinstalação de um ambiente que já estava pronto: a VM nova tem outro banco, com outra senha temporária,
      // e a anterior já pode ter sido revelada. Um ciclo novo de revelação: as marcas da revelação e do e-mail saem,
      // `reissuedAt` abre a janela do e-mail "ambiente pronto" de novo, e o cliente volta a esperar a conexão (o banco
      // novo não tem conta conectada). A revelação continua de uso único (`AccessStore.claimReveal`).
      const access = { reissuedAt: now };
      return {
        ...(current.state === 'waiting_customer_connection'
          ? {}
          : { to: 'waiting_customer_connection' as const }),
        reason: 'enrollment_reinstall_ready',
        audit: { actor: 'system', requestId },
        mutate: (t) => ({ ...t, enrollment: ready, access }),
      };
    });
    const reissued = marked.changed && REISSUE_STATES.has(marked.before.state);
    await this.audit.write({
      actor: 'system',
      action: 'tenant.enrollment_ready',
      tenantId: tenant.id,
      details: { version: report.version, reissued },
      requestId,
    });
    if (reissued) {
      await this.enqueueReissueEmail(tenant.id);
      this.logger.info(
        { event: 'enrollment_reveal_reissued', tenantId: tenant.id },
        'reinstalação pronta: revelação nova da senha do primeiro admin',
      );
    }
    this.logger.info(
      { event: 'enrollment_ready', tenantId: tenant.id, version: report.version },
      'VM do cliente pronta; senha do primeiro admin no cofre',
    );
    return { ok: true };
  }

  /**
   * O e-mail "ambiente pronto" da revelação nova, na fila `lifecycle`. Com um id de execução novo: o do primeiro e-mail
   * (`access_reveal_email-<tenantId>`) pode ainda estar na janela de nomes repetidos do Cloud Tasks. O passo é
   * idempotente pelo `revealEmailSentAt`.
   */
  private async enqueueReissueEmail(tenantId: string): Promise<void> {
    await this.queue.enqueue({
      queue: 'lifecycle',
      step: REVEAL_EMAIL_STEP,
      tenantId,
      runId: newUlid(this.clock.now().getTime()),
    });
  }
}

/**
 * Estados em que um `ready` é de uma reinstalação de um ambiente que já ficou pronto (o provisionamento terminou): o
 * ciclo de revelação recomeça. Durante o provisionamento, o `access.ready` e o motor cuidam do e-mail, como sempre.
 */
const REISSUE_STATES: ReadonlySet<string> = new Set(['waiting_customer_connection', 'active']);

/** Uma revelação nova aberta por reinstalação, sem o e-mail enviado nem a senha vista ainda. */
function reissuePending(tenant: TenantRecord): boolean {
  return (
    tenant.state === 'waiting_customer_connection' &&
    tenant.access?.reissuedAt !== undefined &&
    tenant.access.revealEmailSentAt === undefined &&
    tenant.access.passwordRevealedAt === undefined
  );
}

/** O motivo curto de uma falha, para o log (nunca a mensagem de um terceiro). */
function reasonOf(error: unknown): string {
  if (error instanceof DefinitiveStepError) return error.code;
  if (error instanceof CloudApiError) {
    return `${error.service}_${error.status === 0 ? 'unreachable' : String(error.status)}`;
  }
  return error instanceof Error ? error.name.slice(0, 40) : 'unknown';
}

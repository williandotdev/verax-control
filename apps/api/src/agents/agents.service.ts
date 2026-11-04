import { Inject, Injectable } from '@nestjs/common';
import {
  type Agent,
  type AgentInstall,
  type AgentList,
  type AgentListQuery,
  hasPermission,
  WAZUH_AGENT_ENROLLMENT_PORT,
  WAZUH_AGENT_EVENTS_PORT,
  WAZUH_AGENT_GROUP,
  WAZUH_AGENT_VERSION,
  WAZUH_AGENTS_DEFAULT_MAX,
} from '@verax/shared';
import type { Request } from 'express';
import { requestEntry, withDetails } from '../common/audit/audit-request.js';
import { AuditService } from '../common/audit/audit.service.js';
import type { RequestAuth } from '../common/auth/request-auth.js';
import { APP_CONFIG, type AppConfig } from '../common/config/config.module.js';
import { toPaginated, toPrismaPage } from '../common/http/pagination.js';
import { registerLiveSecret } from '../common/logger/sanitize.js';
import { PrismaService } from '../common/prisma/prisma.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { WazuhAgentsConfig } from './agents-config.js';
import { AGENTS_SYNC_STATE } from './agents-sync.js';

const agentSelect = {
  id: true,
  agentId: true,
  name: true,
  ip: true,
  osName: true,
  osVersion: true,
  osPlatform: true,
  version: true,
  status: true,
  lastKeepAliveAt: true,
  registeredAt: true,
} as const satisfies Prisma.WazuhAgentSelect;

type AgentRow = Prisma.WazuhAgentGetPayload<{ select: typeof agentSelect }>;

function toAgent(row: AgentRow): Agent {
  return {
    ...row,
    lastKeepAliveAt: row.lastKeepAliveAt?.toISOString() ?? null,
    registeredAt: row.registeredAt?.toISOString() ?? null,
  };
}

/**
 * Agentes do Wazuh nas instâncias do cliente (desligados por padrão em cada nó). Só leitura: a lista vem do banco, onde
 * o worker grava o que o host exporta da API do manager (a API nunca fala com o manager); as instruções vêm da
 * configuração do nó.
 *
 * Os agentes valem só para o cliente do nó (WAZUH_AGENTS_TENANT): para qualquer outro, a situação é `disabled`, e a
 * lista, pelo escopo da sessão, sai vazia. A senha de registro sai só na resposta das instruções, só para quem
 * administra (`agents:enroll`), com a liberação pronta e com vaga no limite do nó. Antes de responder, a trilha de
 * auditoria do cliente registra que as instruções foram vistas e se a senha foi mostrada, nunca a senha; se a
 * auditoria falhar, a resposta não sai. O valor da senha também fica registrado como segredo vivo do processo: nenhuma
 * linha de log o mostra, nem por engano.
 */
@Injectable()
export class AgentsService {
  private readonly config: WazuhAgentsConfig | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) config: Pick<AppConfig, 'wazuhAgents'>,
  ) {
    this.config = config.wazuhAgents;
    if (this.config !== null) registerLiveSecret(this.config.enrollmentPassword);
  }

  /** A configuração dos agentes, se o cliente da sessão é o do nó. */
  private configFor(auth: RequestAuth): WazuhAgentsConfig | null {
    return this.config !== null && auth.scopeTenantId === this.config.tenantId ? this.config : null;
  }

  async list(auth: RequestAuth, query: AgentListQuery): Promise<AgentList> {
    const db = this.prisma.scoped();
    const where: Prisma.WazuhAgentWhereInput = query.status ? { status: query.status } : {};
    const [rows, total, syncedAt] = await Promise.all([
      db.wazuhAgent.findMany({
        where,
        select: agentSelect,
        orderBy: [{ name: 'asc' }, { agentId: 'asc' }],
        ...toPrismaPage(query),
      }),
      db.wazuhAgent.count({ where }),
      this.configFor(auth) === null ? Promise.resolve(null) : this.syncedAt(),
    ]);
    return { ...toPaginated(rows.map(toAgent), total, query), syncedAt };
  }

  async install(request: Request): Promise<AgentInstall> {
    const auth = request.auth as RequestAuth;
    // O escopo primeiro: sem cliente escolhido (admin_verax), a recusa é a de sempre (TENANT_REQUIRED).
    const registered = await this.prisma.scoped().wazuhAgent.count();
    const canEnroll = hasPermission(auth.role, 'agents:enroll');
    const fixed = {
      eventsPort: WAZUH_AGENT_EVENTS_PORT,
      enrollmentPort: WAZUH_AGENT_ENROLLMENT_PORT,
      group: WAZUH_AGENT_GROUP,
      version: WAZUH_AGENT_VERSION,
      canEnroll,
      registered,
    } as const;
    const config = this.configFor(auth);
    if (config === null) {
      return {
        status: 'disabled',
        managerAddress: null,
        allowedSources: [],
        caCertificate: null,
        enrollmentPassword: null,
        maxAgents: WAZUH_AGENTS_DEFAULT_MAX,
        ...fixed,
      };
    }
    const status = config.sources.length === 0 ? 'allowlist_pending' : 'ready';
    const reveal = canEnroll && status === 'ready' && registered < config.maxAgents;
    await this.audit.write(this.prisma.db(), {
      ...withDetails(requestEntry(request), { tenantId: config.tenantId }),
      action: 'agents.install_instructions.view',
      resourceType: 'wazuh_agents',
      outcome: 'success',
      statusCode: 200,
      // Só o que aconteceu; a senha nunca entra na trilha.
      after: { status, enrollmentPasswordShown: reveal, registered, maxAgents: config.maxAgents },
    });
    return {
      status,
      managerAddress: config.address,
      allowedSources: config.sources,
      caCertificate: config.caCertificate,
      enrollmentPassword: reveal ? config.enrollmentPassword : null,
      maxAgents: config.maxAgents,
      ...fixed,
    };
  }

  /**
   * Hora da última lista que chegou do manager: a do arquivo que o host exporta, gravada pelo worker. É um dado do nó,
   * não de um cliente (a tabela de estado das sincronizações não tem cliente), lido só para o cliente do nó.
   */
  private async syncedAt(): Promise<string | null> {
    const state = await this.prisma.db().syncState.findUnique({
      where: { name: AGENTS_SYNC_STATE },
      select: { lastProcessedAt: true },
    });
    return state?.lastProcessedAt?.toISOString() ?? null;
  }
}

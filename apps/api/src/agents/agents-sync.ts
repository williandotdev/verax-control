import { open } from 'node:fs/promises';
import {
  AGENT_STATUSES,
  type AgentStatus,
  WAZUH_AGENT_ID_PATTERN,
  WAZUH_AGENTS_MAX_LIMIT,
} from '@verax/shared';
import { z } from 'zod';
import type { PrismaService } from '../common/prisma/prisma.service.js';
import { scopeToTenant } from '../common/prisma/tenant-scope.js';
import type { WazuhAgentsFeed } from './agents-config.js';

/** Nome da sincronização na tabela de estado; a hora da lista (a do arquivo) fica em `lastProcessedAt`. */
export const AGENTS_SYNC_STATE = 'wazuh-agents';
/** O mesmo teto do host (infra/node/bin/wazuh-agents-export.sh): um arquivo maior nem é lido. */
export const AGENTS_FEED_MAX_BYTES = 4 * 1024 * 1024;

/** Texto vindo da instância do cliente: limitado e sem caractere de controle. */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u);

/** Data da API do manager, com fuso (`2026-11-04T12:00:00+00:00`). */
const managerDate = z.iso.datetime({ offset: true });

/**
 * Um agente como a API do manager devolve com os campos que o host pede (`select=` do wazuh-agents-export.sh). Os
 * campos só existem depois da primeira conexão (o sistema, a versão e o último sinal): ausentes, ficam nulos.
 */
const managerAgentSchema = z.object({
  id: z.string().regex(WAZUH_AGENT_ID_PATTERN),
  name: text(128),
  ip: text(64).optional(),
  os: z
    .object({ name: text(128).optional(), version: text(64).optional(), platform: text(32).optional() })
    .optional(),
  version: text(32).optional(),
  status: z.enum(AGENT_STATUSES),
  lastKeepAlive: managerDate.optional(),
  dateAdd: managerDate.optional(),
});

/** A resposta inteira: o envelope da API do Wazuh, com os itens conferidos um a um depois. */
const managerResponseSchema = z.object({
  error: z.literal(0),
  data: z.object({
    affected_items: z.array(z.unknown()).max(WAZUH_AGENTS_MAX_LIMIT),
    total_affected_items: z.number().int().min(0),
  }),
});

export interface ParsedAgent {
  agentId: string;
  name: string;
  ip: string | null;
  osName: string | null;
  osVersion: string | null;
  osPlatform: string | null;
  version: string | null;
  status: AgentStatus;
  lastKeepAliveAt: Date | null;
  registeredAt: Date | null;
}

export class AgentsFeedError extends Error {
  constructor(readonly kind: 'too_large' | 'invalid_json' | 'invalid_feed') {
    super(kind);
    this.name = 'AgentsFeedError';
  }
}

/** O manager marca o próprio último sinal como 9999-12-31: data fora do razoável vira nula. */
function dateOf(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() >= 9999 ? null : date;
}

/**
 * Lê a resposta da API do manager (entrada não confiável: o manager processa log de fora e agora fala com as
 * instâncias do cliente). O envelope fora do formato derruba a lista inteira; um item fora do formato fica de fora e é
 * contado. Id repetido vale uma vez (o primeiro).
 */
export function parseAgentsFeed(raw: string): { agents: ParsedAgent[]; invalid: number } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AgentsFeedError('invalid_json');
  }
  const envelope = managerResponseSchema.safeParse(json);
  if (!envelope.success) throw new AgentsFeedError('invalid_feed');
  const agents = new Map<string, ParsedAgent>();
  let invalid = 0;
  for (const item of envelope.data.data.affected_items) {
    const parsed = managerAgentSchema.safeParse(item);
    if (!parsed.success) {
      invalid += 1;
      continue;
    }
    const agent = parsed.data;
    // O 000 é o próprio manager; o host já o tira da lista.
    if (agent.id === '000' || agents.has(agent.id)) continue;
    agents.set(agent.id, {
      agentId: agent.id,
      name: agent.name,
      ip: agent.ip ?? null,
      osName: agent.os?.name ?? null,
      osVersion: agent.os?.version ?? null,
      osPlatform: agent.os?.platform ?? null,
      version: agent.version ?? null,
      status: agent.status,
      lastKeepAliveAt: dateOf(agent.lastKeepAlive),
      registeredAt: dateOf(agent.dateAdd),
    });
  }
  return { agents: [...agents.values()], invalid };
}

/** O arquivo da lista e a hora dele (a do host, que o escreve), ou null antes da primeira lista. */
export interface AgentsFeedFile {
  content: string;
  modifiedAt: Date;
}

export async function readAgentsFeed(path: string): Promise<AgentsFeedFile | null> {
  let handle;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caminho da configuração do nó, não do request
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (stats.size > AGENTS_FEED_MAX_BYTES) throw new AgentsFeedError('too_large');
    return { content: await handle.readFile('utf8'), modifiedAt: stats.mtime };
  } finally {
    await handle.close();
  }
}

export interface AgentsSyncReport {
  status: 'waiting' | 'synced' | 'tenant_unavailable';
  agents?: number;
  invalid?: number;
  removed?: number;
}

/**
 * Tarefa `wazuh-agents` do worker (WAZUH_AGENTS=true no node.conf): grava no banco, no cliente do nó, a lista dos
 * agentes que o host exporta da API do manager a cada minuto (/run/verax/wazuh-agents/agents.json, só leitura no
 * worker). Agente que saiu do manager sai do banco; agente de outro cliente (o node.conf trocou de cliente) também, pela
 * regra de sempre: na dúvida, não é de ninguém. Cliente inexistente ou desativado: nada é gravado. O relatório só tem
 * contagens.
 */
export class WazuhAgentsSync {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: WazuhAgentsFeed,
    private readonly read: (path: string) => Promise<AgentsFeedFile | null> = readAgentsFeed,
  ) {}

  async runOnce(): Promise<AgentsSyncReport> {
    const runAt = new Date();
    let file: AgentsFeedFile | null;
    let parsed: { agents: ParsedAgent[]; invalid: number };
    try {
      file = await this.read(this.feed.file);
      if (file === null) {
        await this.recordRun(runAt, 'no_file');
        return { status: 'waiting' };
      }
      parsed = parseAgentsFeed(file.content);
    } catch (error) {
      await this.recordRun(runAt, error instanceof AgentsFeedError ? error.kind : 'read_failed');
      throw error;
    }
    const tenantId = this.feed.tenantId;
    const modifiedAt = file.modifiedAt;
    return this.prisma.$transaction(
      async (tx) => {
        const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { status: true } });
        if (tenant?.status !== 'active') {
          await tx.syncState.upsert({
            where: { name: AGENTS_SYNC_STATE },
            create: { name: AGENTS_SYNC_STATE, lastRunAt: runAt, lastError: 'tenant_unavailable' },
            update: { lastRunAt: runAt, lastError: 'tenant_unavailable' },
          });
          return { status: 'tenant_unavailable' } as const;
        }
        // Sistema: agentes gravados para outro cliente saem (o node.conf trocou de cliente).
        const foreign = await tx.wazuhAgent.deleteMany({ where: { tenantId: { not: tenantId } } });
        const scoped = scopeToTenant(tx, tenantId);
        const ids = parsed.agents.map((agent) => agent.agentId);
        const gone = await scoped.wazuhAgent.deleteMany({ where: { agentId: { notIn: ids } } });
        for (const agent of parsed.agents) {
          await scoped.wazuhAgent.upsert({
            where: { agentId: agent.agentId },
            create: { ...agent, tenantId },
            update: agent,
          });
        }
        const state = {
          lastRunAt: runAt,
          lastSuccessAt: runAt,
          lastProcessedAt: modifiedAt,
          lastError: null,
        };
        await tx.syncState.upsert({
          where: { name: AGENTS_SYNC_STATE },
          create: { name: AGENTS_SYNC_STATE, ...state },
          update: state,
        });
        return {
          status: 'synced',
          agents: parsed.agents.length,
          invalid: parsed.invalid,
          removed: gone.count + foreign.count,
        } as const;
      },
      { timeout: 60_000 },
    );
  }

  /** Só a hora e o tipo do problema: a lista anterior continua valendo, com a hora dela. */
  private async recordRun(runAt: Date, lastError: string): Promise<void> {
    await this.prisma.syncState.upsert({
      where: { name: AGENTS_SYNC_STATE },
      create: { name: AGENTS_SYNC_STATE, lastRunAt: runAt, lastError },
      update: { lastRunAt: runAt, lastError },
    });
  }
}

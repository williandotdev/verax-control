import {
  type Agent,
  type AgentInstall,
  agentInstallSchema,
  agentListQuerySchema,
  agentSchema,
  hasPermission,
  WAZUH_AGENT_VERSION,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { API_URL } from '@/lib/env';
import { DEMO_TENANTS } from './fixtures';
import type { MockState } from './handlers';

const url = (path: string): string => `${API_URL}${path}`;
const MINUTE = 60_000;

const problem = (status: number, message: string, code?: string) =>
  HttpResponse.json({ statusCode: status, message, ...(code && { code }) }, { status });

/** O IP de entrada da demonstração e as faixas liberadas: endereços da documentação (RFC 5737), de ninguém. */
export const DEMO_AGENTS_ADDRESS = '203.0.113.10';
export const DEMO_AGENTS_SOURCES = ['198.51.100.0/28', '192.0.2.15/32'];
/** Valor fictício, só de letras e dígitos como o do nó: não registra agente em lugar nenhum. */
export const DEMO_ENROLLMENT = 'Demonstracao0Agentes0Verax0Control';
/** CA fictícia (o texto não é um certificado): a demonstração só mostra onde ela entra no script. */
export const DEMO_AGENTS_CA = [
  '-----BEGIN CERTIFICATE-----',
  'Q2VydGlmaWNhZG8gZmljdGljaW8gZGEgZGVtb25zdHJhY2FvIGRvIFZlcmF4IENvbnRyb2w=',
  '-----END CERTIFICATE-----',
].join('\n');

const [ALFA, BETA] = DEMO_TENANTS;

/**
 * Agentes fictícios da Alfa (servidores Linux e Windows, um desconectado e um recém-registrado); a Beta tem os
 * agentes ligados com a liberação pendente; o resto, desligado.
 */
export function demoAgents(now: Date = new Date()): Agent[] {
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE).toISOString();
  let index = 0;
  const agent = (fields: Partial<Agent> & Pick<Agent, 'name' | 'status'>): Agent => {
    index += 1;
    return agentSchema.parse({
      id: `018f2c1e-0000-7000-8000-0000000e00${String(index).padStart(2, '0')}`,
      agentId: String(index).padStart(3, '0'),
      ip: null,
      osName: null,
      osVersion: null,
      osPlatform: null,
      version: null,
      lastKeepAliveAt: null,
      registeredAt: ago(60 * 24 * 10),
      ...fields,
    });
  };
  const linux = { osName: 'Ubuntu', osVersion: '24.04.1 LTS', osPlatform: 'ubuntu' };
  const version = `Wazuh v${WAZUH_AGENT_VERSION}`;
  return [
    agent({
      name: 'api-producao-01',
      status: 'active',
      ip: '198.51.100.4',
      ...linux,
      version,
      lastKeepAliveAt: ago(0.5),
    }),
    agent({
      name: 'api-producao-02',
      status: 'active',
      ip: '198.51.100.5',
      ...linux,
      version,
      lastKeepAliveAt: ago(0.7),
    }),
    agent({
      name: 'banco-relatorios',
      status: 'disconnected',
      ip: '198.51.100.9',
      osName: 'Amazon Linux',
      osVersion: '2023',
      osPlatform: 'amzn',
      version,
      lastKeepAliveAt: ago(60 * 26),
    }),
    agent({
      name: 'ad-windows-01',
      status: 'active',
      ip: '192.0.2.15',
      osName: 'Microsoft Windows Server 2022 Datacenter',
      osVersion: '10.0.20348.2700',
      osPlatform: 'windows',
      version,
      lastKeepAliveAt: ago(0.4),
    }),
    agent({ name: 'worker-novo', status: 'never_connected', ip: 'any', registeredAt: ago(3) }),
  ];
}

export function createAgentsHandlers(state: MockState, agents: Agent[] = demoAgents()) {
  const scope = () => {
    if (!state.me) return { error: problem(401, 'Não autenticado') } as const;
    if (!state.me.scopeTenantId) {
      return { error: problem(409, 'Selecione um cliente para continuar', 'TENANT_REQUIRED') } as const;
    }
    return { tenantId: state.me.scopeTenantId } as const;
  };
  const listOf = (tenantId: string) => (tenantId === ALFA?.id ? agents : []);

  return [
    http.get(url('/v1/agents/install'), () => {
      const result = scope();
      if ('error' in result) return result.error;
      const me = state.me;
      if (!me) return problem(401, 'Não autenticado');
      const canEnroll = hasPermission(me.role, 'agents:enroll');
      const registered = listOf(result.tenantId).length;
      const base = {
        eventsPort: 1514,
        enrollmentPort: 1515,
        group: 'default',
        version: WAZUH_AGENT_VERSION,
        canEnroll,
        registered,
        maxAgents: 50,
      } as const;
      let body: AgentInstall;
      if (result.tenantId === ALFA?.id) {
        body = {
          ...base,
          status: 'ready',
          managerAddress: DEMO_AGENTS_ADDRESS,
          allowedSources: DEMO_AGENTS_SOURCES,
          caCertificate: DEMO_AGENTS_CA,
          enrollmentPassword: canEnroll ? DEMO_ENROLLMENT : null,
        };
      } else if (result.tenantId === BETA?.id) {
        body = {
          ...base,
          status: 'allowlist_pending',
          managerAddress: DEMO_AGENTS_ADDRESS,
          allowedSources: [],
          caCertificate: DEMO_AGENTS_CA,
          enrollmentPassword: null,
        };
      } else {
        body = {
          ...base,
          status: 'disabled',
          managerAddress: null,
          allowedSources: [],
          caCertificate: null,
          enrollmentPassword: null,
        };
      }
      return HttpResponse.json(agentInstallSchema.parse(body), { headers: { 'Cache-Control': 'no-store' } });
    }),
    http.get(url('/v1/agents'), ({ request }) => {
      const result = scope();
      if ('error' in result) return result.error;
      const parsed = agentListQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!parsed.success) return problem(400, 'Dados inválidos');
      const { page, pageSize, status } = parsed.data;
      const all = listOf(result.tenantId)
        .filter((agent) => status === undefined || agent.status === status)
        .sort((a, b) => a.name.localeCompare(b.name));
      return HttpResponse.json({
        items: all.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: all.length,
        syncedAt: result.tenantId === ALFA?.id ? new Date(Date.now() - 40_000).toISOString() : null,
      });
    }),
  ];
}

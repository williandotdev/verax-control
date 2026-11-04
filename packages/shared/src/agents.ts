import { z } from 'zod';
import { paginatedSchema, withPagination } from './pagination.js';

/**
 * Agentes do Wazuh nas instâncias do cliente (VMs e EC2 dele), que falam com o manager do nó dedicado. Desligado por
 * padrão em cada nó (WAZUH_AGENTS no node.conf e `wazuh_agents` no Terraform do nó). O painel só lê: a lista vem do
 * manager pelo host e pelo worker; as instruções de instalação vêm da configuração do nó.
 */

/**
 * Versão do agente nos comandos de instalação: a mesma do manager do nó (`infra/node/compose.wazuh.yaml`; um teste da
 * API confere). O manager recusa agente mais novo que ele (`allow_higher_versions`, o padrão), então os dois sobem
 * juntos.
 */
export const WAZUH_AGENT_VERSION = '4.14.9';
/** Eventos dos agentes (conexão segura, com a chave de cada agente). */
export const WAZUH_AGENT_EVENTS_PORT = 1514;
/** Registro (enrollment) com a senha do nó. */
export const WAZUH_AGENT_ENROLLMENT_PORT = 1515;
/** Grupo de todo agente do nó: a configuração central (agent.conf) dele é a do nó. */
export const WAZUH_AGENT_GROUP = 'default';
/** Limite de agentes por nó, sem ajuste no node.conf (WAZUH_AGENTS_MAX), e o teto do ajuste. */
export const WAZUH_AGENTS_DEFAULT_MAX = 50;
export const WAZUH_AGENTS_MAX_LIMIT = 500;
/** A lista vem do manager a cada minuto; passado isto sem lista nova, o painel avisa que ela está desatualizada. */
export const WAZUH_AGENTS_STALE_MINUTES = 10;

export const AGENT_PACKAGE_KINDS = ['deb-amd64', 'deb-arm64', 'rpm-x86_64', 'rpm-aarch64', 'msi'] as const;
export type AgentPackageKind = (typeof AGENT_PACKAGE_KINDS)[number];

export interface AgentPackage {
  file: string;
  url: string;
  /** SHA-512 publicado pela Wazuh em packages.wazuh.com/4.x/checksums/wazuh/<versão>/<arquivo>.sha512. */
  sha512: string;
}

const PACKAGES_BASE = 'https://packages.wazuh.com/4.x';

/**
 * Pacotes oficiais do agente na versão do manager, com o SHA-512 que a Wazuh publica para cada um (conferido no
 * download do pacote, no dia da versão). O comando de instalação confere o hash antes de instalar: um pacote trocado
 * no caminho (ou no servidor, depois desta versão) não chega a rodar.
 */
export const WAZUH_AGENT_PACKAGES: Readonly<Record<AgentPackageKind, AgentPackage>> = {
  'deb-amd64': {
    file: `wazuh-agent_${WAZUH_AGENT_VERSION}-1_amd64.deb`,
    url: `${PACKAGES_BASE}/apt/pool/main/w/wazuh-agent/wazuh-agent_${WAZUH_AGENT_VERSION}-1_amd64.deb`,
    sha512:
      'b359cd8b73c024afec048a220b9762606cd02eb74da14eab557b7d424ae530d9406e9071bbefab679bb045e8dcb28c3c19ffac60bda1675f0106e3d814576df4',
  },
  'deb-arm64': {
    file: `wazuh-agent_${WAZUH_AGENT_VERSION}-1_arm64.deb`,
    url: `${PACKAGES_BASE}/apt/pool/main/w/wazuh-agent/wazuh-agent_${WAZUH_AGENT_VERSION}-1_arm64.deb`,
    sha512:
      '414f59163ea80ee3cdbb90099ad93922abee26c98af6645e8887e433d4f005b3c7d30955169ab67a3587c6751a4489412d17a9ac6eed6ea885b56dfdc8234c5a',
  },
  'rpm-x86_64': {
    file: `wazuh-agent-${WAZUH_AGENT_VERSION}-1.x86_64.rpm`,
    url: `${PACKAGES_BASE}/yum/wazuh-agent-${WAZUH_AGENT_VERSION}-1.x86_64.rpm`,
    sha512:
      'd4ad14b5759a73ed8e047f1b834e9943bbedbb8e17914267ac906e89304b583cc4e78e088a8494260b49a644d29e133e65582f5fe2fd8902325a7e213a15acd6',
  },
  'rpm-aarch64': {
    file: `wazuh-agent-${WAZUH_AGENT_VERSION}-1.aarch64.rpm`,
    url: `${PACKAGES_BASE}/yum/wazuh-agent-${WAZUH_AGENT_VERSION}-1.aarch64.rpm`,
    sha512:
      '355d2a5ae190e94c071dc49c61fec8c19ad6d6e80a7244232793273f20bb564226bf6f06e1eb8c37b9031da5fd2af8680dd5b5b6b1f9f4bac5a10434bc9dbef7',
  },
  msi: {
    file: `wazuh-agent-${WAZUH_AGENT_VERSION}-1.msi`,
    url: `${PACKAGES_BASE}/windows/wazuh-agent-${WAZUH_AGENT_VERSION}-1.msi`,
    sha512:
      'ec49c7a39936bcd5cb480807a074dfc513f105d05025704a42a3401772d78bc1bc6a88404f0fe561a5afff3095f158481f1fb884469770cb4bdd899ef142d4f5',
  },
};

/** Estado do agente, como o manager informa: conectado, desconectado, registrado aguardando, nunca conectou. */
export const AGENT_STATUSES = ['active', 'disconnected', 'pending', 'never_connected'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Id do agente no manager do nó: três dígitos ou mais (o 000 é o próprio manager e nunca aparece). */
export const WAZUH_AGENT_ID_PATTERN = /^\d{3,6}$/;

/** Texto vindo da instância (nome, sistema, IP): limitado e sem caractere de controle. */
const instanceText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[^\p{Cc}]+$/u, { error: 'caractere de controle' });

export const agentSchema = z.strictObject({
  id: z.uuid(),
  agentId: z.string().regex(WAZUH_AGENT_ID_PATTERN),
  name: instanceText(128),
  /** IP de onde o agente fala com o manager (`any` antes da primeira conexão: ele chega pelo NAT do cliente). */
  ip: instanceText(64).nullable(),
  osName: instanceText(128).nullable(),
  osVersion: instanceText(64).nullable(),
  osPlatform: instanceText(32).nullable(),
  /** Versão do agente, como ele informa (ex.: `Wazuh v4.14.9`). */
  version: instanceText(32).nullable(),
  status: z.enum(AGENT_STATUSES),
  lastKeepAliveAt: z.iso.datetime().nullable(),
  registeredAt: z.iso.datetime().nullable(),
});
export type Agent = z.infer<typeof agentSchema>;

export const agentListQuerySchema = withPagination({ status: z.enum(AGENT_STATUSES).optional() });
export type AgentListQuery = z.infer<typeof agentListQuerySchema>;

/** A lista paginada e a hora da última lista que chegou do manager (null: nenhuma ainda). */
export const agentListSchema = paginatedSchema(agentSchema).extend({ syncedAt: z.iso.datetime().nullable() });
export type AgentList = z.infer<typeof agentListSchema>;

/**
 * Situação dos agentes neste ambiente, para o painel:
 * - `disabled`: o nó não tem os agentes ligados (ou o cliente da sessão não é o do nó);
 * - `allowlist_pending`: ligado, mas as faixas de saída do cliente ainda não foram liberadas no firewall;
 * - `ready`: pode instalar.
 */
export const AGENT_INSTALL_STATUSES = ['disabled', 'allowlist_pending', 'ready'] as const;
export type AgentInstallStatus = (typeof AGENT_INSTALL_STATUSES)[number];

export const agentInstallSchema = z.strictObject({
  status: z.enum(AGENT_INSTALL_STATUSES),
  /** IP fixo do manager para os agentes (WAZUH_MANAGER e WAZUH_REGISTRATION_SERVER). Null com `disabled`. */
  managerAddress: z.ipv4().nullable(),
  eventsPort: z.literal(WAZUH_AGENT_EVENTS_PORT),
  enrollmentPort: z.literal(WAZUH_AGENT_ENROLLMENT_PORT),
  group: z.literal(WAZUH_AGENT_GROUP),
  version: z.literal(WAZUH_AGENT_VERSION),
  /** Faixas de IP de saída do cliente liberadas no firewall do nó. */
  allowedSources: z.array(z.cidrv4()).max(20),
  /** CA do certificado do registro (PEM): o agente confere o manager antes de mandar a senha. Não é segredo. */
  caCertificate: z.string().max(8192).nullable(),
  /**
   * Senha de registro do nó: só para quem administra (`agents:enroll`), só com `ready` e com vaga no limite. Nunca vai
   * para o log nem para a auditoria (que registra só que as instruções foram vistas).
   */
  enrollmentPassword: z
    .string()
    .regex(/^[A-Za-z0-9]{32,64}$/)
    .nullable(),
  /** Quem pode ver a senha, mesmo quando ela não vem nesta resposta. */
  canEnroll: z.boolean(),
  registered: z.number().int().min(0),
  maxAgents: z.number().int().min(1).max(WAZUH_AGENTS_MAX_LIMIT),
});
export type AgentInstall = z.infer<typeof agentInstallSchema>;

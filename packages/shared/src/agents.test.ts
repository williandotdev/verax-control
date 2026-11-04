import { describe, expect, it } from 'vitest';
import {
  AGENT_PACKAGE_KINDS,
  agentInstallSchema,
  agentSchema,
  WAZUH_AGENT_PACKAGES,
  WAZUH_AGENT_VERSION,
} from './agents.js';

const agent = {
  id: '018f2c1e-0000-7000-8000-0000000e0001',
  agentId: '001',
  name: 'web-01',
  ip: '198.51.100.20',
  osName: 'Ubuntu',
  osVersion: '24.04.1 LTS',
  osPlatform: 'ubuntu',
  version: 'Wazuh v4.14.9',
  status: 'active',
  lastKeepAliveAt: '2026-11-04T12:00:00.000Z',
  registeredAt: '2026-11-01T09:00:00.000Z',
};

describe('agentes do Wazuh', () => {
  it('os pacotes são os oficiais da versão do manager, com o SHA-512 publicado', () => {
    for (const kind of AGENT_PACKAGE_KINDS) {
      const { file, url, sha512 } = WAZUH_AGENT_PACKAGES[kind];
      expect(url.startsWith('https://packages.wazuh.com/4.x/')).toBe(true);
      expect(url.endsWith(`/${file}`)).toBe(true);
      expect(file).toContain(WAZUH_AGENT_VERSION);
      expect(sha512).toMatch(/^[0-9a-f]{128}$/);
    }
  });

  it('o agente vindo da instância: texto sem caractere de controle e id no formato do manager', () => {
    expect(agentSchema.safeParse(agent).success).toBe(true);
    expect(agentSchema.safeParse({ ...agent, name: 'web\u001b[31m' }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent, agentId: '1' }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent, status: 'removed' }).success).toBe(false);
    expect(agentSchema.safeParse({ ...agent, extra: true }).success).toBe(false);
  });

  it('as instruções: a senha de registro só no formato do install.sh, ou nula', () => {
    const install = {
      status: 'ready',
      managerAddress: '203.0.113.10',
      eventsPort: 1514,
      enrollmentPort: 1515,
      group: 'default',
      version: WAZUH_AGENT_VERSION,
      allowedSources: ['198.51.100.0/28'],
      caCertificate: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n',
      enrollmentPassword: null,
      canEnroll: false,
      registered: 3,
      maxAgents: 50,
    };
    expect(agentInstallSchema.safeParse(install).success).toBe(true);
    expect(agentInstallSchema.safeParse({ ...install, enrollmentPassword: 'com espaço' }).success).toBe(
      false,
    );
    expect(agentInstallSchema.safeParse({ ...install, allowedSources: ['0.0.0.0'] }).success).toBe(false);
    expect(agentInstallSchema.safeParse({ ...install, eventsPort: 1515 }).success).toBe(false);
  });
});

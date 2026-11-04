import { readFileSync } from 'node:fs';
import {
  WAZUH_AGENT_ENROLLMENT_PORT,
  WAZUH_AGENT_EVENTS_PORT,
  WAZUH_AGENT_GROUP,
  WAZUH_AGENT_VERSION,
} from '@verax/shared';
import { describe, expect, it } from 'vitest';

const repoFile = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');

/**
 * Contrato dos agentes do Wazuh entre o painel e a API (packages/shared), o pacote do nó (infra/node), o Wazuh
 * (infra/wazuh) e o Terraform do nó (infra/gcp/modules/node). Vivem em lugares diferentes e só funcionam juntos.
 */
describe('agentes do Wazuh: o painel, o nó, o manager e o Terraform dizem o mesmo', () => {
  const composeWazuh = repoFile('infra/node/compose.wazuh.yaml');
  const composeAgents = repoFile('infra/node/compose.wazuh-agents.yaml');
  const startSh = repoFile('infra/node/bin/start.sh');
  const installSh = repoFile('infra/node/bin/install.sh');
  const exportSh = repoFile('infra/node/bin/wazuh-agents-export.sh');
  const ossecAgents = repoFile('infra/wazuh/config/manager/agents/ossec-agents.conf');
  const renderer = repoFile('infra/wazuh/scripts/render-manager-config.py');
  const agentsTf = repoFile('infra/gcp/modules/node/agents.tf');
  const variablesTf = repoFile('infra/gcp/modules/node/variables.tf');

  it('o agente dos comandos de instalação é da versão do manager do nó (o manager recusa agente mais novo)', () => {
    const tags = [...composeWazuh.matchAll(/wazuh\/wazuh-manager:([0-9.]+)@sha256:/g)].map(
      (match) => match[1],
    );
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags)).toEqual(new Set([WAZUH_AGENT_VERSION]));
  });

  it('as portas: as do painel, as que o manager escuta, as que o Docker publica e as que o Terraform abre', () => {
    expect([WAZUH_AGENT_EVENTS_PORT, WAZUH_AGENT_ENROLLMENT_PORT]).toEqual([1514, 1515]);
    expect(ossecAgents).toContain('<port>1514</port>');
    expect(ossecAgents).toContain('<port>1515</port>');
    expect(composeAgents).toContain("- '1514:1514/tcp'");
    expect(composeAgents).toContain("- '1515:1515/tcp'");
    expect(agentsTf).toContain('port_range            = "1514-1515"');
    expect(agentsTf).toContain('ports    = ["1514", "1515"]');
  });

  it('o grupo dos comandos é o da configuração central que o gerador escreve', () => {
    expect(WAZUH_AGENT_GROUP).toBe('default');
    expect(renderer).toContain('SHARED_AGENT_CONF = os.path.join("etc", "shared", "default", "agent.conf")');
  });

  it('a lista dos agentes: o host a escreve onde o worker a lê, com os campos que o worker confere', () => {
    expect(exportSh).toContain('out=/run/verax/wazuh-agents');
    expect(exportSh).toContain('mv -fT "$file" "$out/agents.json"');
    expect(composeAgents).toContain('- /run/verax/wazuh-agents:/run/wazuh-agents:ro');
    expect(startSh).toContain('WAZUH_AGENTS_FILE=/run/wazuh-agents/agents.json');
    const fields = /^FIELDS=(.+)$/m.exec(exportSh)?.[1]?.split(',') ?? [];
    expect(fields.sort()).toEqual(
      [
        'dateAdd',
        'group',
        'id',
        'ip',
        'lastKeepAlive',
        'name',
        'os.name',
        'os.platform',
        'os.version',
        'registerIP',
        'status',
        'version',
      ].sort(),
    );
  });

  it('a senha de registro: o mesmo formato no install.sh, no start.sh, no gerador e na API', () => {
    expect(installSh).toContain('generate wazuh-agents-enrollment 32');
    expect(startSh).toContain('[[ ! $enrollment =~ ^[A-Za-z0-9]{32,64}$ ]]');
    expect(renderer).toContain('ENROLLMENT_FORMAT = re.compile(r"^[A-Za-z0-9]{32,64}$")');
    expect(repoFile('apps/api/src/agents/agents-config.ts')).toContain('.regex(/^[A-Za-z0-9]{32,64}$/');
  });

  it('as faixas do cliente: de /16 a /32 no Terraform, no install.sh, no start.sh e na API', () => {
    expect(variablesTf).toContain('tonumber(split("/", cidr)[1]) >= 16');
    expect(installSh).toContain('cidr="$ipv4/(1[6-9]|2[0-9]|3[0-2])"');
    expect(startSh).toContain('cidr="$ipv4/(1[6-9]|2[0-9]|3[0-2])"');
    expect(repoFile('apps/api/src/agents/agents-config.ts')).toContain("Number(cidr.split('/')[1]) >= 16");
  });
});

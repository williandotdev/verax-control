import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig, loadWorkerConfig } from '../common/config/load-config.js';

const baseEnv = {
  NODE_ENV: 'development',
  WEB_ORIGIN: 'http://localhost:5173',
  API_ORIGIN: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(43),
  CSRF_SECRET: 'y'.repeat(43),
  MAIL_FROM: 'nao-responda@verax.example',
  DATABASE_URL: 'postgresql://verax:segredo@localhost:5432/verax',
};
const TENANT = '018f2c1e-0000-7000-8000-00000000a001';
const CA = readFileSync(new URL('../../test/fixtures/agents-ca.crt', import.meta.url), 'utf8');
// Gerada a cada execução: 32 hexadecimais, letras e dígitos.
const enrollment = randomBytes(16).toString('hex');
const agentsEnv = {
  WAZUH_AGENTS: 'true',
  WAZUH_AGENTS_ADDRESS: '203.0.113.10',
  WAZUH_AGENTS_TENANT: TENANT,
  WAZUH_AGENTS_CA: Buffer.from(CA).toString('base64'),
  WAZUH_AGENTS_ENROLLMENT_PASSWORD: enrollment,
};

function problemsOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('a configuração deveria ter falhado');
}

describe('agentes do Wazuh no ambiente da API', () => {
  it('desligados por padrão, sem nenhuma variável', () => {
    expect(loadConfig(baseEnv).wazuhAgents).toBeNull();
    expect(loadConfig({ ...baseEnv, WAZUH_AGENTS: 'false' }).wazuhAgents).toBeNull();
  });

  it('ligados: endereço, cliente, CA em PEM e senha; faixas e limite com os padrões', () => {
    const config = loadConfig({ ...baseEnv, ...agentsEnv });
    expect(config.wazuhAgents).toMatchObject({
      address: '203.0.113.10',
      tenantId: TENANT,
      sources: [],
      maxAgents: 50,
      enrollmentPassword: enrollment,
    });
    expect(config.wazuhAgents?.caCertificate.startsWith('-----BEGIN CERTIFICATE-----\n')).toBe(true);
    // O texto das variáveis não fica na configuração: só o objeto pronto.
    expect(Object.keys(config).filter((key) => key.startsWith('WAZUH_AGENTS'))).toEqual([]);
    const withSources = loadConfig({
      ...baseEnv,
      ...agentsEnv,
      WAZUH_AGENTS_SOURCES: '198.51.100.0/28, 192.0.2.15/32',
      WAZUH_AGENTS_MAX: '120',
    });
    expect(withSources.wazuhAgents).toMatchObject({
      sources: ['198.51.100.0/28', '192.0.2.15/32'],
      maxAgents: 120,
    });
  });

  it('ligados sem o essencial: cada falta pelo nome', () => {
    expect(problemsOf(() => loadConfig({ ...baseEnv, WAZUH_AGENTS: 'true' }))).toEqual([
      'WAZUH_AGENTS_ADDRESS: obrigatória e não definida',
      'WAZUH_AGENTS_TENANT: obrigatória e não definida',
      'WAZUH_AGENTS_CA: obrigatória e não definida',
      'WAZUH_AGENTS_ENROLLMENT_PASSWORD: obrigatória e não definida',
    ]);
  });

  it('desligados, nenhuma outra variável dos agentes é aceita', () => {
    const { WAZUH_AGENTS: _on, ...rest } = agentsEnv;
    expect(problemsOf(() => loadConfig({ ...baseEnv, ...rest }))).toEqual([
      'WAZUH_AGENTS_ADDRESS: só com WAZUH_AGENTS=true',
      'WAZUH_AGENTS_TENANT: só com WAZUH_AGENTS=true',
      'WAZUH_AGENTS_CA: só com WAZUH_AGENTS=true',
      'WAZUH_AGENTS_ENROLLMENT_PASSWORD: só com WAZUH_AGENTS=true',
    ]);
  });

  it('valores fora do formato são recusados sem mostrar o valor', () => {
    const shortPassword = randomBytes(8).toString('hex');
    const problems = problemsOf(() =>
      loadConfig({
        ...baseEnv,
        ...agentsEnv,
        WAZUH_AGENTS_ADDRESS: '203.0.113.10/32',
        WAZUH_AGENTS_TENANT: 'cliente-a',
        WAZUH_AGENTS_SOURCES: '0.0.0.0/0',
        WAZUH_AGENTS_MAX: '501',
        WAZUH_AGENTS_CA: Buffer.from('não é certificado').toString('base64'),
        WAZUH_AGENTS_ENROLLMENT_PASSWORD: shortPassword,
      }),
    );
    expect(problems.map((problem) => problem.split(':')[0])).toEqual([
      'WAZUH_AGENTS_ADDRESS',
      'WAZUH_AGENTS_TENANT',
      'WAZUH_AGENTS_SOURCES.0',
      'WAZUH_AGENTS_MAX',
      'WAZUH_AGENTS_ENROLLMENT_PASSWORD',
    ]);
    expect(problems.join(' ')).not.toContain(shortPassword);
    const caProblems = problemsOf(() =>
      loadConfig({ ...baseEnv, ...agentsEnv, WAZUH_AGENTS_CA: Buffer.from('x').toString('base64') }),
    );
    expect(caProblems).toEqual([
      'WAZUH_AGENTS_CA: deve ser o certificado da CA do registro, em PEM, codificado em base64',
    ]);
  });
});

describe('agentes do Wazuh no ambiente do worker', () => {
  const workerEnv = { NODE_ENV: 'development', DATABASE_URL: baseEnv.DATABASE_URL };

  it('sem as variáveis, a tarefa dos agentes não existe; com as duas, o arquivo e o cliente', () => {
    expect(loadWorkerConfig(workerEnv).wazuhAgents).toBeNull();
    expect(
      loadWorkerConfig({
        ...workerEnv,
        WAZUH_AGENTS_FILE: '/run/wazuh-agents/agents.json',
        WAZUH_AGENTS_TENANT: TENANT,
      }).wazuhAgents,
    ).toEqual({ file: '/run/wazuh-agents/agents.json', tenantId: TENANT });
  });

  it('as duas andam juntas, e o caminho é absoluto', () => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...workerEnv, WAZUH_AGENTS_FILE: '/run/wazuh-agents/agents.json' }),
      ),
    ).toEqual(['WAZUH_AGENTS_TENANT: obrigatória e não definida']);
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...workerEnv, WAZUH_AGENTS_FILE: 'agents.json', WAZUH_AGENTS_TENANT: TENANT }),
      ),
    ).toEqual(['WAZUH_AGENTS_FILE: deve ser o caminho absoluto do arquivo da lista']);
  });
});

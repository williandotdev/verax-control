import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nodePlan } from './env.schema.js';
import { ConfigValidationError, loadConfig, loadWorkerConfig } from './load-config.js';

const validEnv = {
  NODE_ENV: 'development',
  WEB_ORIGIN: 'http://localhost:5173',
  API_ORIGIN: 'http://localhost:3000',
  BETTER_AUTH_SECRET: 'x'.repeat(43),
  CSRF_SECRET: 'y'.repeat(43),
  MAIL_FROM: 'nao-responda@verax.example',
  DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
};

const validProductionEnv = {
  ...validEnv,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://painel.example.com',
  API_ORIGIN: 'https://api.example.com',
  DATABASE_URL: 'postgresql://verax:secret@db.internal:5432/verax?sslmode=verify-full',
  MAIL_TRANSPORT: 'ses',
  TRUST_PROXY_HOPS: '1',
  PLAN: 'essencial',
};

const enterpriseOverrides = {
  PLAN_MAX_CLOUD_ACCOUNTS: '40',
  PLAN_MAX_USERS: '30',
  PLAN_MONTHLY_GIB: '250',
  PLAN_HISTORY_DAYS: '730',
};

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('loadConfig deveria ter falhado');
}

describe('loadConfig', () => {
  it('aceita um ambiente válido e aplica os padrões', () => {
    const config = loadConfig(validEnv);
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('recusa segredo de autenticação curto sem mostrar o valor', () => {
    const shortValue = 'curto'.repeat(3);
    const problems = problemsOf({ ...validEnv, BETTER_AUTH_SECRET: shortValue });
    expect(problems).toContain('BETTER_AUTH_SECRET: deve ter pelo menos 32 caracteres');
    expect(problems.join(' ')).not.toContain(shortValue);
  });

  it('valida a região AWS', () => {
    expect(loadConfig(validEnv).AWS_REGION).toBe('sa-east-1');
    expect(loadConfig({ ...validEnv, AWS_REGION: 'us-east-1' }).AWS_REGION).toBe('us-east-1');
    expect(problemsOf({ ...validEnv, AWS_REGION: 'sa-east' })).toContain('AWS_REGION: região AWS inválida');
  });

  it('não aceita desligar a checagem de senha vazada em produção', () => {
    expect(problemsOf({ ...validProductionEnv, PASSWORD_BREACH_CHECK_ENABLED: 'false' })).toContain(
      'PASSWORD_BREACH_CHECK_ENABLED: deve ficar ligado em produção',
    );
  });

  it('SMTP exige servidor, usuário e senha; a porta padrão é a 465 (TLS desde o início)', () => {
    const smtp = { ...validProductionEnv, MAIL_TRANSPORT: 'smtp' };
    expect(problemsOf(smtp)).toEqual(
      expect.arrayContaining([
        'SMTP_HOST: obrigatória e não definida',
        'SMTP_USER: obrigatória e não definida',
        'SMTP_PASSWORD: obrigatória e não definida',
      ]),
    );
    const config = loadConfig({
      ...smtp,
      SMTP_HOST: 'smtp.exemplo.com',
      SMTP_USER: 'nao-responda@verax.example',
      SMTP_PASSWORD: 'senha-de-aplicativo',
    });
    expect(config).toMatchObject({ MAIL_TRANSPORT: 'smtp', SMTP_PORT: 465 });
    expect(problemsOf({ ...smtp, SMTP_HOST: 'smtp.exemplo.com/../x' })).toContain(
      'SMTP_HOST: nome de servidor inválido',
    );
  });

  it('exige SES ou SMTP em produção', () => {
    expect(problemsOf({ ...validProductionEnv, MAIL_TRANSPORT: 'dev-mailbox' })).toContain(
      'MAIL_TRANSPORT: deve ser ses, smtp ou none em produção',
    );
    expect(loadConfig({ ...validProductionEnv, MAIL_TRANSPORT: 'ses' }).MAIL_TRANSPORT).toBe('ses');
    // Nó sem e-mail: contas nascem com senha temporária, e quem esquece a senha pede outra ao administrador.
    expect(loadConfig({ ...validProductionEnv, MAIL_TRANSPORT: 'none' }).MAIL_TRANSPORT).toBe('none');
  });

  it('não aceita desligar o limite de tentativas em produção', () => {
    expect(problemsOf({ ...validProductionEnv, AUTH_RATE_LIMIT_ENABLED: 'false' })).toContain(
      'AUTH_RATE_LIMIT_ENABLED: deve ficar ligado em produção',
    );
    expect(loadConfig(validEnv).AUTH_RATE_LIMIT_ENABLED).toBe(true);
  });

  it('exige o ALB contado em TRUST_PROXY_HOPS em produção', () => {
    expect(problemsOf({ ...validProductionEnv, TRUST_PROXY_HOPS: '0' })).toContain(
      'TRUST_PROXY_HOPS: deve contar o ALB (1) em produção',
    );
    expect(loadConfig(validProductionEnv).TRUST_PROXY_HOPS).toBe(1);
  });

  it('exige https na origem da API em produção', () => {
    expect(problemsOf({ ...validProductionEnv, API_ORIGIN: 'http://api.example.com' })).toContain(
      'API_ORIGIN: deve usar https em produção',
    );
  });

  it('tópico do sink de projeto GCP de cliente: opcional, só no formato do Terraform do nó', () => {
    expect(loadConfig(validEnv).GCP_SINK_TOPIC_PREFIX).toBeUndefined();
    const prefix = 'projects/projeto-dos-nos/topics/verax-c1-security-';
    expect(loadConfig({ ...validProductionEnv, GCP_SINK_TOPIC_PREFIX: prefix }).GCP_SINK_TOPIC_PREFIX).toBe(
      prefix,
    );
    for (const value of [
      'projects/projeto-dos-nos/topics/verax-c1-security-cliente',
      'projects/projeto-dos-nos/subscriptions/verax-c1-security-',
      'projects/Projeto/topics/verax-c1-security-',
      "projects/projeto-dos-nos/topics/verax-c1-security-' --log-filter='",
    ]) {
      expect(problemsOf({ ...validEnv, GCP_SINK_TOPIC_PREFIX: value })).toEqual([
        'GCP_SINK_TOPIC_PREFIX: deve ser projects/<projeto>/topics/<prefixo>-security-',
      ]);
    }
  });

  it('IPs de saída do nó: opcional, IPv4 com /32 separados por vírgula', () => {
    expect(loadConfig(validEnv).NODE_EGRESS_IPS).toBeUndefined();
    expect(
      loadConfig({ ...validProductionEnv, NODE_EGRESS_IPS: '203.0.113.10/32, 198.51.100.7/32' })
        .NODE_EGRESS_IPS,
    ).toEqual(['203.0.113.10/32', '198.51.100.7/32']);
    for (const value of [
      '203.0.113.10',
      '203.0.113.10/24',
      '203.0.113.256/32',
      '203.0.113.010/32',
      'a.b.c.d/32',
    ]) {
      expect(problemsOf({ ...validEnv, NODE_EGRESS_IPS: value })).toEqual([
        'NODE_EGRESS_IPS.0: use IPv4 com /32, separados por vírgula',
      ]);
    }
  });

  it('papel de leitura sem chave da AWS: o ID da conta de serviço do nó e o audience, opcionais e conferidos', () => {
    const plain = loadConfig(validEnv);
    expect(plain.NODE_SA_UNIQUE_ID).toBeUndefined();
    expect(plain.AWS_WEB_IDENTITY_AUDIENCE).toBeUndefined();
    const configured = loadConfig({
      ...validProductionEnv,
      NODE_SA_UNIQUE_ID: '123456789012345678901',
      AWS_WEB_IDENTITY_AUDIENCE: 'https://control.veraxsistemas.com.br/aws-reader',
    });
    expect(configured.NODE_SA_UNIQUE_ID).toBe('123456789012345678901');
    expect(configured.AWS_WEB_IDENTITY_AUDIENCE).toBe('https://control.veraxsistemas.com.br/aws-reader');
    for (const value of ['12345678901234567890', '1234567890123456789012', 'conta-do-no@exemplo.iam']) {
      expect(problemsOf({ ...validEnv, NODE_SA_UNIQUE_ID: value })).toEqual([
        'NODE_SA_UNIQUE_ID: deve ser o ID único da conta de serviço do nó (21 dígitos)',
      ]);
    }
    for (const value of [
      'http://control.veraxsistemas.com.br/aws-reader',
      'https://control.veraxsistemas.com.br/*',
      'https://control.veraxsistemas.com.br:8443/aws-reader',
    ]) {
      expect(problemsOf({ ...validEnv, AWS_WEB_IDENTITY_AUDIENCE: value })).toEqual([
        'AWS_WEB_IDENTITY_AUDIENCE: deve ser https://<host>[/<caminho>], só com minúsculas no host e sem porta, consulta ou curinga',
      ]);
    }
  });

  it('converte PORT para número', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).PORT).toBe(8080);
  });

  it('lista todas as variáveis obrigatórias que faltam', () => {
    const problems = problemsOf({});
    expect(problems).toEqual(
      expect.arrayContaining([
        'NODE_ENV: obrigatória e não definida',
        'WEB_ORIGIN: obrigatória e não definida',
        'DATABASE_URL: obrigatória e não definida',
        'API_ORIGIN: obrigatória e não definida',
        'BETTER_AUTH_SECRET: obrigatória e não definida',
      ]),
    );
  });

  it('rejeita PORT fora do intervalo', () => {
    expect(problemsOf({ ...validEnv, PORT: '70000' }).some((p) => p.startsWith('PORT:'))).toBe(true);
  });

  it('rejeita NODE_ENV desconhecido', () => {
    expect(problemsOf({ ...validEnv, NODE_ENV: 'staging' }).some((p) => p.startsWith('NODE_ENV:'))).toBe(
      true,
    );
  });

  it('exige https no WEB_ORIGIN em produção', () => {
    expect(problemsOf({ ...validEnv, NODE_ENV: 'production' })).toContain(
      'WEB_ORIGIN: deve usar https em produção',
    );
    expect(() => loadConfig(validProductionEnv)).not.toThrow();
  });

  it('exige TLS com certificado conferido até o banco em produção', () => {
    for (const sslmode of ['', '?sslmode=disable', '?sslmode=require', '?sslmode=no-verify']) {
      expect(
        problemsOf({
          ...validProductionEnv,
          DATABASE_URL: `postgresql://verax:x@db.internal:5432/verax${sslmode}`,
        }),
      ).toContain('DATABASE_URL: deve usar sslmode=verify-full em produção (TLS com certificado conferido)');
    }
  });

  describe('Cloudflare Turnstile', () => {
    const keys = { TURNSTILE_SITE_KEY: '1x00000000000000000000AA', TURNSTILE_SECRET_KEY: 'segredo-de-teste' };

    it('é opcional: sem as chaves, desligado, com o siteverify oficial como padrão', () => {
      const config = loadConfig(validEnv);
      expect(config.TURNSTILE_SECRET_KEY).toBeUndefined();
      expect(config.TURNSTILE_SITE_KEY).toBeUndefined();
      expect(config.TURNSTILE_SITEVERIFY_URL).toBe(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      );
      expect(loadConfig({ ...validProductionEnv, ...keys }).TURNSTILE_SITE_KEY).toBe(keys.TURNSTILE_SITE_KEY);
    });

    it('as duas chaves andam juntas: uma sem a outra é recusada, sem mostrar o valor', () => {
      expect(problemsOf({ ...validEnv, TURNSTILE_SECRET_KEY: keys.TURNSTILE_SECRET_KEY })).toEqual([
        'TURNSTILE_SECRET_KEY: exige TURNSTILE_SITE_KEY (as duas chaves andam juntas, ou nenhuma)',
      ]);
      const problems = problemsOf({ ...validEnv, TURNSTILE_SITE_KEY: keys.TURNSTILE_SITE_KEY });
      expect(problems).toEqual([
        'TURNSTILE_SITE_KEY: exige TURNSTILE_SECRET_KEY (as duas chaves andam juntas, ou nenhuma)',
      ]);
      expect(problems.join(' ')).not.toContain(keys.TURNSTILE_SITE_KEY);
    });

    it('confere o formato da chave do site (as reais e as de teste da Cloudflare)', () => {
      for (const siteKey of [
        '0x4AAAAAAADnPIDROrmt1Wwj',
        '2x00000000000000000000AB',
        '3x00000000000000000000FF',
      ]) {
        expect(loadConfig({ ...validEnv, ...keys, TURNSTILE_SITE_KEY: siteKey }).TURNSTILE_SITE_KEY).toBe(
          siteKey,
        );
      }
      for (const siteKey of ['chave', '0x curta', '0x' + 'a'.repeat(41), 'AAAAAAAADnPIDROrmt1Wwj']) {
        expect(problemsOf({ ...validEnv, ...keys, TURNSTILE_SITE_KEY: siteKey })).toContain(
          'TURNSTILE_SITE_KEY: chave do site do Turnstile em formato inválido',
        );
      }
    });

    it('a URL do siteverify só muda fora de produção (servidor falso dos testes)', () => {
      const fake = 'http://127.0.0.1:4545/siteverify';
      expect(
        loadConfig({ ...validEnv, ...keys, TURNSTILE_SITEVERIFY_URL: fake }).TURNSTILE_SITEVERIFY_URL,
      ).toBe(fake);
      expect(problemsOf({ ...validProductionEnv, ...keys, TURNSTILE_SITEVERIFY_URL: fake })).toEqual([
        'TURNSTILE_SITEVERIFY_URL: só muda fora de produção (servidor falso dos testes)',
      ]);
    });
  });

  describe('plano do nó (fase 2)', () => {
    it('em produção, PLAN é obrigatório', () => {
      const { PLAN: _plan, ...withoutPlan } = validProductionEnv;
      expect(problemsOf(withoutPlan)).toEqual(['PLAN: obrigatória e não definida']);
      expect(loadConfig(validProductionEnv).PLAN).toBe('essencial');
    });

    it('fora de produção, sem PLAN, o plano é o interno (sem limite)', () => {
      const config = loadConfig(validEnv);
      expect(config.PLAN).toBe('interno');
      expect(nodePlan(config).limits).toEqual({
        maxCloudAccounts: null,
        maxUsers: null,
        monthlyGib: null,
        historyDays: null,
      });
    });

    it('enterprise sem os quatro ajustes é recusado', () => {
      expect(problemsOf({ ...validProductionEnv, PLAN: 'enterprise' })).toEqual([
        'PLAN_MAX_CLOUD_ACCOUNTS: obrigatória e não definida',
        'PLAN_MAX_USERS: obrigatória e não definida',
        'PLAN_MONTHLY_GIB: obrigatória e não definida',
        'PLAN_HISTORY_DAYS: obrigatória e não definida',
      ]);
      const { PLAN_HISTORY_DAYS: _days, ...threeOfFour } = enterpriseOverrides;
      expect(problemsOf({ ...validProductionEnv, PLAN: 'enterprise', ...threeOfFour })).toEqual([
        'PLAN_HISTORY_DAYS: obrigatória e não definida',
      ]);
    });

    it('enterprise com os quatro ajustes: os limites vêm do ambiente', () => {
      const config = loadConfig({ ...validProductionEnv, PLAN: 'enterprise', ...enterpriseOverrides });
      expect(nodePlan(config)).toEqual({
        id: 'enterprise',
        label: 'Enterprise',
        limits: { maxCloudAccounts: 40, maxUsers: 30, monthlyGib: 250, historyDays: 730 },
      });
    });

    it('ajuste no Essencial troca só o limite informado (extra de contas)', () => {
      const config = loadConfig({ ...validProductionEnv, PLAN_MAX_CLOUD_ACCOUNTS: '4' });
      expect(nodePlan(config).limits).toEqual({
        maxCloudAccounts: 4,
        maxUsers: 5,
        monthlyGib: 15,
        historyDays: 90,
      });
    });

    it('plano desconhecido, ajuste inválido e ajuste no interno são recusados', () => {
      expect(problemsOf({ ...validProductionEnv, PLAN: 'gratis' })).toEqual([
        'PLAN: plano desconhecido: use essencial, profissional, enterprise ou interno',
      ]);
      expect(problemsOf({ ...validProductionEnv, PLAN_HISTORY_DAYS: '7' })).toEqual([
        'PLAN_HISTORY_DAYS: deve ser um número inteiro de 30 a 3650',
      ]);
      for (const value of ['', 'dez', '2.5', '-1']) {
        expect(problemsOf({ ...validProductionEnv, PLAN_MAX_USERS: value })).toEqual([
          'PLAN_MAX_USERS: deve ser um número inteiro de 1 a 1000',
        ]);
      }
      expect(problemsOf({ ...validEnv, PLAN: 'interno', PLAN_MAX_USERS: '10' })).toEqual([
        'PLAN_MAX_USERS: não se aplica ao plano interno, que não tem limite',
      ]);
    });
  });

  describe('modo do nó (CE-02)', () => {
    it('sem NODE_MODE, o nó é dedicado, e o plano continua vindo do ambiente', () => {
      expect(loadConfig(validProductionEnv).NODE_MODE).toBe('dedicated');
    });

    /** A célula exige também o domínio e o subdomínio da equipe, e os endereços da equipe (CE-01). */
    const cellEnv = {
      NODE_MODE: 'cell',
      CELL_DOMAIN: 'exemplo.com.br',
      CELL_STAFF_SLUG: 'verax',
      WEB_ORIGIN: 'https://verax.control.exemplo.com.br',
      API_ORIGIN: 'https://api-verax.exemplo.com.br',
    };

    it('na célula, o PLAN não é obrigatório em produção e o plano do ambiente não vale', () => {
      const { PLAN: _plan, ...withoutPlan } = validProductionEnv;
      expect(loadConfig({ ...withoutPlan, ...cellEnv }).NODE_MODE).toBe('cell');
    });

    it('na célula, o PLAN e os ajustes são recusados: o plano é de cada cliente', () => {
      expect(problemsOf({ ...validProductionEnv, ...cellEnv, PLAN_MAX_USERS: '10' })).toEqual([
        'PLAN: não se aplica com NODE_MODE=cell: o plano é de cada cliente, gravado pelo plano de controle',
        'PLAN_MAX_USERS: não se aplica com NODE_MODE=cell: o plano é de cada cliente, gravado pelo plano de controle',
      ]);
    });

    it('modo desconhecido e a Plataforma no node.conf são recusados', () => {
      expect(problemsOf({ ...validProductionEnv, NODE_MODE: 'shared' })).toEqual([
        'NODE_MODE: use dedicated ou cell',
      ]);
      expect(problemsOf({ ...validProductionEnv, PLAN: 'plataforma' })).toEqual([
        'PLAN: plano desconhecido: use essencial, profissional, enterprise ou interno',
      ]);
    });
  });

  it('nunca inclui o valor recebido na mensagem de erro', () => {
    const secret = 'S3nh4-Sup3r-S3cr3t4';
    let message = '';
    try {
      loadConfig({ ...validEnv, DATABASE_URL: `mysql://root:${secret}@db:3306/x`, WEB_ORIGIN: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('WEB_ORIGIN');
    expect(message).not.toContain(secret);
  });
});

describe('configuração do worker do sync (T5.3)', () => {
  const workerEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
  };

  it('sobe só com banco: sem segredos de autenticação nem e-mail', () => {
    expect(loadWorkerConfig(workerEnv)).toMatchObject({ LOG_LEVEL: 'info', SYNC_INTERVAL_SECONDS: 60 });
  });

  it('em produção exige TLS conferido até o banco, sem imprimir a URL', () => {
    const secret = 'senha-que-nao-pode-vazar';
    try {
      loadWorkerConfig({
        NODE_ENV: 'production',
        PLAN: 'profissional',
        DATABASE_URL: `postgresql://verax:${secret}@db.internal:5432/verax`,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).problems).toEqual([
        'DATABASE_URL: deve usar sslmode=verify-full em produção (TLS com certificado conferido)',
      ]);
      expect((error as Error).message).not.toContain(secret);
    }
  });

  it('fontes do sync: Wazuh por padrão; a GCP sozinha no nó da Verax; repetida conta uma vez', () => {
    expect(loadWorkerConfig(workerEnv).SYNC_SOURCES).toEqual(['wazuh']);
    expect(loadWorkerConfig({ ...workerEnv, SYNC_SOURCES: 'gcp' }).SYNC_SOURCES).toEqual(['gcp']);
    expect(loadWorkerConfig({ ...workerEnv, SYNC_SOURCES: 'gcp, wazuh,gcp' }).SYNC_SOURCES).toEqual([
      'gcp',
      'wazuh',
    ]);
    expect(() => loadWorkerConfig({ ...workerEnv, SYNC_SOURCES: 'gcp,splunk' })).toThrow(
      ConfigValidationError,
    );
  });

  it('plano: a mesma regra da API (obrigatório em produção, enterprise com os quatro ajustes)', () => {
    const production = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://verax:x@db.internal:5432/verax?sslmode=verify-full',
    };
    expect(() => loadWorkerConfig(production)).toThrow('PLAN: obrigatória e não definida');
    expect(loadWorkerConfig({ ...production, PLAN: 'profissional' }).PLAN).toBe('profissional');
    expect(loadWorkerConfig(workerEnv).PLAN).toBe('interno');
    expect(() => loadWorkerConfig({ ...production, PLAN: 'enterprise' })).toThrow(
      'PLAN_MONTHLY_GIB: obrigatória e não definida',
    );
    expect(
      nodePlan(loadWorkerConfig({ ...production, PLAN: 'enterprise', ...enterpriseOverrides })).limits,
    ).toEqual({ maxCloudAccounts: 40, maxUsers: 30, monthlyGib: 250, historyDays: 730 });
    // Na célula (CE-02), o mesmo: sem PLAN em produção, e o PLAN recusado.
    expect(loadWorkerConfig({ ...production, NODE_MODE: 'cell' }).NODE_MODE).toBe('cell');
    expect(() => loadWorkerConfig({ ...production, NODE_MODE: 'cell', PLAN: 'essencial' })).toThrow(
      'PLAN: não se aplica com NODE_MODE=cell',
    );
  });

  describe('e-mail dos avisos (PR-16)', () => {
    const production = {
      NODE_ENV: 'production',
      PLAN: 'essencial',
      DATABASE_URL: 'postgresql://verax:x@db.internal:5432/verax?sslmode=verify-full',
    };
    const smtp = {
      MAIL_TRANSPORT: 'smtp',
      MAIL_FROM: 'nao-responda@exemplo.com.br',
      SMTP_HOST: 'smtp.exemplo.com',
      SMTP_USER: 'nao-responda@exemplo.com.br',
      SMTP_PASSWORD: 'senha-de-aplicativo-ficticia',
      WEB_ORIGIN: 'https://cliente.control.exemplo.com.br',
    };

    it('sem as variáveis (o worker.env do nó sem e-mail), o e-mail fica desligado', () => {
      expect(loadWorkerConfig(production)).toMatchObject({ MAIL_TRANSPORT: 'none' });
      expect(loadWorkerConfig(production).MAIL_FROM).toBeUndefined();
      expect(loadWorkerConfig(production).WEB_ORIGIN).toBeUndefined();
    });

    it('SMTP: o mesmo bloco da API, mais a origem do painel; porta 465 por padrão', () => {
      expect(loadWorkerConfig({ ...production, ...smtp })).toMatchObject({
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.exemplo.com',
        SMTP_PORT: 465,
        WEB_ORIGIN: 'https://cliente.control.exemplo.com.br',
      });
    });

    it('com o e-mail ligado, o servidor, o remetente e a origem do painel são obrigatórios', () => {
      const { SMTP_PASSWORD: _password, MAIL_FROM: _from, WEB_ORIGIN: _origin, ...partial } = smtp;
      let problems: readonly string[] = [];
      try {
        loadWorkerConfig({ ...production, ...partial });
      } catch (error) {
        problems = (error as ConfigValidationError).problems;
      }
      expect(problems).toEqual(
        expect.arrayContaining([
          'SMTP_PASSWORD: obrigatória e não definida',
          'MAIL_FROM: obrigatória e não definida',
          'WEB_ORIGIN: obrigatória e não definida',
        ]),
      );
    });

    it('em produção: nada de caixa local nem de origem http; nunca mostra a senha', () => {
      expect(() => loadWorkerConfig({ ...production, ...smtp, MAIL_TRANSPORT: 'dev-mailbox' })).toThrow(
        'MAIL_TRANSPORT: deve ser ses, smtp ou none em produção',
      );
      expect(() =>
        loadWorkerConfig({ ...production, ...smtp, WEB_ORIGIN: 'http://cliente.control.exemplo.com.br' }),
      ).toThrow('WEB_ORIGIN: deve usar https em produção');
      try {
        loadWorkerConfig({ ...production, ...smtp, SMTP_HOST: 'servidor inválido' });
        expect.unreachable();
      } catch (error) {
        expect((error as Error).message).toContain('SMTP_HOST: nome de servidor inválido');
        expect((error as Error).message).not.toContain(smtp.SMTP_PASSWORD);
      }
    });

    it('fora de produção, a caixa local também vale para o worker', () => {
      expect(
        loadWorkerConfig({
          ...workerEnv,
          MAIL_TRANSPORT: 'dev-mailbox',
          MAIL_FROM: 'nao-responda@verax.example',
          WEB_ORIGIN: 'http://localhost:5173',
        }),
      ).toMatchObject({ MAIL_TRANSPORT: 'dev-mailbox', WEB_ORIGIN: 'http://localhost:5173' });
    });
  });

  it.each(['5', '7200', 'um minuto'])('intervalo fora da faixa é recusado: %s', (value) => {
    expect(() => loadWorkerConfig({ ...workerEnv, SYNC_INTERVAL_SECONDS: value })).toThrow(
      ConfigValidationError,
    );
  });

  it("PR-V5': o ID da conta de serviço, o audience e o IP de saída do nó, opcionais e com as regras da API", () => {
    const plain = loadWorkerConfig(workerEnv);
    expect(plain.NODE_SA_UNIQUE_ID).toBeUndefined();
    expect(plain.AWS_WEB_IDENTITY_AUDIENCE).toBeUndefined();
    expect(plain.NODE_EGRESS_IPS).toBeUndefined();
    const configured = loadWorkerConfig({
      ...workerEnv,
      NODE_SA_UNIQUE_ID: '123456789012345678901',
      AWS_WEB_IDENTITY_AUDIENCE: 'https://control.veraxsistemas.com.br/aws-reader',
      NODE_EGRESS_IPS: '203.0.113.10/32,198.51.100.7/32',
    });
    expect(configured).toMatchObject({
      NODE_SA_UNIQUE_ID: '123456789012345678901',
      AWS_WEB_IDENTITY_AUDIENCE: 'https://control.veraxsistemas.com.br/aws-reader',
      NODE_EGRESS_IPS: ['203.0.113.10/32', '198.51.100.7/32'],
    });
    for (const [key, value, problem] of [
      [
        'NODE_SA_UNIQUE_ID',
        '12345678901234567890',
        'deve ser o ID único da conta de serviço do nó (21 dígitos)',
      ],
      ['AWS_WEB_IDENTITY_AUDIENCE', 'http://control.veraxsistemas.com.br/aws-reader', 'deve ser https://'],
      ['NODE_EGRESS_IPS', '203.0.113.10/24', 'use IPv4 com /32'],
    ] as const) {
      expect(() => loadWorkerConfig({ ...workerEnv, [key]: value }), key).toThrow(problem);
    }
  });

  describe('estado do nó nos guest attributes (fase 3, CP-10)', () => {
    const commit = 'a'.repeat(40);

    it('sem as variáveis (o nó da Verax), a tarefa node-status não existe', () => {
      const config = loadWorkerConfig(workerEnv);
      expect(config.nodeStatus).toBeNull();
      expect(config).not.toHaveProperty('NODE_STATUS');
      expect(config).not.toHaveProperty('VERAX_NODE_COMMIT');
      expect(
        loadWorkerConfig({ ...workerEnv, NODE_STATUS: 'false', VERAX_NODE_COMMIT: commit }).nodeStatus,
      ).toBeNull();
    });

    it('o NODE_VERSION da imagem do Node.js (a versão do runtime) não é a do nó e não derruba o worker', () => {
      // A imagem oficial do Node.js define NODE_VERSION (por exemplo, 24.22.2) no ambiente de todo contêiner; com esse
      // nome para o commit, o worker parava na partida em todo nó.
      const env = { ...workerEnv, NODE_VERSION: '24.22.2' };
      expect(loadWorkerConfig(env).nodeStatus).toBeNull();
      expect(loadWorkerConfig({ ...env, NODE_STATUS: 'true', VERAX_NODE_COMMIT: commit }).nodeStatus).toEqual(
        { version: commit },
      );
    });

    it('NODE_STATUS=true com a versão: a tarefa recebe o commit', () => {
      expect(
        loadWorkerConfig({ ...workerEnv, NODE_STATUS: 'true', VERAX_NODE_COMMIT: commit }).nodeStatus,
      ).toEqual({ version: commit });
    });

    it('NODE_STATUS=true sem a versão, versão fora do formato ou interruptor inválido: recusado', () => {
      expect(() => loadWorkerConfig({ ...workerEnv, NODE_STATUS: 'true' })).toThrow(
        'VERAX_NODE_COMMIT: obrigatória e não definida',
      );
      expect(() =>
        loadWorkerConfig({ ...workerEnv, NODE_STATUS: 'true', VERAX_NODE_COMMIT: 'v1.2.3' }),
      ).toThrow('VERAX_NODE_COMMIT: deve ser o commit instalado');
      expect(() => loadWorkerConfig({ ...workerEnv, NODE_STATUS: 'sim', VERAX_NODE_COMMIT: commit })).toThrow(
        'NODE_STATUS: use true ou false',
      );
    });
  });

  describe('API do manager do Wazuh para o medidor (fase 2, PR-V6)', () => {
    const statsPhrase = 'senha-de-teste-do-medidor-1';
    const api = {
      WAZUH_API_URL: 'https://wazuh.manager:55000',
      WAZUH_API_CA_FILE: '/etc/verax/wazuh/root-ca.pem',
      WAZUH_STATS_PASSWORD: statsPhrase,
    };

    it('sem as variáveis (o nó da Verax, o lean), a tarefa wazuh-usage não existe', () => {
      const config = loadWorkerConfig(workerEnv);
      expect(config.wazuhApi).toBeNull();
      expect(config).not.toHaveProperty('WAZUH_STATS_PASSWORD');
    });

    it('as três juntas: o endereço, a CA e a senha, que não vira JSON nem aparece ao inspecionar', () => {
      const config = loadWorkerConfig({ ...workerEnv, ...api });
      expect(config.wazuhApi?.url).toBe('https://wazuh.manager:55000');
      expect(config.wazuhApi?.caFile).toBe('/etc/verax/wazuh/root-ca.pem');
      expect(config.wazuhApi?.password()).toBe(statsPhrase);
      expect(config).not.toHaveProperty('WAZUH_STATS_PASSWORD');
      expect(JSON.stringify(config)).not.toContain(statsPhrase);
      expect(inspect(config, { depth: 5 })).not.toContain(statsPhrase);
    });

    it('uma sem as outras, sem TLS, CA relativa ou senha fora da política do Wazuh: recusado sem o valor', () => {
      for (const missing of Object.keys(api)) {
        const partial: Record<string, string> = { ...workerEnv, ...api };
        delete partial[missing];
        expect(() => loadWorkerConfig(partial), missing).toThrow(`${missing}: obrigatória e não definida`);
      }
      expect(() =>
        loadWorkerConfig({ ...workerEnv, ...api, WAZUH_API_URL: 'http://wazuh.manager:55000' }),
      ).toThrow('WAZUH_API_URL: deve ser uma URL https://');
      expect(() => loadWorkerConfig({ ...workerEnv, ...api, WAZUH_API_CA_FILE: 'root-ca.pem' })).toThrow(
        'WAZUH_API_CA_FILE: deve ser o caminho absoluto',
      );
      for (const value of ['curta', 'x'.repeat(65)]) {
        try {
          loadWorkerConfig({ ...workerEnv, ...api, WAZUH_STATS_PASSWORD: value });
          throw new Error('deveria ter recusado');
        } catch (error) {
          expect((error as Error).message).toContain('WAZUH_STATS_PASSWORD: deve ter de 8 a 64 caracteres');
          expect((error as Error).message).not.toContain(value);
        }
      }
    });
  });
});

describe('canal da célula no worker (CE-05)', () => {
  const workerEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
  };
  const channel = {
    CELL_ID: 'verax-celula',
    CELL_COMMANDS_SUBSCRIPTION: 'projects/projeto-exemplo/subscriptions/vxc-verax-celula-comandos',
    CELL_REPORTS_TOPIC: 'projects/projeto-exemplo/topics/vxc-verax-celula-relatorios',
  };

  it('fora da célula e sem as variáveis, o canal não existe; na célula com as três, existe', () => {
    expect(loadWorkerConfig(workerEnv).cellChannel).toBeNull();
    expect(loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell' }).cellChannel).toBeNull();
    expect(loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell', ...channel }).cellChannel).toEqual({
      cellId: 'verax-celula',
      commandsSubscription: channel.CELL_COMMANDS_SUBSCRIPTION,
      reportsTopic: channel.CELL_REPORTS_TOPIC,
    });
  });

  it('as três juntas, só na célula, e cada uma no formato', () => {
    for (const missing of Object.keys(channel)) {
      const partial: Record<string, string> = { ...workerEnv, NODE_MODE: 'cell', ...channel };
      delete partial[missing];
      expect(() => loadWorkerConfig(partial), missing).toThrow(`${missing}: obrigatória`);
    }
    expect(() => loadWorkerConfig({ ...workerEnv, ...channel })).toThrow(
      'CELL_ID: só existe com NODE_MODE=cell',
    );
    expect(() =>
      loadWorkerConfig({
        ...workerEnv,
        NODE_MODE: 'cell',
        ...channel,
        CELL_REPORTS_TOPIC: channel.CELL_COMMANDS_SUBSCRIPTION,
      }),
    ).toThrow('CELL_REPORTS_TOPIC: use projects/<projeto>/topics/<nome>');
    expect(() =>
      loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell', ...channel, CELL_ID: 'Celula' }),
    ).toThrow('CELL_ID');
  });

  it('as pastas do primeiro administrador (CE-04): as duas juntas, absolutas e só na célula', () => {
    const dirs = {
      TENANT_BOOTSTRAP_DIR: '/run/tenant-bootstrap',
      TENANT_BOOTSTRAP_STATUS_DIR: '/run/tenant-bootstrap-status',
    };
    expect(loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell', ...channel }).tenantBootstrap).toBeNull();
    expect(
      loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell', ...channel, ...dirs }).tenantBootstrap,
    ).toEqual({
      requestsDir: '/run/tenant-bootstrap',
      statusDir: '/run/tenant-bootstrap-status',
    });
    expect(() =>
      loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell', TENANT_BOOTSTRAP_DIR: dirs.TENANT_BOOTSTRAP_DIR }),
    ).toThrow('TENANT_BOOTSTRAP_STATUS_DIR: obrigatória');
    expect(() => loadWorkerConfig({ ...workerEnv, ...dirs })).toThrow(
      'TENANT_BOOTSTRAP_DIR: só existe com NODE_MODE=cell',
    );
    expect(() =>
      loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell', ...dirs, TENANT_BOOTSTRAP_DIR: 'pedidos' }),
    ).toThrow('TENANT_BOOTSTRAP_DIR: deve ser o caminho absoluto');
  });
});

describe('cofre de credenciais no ambiente (fase 2)', () => {
  // Chaves geradas na hora; o PEM vai em base64, como o start.sh escreve. As privadas do worker ficam num arquivo
  // temporário, uma versão por linha, como o arquivo do tmpfs do nó.
  let publicKey64: string;
  let privateKey64: string;
  let otherPrivateKey64: string;
  let keysDir: string;
  let keysFile: string;
  const workerEnv = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
  };
  const keysFileNamed = (name: string, content: string): string => {
    const path = join(keysDir, name);
    writeFileSync(path, content, { mode: 0o400 });
    return path;
  };

  beforeAll(() => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072 });
    const other = generateKeyPairSync('rsa', { modulusLength: 3072 });
    publicKey64 = Buffer.from(pair.publicKey.export({ type: 'spki', format: 'pem' })).toString('base64');
    privateKey64 = Buffer.from(pair.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
    otherPrivateKey64 = Buffer.from(other.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString(
      'base64',
    );
    keysDir = mkdtempSync(join(tmpdir(), 'verax-vault-keys-'));
    keysFile = keysFileNamed('worker-keys', `1:${otherPrivateKey64}\n2:${privateKey64}\n`);
  });

  afterAll(() => {
    rmSync(keysDir, { recursive: true, force: true });
  });

  it('sem as variáveis, a API e o worker sobem sem o cofre (o nó da Verax)', () => {
    expect(loadConfig(validProductionEnv).credentialsPublicKey).toBeNull();
    expect(loadWorkerConfig(workerEnv).credentialsKeyring).toBeNull();
  });

  it('a API recebe a chave pública e a versão; o texto em base64 não fica na configuração', () => {
    const config = loadConfig({
      ...validProductionEnv,
      CREDENTIALS_PUBLIC_KEY: publicKey64,
      CREDENTIALS_KEY_VERSION: '3',
    });
    expect(config.credentialsPublicKey?.version).toBe(3);
    expect(config.credentialsPublicKey?.key.type).toBe('public');
    expect(JSON.stringify(config)).not.toContain(publicKey64.slice(0, 40));
    expect(problemsOf({ ...validProductionEnv, CREDENTIALS_PUBLIC_KEY: publicKey64 })).toEqual([
      'CREDENTIALS_KEY_VERSION: obrigatória e não definida',
    ]);
    expect(problemsOf({ ...validProductionEnv, CREDENTIALS_KEY_VERSION: '1' })).toEqual([
      'CREDENTIALS_PUBLIC_KEY: obrigatória e não definida',
    ]);
    expect(
      problemsOf({
        ...validProductionEnv,
        CREDENTIALS_PUBLIC_KEY: publicKey64,
        CREDENTIALS_KEY_VERSION: '0',
      }),
    ).toEqual(['CREDENTIALS_KEY_VERSION: deve ser um inteiro positivo']);
  });

  it('a API recusa qualquer chave privada: as variáveis do worker, outro nome e a privada no lugar da pública', () => {
    const refused = 'a API recebe só a chave pública do cofre de credenciais; a privada fica só no worker';
    for (const extra of [
      { CREDENTIALS_PRIVATE_KEYS_FILE: keysFile, CREDENTIALS_KEY_CURRENT: '1' },
      { CREDENTIALS_PRIVATE_KEYS_FILE: keysFile },
      { CREDENTIALS_PRIVATE_KEYS: `1:${privateKey64}` },
      { CREDENTIALS_KEY_CURRENT: '1' },
      { CREDENTIALS_KEY_V1: privateKey64 },
      { VAULT_PRIVATE_KEY: privateKey64 },
    ]) {
      const problems = problemsOf({
        ...validProductionEnv,
        CREDENTIALS_PUBLIC_KEY: publicKey64,
        CREDENTIALS_KEY_VERSION: '1',
        ...extra,
      });
      expect(problems).toEqual(Object.keys(extra).map((key) => `${key}: ${refused}`));
      expect(problems.join(' ')).not.toContain(privateKey64.slice(0, 40));
    }
    const problems = problemsOf({
      ...validProductionEnv,
      CREDENTIALS_PUBLIC_KEY: privateKey64,
      CREDENTIALS_KEY_VERSION: '1',
    });
    expect(problems).toEqual([
      'CREDENTIALS_PUBLIC_KEY: a API recebe só a chave pública do cofre; a privada fica só no worker',
    ]);
    expect(problems.join(' ')).not.toContain(privateKey64.slice(0, 40));
  });

  it('o worker lê as privadas de todas as versões e a corrente do arquivo; nem o texto nem o caminho ficam na configuração', () => {
    const config = loadWorkerConfig({
      ...workerEnv,
      CREDENTIALS_PRIVATE_KEYS_FILE: keysFile,
      CREDENTIALS_KEY_CURRENT: '2',
    });
    expect(config.credentialsKeyring?.versions).toEqual([1, 2]);
    expect(config.credentialsKeyring?.current).toBe(2);
    expect(JSON.stringify(config)).not.toContain(privateKey64.slice(0, 40));
    expect(JSON.stringify(config)).not.toContain(keysFile);
    expect(JSON.stringify(config)).toContain('[chaves privadas do cofre]');
  });

  it('fonte cloudflare: exige o cofre (o token só abre no worker); intervalo da auditoria de 1 a 60 min, 5 por padrão', () => {
    expect(problemsOfWorker({ ...workerEnv, SYNC_SOURCES: 'gcp,cloudflare' })).toEqual([
      'SYNC_SOURCES: a fonte cloudflare lê o token do cofre de credenciais: exige CREDENTIALS_PRIVATE_KEYS_FILE e CREDENTIALS_KEY_CURRENT',
    ]);
    const vault = { CREDENTIALS_PRIVATE_KEYS_FILE: keysFile, CREDENTIALS_KEY_CURRENT: '2' };
    const config = loadWorkerConfig({ ...workerEnv, ...vault, SYNC_SOURCES: 'gcp,cloudflare' });
    expect(config.SYNC_SOURCES).toEqual(['gcp', 'cloudflare']);
    expect(config.CLOUDFLARE_AUDIT_INTERVAL_SECONDS).toBe(300);
    expect(
      loadWorkerConfig({ ...workerEnv, ...vault, CLOUDFLARE_AUDIT_INTERVAL_SECONDS: '600' })
        .CLOUDFLARE_AUDIT_INTERVAL_SECONDS,
    ).toBe(600);
    for (const value of ['30', '7200', 'cinco']) {
      expect(() => loadWorkerConfig({ ...workerEnv, CLOUDFLARE_AUDIT_INTERVAL_SECONDS: value })).toThrow(
        ConfigValidationError,
      );
    }
  });

  it('o worker recusa chave privada pelo ambiente: qualquer nome com PRIVATE_KEY, menos o caminho do arquivo', () => {
    // O ambiente do contêiner fica gravado no disco do nó (configuração do Docker) e nos snapshots dele. A mesma
    // régua da API, com a única exceção do caminho do arquivo.
    const refused =
      'as chaves privadas do cofre vêm por arquivo (CREDENTIALS_PRIVATE_KEYS_FILE), nunca pelo ambiente';
    for (const extra of [
      { CREDENTIALS_PRIVATE_KEYS: `1:${privateKey64}` },
      { CREDENTIALS_PRIVATE_KEY: privateKey64 },
      { CREDENTIALS_PRIVATEKEY_V1: privateKey64 },
      { VAULT_PRIVATE_KEY: privateKey64 },
      { privateKey: privateKey64 },
      { CREDENTIALS_PRIVATE_KEYS: `1:${privateKey64}`, WORKER_PRIVATE_KEY_PEM: privateKey64 },
    ]) {
      const problems = problemsOfWorker({
        ...workerEnv,
        CREDENTIALS_PRIVATE_KEYS_FILE: keysFile,
        CREDENTIALS_KEY_CURRENT: '2',
        ...extra,
      });
      expect(problems).toEqual(Object.keys(extra).map((key) => `${key}: ${refused}`));
      expect(problems.join(' ')).not.toContain(privateKey64.slice(0, 40));
    }
    // O caminho do arquivo é a exceção, e um nome parecido sem PRIVATE_KEY passa.
    expect(
      loadWorkerConfig({
        ...workerEnv,
        CREDENTIALS_PRIVATE_KEYS_FILE: keysFile,
        CREDENTIALS_KEY_CURRENT: '2',
        PRIVATE_NETWORK: 'sim',
      }).credentialsKeyring?.current,
    ).toBe(2);
  });

  it('o worker recusa par incompleto, arquivo ilegível, corrente fora da lista e chave pública no lugar da privada, sem o valor', () => {
    expect(problemsOfWorker({ ...workerEnv, CREDENTIALS_PRIVATE_KEYS_FILE: keysFile })).toEqual([
      'CREDENTIALS_KEY_CURRENT: obrigatória e não definida',
    ]);
    expect(problemsOfWorker({ ...workerEnv, CREDENTIALS_KEY_CURRENT: '1' })).toEqual([
      'CREDENTIALS_PRIVATE_KEYS_FILE: obrigatória e não definida',
    ]);
    const missing = join(keysDir, 'nao-existe');
    const unreadable = problemsOfWorker({
      ...workerEnv,
      CREDENTIALS_PRIVATE_KEYS_FILE: missing,
      CREDENTIALS_KEY_CURRENT: '1',
    });
    expect(unreadable).toEqual([
      'CREDENTIALS_PRIVATE_KEYS_FILE: não foi possível ler o arquivo das chaves privadas',
    ]);
    expect(unreadable.join(' ')).not.toContain(missing);
    expect(
      problemsOfWorker({
        ...workerEnv,
        CREDENTIALS_PRIVATE_KEYS_FILE: keysFile,
        CREDENTIALS_KEY_CURRENT: '3',
      }),
    ).toEqual(['CREDENTIALS_PRIVATE_KEYS_FILE: a versão corrente precisa estar entre as chaves privadas']);
    const problems = problemsOfWorker({
      ...workerEnv,
      CREDENTIALS_PRIVATE_KEYS_FILE: keysFileNamed('public-instead', `1:${publicKey64}\n`),
      CREDENTIALS_KEY_CURRENT: '1',
    });
    expect(problems).toEqual([
      'CREDENTIALS_PRIVATE_KEYS_FILE: a versão 1 deve ser uma chave privada em PEM (BEGIN PRIVATE KEY)',
    ]);
    expect(problems.join(' ')).not.toContain(publicKey64.slice(0, 40));
    expect(
      problemsOfWorker({
        ...workerEnv,
        CREDENTIALS_PRIVATE_KEYS_FILE: keysFileNamed('empty', ''),
        CREDENTIALS_KEY_CURRENT: '1',
      }),
    ).toEqual(['CREDENTIALS_PRIVATE_KEYS_FILE: o arquivo das chaves privadas está vazio']);
  });
});

function problemsOfWorker(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadWorkerConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('loadWorkerConfig deveria ter falhado');
}

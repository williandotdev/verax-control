import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './load-config.js';

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

  it('exige SES em produção', () => {
    expect(problemsOf({ ...validProductionEnv, MAIL_TRANSPORT: 'dev-mailbox' })).toContain(
      'MAIL_TRANSPORT: deve ser ses em produção',
    );
    expect(loadConfig({ ...validProductionEnv, MAIL_TRANSPORT: 'ses' }).MAIL_TRANSPORT).toBe('ses');
  });

  it('não aceita desligar o limite de tentativas em produção', () => {
    expect(problemsOf({ ...validProductionEnv, AUTH_RATE_LIMIT_ENABLED: 'false' })).toContain(
      'AUTH_RATE_LIMIT_ENABLED: deve ficar ligado em produção',
    );
    expect(loadConfig(validEnv).AUTH_RATE_LIMIT_ENABLED).toBe(true);
  });

  it('exige https na origem da API em produção', () => {
    expect(problemsOf({ ...validProductionEnv, API_ORIGIN: 'http://api.example.com' })).toContain(
      'API_ORIGIN: deve usar https em produção',
    );
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

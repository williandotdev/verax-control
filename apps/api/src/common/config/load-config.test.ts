import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig } from './load-config.js';

const validEnv = {
  NODE_ENV: 'development',
  WEB_ORIGIN: 'http://localhost:5173',
  DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
};

const validProductionEnv = {
  ...validEnv,
  NODE_ENV: 'production',
  WEB_ORIGIN: 'https://painel.example.com',
  DATABASE_URL: 'postgresql://verax:secret@db.internal:5432/verax?sslmode=verify-full',
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

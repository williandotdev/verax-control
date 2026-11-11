import { describe, expect, it } from 'vitest';
import { cellApiHost, cellPanelOrigin, isCellDomain, isTenantSlug, slugFromApiHost } from './cell.js';
import { ConfigValidationError, loadConfig, loadWorkerConfig } from './load-config.js';

const cell = { domain: 'exemplo.com.br', staffSlug: 'verax' };

describe('endereços da célula (CE-01)', () => {
  it('subdomínio: a regra do plano de controle e do painel', () => {
    for (const slug of ['verax', 'cliente-demo-a', 'abc', 'a1b', 'a'.repeat(16)]) {
      expect(isTenantSlug(slug), slug).toBe(true);
    }
    for (const slug of [
      'ab',
      'a'.repeat(17),
      '1abc',
      'abc-',
      'ABC',
      'ab--c',
      'xn--abc',
      'a.b.c',
      'a_bc',
      '',
    ]) {
      expect(isTenantSlug(slug), slug).toBe(false);
    }
  });

  it('domínio: rótulos em minúsculas, sem ponto no fim nem rótulo vazio', () => {
    expect(isCellDomain('exemplo.com.br')).toBe(true);
    expect(isCellDomain('example.com')).toBe(true);
    for (const domain of [
      'localhost',
      'Exemplo.com',
      'exemplo.com.',
      '.exemplo.com',
      'a..b',
      '-a.com',
      'a-.com',
    ]) {
      expect(isCellDomain(domain), domain).toBe(false);
    }
  });

  it('deriva a API e o painel do subdomínio, sem domínio fixo no código', () => {
    expect(cellApiHost(cell, 'cliente-a')).toBe('api-cliente-a.exemplo.com.br');
    expect(cellPanelOrigin(cell, 'cliente-a')).toBe('https://cliente-a.control.exemplo.com.br');
  });

  it('lê o subdomínio só de `api-<slug>.<domínio>`, exatamente', () => {
    expect(slugFromApiHost(cell, 'api-cliente-a.exemplo.com.br')).toBe('cliente-a');
    expect(slugFromApiHost(cell, 'api-verax.exemplo.com.br')).toBe('verax');
    for (const host of [
      undefined,
      '',
      'exemplo.com.br',
      'api-.exemplo.com.br',
      'api-cliente-a.exemplo.com.br:443',
      'api-cliente-a.exemplo.com.br.',
      'API-cliente-a.exemplo.com.br',
      'api-Cliente-a.exemplo.com.br',
      'api-a.b.exemplo.com.br',
      'x.api-cliente-a.exemplo.com.br',
      'api-cliente-a.outro.com.br',
      'api-cliente-a.exemplo.com.br.evil.example',
      'cliente-a.control.exemplo.com.br',
      '127.0.0.1:3000',
      'localhost',
      `api-${'a'.repeat(5000)}.exemplo.com.br`,
    ]) {
      expect(slugFromApiHost(cell, host), String(host)).toBeUndefined();
    }
  });
});

describe('configuração da célula (CE-01)', () => {
  const baseEnv = {
    NODE_ENV: 'development',
    WEB_ORIGIN: 'http://localhost:5173',
    API_ORIGIN: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'x'.repeat(43),
    CSRF_SECRET: 'y'.repeat(43),
    MAIL_FROM: 'nao-responda@verax.example',
    DATABASE_URL: 'postgresql://verax:secret@localhost:5432/verax',
  };
  const cellEnv = {
    ...baseEnv,
    NODE_MODE: 'cell',
    CELL_DOMAIN: 'exemplo.com.br',
    CELL_STAFF_SLUG: 'verax',
    WEB_ORIGIN: 'https://verax.control.exemplo.com.br',
    API_ORIGIN: 'https://api-verax.exemplo.com.br',
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

  it('sem NODE_MODE, o nó dedicado de sempre, sem célula', () => {
    const config = loadConfig(baseEnv);
    expect(config.NODE_MODE).toBe('dedicated');
    expect(config.cell).toBeNull();
  });

  it('na célula, o domínio e o subdomínio da equipe num objeto só', () => {
    const config = loadConfig(cellEnv);
    expect(config.NODE_MODE).toBe('cell');
    expect(config.cell).toEqual({ domain: 'exemplo.com.br', staffSlug: 'verax' });
    expect(config).not.toHaveProperty('CELL_DOMAIN');
    expect(config).not.toHaveProperty('CELL_STAFF_SLUG');
  });

  it('a célula exige as duas variáveis; o nó dedicado recusa as duas', () => {
    expect(problemsOf({ ...cellEnv, CELL_DOMAIN: undefined, CELL_STAFF_SLUG: undefined })).toEqual(
      expect.arrayContaining([
        'CELL_DOMAIN: obrigatória e não definida',
        'CELL_STAFF_SLUG: obrigatória e não definida',
      ]),
    );
    expect(problemsOf({ ...baseEnv, CELL_DOMAIN: 'exemplo.com.br', CELL_STAFF_SLUG: 'verax' })).toEqual([
      'CELL_DOMAIN: só existe com NODE_MODE=cell',
      'CELL_STAFF_SLUG: só existe com NODE_MODE=cell',
    ]);
    expect(problemsOf({ ...baseEnv, NODE_MODE: 'shared' })).toEqual(['NODE_MODE: use dedicated ou cell']);
  });

  it('recusa domínio e subdomínio fora do formato', () => {
    expect(problemsOf({ ...cellEnv, CELL_DOMAIN: 'Exemplo.com.br' })).toContain(
      'CELL_DOMAIN: deve ser um domínio em minúsculas, sem ponto no fim (ex.: exemplo.com.br)',
    );
    expect(problemsOf({ ...cellEnv, CELL_STAFF_SLUG: 'xn--verax' })).toContain(
      'CELL_STAFF_SLUG: subdomínio inválido',
    );
  });

  it('o WEB_ORIGIN e o API_ORIGIN da célula são os da equipe, derivados do domínio', () => {
    expect(
      problemsOf({
        ...cellEnv,
        WEB_ORIGIN: 'https://cliente-a.control.exemplo.com.br',
        API_ORIGIN: 'https://api-cliente-a.exemplo.com.br',
      }),
    ).toEqual([
      'WEB_ORIGIN: na célula, deve ser o painel da equipe: https://<CELL_STAFF_SLUG>.control.<CELL_DOMAIN>',
      'API_ORIGIN: na célula, deve ser a API da equipe: https://api-<CELL_STAFF_SLUG>.<CELL_DOMAIN>',
    ]);
  });

  it('o worker da célula não manda aviso por e-mail enquanto os links não forem por cliente', () => {
    const workerEnv = { NODE_ENV: 'development', DATABASE_URL: baseEnv.DATABASE_URL };
    expect(loadWorkerConfig(workerEnv).NODE_MODE).toBe('dedicated');
    expect(loadWorkerConfig({ ...workerEnv, NODE_MODE: 'cell' }).MAIL_TRANSPORT).toBe('none');
    expect(() =>
      loadWorkerConfig({
        ...workerEnv,
        NODE_MODE: 'cell',
        MAIL_TRANSPORT: 'dev-mailbox',
        MAIL_FROM: 'nao-responda@exemplo.com.br',
        WEB_ORIGIN: 'https://verax.control.exemplo.com.br',
      }),
    ).toThrow('MAIL_TRANSPORT: deve ser none com NODE_MODE=cell');
  });
});

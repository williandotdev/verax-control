import { describe, expect, it } from 'vitest';
import { PROVISIONING_REQUIRED } from './env.schema.js';
import { ConfigValidationError, loadConfig } from './load-config.js';

const validEnv = { ROLE: 'public', NODE_ENV: 'development' };
const validProductionEnv = { ROLE: 'worker', NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' };

/** Chaves falsas montadas em partes para o gitleaks não as ver como chaves reais. */
const testKey = ['rk', 'test', 'chaveDeTeste1234567890'].join('_');
const liveKey = ['rk', 'live', 'chaveDeProducao1234567890'].join('_');

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('loadConfig deveria ter falhado');
}

describe('loadConfig (CP-01)', () => {
  it('aceita o mínimo (papel e ambiente) e aplica os padrões do Cloud Run', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      ROLE: 'public',
      PORT: 8080,
      LOG_LEVEL: 'info',
      TRUST_PROXY_HOPS: 0,
      FIRESTORE_DATABASE: '(default)',
      STRIPE_LIVE: false,
      PROVISIONING_ENABLED: false,
      CLOUDFLARE_ZONE_NAME: 'veraxsistemas.com.br',
      PANEL_DOMAIN_SUFFIX: 'control.veraxsistemas.com.br',
      API_DOMAIN_PREFIX: 'api-',
      SMTP_PORT: 465,
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('sem ROLE o processo não sobe; papel desconhecido é recusado', () => {
    expect(problemsOf({ NODE_ENV: 'development' })).toEqual(['ROLE: obrigatória e não definida']);
    expect(problemsOf({ ...validEnv, ROLE: 'admin' })).toEqual(['ROLE: deve ser public ou worker']);
    expect(loadConfig({ ...validEnv, ROLE: 'worker' }).ROLE).toBe('worker');
  });

  it('em produção exige o Hosting e o Cloud Run contados em TRUST_PROXY_HOPS', () => {
    expect(problemsOf({ ...validProductionEnv, TRUST_PROXY_HOPS: '0' })).toEqual([
      'TRUST_PROXY_HOPS: deve contar o Hosting e o Cloud Run (1) em produção',
    ]);
    expect(() => loadConfig(validProductionEnv)).not.toThrow();
  });

  it('emulador do Firestore: proibido em produção e exige o id do projeto fora dela', () => {
    expect(problemsOf({ ...validEnv, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8681' })).toEqual([
      'FIRESTORE_PROJECT_ID: obrigatória e não definida',
    ]);
    const local = loadConfig({
      ...validEnv,
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8681',
      FIRESTORE_PROJECT_ID: 'demo-verax-cp',
    });
    expect(local.FIRESTORE_PROJECT_ID).toBe('demo-verax-cp');
    expect(problemsOf({ ...validEnv, FIRESTORE_EMULATOR_HOST: 'sem-porta' })).toContain(
      'FIRESTORE_EMULATOR_HOST: deve ter o formato host:porta',
    );
    expect(
      problemsOf({
        ...validProductionEnv,
        FIRESTORE_EMULATOR_HOST: '127.0.0.1:8681',
        FIRESTORE_PROJECT_ID: 'demo-verax-cp',
      }),
    ).toEqual(['FIRESTORE_EMULATOR_HOST: não pode apontar para o emulador em produção']);
  });

  it('Stripe: a chave precisa bater com STRIPE_LIVE, e o formato é conferido', () => {
    expect(loadConfig({ ...validEnv, STRIPE_SECRET_KEY: testKey }).STRIPE_SECRET_KEY).toBe(testKey);
    expect(problemsOf({ ...validEnv, STRIPE_SECRET_KEY: liveKey })).toEqual([
      'STRIPE_SECRET_KEY: chave de produção com STRIPE_LIVE=false',
    ]);
    expect(problemsOf({ ...validEnv, STRIPE_SECRET_KEY: testKey, STRIPE_LIVE: 'true' })).toEqual([
      'STRIPE_SECRET_KEY: chave de teste com STRIPE_LIVE=true',
    ]);
    expect(loadConfig({ ...validEnv, STRIPE_SECRET_KEY: liveKey, STRIPE_LIVE: 'true' }).STRIPE_LIVE).toBe(
      true,
    );
    expect(problemsOf({ ...validEnv, STRIPE_SECRET_KEY: 'chave-qualquer' })).toEqual([
      'STRIPE_SECRET_KEY: chave da Stripe em formato inválido',
    ]);
    expect(problemsOf({ ...validEnv, STRIPE_WEBHOOK_SECRET: 'abc' })).toEqual([
      'STRIPE_WEBHOOK_SECRET: segredo de webhook da Stripe em formato inválido',
    ]);
  });

  it('PROVISIONING_ENABLED=true exige o grupo inteiro na partida; false deixa tudo opcional', () => {
    expect(loadConfig(validEnv).PROVISIONING_ENABLED).toBe(false);
    expect(problemsOf({ ...validEnv, PROVISIONING_ENABLED: 'true' })).toEqual(
      PROVISIONING_REQUIRED.map((key) => `${key}: obrigatória e não definida`),
    );
    const complete = {
      ...validEnv,
      PROVISIONING_ENABLED: 'true',
      NODES_PROJECT_ID: 'projeto-dos-nos-demo',
      NODES_REGION: 'southamerica-east1',
      NODES_ZONE: 'southamerica-east1-b',
      TFSTATE_BUCKET: 'projeto-dos-nos-demo-tfstate',
      TERRAFORM_JOB_NAME: 'cp-terraform',
      IMAGES_PROJECT_ID: 'projeto-da-verax-demo',
      RELEASE_BUCKET: 'projeto-da-verax-demo-releases',
      NODE_RELEASE: 'v2026.11.0',
      MAIL_FROM_NODES: 'nao-responda@verax.example',
    };
    expect(loadConfig(complete).NODES_ZONE).toBe('southamerica-east1-b');
    expect(problemsOf({ ...complete, NODES_ZONE: 'southamerica-east1' })).toEqual([
      'NODES_ZONE: zona GCP inválida',
    ]);
  });

  it('listas separadas por vírgula: origens do site, projetos do Firebase e principais', () => {
    const config = loadConfig({
      ...validEnv,
      SITE_ORIGINS:
        'https://veraxsistemas.com.br, https://www.veraxsistemas.com.br,https://veraxsistemas.com.br',
      FIREBASE_PANEL_PROJECTS: 'paineis-demo-1,paineis-demo-2',
      OWNER_PRINCIPALS: 'responsavel@verax.example',
    });
    expect(config.SITE_ORIGINS).toEqual(['https://veraxsistemas.com.br', 'https://www.veraxsistemas.com.br']);
    expect(config.FIREBASE_PANEL_PROJECTS).toEqual(['paineis-demo-1', 'paineis-demo-2']);
    expect(config.OWNER_PRINCIPALS).toEqual(['responsavel@verax.example']);
    expect(problemsOf({ ...validEnv, SITE_ORIGINS: 'http://veraxsistemas.com.br' })).toEqual([
      'SITE_ORIGINS.0: deve ser uma URL https válida',
    ]);
  });

  it('SMTP exige usuário, senha e remetente quando o servidor é informado', () => {
    expect(problemsOf({ ...validEnv, SMTP_HOST: 'smtp.zoho.com' })).toEqual([
      'SMTP_USER: obrigatória e não definida',
      'SMTP_PASSWORD: obrigatória e não definida',
      'MAIL_FROM: obrigatória e não definida',
    ]);
    expect(problemsOf({ ...validEnv, COOKIE_KEY: 'curta' })).toEqual([
      'COOKIE_KEY: deve ter pelo menos 32 caracteres',
    ]);
  });

  it('converte PORT e rejeita fora do intervalo', () => {
    expect(loadConfig({ ...validEnv, PORT: '3000' }).PORT).toBe(3000);
    expect(problemsOf({ ...validEnv, PORT: '70000' }).some((p) => p.startsWith('PORT:'))).toBe(true);
  });

  it('nunca inclui o valor recebido na mensagem de erro', () => {
    const secret = 'S3nh4-Sup3r-S3cr3t4';
    let message = '';
    try {
      loadConfig({
        ...validEnv,
        STRIPE_SECRET_KEY: secret,
        CLOUDFLARE_ZONE_ID: secret,
        COOKIE_KEY: secret,
        FIRESTORE_EMULATOR_HOST: secret,
        SITE_SUCCESS_URL: `https://${secret}@exemplo.com/`,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of ['STRIPE_SECRET_KEY', 'CLOUDFLARE_ZONE_ID', 'COOKIE_KEY', 'FIRESTORE_EMULATOR_HOST']) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain(secret);
  });
});

import { describe, expect, it } from 'vitest';
import { PROVISIONING_REQUIRED, ROLE_ONLY } from './env.schema.js';
import { ConfigValidationError, loadConfig } from './load-config.js';

const validEnv = { ROLE: 'public', NODE_ENV: 'development' };
const validProductionEnv = { ROLE: 'worker', NODE_ENV: 'production' };

/** Chaves falsas montadas em partes para o gitleaks não as ver como chaves reais. */
const testKey = ['rk', 'test', 'chaveDeTeste1234567890'].join('_');
const liveKey = ['rk', 'live', 'chaveDeProducao1234567890'].join('_');
const webhookSecret = ['whsec', 'segredoDeWebhookDeTeste1234'].join('_');
const cookieKey = 'chave-do-cookie-de-teste-com-mais-de-32-caracteres';

function problemsOf(env: NodeJS.ProcessEnv): readonly string[] {
  try {
    loadConfig(env, () => undefined);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.problems;
    throw error;
  }
  throw new Error('loadConfig deveria ter falhado');
}

function warningsOf(env: NodeJS.ProcessEnv): string[] {
  const warnings: string[] = [];
  loadConfig(env, (message) => warnings.push(message));
  return warnings;
}

/**
 * O ambiente que o Terraform (`infra/gcp/envs/control-plane`: `run.tf` e `secrets.tf`) dá a cada serviço, com
 * valores fictícios: as variáveis comuns aos dois, as só do worker (SMTP) e os segredos que cada um lê.
 * TRUST_PROXY_HOPS não vem de lá: é o padrão do app.
 */
const terraformSharedEnv = {
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',
  SITE_ORIGINS: 'https://veraxsistemas.com.br,https://www.veraxsistemas.com.br',
  SITE_SUCCESS_URL: 'https://veraxsistemas.com.br/checkout/sucesso?cs={CHECKOUT_SESSION_ID}',
  SITE_CANCEL_URL: 'https://veraxsistemas.com.br/#planos',
  STRIPE_LIVE: 'false',
  STRIPE_PRICE_LOOKUP_ESSENCIAL: 'verax_control_essencial_mensal',
  STRIPE_PRICE_LOOKUP_PROFISSIONAL: 'verax_control_profissional_mensal',
  PROVISIONING_ENABLED: 'false',
  CLOUDFLARE_ZONE_NAME: 'veraxsistemas.com.br',
  PANEL_DOMAIN_SUFFIX: 'control.veraxsistemas.com.br',
  API_DOMAIN_PREFIX: 'api-',
  FIRESTORE_DATABASE: '(default)',
  TASKS_LOCATION: 'southamerica-east1',
  TASKS_QUEUE_PROVISIONING: 'provisioning',
  TASKS_QUEUE_LIFECYCLE: 'lifecycle',
  WORKER_URL: 'https://cp-worker-111111111111.southamerica-east1.run.app',
  // As duas apontam para a cp-invoker, a única identidade cujo token chega ao cp-worker (identities.tf).
  WORKER_SA_EMAIL: 'cp-invoker@projeto-demo.iam.gserviceaccount.com',
  SCHEDULER_SA_EMAIL: 'cp-invoker@projeto-demo.iam.gserviceaccount.com',
  OWNER_PRINCIPALS: 'responsavel@verax.example',
  OWNER_ALERT_EMAIL: 'alertas@verax.example',
  TERRAFORM_JOB_NAME: 'cp-terraform',
  NODES_REGION: 'southamerica-east1',
  NODES_ZONE: 'southamerica-east1-b',
  FIREBASE_PANEL_PROJECTS: 'projeto-demo',
  TERMS_VERSION: '2026-11-04',
  PRIVACY_VERSION: '2026-11-04',
  DPA_VERSION: '2026-11-04',
  STRIPE_PORTAL_LOGIN_URL: 'https://billing.stripe.com/p/login/test_demo',
};
const cpPublicEnv = {
  ...terraformSharedEnv,
  ROLE: 'public',
  STRIPE_SECRET_KEY: testKey,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  COOKIE_KEY: cookieKey,
};
const cpWorkerEnv = {
  ...terraformSharedEnv,
  ROLE: 'worker',
  SMTP_HOST: 'smtp.zoho.com',
  SMTP_PORT: '465',
  SMTP_USER: 'nao-responda@verax.example',
  MAIL_FROM: 'Verax Control <nao-responda@verax.example>',
  STRIPE_SECRET_KEY: testKey,
  CLOUDFLARE_API_TOKEN: 'token-de-teste-do-cloudflare',
  SMTP_PASSWORD: 'senha-de-aplicativo-de-teste',
};

describe('loadConfig (CP-01)', () => {
  it('aceita o mínimo (papel e ambiente) e aplica os padrões do Cloud Run', () => {
    const config = loadConfig(validEnv);
    expect(config).toMatchObject({
      ROLE: 'public',
      PORT: 8080,
      LOG_LEVEL: 'info',
      TRUST_PROXY_HOPS: 1,
      FIRESTORE_DATABASE: '(default)',
      STRIPE_LIVE: false,
      PROVISIONING_ENABLED: false,
      CLOUDFLARE_ZONE_NAME: 'veraxsistemas.com.br',
      PANEL_DOMAIN_SUFFIX: 'control.veraxsistemas.com.br',
      API_DOMAIN_PREFIX: 'api-',
      SMTP_PORT: 465,
    });
    expect(config.TRUSTED_PROXIES).toBeUndefined();
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('sem ROLE o processo não sobe; papel desconhecido é recusado', () => {
    expect(problemsOf({ NODE_ENV: 'development' })).toEqual(['ROLE: obrigatória e não definida']);
    expect(problemsOf({ ...validEnv, ROLE: 'admin' })).toEqual(['ROLE: deve ser public ou worker']);
    expect(loadConfig({ ...validEnv, ROLE: 'worker' }).ROLE).toBe('worker');
  });

  it('TRUST_PROXY_HOPS: 1 por padrão (o front end do Cloud Run), nunca 0 em produção', () => {
    expect(loadConfig(validProductionEnv).TRUST_PROXY_HOPS).toBe(1);
    expect(problemsOf({ ...validProductionEnv, TRUST_PROXY_HOPS: '0' })).toEqual([
      'TRUST_PROXY_HOPS: deve contar o front end do Cloud Run (1) em produção',
    ]);
    expect(loadConfig({ ...validEnv, TRUST_PROXY_HOPS: '0' }).TRUST_PROXY_HOPS).toBe(0);
    expect(
      problemsOf({ ...validEnv, TRUST_PROXY_HOPS: '6' }).some((p) => p.startsWith('TRUST_PROXY_HOPS:')),
    ).toBe(true);
  });

  it('TRUSTED_PROXIES: endereços e blocos CIDR, v4 e v6; o resto é recusado', () => {
    const config = loadConfig({
      ...validEnv,
      TRUSTED_PROXIES: '198.51.100.0/24, 203.0.113.7,2001:db8::/32, 2001:db8:ff::1',
    });
    expect(config.TRUSTED_PROXIES).toEqual([
      '198.51.100.0/24',
      '203.0.113.7',
      '2001:db8::/32',
      '2001:db8:ff::1',
    ]);
    for (const bad of ['hosting.example', '198.51.100.0/40', '300.1.1.1', '198.51.100.0/24,lixo']) {
      expect(
        problemsOf({ ...validEnv, TRUSTED_PROXIES: bad }).some((p) => p.startsWith('TRUSTED_PROXIES')),
      ).toBe(true);
    }
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

  it('o ambiente que o Terraform dá ao cp-public sobe sem SMTP, sem aviso e com os saltos padrão', () => {
    expect(warningsOf(cpPublicEnv)).toEqual([]);
    const config = loadConfig(cpPublicEnv, () => undefined);
    expect(config).toMatchObject({ ROLE: 'public', NODE_ENV: 'production', TRUST_PROXY_HOPS: 1 });
    expect(config.SMTP_HOST).toBeUndefined();
    expect(config.SMTP_PASSWORD).toBeUndefined();
    expect(config.STRIPE_WEBHOOK_SECRET).toBe(webhookSecret);
    expect(config.COOKIE_KEY).toBe(cookieKey);
  });

  it('o ambiente que o Terraform dá ao cp-worker sobe com o grupo do SMTP completo', () => {
    expect(warningsOf(cpWorkerEnv)).toEqual([]);
    const config = loadConfig(cpWorkerEnv, () => undefined);
    expect(config).toMatchObject({
      ROLE: 'worker',
      SMTP_HOST: 'smtp.zoho.com',
      SMTP_PORT: 465,
      MAIL_FROM: 'Verax Control <nao-responda@verax.example>',
    });
    expect(config.STRIPE_WEBHOOK_SECRET).toBeUndefined();
    expect(config.COOKIE_KEY).toBeUndefined();
  });

  it('no worker, SMTP exige usuário, senha e remetente quando o servidor é informado', () => {
    expect(problemsOf({ ...validProductionEnv, SMTP_HOST: 'smtp.zoho.com' })).toEqual([
      'SMTP_USER: obrigatória e não definida',
      'SMTP_PASSWORD: obrigatória e não definida',
      'MAIL_FROM: obrigatória e não definida',
    ]);
    expect(problemsOf({ ...validEnv, COOKIE_KEY: 'curta' })).toEqual([
      'COOKIE_KEY: deve ter pelo menos 32 caracteres',
    ]);
  });

  it('no public, as variáveis comuns do SMTP são ignoradas com aviso; os segredos do worker são recusados', () => {
    const shared = {
      ...validEnv,
      SMTP_HOST: 'smtp.zoho.com',
      SMTP_USER: 'x@verax.example',
      MAIL_FROM: 'x@verax.example',
    };
    expect(warningsOf(shared)).toEqual([
      'SMTP_HOST: só o papel worker usa; ignorada no papel public',
      'SMTP_USER: só o papel worker usa; ignorada no papel public',
      'MAIL_FROM: só o papel worker usa; ignorada no papel public',
    ]);
    const config = loadConfig(shared, () => undefined);
    expect(config.SMTP_HOST).toBeUndefined();
    expect(config.SMTP_USER).toBeUndefined();
    expect(config.MAIL_FROM).toBeUndefined();

    expect(
      problemsOf({ ...validEnv, SMTP_PASSWORD: 'senha-de-teste', CLOUDFLARE_API_TOKEN: 'token-de-teste' }),
    ).toEqual([
      'SMTP_PASSWORD: segredo só do papel worker; não pode estar no papel public',
      'CLOUDFLARE_API_TOKEN: segredo só do papel worker; não pode estar no papel public',
    ]);
  });

  it('no worker, o segredo do webhook e a chave do cookie são recusados', () => {
    expect(
      problemsOf({ ...validProductionEnv, STRIPE_WEBHOOK_SECRET: webhookSecret, COOKIE_KEY: cookieKey }),
    ).toEqual([
      'STRIPE_WEBHOOK_SECRET: segredo só do papel public; não pode estar no papel worker',
      'COOKIE_KEY: segredo só do papel public; não pode estar no papel worker',
    ]);
    expect(warningsOf(validProductionEnv)).toEqual([]);
  });

  it('ROLE_ONLY cobre os cinco segredos do Terraform e só os de um papel', () => {
    const secrets = [...ROLE_ONLY.public.secrets, ...ROLE_ONLY.worker.secrets].sort();
    expect(secrets).toEqual(['CLOUDFLARE_API_TOKEN', 'COOKIE_KEY', 'SMTP_PASSWORD', 'STRIPE_WEBHOOK_SECRET']);
    // A chave da Stripe é lida pelos dois papéis: nunca pode entrar na lista de um só.
    expect(secrets).not.toContain('STRIPE_SECRET_KEY');
  });

  it('MAIL_FROM e MAIL_FROM_NODES aceitam o e-mail puro ou "Nome <e-mail>"', () => {
    for (const value of [
      'nao-responda@verax.example',
      'Verax Control <nao-responda@verax.example>',
      '"Verax, Control" <nao-responda@verax.example>',
      '<nao-responda@verax.example>',
    ]) {
      expect(loadConfig({ ...validProductionEnv, MAIL_FROM_NODES: value }).MAIL_FROM_NODES).toBe(value);
      expect(
        loadConfig(
          {
            ...validProductionEnv,
            SMTP_HOST: 'smtp.zoho.com',
            SMTP_USER: 'u',
            SMTP_PASSWORD: 'p',
            MAIL_FROM: value,
          },
          () => undefined,
        ).MAIL_FROM,
      ).toBe(value);
    }
    for (const bad of [
      'Verax Control nao-responda@verax.example',
      'Verax <nao-e-email>',
      'Verax <nao-responda@verax.example> extra',
      'Ve<rax <nao-responda@verax.example>',
      'Verax\n <nao-responda@verax.example>',
      '"Verax <nao-responda@verax.example>',
    ]) {
      expect(problemsOf({ ...validProductionEnv, MAIL_FROM_NODES: bad })).toEqual([
        'MAIL_FROM_NODES: deve ser um e-mail válido ou "Nome <e-mail>"',
      ]);
    }
  });

  it('converte PORT e rejeita fora do intervalo', () => {
    expect(loadConfig({ ...validEnv, PORT: '3000' }).PORT).toBe(3000);
    expect(problemsOf({ ...validEnv, PORT: '70000' }).some((p) => p.startsWith('PORT:'))).toBe(true);
  });

  it('nunca inclui o valor recebido na mensagem de erro', () => {
    const secret = 'S3nh4-Sup3r-S3cr3t4';
    let message = '';
    try {
      loadConfig(
        {
          ...validEnv,
          STRIPE_SECRET_KEY: secret,
          CLOUDFLARE_ZONE_ID: secret,
          COOKIE_KEY: secret,
          FIRESTORE_EMULATOR_HOST: secret,
          SITE_SUCCESS_URL: `https://${secret}@exemplo.com/`,
          TRUSTED_PROXIES: secret,
        },
        () => undefined,
      );
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of [
      'STRIPE_SECRET_KEY',
      'CLOUDFLARE_ZONE_ID',
      'COOKIE_KEY',
      'FIRESTORE_EMULATOR_HOST',
      'TRUSTED_PROXIES',
    ]) {
      expect(message).toContain(name);
    }
    expect(message).not.toContain(secret);
  });
});

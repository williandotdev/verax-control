import { describe, expect, it } from 'vitest';
import { PROVISIONING_REQUIRED, PROVISIONING_WORKER_REQUIRED, ROLE_ONLY } from './env.schema.js';
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
  // O `run.tf` ainda passa os dois `lookup_key` dos planos fixos; com o preço configurável o app os ignora (o schema
  // não os conhece), até o PR da infraestrutura do cp-admin tirá-los de lá.
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
    expect(problemsOf({ ...validEnv, ROLE: 'operador' })).toEqual(['ROLE: deve ser public, worker ou admin']);
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
      NODE_RELEASE: 'node-v1.2.3',
      MAIL_FROM_NODES: 'nao-responda@verax.example',
    };
    expect(loadConfig(complete).NODES_ZONE).toBe('southamerica-east1-b');
    expect(problemsOf({ ...complete, NODES_ZONE: 'southamerica-east1' })).toEqual([
      'NODES_ZONE: zona GCP inválida',
    ]);
    // O que vai para o Terraform do nó (CP-07): a versão no formato do release e o remetente só com o endereço.
    expect(problemsOf({ ...complete, NODE_RELEASE: 'v2026.11.0' })).toEqual([
      'NODE_RELEASE: com PROVISIONING_ENABLED=true, deve ser a versão do nó (node-vX.Y.Z)',
    ]);
    for (const sender of ['Verax <nao-responda@verax.example>', "o'neil@verax.example"]) {
      expect(problemsOf({ ...complete, MAIL_FROM_NODES: sender })).toEqual([
        'MAIL_FROM_NODES: com PROVISIONING_ENABLED=true, deve ser só o endereço, sem nome e sem apóstrofo',
      ]);
    }
    // Desligado, nada disso é conferido (o NODE_RELEASE antigo continua aceito).
    expect(loadConfig({ ...validEnv, NODE_RELEASE: 'v2026.11.0' }).NODE_RELEASE).toBe('v2026.11.0');
  });

  it('no worker, o provisionamento ligado exige também o Cloudflare, o Firebase e a conta de suporte (CP-07)', () => {
    const worker = {
      ROLE: 'worker',
      NODE_ENV: 'development',
      PROVISIONING_ENABLED: 'true',
      NODES_PROJECT_ID: 'projeto-dos-nos-demo',
      NODES_REGION: 'southamerica-east1',
      NODES_ZONE: 'southamerica-east1-b',
      TFSTATE_BUCKET: 'projeto-dos-nos-demo-tfstate',
      TERRAFORM_JOB_NAME: 'cp-terraform',
      RELEASE_BUCKET: 'projeto-da-verax-demo-releases',
      NODE_RELEASE: 'node-v1.2.3',
      MAIL_FROM_NODES: 'nao-responda@verax.example',
    };
    expect(problemsOf(worker)).toEqual(
      PROVISIONING_WORKER_REQUIRED.map((key) => `${key}: obrigatória e não definida`),
    );
    const complete = {
      ...worker,
      CLOUDFLARE_API_TOKEN: 'token-do-cloudflare-de-teste',
      CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
      CLOUDFLARE_ZONE_ID: '1'.repeat(32),
      FIREBASE_PANEL_PROJECTS: 'paineis-demo-1',
      BOOTSTRAP_SUPPORT_EMAIL: 'suporte@verax.example',
    };
    const config = loadConfig(complete);
    // O registro das imagens do nó: o GHCR público por padrão (decisão do CP-07); o Artifact Registry também serve.
    expect(config.NODE_IMAGES_REPOSITORY).toBe('ghcr.io/williandotdev/verax-control');
    expect(
      loadConfig({
        ...complete,
        NODE_IMAGES_REPOSITORY: 'us-east1-docker.pkg.dev/projeto-demo/verax-control',
      }).NODE_IMAGES_REPOSITORY,
    ).toBe('us-east1-docker.pkg.dev/projeto-demo/verax-control');
    expect(
      problemsOf({ ...complete, NODE_IMAGES_REPOSITORY: 'docker.io/williandotdev/verax-control' }),
    ).toEqual([
      'NODE_IMAGES_REPOSITORY: deve ser ghcr.io/<dono>/<repositório> ou <região>-docker.pkg.dev/<projeto>/<registro>',
    ]);
    // A conta de suporte é só do worker: no public, sai com aviso, sem derrubar.
    expect(warningsOf({ ...validEnv, BOOTSTRAP_SUPPORT_EMAIL: 'suporte@verax.example' })).toHaveLength(1);
    // A conta do console (o grupo `console` das operações do responsável): só uma conta de serviço.
    expect(
      loadConfig({ ...complete, ADMIN_SA_EMAIL: 'cp-admin@projeto-demo.iam.gserviceaccount.com' })
        .ADMIN_SA_EMAIL,
    ).toBe('cp-admin@projeto-demo.iam.gserviceaccount.com');
    expect(problemsOf({ ...complete, ADMIN_SA_EMAIL: 'responsavel@verax.example' })).toEqual([
      'ADMIN_SA_EMAIL: deve ser o e-mail de uma conta de serviço',
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
    expect(Object.keys(config).filter((key) => key.startsWith('STRIPE_PRICE_LOOKUP_'))).toEqual([]);
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

  it('e-mail dos nós: opcional; o servidor e o usuário andam juntos, no formato do node.conf, só no worker', () => {
    const config = loadConfig(cpWorkerEnv, () => undefined);
    expect(config.SMTP_HOST_NODES).toBeUndefined();
    expect(config.SMTP_PORT_NODES).toBe(465);
    const nodes = {
      ...cpWorkerEnv,
      SMTP_HOST_NODES: 'smtp.caixa-exemplo.example',
      SMTP_PORT_NODES: '587',
      SMTP_USER_NODES: 'avisos@verax.example',
    };
    expect(loadConfig(nodes, () => undefined)).toMatchObject({
      SMTP_HOST_NODES: 'smtp.caixa-exemplo.example',
      SMTP_PORT_NODES: 587,
      SMTP_USER_NODES: 'avisos@verax.example',
    });
    expect(problemsOf({ ...cpWorkerEnv, SMTP_HOST_NODES: 'smtp.caixa-exemplo.example' })).toEqual([
      'SMTP_USER_NODES: obrigatória e não definida',
    ]);
    expect(problemsOf({ ...cpWorkerEnv, SMTP_USER_NODES: 'avisos@verax.example' })).toEqual([
      'SMTP_HOST_NODES: obrigatória e não definida',
    ]);
    expect(
      problemsOf({
        ...nodes,
        SMTP_HOST_NODES: 'SMTP.Caixa.example',
        SMTP_PORT_NODES: '70000',
        SMTP_USER_NODES: "o'neil@verax.example",
      }),
    ).toEqual([
      'SMTP_HOST_NODES: deve ser o nome do servidor, em minúsculas (smtp.exemplo.com)',
      'SMTP_PORT_NODES: deve ser uma porta de 1 a 65535',
      'SMTP_USER_NODES: deve ter só letras, números e @ . _ + - (até 254)',
    ]);
    // No cp-public, ignoradas com aviso (como o SMTP do plano de controle).
    expect(
      warningsOf({ ...validEnv, SMTP_HOST_NODES: 'smtp.caixa-exemplo.example', SMTP_USER_NODES: 'avisos' }),
    ).toEqual([
      'SMTP_HOST_NODES: só o papel worker usa; ignorada no papel public',
      'SMTP_USER_NODES: só o papel worker usa; ignorada no papel public',
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
    // O console (admin) não recebe segredo nenhum.
    expect(ROLE_ONLY.admin.secrets).toEqual([]);
  });

  describe('papel admin (console do responsável, atrás do IAP)', () => {
    const audience = '/projects/111111111111/locations/southamerica-east1/services/cp-admin';
    const adminEnv = {
      ROLE: 'admin',
      NODE_ENV: 'production',
      IAP_AUDIENCE: audience,
      OWNER_PRINCIPALS: 'responsavel@verax.example',
    };

    it('sobe com o aud do IAP e a lista de responsáveis; sem eles, não sobe', () => {
      expect(loadConfig(adminEnv)).toMatchObject({
        ROLE: 'admin',
        IAP_AUDIENCE: audience,
        OWNER_PRINCIPALS: ['responsavel@verax.example'],
      });
      expect(problemsOf({ ROLE: 'admin', NODE_ENV: 'production' })).toEqual([
        'IAP_AUDIENCE: obrigatória e não definida',
        'OWNER_PRINCIPALS: obrigatória e não definida',
      ]);
      expect(problemsOf({ ...adminEnv, IAP_AUDIENCE: 'https://cp-admin.example' })).toEqual([
        'IAP_AUDIENCE: deve ser o aud do IAP (/projects/<número>/...)',
      ]);
    });

    it('recusa os segredos dos outros papéis e a chave da Stripe; ignora as variáveis só do worker', () => {
      expect(
        problemsOf({
          ...adminEnv,
          STRIPE_WEBHOOK_SECRET: webhookSecret,
          COOKIE_KEY: cookieKey,
          SMTP_PASSWORD: 'senha-de-teste',
          STRIPE_SECRET_KEY: testKey,
        }),
      ).toEqual([
        'STRIPE_WEBHOOK_SECRET: segredo só do papel public; não pode estar no papel admin',
        'COOKIE_KEY: segredo só do papel public; não pode estar no papel admin',
        'SMTP_PASSWORD: segredo só do papel worker; não pode estar no papel admin',
        'STRIPE_SECRET_KEY: o papel admin não recebe este segredo',
      ]);
      expect(warningsOf({ ...adminEnv, SMTP_HOST: 'smtp.zoho.com' })).toEqual([
        'SMTP_HOST: só o papel worker usa; ignorada no papel admin',
      ]);
    });

    it('IAP_AUDIENCE é só do admin: nos outros papéis é ignorada com aviso', () => {
      expect(warningsOf({ ...validEnv, IAP_AUDIENCE: audience })).toEqual([
        'IAP_AUDIENCE: só o papel admin usa; ignorada no papel public',
      ]);
    });
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

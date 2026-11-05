import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * Papel do processo: a mesma imagem sobe como `cp-public` (rotas públicas), `cp-worker` (passos internos) ou
 * `cp-admin` (console do responsável, atrás do IAP: tabelas de preços e de custos, publicação e DRE).
 */
export const ROLES = ['public', 'worker', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function otherRoles(role: Role): Role[] {
  return ROLES.filter((candidate) => candidate !== role);
}

/** `true`/`false` com padrão. O `.default()` vem antes do `.transform()`: depois dele, o padrão sairia sem converter. */
const boolean = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'], { error: 'deve ser true ou false' })
    .default(fallback)
    .transform((value) => value === 'true');

const httpsUrl = z.url({ protocol: /^https$/, error: 'deve ser uma URL https válida' });

/** Lista separada por vírgula; itens repetidos contam uma vez. */
const list = <T extends z.ZodType<string, string>>(item: T, min = 1) =>
  z
    .string()
    .transform((value) => [...new Set(value.split(',').map((part) => part.trim()))].filter(Boolean))
    .pipe(z.array(item).min(min, { error: 'deve ter ao menos um item' }));

const email = z.email({ error: 'deve ser um e-mail válido' });
const serviceAccountEmail = z.string().regex(/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/, {
  error: 'deve ser o e-mail de uma conta de serviço',
});

/**
 * Remetente de e-mail como o SMTP aceita no `From`: `endereco@dominio` ou `Nome <endereco@dominio>`. O nome não
 * pode ter `<`, `>`, aspas, barra invertida nem quebra de linha (ou vai inteiro entre aspas); o endereço é um e-mail.
 */
const MAILBOX_NAME_PATTERN = /^(?:"[^"\\\r\n]{1,64}"|[^<>"\\\r\n]{1,64})$/;
function isMailbox(value: string): boolean {
  if (value.includes('\r') || value.includes('\n')) return false;
  if (!value.endsWith('>')) return email.safeParse(value).success;
  const open = value.lastIndexOf('<');
  if (open < 0) return false;
  const name = value.slice(0, open).trim();
  const address = value.slice(open + 1, -1);
  return (name === '' || MAILBOX_NAME_PATTERN.test(name)) && email.safeParse(address).success;
}
const mailbox = z
  .string()
  .max(400)
  .refine(isMailbox, { error: 'deve ser um e-mail válido ou "Nome <e-mail>"' });

/** Identificadores da GCP e do Cloudflare, no formato exigido por cada serviço. */
const gcpProjectId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/, { error: 'ID de projeto GCP inválido' });
const gcpRegion = z.string().regex(/^[a-z]+-[a-z]+[0-9]$/, { error: 'região GCP inválida' });
const gcpZone = z.string().regex(/^[a-z]+-[a-z]+[0-9]-[a-z]$/, { error: 'zona GCP inválida' });
const gcsBucket = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/, { error: 'nome de bucket inválido' });
const gcpResourceName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/, { error: 'nome de recurso inválido' });
const cloudflareId = z.string().regex(/^[0-9a-f]{32}$/, { error: 'deve ter 32 dígitos hexadecimais' });
// Classe única e tamanho limitado: tempo linear, sem backtracking (o DNS valida o resto).
const hostname = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/i, { error: 'nome de domínio inválido' });
const hostPort = z.string().regex(/^[a-z0-9.-]+:[0-9]{1,5}$/i, { error: 'deve ter o formato host:porta' });
/** Endereço IP ou bloco CIDR (v4 ou v6), para a lista de proxies confiáveis. */
const ipOrCidr = z.union([z.ipv4(), z.cidrv4(), z.ipv6(), z.cidrv6()], {
  error: 'deve ser um endereço IP ou um bloco CIDR',
});
/** Versão de um texto legal publicado no site, como `2026-11-04` ou `v3`. */
const documentVersion = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, { error: 'versão inválida (letras, números, ponto, traço)' });
const releaseVersion = documentVersion;

/**
 * Versão do nó que o provisionamento instala: o release `node-vX.Y.Z` do manifesto assinado (`scripts/node-release.sh`),
 * o mesmo formato da variável `node_version` do `envs/tenant` e do `boot-install.sh` (PR-N7).
 */
export const NODE_RELEASE_PATTERN = /^node-v(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;
export function isNodeRelease(value: string): boolean {
  return NODE_RELEASE_PATTERN.test(value);
}

const MAIL_LOCAL_BODY = /^[A-Za-z0-9_+.'-]*$/;
const MAIL_LOCAL_END = /^[A-Za-z0-9_+-]$/;
const MAIL_DOMAIN_LABEL = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MAIL_TOP_LABEL = /^[A-Za-z]{2,}$/;

/**
 * O e-mail na forma do `z.email()` do zod 4 e das `validation` do `envs/tenant` (a expressão
 * `^[A-Za-z0-9_'+.-]*[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$`, sem ponto no começo nem dois pontos
 * seguidos), conferida por partes, sem quantificador aninhado: a parte local, cada rótulo do domínio e o último, só de
 * letras. O apóstrofo é aceito aqui; `isNodeMailAddress` o recusa.
 */
export function isMailAddress(value: string): boolean {
  if (value.length > 254 || value.startsWith('.') || value.includes('..')) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const local = value.slice(0, at);
  const labels = value.slice(at + 1).split('.');
  const top = labels.pop();
  return (
    MAIL_LOCAL_BODY.test(local) &&
    MAIL_LOCAL_END.test(local.slice(-1)) &&
    labels.length >= 1 &&
    labels.every((label) => MAIL_DOMAIN_LABEL.test(label)) &&
    top !== undefined &&
    MAIL_TOP_LABEL.test(top)
  );
}

/**
 * Remetente dos e-mails do nó (MAIL_FROM do node.conf): só o endereço, sem "Nome <...>" e sem apóstrofo, que a
 * instalação sem operador recusa (o arquivo de ambiente do `start.sh` não o comporta; `re_mail` do `boot-install.sh`).
 */
export function isNodeMailAddress(value: string): boolean {
  return !value.includes("'") && isMailAddress(value);
}

/**
 * Registro das imagens do Verax (API e migrations) que o nó do cliente usa, pelo digest do manifesto: o GHCR público
 * do repositório (`ghcr.io/<dono>/<repositório>`, sem login e sem limpeza) ou o Artifact Registry do projeto da Verax
 * (`<região>-docker.pkg.dev/<projeto>/<registro>`). Os mesmos dois formatos do `boot-install.sh` e do `envs/tenant`.
 */
const GHCR_REPOSITORY_PATTERN = /^ghcr\.io\/[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/;
const ARTIFACT_REGISTRY_PATTERN =
  /^[a-z0-9-]+-docker\.pkg\.dev\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/[a-z0-9-]{1,63}$/;
export function isNodeImagesRepository(value: string): boolean {
  return GHCR_REPOSITORY_PATTERN.test(value) || ARTIFACT_REGISTRY_PATTERN.test(value);
}
/** O padrão (decisão do CP-07, à espera do responsável): o GHCR público deste repositório, que o PR-N7 já aceita. */
export const DEFAULT_NODE_IMAGES_REPOSITORY = 'ghcr.io/williandotdev/verax-control';

/**
 * Chaves da Stripe: a chave restrita (`rk_`) é a esperada; a completa (`sk_`) passa no formato, mas o responsável
 * foi orientado a não usá-la (plano §9). O trecho `test`/`live` decide o modo e é conferido com `STRIPE_LIVE`.
 */
const stripeSecretKey = z
  .string()
  .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/, { error: 'chave da Stripe em formato inválido' });
const stripeWebhookSecret = z
  .string()
  .regex(/^whsec_[A-Za-z0-9]{8,}$/, { error: 'segredo de webhook da Stripe em formato inválido' });

/**
 * Variáveis que passam a ser obrigatórias com `PROVISIONING_ENABLED=true` (plano §2.5), em qualquer papel. Desde o
 * CP-07, `IMAGES_PROJECT_ID` não está mais aqui: o registro das imagens do nó é `NODE_IMAGES_REPOSITORY` (com padrão),
 * e o projeto do Artifact Registry só importa a quem escolher ele.
 */
export const PROVISIONING_REQUIRED = [
  'NODES_PROJECT_ID',
  'NODES_REGION',
  'NODES_ZONE',
  'TFSTATE_BUCKET',
  'TERRAFORM_JOB_NAME',
  'RELEASE_BUCKET',
  'NODE_RELEASE',
  'MAIL_FROM_NODES',
] as const;

/**
 * As que só o cp-worker precisa para provisionar (CP-07): o token e a zona do Cloudflare (túnel e DNS), os projetos do
 * Firebase dos painéis e o e-mail da conta de suporte da Verax em cada nó (CP-10). Conferidas na partida só no papel
 * worker com `PROVISIONING_ENABLED=true`: o cp-public nunca recebe o token do Cloudflare (`ROLE_ONLY`).
 */
export const PROVISIONING_WORKER_REQUIRED = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_ZONE_ID',
  'FIREBASE_PANEL_PROJECTS',
  'BOOTSTRAP_SUPPORT_EMAIL',
] as const;

const envShape = {
  // Papel
  ROLE: z.enum(ROLES, { error: 'deve ser public, worker ou admin' }),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  // O Cloud Run define PORT (8080 por padrão); o valor precisa bater com a porta do contêiner.
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),

  // IP do cliente (limites por IP, logs). O Cloud Run acrescenta ao X-Forwarded-For o IP de quem se conectou a
  // ele, e esse acréscimo ninguém forja. O IP do cliente é o primeiro endereço não confiável, de trás para a
  // frente (`req.ip` do Express, com a regra de `common/http/client-ip.ts`):
  // - TRUST_PROXY_HOPS: quantos saltos, contados do contêiner, são confiáveis só pela posição. No Cloud Run é 1
  //   (o front end do próprio Cloud Run), e é o padrão, sem depender do Terraform. Com 0 (só fora do Cloud Run),
  //   o X-Forwarded-For é ignorado. Contar 2 para "pular" o Hosting seria forjável: quem chama o run.app direto
  //   está um salto mais perto e escolheria o próprio IP;
  // - TRUSTED_PROXIES: endereços ou blocos CIDR confiáveis em qualquer posição: as saídas do Firebase Hosting
  //   (Fastly) que se conectam ao Cloud Run. Sem a lista, uma requisição pelo Hosting tem como "cliente" a saída
  //   do Hosting, e os limites por IP se juntam num balde só (degradação, não forja). O responsável preenche com
  //   os endereços que aparecem em `req.ip` nos logs do cp-public (ou a lista pública da Fastly); um chamador
  //   direto do run.app continua identificado pelo IP que o Cloud Run acrescentou, o dele.
  // O cabeçalho Fastly-Client-IP não é usado: chamando o run.app direto, qualquer um o forjaria.
  // O Terraform não define nenhuma das duas; o responsável põe TRUSTED_PROXIES (e TRUST_PROXY_HOPS, só se quiser
  // algo diferente do padrão) em `service_env`, as variáveis comuns aos dois serviços.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  TRUSTED_PROXIES: list(ipOrCidr).optional(),

  // Site (CP-03): origens aceitas no CORS, páginas de retorno do Checkout e versões dos textos aceitos. Os links dos
  // textos legais no aceite do Checkout saem da origem de SITE_SUCCESS_URL (`/termos`, `/privacidade`, `/dpa`).
  // Site e Stripe ficam opcionais mesmo no cp-public: sem o grupo completo (`CHECKOUT_REQUIRED`, em
  // checkout/checkout-settings.ts), o serviço sobe, avisa quais faltam e o checkout responde 503.
  SITE_ORIGINS: list(httpsUrl).optional(),
  SITE_SUCCESS_URL: httpsUrl.optional(),
  SITE_CANCEL_URL: httpsUrl.optional(),
  TERMS_VERSION: documentVersion.optional(),
  PRIVACY_VERSION: documentVersion.optional(),
  DPA_VERSION: documentVersion.optional(),

  // Stripe (CP-03 e CP-04). Chaves de teste e de produção são segredos distintos; STRIPE_LIVE diz qual vale (e o
  // webhook ignora evento do outro modo). Sem STRIPE_WEBHOOK_SECRET e STRIPE_SECRET_KEY o webhook responde 503 sem
  // ler nada (a Stripe repete por até 3 dias); a partida avisa quais faltam.
  STRIPE_SECRET_KEY: stripeSecretKey.optional(),
  STRIPE_WEBHOOK_SECRET: stripeWebhookSecret.optional(),
  STRIPE_LIVE: boolean('false'),
  // Os preços não são variáveis: saem da tabela de preços publicada no Firestore (preço configurável). Uma
  // `STRIPE_PRICE_LOOKUP_*` antiga ainda no ambiente é ignorada (o schema não a conhece).
  STRIPE_PORTAL_LOGIN_URL: httpsUrl.optional(),

  // Estado e filas. O banco gratuito do Firestore é o `(default)`; o projeto vem do ambiente do Cloud Run, e só
  // precisa ser informado com o emulador (testes e desenvolvimento), que não tem metadados de projeto.
  FIRESTORE_DATABASE: z
    .string()
    .regex(/^(\(default\)|[a-z0-9-]{4,63})$/, { error: 'nome de banco do Firestore inválido' })
    .default('(default)'),
  FIRESTORE_PROJECT_ID: gcpProjectId.optional(),
  FIRESTORE_EMULATOR_HOST: hostPort.optional(),
  // Cloud Tasks (CP-04): a fila é `projects/<TASKS_PROJECT_ID>/locations/<TASKS_LOCATION>/queues/<nome>`. Sem o grupo
  // inteiro (`STEP_QUEUE_REQUIRED`, em queue/step-queue.module.ts) o serviço sobe e avisa quais faltam, e o webhook
  // que precisar enfileirar responde 500 (a Stripe repete a entrega). O Terraform deriva todas (run.tf).
  TASKS_PROJECT_ID: gcpProjectId.optional(),
  TASKS_LOCATION: gcpRegion.optional(),
  TASKS_QUEUE_PROVISIONING: gcpResourceName.optional(),
  TASKS_QUEUE_LIFECYCLE: gcpResourceName.optional(),
  // Quem chama o cp-worker (contrato com identities.tf e run.tf do Terraform): as tasks e o Scheduler levam o token
  // OIDC da conta `cp-invoker`, a única cujo token chega ao worker; WORKER_SA_EMAIL e SCHEDULER_SA_EMAIL apontam as
  // duas para ela. O worker (CP-07) confere no token `aud == WORKER_URL` e `email` em
  // {WORKER_SA_EMAIL, SCHEDULER_SA_EMAIL} ∪ OWNER_PRINCIPALS; quem enfileira no Cloud Tasks (CP-04 e CP-07) usa
  // WORKER_SA_EMAIL como conta do token (o cp-public e o cp-worker só têm `actAs` na cp-invoker). Tudo isso o
  // Terraform deriva; o responsável não define nenhuma delas em `service_env`.
  WORKER_URL: httpsUrl.optional(),
  WORKER_SA_EMAIL: serviceAccountEmail.optional(),
  SCHEDULER_SA_EMAIL: serviceAccountEmail.optional(),
  OWNER_PRINCIPALS: list(email).optional(),
  // Console do responsável (cp-admin, só ROLE=admin, obrigatória nele): o `aud` que o IAP põe no JWT assinado do
  // cabeçalho `x-goog-iap-jwt-assertion` (o serviço do Cloud Run com o IAP ligado). Para o IAP no Cloud Run, o formato
  // é `/projects/<número>/locations/<região>/services/<nome>` (documentação dos cabeçalhos assinados do IAP, conferida
  // em 04/11/2026); o Terraform (admin.tf) o monta. O e-mail do JWT precisa estar em OWNER_PRINCIPALS, também
  // obrigatória no admin.
  IAP_AUDIENCE: z
    .string()
    .max(300)
    .regex(/^\/projects\/[0-9]{1,20}\/[a-z][a-zA-Z0-9/_-]{1,250}$/, {
      error: 'deve ser o aud do IAP (/projects/<número>/...)',
    })
    .optional(),

  // Provisionamento (CP-07): desligado até existir o projeto dos nós; ligado, exige o grupo inteiro na partida
  // (`PROVISIONING_REQUIRED` e, no worker, `PROVISIONING_WORKER_REQUIRED`). Desligado, o passo `preflight` termina o
  // cliente em `provisioning_failed` com `provisioning_disabled`, sem enfileirar mais nada; o `resume` do responsável
  // retoma depois de ligar.
  PROVISIONING_ENABLED: boolean('false'),
  NODES_PROJECT_ID: gcpProjectId.optional(),
  NODES_REGION: gcpRegion.optional(),
  NODES_ZONE: gcpZone.optional(),
  TFSTATE_BUCKET: gcsBucket.optional(),
  TERRAFORM_JOB_NAME: gcpResourceName.optional(),
  // Projeto do Artifact Registry das imagens do nó (o `cpImagesAccessGranter` do envs/control-plane). O
  // provisionamento não a usa: o registro de cada nó é `NODE_IMAGES_REPOSITORY`.
  IMAGES_PROJECT_ID: gcpProjectId.optional(),
  // Bucket de releases: `<NODE_RELEASE>/manifest.json`, a assinatura e o bundle do painel (o `preflight` e o
  // `firebase.site` leem; a assinatura é conferida com as chaves de release de `infra/node/keys`).
  RELEASE_BUCKET: gcsBucket.optional(),
  // Com o provisionamento ligado, precisa ser `node-vX.Y.Z` (`NODE_RELEASE_PATTERN`).
  NODE_RELEASE: releaseVersion.optional(),
  // Com o provisionamento ligado, precisa ser só o endereço, sem apóstrofo (`NODE_MAIL_PATTERN`).
  MAIL_FROM_NODES: mailbox.optional(),
  // De onde cada nó de cliente baixa a API e as migrations (decisão do CP-07, à espera do responsável): o GHCR público
  // por padrão. O Artifact Registry do projeto da Verax apaga, depois de 30 dias, as versões fora das 3 mais recentes,
  // e um cliente novo numa versão mais antiga não instalaria.
  NODE_IMAGES_REPOSITORY: z
    .string()
    .refine(isNodeImagesRepository, {
      error: 'deve ser ghcr.io/<dono>/<repositório> ou <região>-docker.pkg.dev/<projeto>/<registro>',
    })
    .default(DEFAULT_NODE_IMAGES_REPOSITORY),
  // A conta de suporte da Verax em cada nó de cliente (CP-10): `bootstrap_support_email` do envs/tenant. Só o
  // cp-worker a recebe.
  BOOTSTRAP_SUPPORT_EMAIL: email.optional(),

  // Cloudflare e Firebase (CP-07).
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: cloudflareId.optional(),
  CLOUDFLARE_ZONE_ID: cloudflareId.optional(),
  CLOUDFLARE_ZONE_NAME: hostname.default('veraxsistemas.com.br'),
  PANEL_DOMAIN_SUFFIX: hostname.default('control.veraxsistemas.com.br'),
  API_DOMAIN_PREFIX: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]{0,30})$/, { error: 'prefixo de subdomínio inválido' })
    .default('api-'),
  FIREBASE_PANEL_PROJECTS: list(gcpProjectId).optional(),

  // Acesso e e-mail (CP-05). COOKIE_KEY assina o cookie da página de status: 32 bytes ou mais (só o cp-public).
  // O grupo do SMTP é só do cp-worker (`ROLE_ONLY`): SMTP_HOST e SMTP_PORT têm padrão no `worker_env` do
  // Terraform, SMTP_USER e MAIL_FROM o responsável define lá, e SMTP_PASSWORD vem do Secret Manager.
  COOKIE_KEY: z.string().min(32, { error: 'deve ter pelo menos 32 caracteres' }).optional(),
  // A conta do cp-public (contrato com identities.tf e run.tf, que a derivam): o cp-worker aceita o token dela só na
  // revelação da senha (`POST /internal/access/reveal`), a única rota interna que o cp-public chama; o token das tasks
  // e do Scheduler (a cp-invoker) não serve nessa rota, e o do cp-public não serve nos passos (`worker-caller.ts`).
  PUBLIC_SA_EMAIL: serviceAccountEmail.optional(),
  SMTP_HOST: hostname.optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: mailbox.optional(),
  // Nunca vai a log: só a métrica de alerta cita "owner".
  OWNER_ALERT_EMAIL: email.optional(),
};

export type EnvKey = keyof typeof envShape;

/**
 * Variáveis que só um dos papéis recebe: as mesmas listas de `secrets.tf` (quem lê cada segredo) e `run.tf` (o
 * mapa de variáveis só do worker) em `infra/gcp/envs/control-plane`.
 * - `secrets`: um segredo montado no papel errado é erro de configuração e derruba a partida. O cp-public nunca
 *   carrega a senha do SMTP nem o token do Cloudflare; o cp-worker, nem o segredo do webhook nem a chave do cookie;
 * - `settings`: variável comum do outro papel é tirada do ambiente na partida, com um aviso no log (`loadConfig`),
 *   para uma variável compartilhada por engano não derrubar o serviço. `SMTP_PORT` tem padrão e não entra: sem
 *   `SMTP_HOST` ela não significa nada.
 * Um grupo novo de um papel só (ex.: outro segredo do cp-public) entra aqui, não em regra solta no `superRefine`.
 */
export const ROLE_ONLY: Readonly<Record<Role, { secrets: readonly EnvKey[]; settings: readonly EnvKey[] }>> =
  {
    public: { secrets: ['STRIPE_WEBHOOK_SECRET', 'COOKIE_KEY'], settings: [] },
    worker: {
      secrets: ['SMTP_PASSWORD', 'CLOUDFLARE_API_TOKEN'],
      settings: ['SMTP_HOST', 'SMTP_USER', 'MAIL_FROM', 'BOOTSTRAP_SUPPORT_EMAIL'],
    },
    admin: { secrets: [], settings: ['IAP_AUDIENCE'] },
  };

/**
 * Segredos que o papel admin nunca recebe, além dos de um papel só: o console não fala com a Stripe nesta versão (a
 * conferência dos preços na Stripe é do `stripe-setup` e do checkout), então a chave da Stripe fica fora dele.
 */
export const ADMIN_FORBIDDEN_SECRETS = ['STRIPE_SECRET_KEY'] as const satisfies readonly EnvKey[];

/**
 * Variáveis de ambiente do plano de controle (plano §2.5), validadas na partida: o processo não sobe se alguma
 * obrigatória faltar ou for inválida. Os grupos que só os PRs seguintes usam (site, Stripe, filas, provisionamento,
 * Cloudflare e Firebase, acesso e e-mail) já entram aqui como opcionais com o formato conferido, para que uma
 * configuração errada apareça na partida, e não no meio de um checkout. Cada PR que passar a depender de um grupo
 * decide se ele derruba a partida no papel certo ou só desliga a função: o checkout (CP-03) escolheu desligar
 * (503 `checkout_unavailable`), para o serviço subir e responder `/health` antes de o responsável preencher as
 * versões dos textos legais. A porta de entrada é `loadConfig`, que aplica `ROLE_ONLY.settings` antes.
 */
export const envSchema = z.object(envShape).superRefine((env, ctx) => {
  const production = env.NODE_ENV === 'production';
  if (production && env.TRUST_PROXY_HOPS === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['TRUST_PROXY_HOPS'],
      message: 'deve contar o front end do Cloud Run (1) em produção',
    });
  }
  if (production && env.FIRESTORE_EMULATOR_HOST !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['FIRESTORE_EMULATOR_HOST'],
      message: 'não pode apontar para o emulador em produção',
    });
  }
  if (env.FIRESTORE_EMULATOR_HOST !== undefined && env.FIRESTORE_PROJECT_ID === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['FIRESTORE_PROJECT_ID'],
      message: 'obrigatória com FIRESTORE_EMULATOR_HOST',
    });
  }
  if (env.STRIPE_SECRET_KEY !== undefined) {
    const liveKey = env.STRIPE_SECRET_KEY.includes('_live_');
    if (env.STRIPE_LIVE && !liveKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'chave de teste com STRIPE_LIVE=true',
      });
    }
    if (!env.STRIPE_LIVE && liveKey) {
      ctx.addIssue({
        code: 'custom',
        path: ['STRIPE_SECRET_KEY'],
        message: 'chave de produção com STRIPE_LIVE=false',
      });
    }
  }
  if (env.PROVISIONING_ENABLED) {
    const required: readonly EnvKey[] =
      env.ROLE === 'worker'
        ? [...PROVISIONING_REQUIRED, ...PROVISIONING_WORKER_REQUIRED]
        : PROVISIONING_REQUIRED;
    for (const key of required) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com PROVISIONING_ENABLED=true' });
      }
    }
    // O que vai para o Terraform do nó tem o formato do envs/tenant e da instalação sem operador.
    if (env.NODE_RELEASE !== undefined && !isNodeRelease(env.NODE_RELEASE)) {
      ctx.addIssue({
        code: 'custom',
        path: ['NODE_RELEASE'],
        message: 'com PROVISIONING_ENABLED=true, deve ser a versão do nó (node-vX.Y.Z)',
      });
    }
    if (env.MAIL_FROM_NODES !== undefined && !isNodeMailAddress(env.MAIL_FROM_NODES)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAIL_FROM_NODES'],
        message: 'com PROVISIONING_ENABLED=true, deve ser só o endereço, sem nome e sem apóstrofo',
      });
    }
  }
  // Segredo de outro papel: recusado. (As variáveis comuns de outro papel já saíram em `loadConfig`.)
  for (const other of otherRoles(env.ROLE)) {
    for (const key of ROLE_ONLY[other].secrets) {
      if (env[key] !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `segredo só do papel ${other}; não pode estar no papel ${env.ROLE}`,
        });
      }
    }
  }
  if (env.ROLE === 'admin') {
    for (const key of ADMIN_FORBIDDEN_SECRETS) {
      if (env[key] !== undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'o papel admin não recebe este segredo' });
      }
    }
    // Sem o `aud` do IAP e a lista de responsáveis, o console não teria como conferir quem chama: não sobe.
    for (const key of ['IAP_AUDIENCE', 'OWNER_PRINCIPALS'] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com ROLE=admin' });
      }
    }
  }
  // O grupo do SMTP é do worker (quem envia e-mail): informado o servidor, o resto é obrigatório.
  if (env.ROLE === 'worker' && env.SMTP_HOST !== undefined) {
    for (const key of ['SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const) {
      if (env[key] === undefined) {
        ctx.addIssue({ code: 'custom', path: [key], message: 'obrigatória com SMTP_HOST' });
      }
    }
  }
});

export type Env = z.infer<typeof envSchema>;

/**
 * Catálogo da Stripe do Verax Control (preço por GB/dia), idempotente: um produto por componente, os preços da
 * versão da tabela achados pelo `lookup_key` (mensais em BRL; a implantação do vCISO, avulsa), o cupom e o código
 * promocional. Os componentes são os de `lookupKeysOf` (`src/pricing/pricing.schema.ts`): a base da Plataforma, o
 * GB/dia adicional (a franquia contratada é a quantidade dele na assinatura), o GB/dia excedente, o GB/dia do Dedicado,
 * o serviço e a implantação do vCISO. Roda na conta da chave informada (sandbox primeiro; produção só com `--live`).
 *
 * Nenhum valor comercial está aqui: produtos, preços, valores e os termos do cupom vêm de um arquivo JSON passado com
 * `--catalog <arquivo>`, que fica FORA do repositório (ele é público). O formato está documentado, com valores
 * fictícios, em `apps/control-plane/scripts/catalog.example.json`. Os preços do arquivo precisam ser os da tabela de
 * preços publicada no Firestore (mesmos `lookup_key` e valores): o checkout confere cada preço antes de abrir a sessão
 * e fica indisponível se algum divergir.
 *
 * Uso (Node 24 executa o TypeScript direto, sem build). A chave nunca vai para a linha de comando, o histórico do
 * shell ou a saída: `read -s` não ecoa o que é digitado.
 *
 *   read -rsp 'Chave da Stripe: ' STRIPE_SETUP_KEY && echo && export STRIPE_SETUP_KEY
 *   read -rsp 'Código promocional: ' STRIPE_SETUP_PROMO_CODE && echo && export STRIPE_SETUP_PROMO_CODE
 *   node apps/control-plane/scripts/stripe-setup.ts --catalog=$HOME/verax/catalogo-2026-11-v1.json           # simulação
 *   node apps/control-plane/scripts/stripe-setup.ts --catalog=$HOME/verax/catalogo-2026-11-v1.json --apply   # cria
 *   unset STRIPE_SETUP_KEY STRIPE_SETUP_PROMO_CODE
 *
 * A chave precisa escrever em Products, Prices, Coupons e Promotion Codes: a chave secreta do sandbox, ou uma chave
 * restrita só para isto. Nunca a chave do serviço (`cp-stripe-secret-key`), que não tem essas permissões.
 *
 * O texto do código promocional é decidido na hora (variável STRIPE_SETUP_PROMO_CODE ou `--promo-code`, que fica no
 * histórico do shell) e nunca entra no repositório nem no arquivo do catálogo: quem o lesse queimaria os resgates. A
 * saída mostra só os ids dos objetos e o que foi criado ou mantido.
 *
 * Opções:
 *   --catalog=<arquivo>           o catálogo (JSON, fora do repositório)
 *   --apply                       grava (sem ela, simulação)
 *   --live                        aceita chave de produção (sem ela, só chave de teste)
 *   --promo-code=<texto>          o código promocional (prefira STRIPE_SETUP_PROMO_CODE); exige o cupom no catálogo
 *   --tax-rate-percent=<n>        cria ou acha a alíquota de imposto exclusiva (o "+ impostos") com este percentual
 *                                 (ex.: o da alíquota padrão do modelo de custos) e imprime o id (`txr_...`), que vai
 *                                 em STRIPE_TAX_RATE_ID (abaixo)
 *   --webhook-url=<url>           confere também o endpoint do webhook (abaixo): https://<host>/v1/stripe/webhook
 *   --webhook-secret-name=<nome>  o segredo do Secret Manager que recebe o segredo de assinatura (só na criação)
 *   --gcloud-project=<projeto>    o projeto do segredo, se não for o configurado no gcloud
 *
 * Preços são imutáveis, e cada versão da tabela tem os próprios `lookup_key` (sufixo `_v<n>`): mudar um valor é
 * publicar uma versão nova da tabela com uma chave nova, nunca mover a chave de um preço. Um preço existente que
 * diverge do arquivo (valor, moeda, tipo, intervalo, produto, metadados, inativo) não é alterado: o script relata e para
 * sem gravar nada. O mesmo vale para o cupom (um cupom diferente com o mesmo id exige decisão no Dashboard) e para um
 * código promocional igual ligado a outro cupom. Os metadados de cada preço levam `component`, `variant` (do arquivo) e
 * `tableVersion` (do campo do arquivo): é por eles que o webhook reconhece cada item de uma assinatura.
 *
 * Alíquota do imposto por cima (opcional). Com a tabela de preços sem impostos (`taxMode: exclusive`), o checkout aplica
 * nos itens e na assinatura uma alíquota de imposto exclusiva da Stripe, a de `STRIPE_TAX_RATE_ID`, e a confere a cada
 * sessão contra a alíquota padrão do modelo de custos vigente. Com `--tax-rate-percent=<n>` (o percentual vem na hora,
 * nunca do repositório), o script procura uma alíquota ativa, exclusiva, marcada como a da Verax
 * (`metadata.verax = imposto`) e com esse percentual; sem ela, cria ("Impostos"). Uma alíquota da Stripe não muda de
 * percentual: outro percentual é outra alíquota, com outro id, e a variável precisa ser trocada no cp-public e no
 * cp-admin. A chave precisa escrever em Tax Rates.
 *
 * Endpoint do webhook (CP-04, opcional, plano §9, item 7). Com `--webhook-url`, o script procura o endpoint com essa
 * URL: se não existe, cria com os 13 eventos do plano §4b (`WEBHOOK_EVENTS`) e a versão fixada da API; se existe com
 * outra lista de eventos ou desligado, acerta a lista e religa (o segredo de assinatura não muda); igual, mantém. O
 * segredo de assinatura (`whsec_...`) que a Stripe devolve só na criação NUNCA é impresso nem passa por variável de
 * ambiente ou argumento: vai pelo stdin de `gcloud secrets versions add <segredo> --data-file=-`, um processo filho
 * sem shell (`spawn` com a lista de argumentos), com o nome do segredo vindo de `--webhook-secret-name` (no plano de
 * controle, `cp-stripe-webhook-secret`). Antes de criar, `gcloud secrets describe <segredo>` confirma que o gcloud
 * funciona, está logado e o segredo existe; se a gravação da versão falhar depois da criação, o endpoint é apagado
 * (um segredo que ninguém guardou não serve). O gcloud precisa de permissão para adicionar versão ao segredo
 * (`secretmanager.versions.add`). No Windows o gcloud é um `.cmd`, que o Node não executa sem shell: rode este passo
 * no WSL ou no Cloud Shell (ou crie o endpoint no Workbench, grave o segredo à mão e use o script só para conferir os
 * eventos). A chave da Stripe precisa escrever em Webhook Endpoints. Sem `--catalog`, só o webhook é conferido.
 *
 *   node apps/control-plane/scripts/stripe-setup.ts --apply \
 *     --webhook-url=https://conta.veraxsistemas.com.br/v1/stripe/webhook \
 *     --webhook-secret-name=cp-stripe-webhook-secret --gcloud-project=<projeto-da-verax>
 *
 * Saída: 0 feito (ou simulado), 1 divergência (nada gravado), 2 uso, configuração ou catálogo inválido, 3 erro da
 * Stripe, 4 o gcloud falhou (nada criado na Stripe, ou o endpoint criado foi apagado).
 */
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Stripe from 'stripe';
import { z } from 'zod';

/** A mesma versão fixada do serviço (`src/stripe/stripe-client.ts`); o script não importa do `src` para rodar sem build. */
const STRIPE_API_VERSION = '2026-10-28.endive' satisfies Stripe.LatestApiVersion;

/** A raiz do repositório (público): o catálogo de verdade fica fora dela. */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Os 13 eventos do endpoint (plano §4b). A mesma lista, na mesma ordem, de `HANDLED_EVENT_TYPES` em
 * `src/webhook/stripe-events.ts` (o teste confere).
 */
export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
  'charge.dispute.created',
  'radar.early_fraud_warning.created',
  'customer.updated',
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

/** O caminho do webhook no cp-public (`src/webhook/raw-body.ts`). */
export const WEBHOOK_PATH = '/v1/stripe/webhook';
const WEBHOOK_DESCRIPTION = 'Verax Control: plano de controle (cp-public)';

const KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;
/** A Stripe aceita letras e números no código promocional. */
const PROMO_CODE_PATTERN = /^[A-Za-z0-9]{3,40}$/;
/** Id de segredo do Secret Manager. Classe única: tempo linear. */
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Ids de produto e de cupom e `lookup_key`: o mesmo alfabeto da tabela de preços do plano de controle. */
const stripeKey = z.string().regex(/^[a-z0-9_]{3,64}$/, { error: 'use minúsculas, números e _' });
const label = z.string().trim().min(1).max(250);
const metadataValue = z.string().min(1).max(500);

/**
 * O formato do arquivo do catálogo (`--catalog`), conferido antes de qualquer chamada à Stripe. Os valores são do
 * responsável e vivem fora do repositório; o exemplo `catalog.example.json` tem só valores fictícios.
 */
export const catalogSchema = z
  .strictObject({
    /** Comentário livre (o JSON não tem comentários). Ignorado. */
    _comment: z.string().max(2000).optional(),
    /** A versão da tabela de preços (ex.: `2026-11-v1`): vai aos metadados de cada preço. */
    tableVersion: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'versão inválida' }),
    products: z
      .array(
        z.strictObject({
          id: stripeKey,
          name: label,
          unitLabel: z.string().trim().min(1).max(12).optional(),
        }),
      )
      .min(1)
      .max(50),
    prices: z
      .array(
        z.strictObject({
          lookupKey: stripeKey,
          product: stripeKey,
          /** Centavos de real. */
          unitAmount: z.number().int().min(1).max(100_000_000),
          /** `true`: mensal; `false`: avulso (a implantação, só na primeira fatura). */
          recurring: z.boolean(),
          nickname: label.optional(),
          metadata: z.strictObject({ component: metadataValue, variant: metadataValue }),
        }),
      )
      .min(1)
      .max(100),
    coupon: z
      .strictObject({
        id: stripeKey,
        name: label,
        percentOff: z.number().gt(0).max(100),
        durationInMonths: z.number().int().min(1).max(36),
        maxRedemptions: z.number().int().min(1).max(100_000),
        /** Só produtos com preço mensal: o cupom nunca desconta a implantação. */
        appliesToProducts: z.array(stripeKey).min(1).max(50),
      })
      .optional(),
  })
  .superRefine((catalog, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    const products = new Set(catalog.products.map((product) => product.id));
    if (products.size !== catalog.products.length) issue(['products'], 'produto repetido');
    const keys = catalog.prices.map((price) => price.lookupKey);
    if (new Set(keys).size !== keys.length) issue(['prices'], 'lookup_key repetido');
    catalog.prices.forEach((price, index) => {
      if (!products.has(price.product))
        issue(['prices', index, 'product'], 'produto fora da lista de produtos');
    });
    const oneTime = new Set(catalog.prices.filter((price) => !price.recurring).map((price) => price.product));
    catalog.coupon?.appliesToProducts.forEach((product, index) => {
      if (!products.has(product)) {
        issue(['coupon', 'appliesToProducts', index], 'produto fora da lista de produtos');
      } else if (oneTime.has(product)) {
        issue(
          ['coupon', 'appliesToProducts', index],
          'o cupom não pode descontar um produto avulso (implantação)',
        );
      }
    });
  });
export type Catalog = z.infer<typeof catalogSchema>;
type CatalogPrice = Catalog['prices'][number];
type CatalogCoupon = NonNullable<Catalog['coupon']>;

const EXIT = { ok: 0, conflict: 1, usage: 2, stripe: 3, gcloud: 4 } as const;

/**
 * Roda o `gcloud` com estes argumentos e devolve o código de saída. `input`, quando há, vai só pelo stdin (nunca por
 * argumento, ambiente ou arquivo). Sem o executável, devolve 127.
 */
export type GcloudRunner = (args: readonly string[], input?: string) => Promise<number>;

/** Opções do processo filho: sem shell, stdin só quando há o que mandar, a saída do comando não é mostrada. */
export function childOptions(input?: string): SpawnOptions {
  return { shell: false, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'inherit'] };
}

/** Espera o processo filho terminar, depois de mandar `input` pelo stdin e fechá-lo. Sem o executável, 127. */
export function exitCodeOf(child: ChildProcess, input?: string): Promise<number> {
  return new Promise((resolve) => {
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** O `gcloud` de verdade: executável fixo, argumentos em lista, nada interpretado por shell. */
export const runGcloud: GcloudRunner = (args, input) =>
  exitCodeOf(spawn('gcloud', [...args], childOptions(input)), input);

export interface SetupIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** Só nos testes: a API da Stripe num servidor falso em 127.0.0.1. */
  stripeApi?: { host: string; port: number; protocol: 'http' | 'https' };
  /** Só nos testes: o gcloud de mentira. Em uso, `runGcloud`. */
  gcloud?: GcloudRunner;
}

interface WebhookOptions {
  url: string;
  secretName?: string;
  project?: string;
}

/** A URL do endpoint: https, no caminho do webhook, sem usuário, senha, query nem fragmento. Normalizada. */
function webhookUrlOf(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const clean =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    url.pathname === WEBHOOK_PATH;
  return clean ? url.toString() : undefined;
}

/** Um item do catálogo: o que existe, o que falta e como criar. */
interface Step {
  label: string;
  status: 'keep' | 'create' | 'conflict';
  existingId?: string;
  problems?: string[];
  /** O que a criação faz, para a simulação. */
  plan?: string;
  create?: () => Promise<string>;
}

function brl(cents: number): string {
  return `R$ ${(cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}

function isMissing(error: unknown): boolean {
  return error instanceof Stripe.errors.StripeError && error.statusCode === 404;
}

function differences(checks: readonly [string, unknown, unknown][]): string[] {
  return checks
    .filter(([, expected, found]) => expected !== found)
    .map(([field, expected, found]) => `${field}: esperado ${String(expected)}, encontrado ${String(found)}`);
}

function idOf(value: string | { id: string } | null | undefined): string | null | undefined {
  return typeof value === 'object' && value !== null ? value.id : value;
}

/**
 * Lê e valida o arquivo do catálogo; `undefined` com a mensagem já escrita (só caminhos e problemas, nunca valores).
 * Um arquivo dentro do repositório gera um aviso: o catálogo de verdade tem valores comerciais e fica fora dele.
 */
export function loadCatalog(path: string, out: (line: string) => void): Catalog | undefined {
  const absolute = resolve(path);
  const inside = relative(REPOSITORY_ROOT, absolute);
  if (!inside.startsWith('..') && !inside.startsWith('/') && !/^[A-Za-z]:/.test(inside)) {
    out(
      `aviso: o catálogo ${inside} está dentro do repositório, que é público. O de verdade (com os valores) fica fora ` +
        'dele; o exemplo do repositório só tem valores fictícios.',
    );
  }
  let text: string;
  try {
    // O caminho é o que o responsável passou na linha de comando, de propósito.
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- arquivo indicado pelo operador
    text = readFileSync(absolute, 'utf8');
  } catch {
    out(`--catalog: não consegui ler ${path}.`);
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    out('--catalog: o arquivo não é um JSON válido.');
    return undefined;
  }
  const result = catalogSchema.safeParse(json);
  if (result.success) return result.data;
  out('--catalog inválido:');
  for (const issue of result.error.issues.slice(0, 20)) {
    out(`  ${issue.path.map(String).join('.') || '(raiz)'}: ${issue.message}`);
  }
  return undefined;
}

async function productStep(stripe: Stripe, product: Catalog['products'][number]): Promise<Step> {
  const label = `produto ${product.id}`;
  try {
    const existing = await stripe.products.retrieve(product.id);
    return { label, status: 'keep', existingId: existing.id };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    label,
    status: 'create',
    plan: `"${product.name}"`,
    create: async () =>
      (
        await stripe.products.create({
          id: product.id,
          name: product.name,
          ...(product.unitLabel === undefined ? {} : { unit_label: product.unitLabel }),
        })
      ).id,
  };
}

async function priceStep(stripe: Stripe, price: CatalogPrice, tableVersion: string): Promise<Step> {
  const label = `preço ${price.lookupKey} (${brl(price.unitAmount)}${price.recurring ? '/mês' : ', avulso'})`;
  const metadata = { ...price.metadata, tableVersion };
  const [existing] = (await stripe.prices.list({ lookup_keys: [price.lookupKey], limit: 1 })).data;
  if (existing === undefined) {
    return {
      label,
      status: 'create',
      plan: 'novo',
      create: async () =>
        (
          await stripe.prices.create({
            product: price.product,
            currency: 'brl',
            unit_amount: price.unitAmount,
            ...(price.recurring ? { recurring: { interval: 'month', interval_count: 1 } } : {}),
            lookup_key: price.lookupKey,
            ...(price.nickname === undefined ? {} : { nickname: price.nickname }),
            metadata,
          })
        ).id,
    };
  }
  const problems = differences([
    ['active', true, existing.active],
    ['type', price.recurring ? 'recurring' : 'one_time', existing.type],
    ['currency', 'brl', existing.currency],
    ['unit_amount', price.unitAmount, existing.unit_amount],
    ['recurring.interval', price.recurring ? 'month' : undefined, existing.recurring?.interval],
    ['recurring.interval_count', price.recurring ? 1 : undefined, existing.recurring?.interval_count],
    ['product', price.product, idOf(existing.product)],
    ['metadata.component', metadata.component, existing.metadata['component']],
    ['metadata.variant', metadata.variant, existing.metadata['variant']],
    ['metadata.tableVersion', metadata.tableVersion, existing.metadata['tableVersion']],
  ]);
  return problems.length === 0
    ? { label, status: 'keep', existingId: existing.id }
    : { label, status: 'conflict', existingId: existing.id, problems };
}

/**
 * O percentual de uma alíquota: maior que 0 e menor que 100, com até 4 casas (o que a Stripe guarda), com ponto.
 * Conferido por partes, sem quantificador aninhado na expressão.
 */
function isTaxPercent(value: string): boolean {
  const [whole = '', decimals, extra] = value.split('.');
  return (
    extra === undefined &&
    /^[0-9]{1,2}$/.test(whole) &&
    (decimals === undefined || /^[0-9]{1,4}$/.test(decimals)) &&
    Number(value) > 0
  );
}

/** A marca da alíquota do imposto por cima nos metadados (para não confundir com outra alíquota da conta). */
const TAX_RATE_MARK = { verax: 'imposto' } as const;

async function taxRateStep(stripe: Stripe, percentage: number): Promise<Step> {
  const label = `alíquota de imposto exclusiva de ${percentage}%`;
  const existing = (await stripe.taxRates.list({ active: true, inclusive: false, limit: 100 })).data.find(
    (rate) => rate.metadata?.['verax'] === TAX_RATE_MARK.verax && rate.percentage === percentage,
  );
  if (existing !== undefined) return { label, status: 'keep', existingId: existing.id };
  return {
    label,
    status: 'create',
    plan: 'nova, exclusiva (o imposto por cima do preço)',
    create: async () =>
      (
        await stripe.taxRates.create({
          display_name: 'Impostos',
          description: 'Verax Control: imposto por cima dos preços sem impostos',
          percentage,
          inclusive: false,
          metadata: { ...TAX_RATE_MARK },
        })
      ).id,
  };
}

function sameProducts(expected: readonly string[], found: readonly string[] | undefined): boolean {
  const wanted = [...expected].sort();
  const actual = [...(found ?? [])].sort();
  return wanted.length === actual.length && wanted.every((product, index) => product === actual[index]);
}

async function couponStep(stripe: Stripe, coupon: CatalogCoupon): Promise<Step> {
  const label = `cupom ${coupon.id} (${coupon.percentOff}% por ${coupon.durationInMonths} meses, ${coupon.maxRedemptions} resgates)`;
  try {
    const existing = await stripe.coupons.retrieve(coupon.id, { expand: ['applies_to'] });
    const problems = differences([
      ['percent_off', coupon.percentOff, existing.percent_off],
      ['duration', 'repeating', existing.duration],
      ['duration_in_months', coupon.durationInMonths, existing.duration_in_months],
      ['max_redemptions', coupon.maxRedemptions, existing.max_redemptions],
      ['valid', true, existing.valid],
    ]);
    if (!sameProducts(coupon.appliesToProducts, existing.applies_to?.products)) {
      problems.push(
        `applies_to.products: esperado ${[...coupon.appliesToProducts].sort().join(', ')}, encontrado ` +
          `${[...(existing.applies_to?.products ?? [])].sort().join(', ') || 'todos'}`,
      );
    }
    return problems.length === 0
      ? { label, status: 'keep', existingId: existing.id }
      : { label, status: 'conflict', existingId: existing.id, problems };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    label,
    status: 'create',
    plan: `novo, só nos produtos ${coupon.appliesToProducts.join(', ')}`,
    create: async () =>
      (
        await stripe.coupons.create({
          id: coupon.id,
          name: coupon.name,
          percent_off: coupon.percentOff,
          duration: 'repeating',
          duration_in_months: coupon.durationInMonths,
          max_redemptions: coupon.maxRedemptions,
          applies_to: { products: [...coupon.appliesToProducts] },
        })
      ).id,
  };
}

async function promotionCodeStep(stripe: Stripe, code: string, couponId: string): Promise<Step> {
  // O texto do código fica fora da saída: só o id do objeto aparece.
  const label = 'código promocional (texto omitido)';
  const existing = (await stripe.promotionCodes.list({ code, limit: 100 })).data.find(
    (promotion) => promotion.code.toLowerCase() === code.toLowerCase(),
  );
  if (existing !== undefined) {
    const coupon = existing.promotion.coupon;
    const problems = differences([
      ['cupom', couponId, idOf(coupon)],
      ['active', true, existing.active],
    ]);
    return problems.length === 0
      ? { label, status: 'keep', existingId: existing.id }
      : { label, status: 'conflict', existingId: existing.id, problems };
  }
  return {
    label,
    status: 'create',
    plan: `novo, no cupom ${couponId}`,
    create: async () =>
      (
        await stripe.promotionCodes.create({
          promotion: { type: 'coupon', coupon: couponId },
          code,
          active: true,
        })
      ).id,
  };
}

/**
 * O endpoint do webhook (CP-04): mantém, acerta os eventos ou cria. Na criação, o segredo de assinatura vai do
 * retorno da Stripe direto para o stdin do gcloud, sem passar pela saída; o gcloud é conferido antes, e o endpoint é
 * apagado se a gravação falhar.
 */
async function webhookStep(
  stripe: Stripe,
  options: WebhookOptions,
  apply: boolean,
  out: SetupIo['out'],
  gcloud: GcloudRunner,
): Promise<number> {
  const label = `endpoint do webhook ${options.url}`;
  const wanted = WEBHOOK_EVENTS as readonly string[];
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find(
    (endpoint) => endpoint.url === options.url,
  );
  if (existing !== undefined) {
    const missing = wanted.filter((event) => !existing.enabled_events.includes(event));
    const extra = existing.enabled_events.filter((event) => !wanted.includes(event));
    const disabled = existing.status === 'disabled';
    if (existing.api_version !== null && existing.api_version !== STRIPE_API_VERSION) {
      out(
        `${label}: api_version ${existing.api_version}, diferente da fixada (${STRIPE_API_VERSION}); o webhook relê ` +
          'os objetos pela API e não depende dela, mas, para alinhar, apague o endpoint no Workbench e rode de novo',
      );
    }
    if (missing.length === 0 && extra.length === 0 && !disabled) {
      out(`${label}: mantido ${existing.id}`);
      return EXIT.ok;
    }
    const changes = [
      ...(missing.length > 0 ? [`faltam ${missing.join(', ')}`] : []),
      ...(extra.length > 0 ? [`sobram ${extra.join(', ')}`] : []),
      ...(disabled ? ['desligado'] : []),
    ].join('; ');
    if (!apply) {
      out(`${label}: atualizaria ${existing.id} (${changes})`);
      return EXIT.ok;
    }
    await stripe.webhookEndpoints.update(existing.id, {
      enabled_events: [...WEBHOOK_EVENTS],
      disabled: false,
    });
    out(`${label}: atualizado ${existing.id} (${changes}); o segredo de assinatura não muda`);
    return EXIT.ok;
  }

  if (options.secretName === undefined) {
    out(
      `${label}: não existe. Para criá-lo, informe --webhook-secret-name=<segredo>: o segredo de assinatura vai ` +
        'direto para o Secret Manager, sem aparecer na tela.',
    );
    return apply ? EXIT.usage : EXIT.ok;
  }
  if (!apply) {
    out(
      `${label}: criaria (${WEBHOOK_EVENTS.length} eventos, api_version ${STRIPE_API_VERSION}); o segredo de ` +
        `assinatura iria como nova versão de ${options.secretName}, sem aparecer na tela`,
    );
    return EXIT.ok;
  }

  const projectArgs = options.project === undefined ? [] : ['--project', options.project];
  const ready = await gcloud(['secrets', 'describe', options.secretName, ...projectArgs]);
  if (ready !== 0) {
    out(
      `gcloud não confirmou o segredo ${options.secretName} (saída ${ready}): nada foi criado na Stripe. Confira o ` +
        'login (gcloud auth login), o projeto e o nome do segredo; no Windows, rode este passo no WSL ou no Cloud Shell.',
    );
    return EXIT.gcloud;
  }
  const created = await stripe.webhookEndpoints.create({
    url: options.url,
    enabled_events: [...WEBHOOK_EVENTS],
    api_version: STRIPE_API_VERSION,
    description: WEBHOOK_DESCRIPTION,
  });
  const signing = created.secret;
  const stored =
    signing === undefined || signing === ''
      ? -1
      : await gcloud(
          ['secrets', 'versions', 'add', options.secretName, '--data-file=-', ...projectArgs],
          signing,
        );
  if (stored === 0) {
    out(
      `${label}: criado ${created.id}; segredo de assinatura gravado como nova versão de ${options.secretName}`,
    );
    return EXIT.ok;
  }
  try {
    await stripe.webhookEndpoints.del(created.id);
    out(
      `gcloud não gravou o segredo de assinatura (saída ${stored}): o endpoint ${created.id} foi apagado, para não ` +
        'ficar um segredo que ninguém guardou. Resolva e rode de novo.',
    );
  } catch {
    out(
      `gcloud não gravou o segredo de assinatura (saída ${stored}) e o endpoint ${created.id} não pôde ser apagado: ` +
        'apague-o no Workbench antes de rodar de novo.',
    );
  }
  return EXIT.gcloud;
}

function usage(out: SetupIo['out']): void {
  out('Uso:');
  out("  read -rsp 'Chave da Stripe: ' STRIPE_SETUP_KEY && echo && export STRIPE_SETUP_KEY");
  out("  read -rsp 'Código promocional: ' STRIPE_SETUP_PROMO_CODE && echo && export STRIPE_SETUP_PROMO_CODE");
  out(
    '  node apps/control-plane/scripts/stripe-setup.ts --catalog=<arquivo fora do repositório> [--apply] [--live]',
  );
  out(
    '      [--webhook-url=https://<host>/v1/stripe/webhook --webhook-secret-name=<segredo> [--gcloud-project=<id>]]',
  );
  out('      [--tax-rate-percent=<n>]  (a alíquota do imposto por cima; o id vai em STRIPE_TAX_RATE_ID)');
  out('  unset STRIPE_SETUP_KEY STRIPE_SETUP_PROMO_CODE');
  out('O formato do catálogo está em apps/control-plane/scripts/catalog.example.json (valores fictícios).');
}

/** Lê e confere as opções do webhook; `undefined` sem `--webhook-url`; `'invalid'` com a mensagem já escrita. */
function webhookOptions(
  values: { 'webhook-url'?: string; 'webhook-secret-name'?: string; 'gcloud-project'?: string },
  out: SetupIo['out'],
): WebhookOptions | undefined | 'invalid' {
  const rawUrl = values['webhook-url'];
  const secretName = values['webhook-secret-name'];
  const project = values['gcloud-project'];
  if (rawUrl === undefined) {
    if (secretName === undefined && project === undefined) return undefined;
    out('--webhook-secret-name e --gcloud-project só valem com --webhook-url.');
    return 'invalid';
  }
  const url = webhookUrlOf(rawUrl);
  if (url === undefined) {
    out(`--webhook-url inválida: https://<host>${WEBHOOK_PATH}, sem usuário, query nem fragmento.`);
    return 'invalid';
  }
  if (secretName !== undefined && !SECRET_ID_PATTERN.test(secretName)) {
    out('--webhook-secret-name inválido: letras, números, hífen e sublinhado.');
    return 'invalid';
  }
  if (project !== undefined && !GCP_PROJECT_PATTERN.test(project)) {
    out('--gcloud-project inválido: o id do projeto GCP.');
    return 'invalid';
  }
  return { url, secretName, project };
}

/** O que um erro da Stripe pode mostrar: tipo, código, status e id da requisição; nunca a mensagem. */
function describeError(error: unknown): string {
  if (error instanceof Stripe.errors.StripeError) {
    return [error.type, error.code, error.statusCode, error.requestId]
      .filter((part) => part !== undefined)
      .join(' ');
  }
  return error instanceof Error ? error.name : 'erro desconhecido';
}

export async function main(io: SetupIo): Promise<number> {
  const { out } = io;
  // As mensagens da validação do catálogo em português, como no serviço.
  z.config(z.locales.ptBR());
  let args;
  try {
    args = parseArgs({
      args: [...io.argv],
      options: {
        catalog: { type: 'string' },
        apply: { type: 'boolean', default: false },
        live: { type: 'boolean', default: false },
        'promo-code': { type: 'string' },
        'tax-rate-percent': { type: 'string' },
        'webhook-url': { type: 'string' },
        'webhook-secret-name': { type: 'string' },
        'gcloud-project': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    usage(out);
    return EXIT.usage;
  }
  if (args.help) {
    usage(out);
    return EXIT.ok;
  }

  const apiKey = io.env['STRIPE_SETUP_KEY'];
  if (apiKey === undefined || apiKey === '') {
    out(
      'STRIPE_SETUP_KEY não definida. Leia a chave sem eco (ela não vai para o histórico nem para a tela):',
    );
    usage(out);
    return EXIT.usage;
  }
  if (!KEY_PATTERN.test(apiKey)) {
    out('STRIPE_SETUP_KEY em formato inválido (esperado sk_ ou rk_, test ou live).');
    return EXIT.usage;
  }
  const live = apiKey.includes('_live_');
  if (live !== args.live) {
    out(
      live
        ? 'A chave é de produção: confirme com --live (o plano roda o sandbox primeiro).'
        : 'A chave é de teste, mas --live foi pedido: use a chave de produção ou tire --live.',
    );
    return EXIT.usage;
  }
  const promoCode = args['promo-code'] ?? io.env['STRIPE_SETUP_PROMO_CODE'];
  if (promoCode !== undefined && promoCode !== '' && !PROMO_CODE_PATTERN.test(promoCode)) {
    out('Código promocional inválido: 3 a 40 letras e números, sem espaço nem símbolo.');
    return EXIT.usage;
  }
  const webhook = webhookOptions(args, out);
  if (webhook === 'invalid') return EXIT.usage;
  const rawTaxPercent = args['tax-rate-percent'];
  const taxPercent = rawTaxPercent === undefined ? undefined : Number(rawTaxPercent);
  if (rawTaxPercent !== undefined && (!isTaxPercent(rawTaxPercent) || taxPercent === undefined)) {
    out('--tax-rate-percent inválido: o percentual da alíquota, maior que 0 e menor que 100 (ex.: 7.5).');
    return EXIT.usage;
  }
  if (args.catalog === undefined && webhook === undefined && taxPercent === undefined) {
    out(
      'Informe --catalog=<arquivo> (o catálogo de preços), --tax-rate-percent (a alíquota do imposto por cima) ' +
        'e/ou --webhook-url (o endpoint do webhook).',
    );
    usage(out);
    return EXIT.usage;
  }
  const catalog = args.catalog === undefined ? undefined : loadCatalog(args.catalog, out);
  if (args.catalog !== undefined && catalog === undefined) return EXIT.usage;
  const withPromo = promoCode !== undefined && promoCode !== '';
  if (catalog !== undefined && withPromo && catalog.coupon === undefined) {
    out('Código promocional informado, mas o catálogo não tem cupom: o código precisa de um cupom.');
    return EXIT.usage;
  }

  const stripe = new Stripe(apiKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 20_000,
    telemetry: false,
    appInfo: { name: 'verax-stripe-setup' },
    ...io.stripeApi,
  });
  out(`Stripe: modo de ${live ? 'PRODUÇÃO' : 'teste'} (a conta da chave informada).`);
  out(
    args.apply
      ? 'Gravando o que falta.'
      : 'Simulação: nada é gravado. Rode com --apply para criar o que falta.',
  );

  try {
    if (catalog !== undefined) {
      out(
        `Catálogo da tabela ${catalog.tableVersion}: ${catalog.products.length} produtos, ${catalog.prices.length} preços.`,
      );
      const steps: Step[] = [];
      for (const product of catalog.products) steps.push(await productStep(stripe, product));
      for (const price of catalog.prices) steps.push(await priceStep(stripe, price, catalog.tableVersion));
      if (catalog.coupon === undefined) {
        out('cupom: o catálogo não tem, pulado');
      } else {
        steps.push(await couponStep(stripe, catalog.coupon));
        if (withPromo) steps.push(await promotionCodeStep(stripe, promoCode, catalog.coupon.id));
        else out('código promocional: não informado (STRIPE_SETUP_PROMO_CODE), pulado');
      }

      const conflicts = steps.filter((step) => step.status === 'conflict');
      if (conflicts.length > 0) {
        for (const step of conflicts) {
          out(`${step.label}: diverge em ${step.existingId ?? '?'} (${(step.problems ?? []).join('; ')})`);
        }
        out(
          'Nada foi gravado. Preços e cupons são imutáveis: um valor novo é um preço novo, com outro lookup_key, ' +
            'numa versão nova da tabela; cupom ou código promocional divergente se resolve no Dashboard.',
        );
        return EXIT.conflict;
      }

      for (const step of steps) {
        if (step.status === 'keep') {
          out(`${step.label}: mantido ${step.existingId ?? ''}`.trimEnd());
        } else if (!args.apply) {
          out(`${step.label}: criaria (${step.plan ?? 'novo'})`);
        } else if (step.create !== undefined) {
          out(`${step.label}: criado ${await step.create()}`);
        }
      }
    }
    if (taxPercent !== undefined) {
      const step = await taxRateStep(stripe, taxPercent);
      if (step.status === 'keep') {
        out(`${step.label}: mantida ${step.existingId ?? ''}`.trimEnd());
        out(`STRIPE_TAX_RATE_ID=${step.existingId ?? ''} (no service_env do cp-public e do cp-admin)`);
      } else if (!args.apply) {
        out(`${step.label}: criaria (${step.plan ?? 'nova'})`);
      } else if (step.create !== undefined) {
        const id = await step.create();
        out(`${step.label}: criada ${id}`);
        out(`STRIPE_TAX_RATE_ID=${id} (no service_env do cp-public e do cp-admin)`);
      }
    }
    if (webhook === undefined) return EXIT.ok;
    return await webhookStep(stripe, webhook, args.apply, out, io.gcloud ?? runGcloud);
  } catch (error) {
    out(
      `Erro da Stripe: ${describeError(error)}. O que já foi criado fica; rodar de novo continua de onde parou.`,
    );
    return EXIT.stripe;
  }
}

if (import.meta.main) {
  process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    out: (line) => console.log(line),
  });
}

/**
 * Catálogo da Stripe do Verax Control, idempotente (plano da fase 3, §9, item 1): o produto "Verax Control", os dois
 * preços mensais em BRL achados pelo `lookup_key` e o cupom dos fundadores (30% por 12 meses, 5 resgates) com o
 * código promocional. Roda na conta da chave informada (sandbox primeiro; produção só com `--live`).
 *
 * Uso (Node 24 executa o TypeScript direto, sem build). A chave nunca vai para a linha de comando, o histórico do
 * shell ou a saída: `read -s` não ecoa o que é digitado.
 *
 *   read -rsp 'Chave da Stripe: ' STRIPE_SETUP_KEY && echo && export STRIPE_SETUP_KEY
 *   read -rsp 'Código promocional dos fundadores: ' STRIPE_SETUP_PROMO_CODE && echo && export STRIPE_SETUP_PROMO_CODE
 *   node apps/control-plane/scripts/stripe-setup.ts            # simulação: só lê e mostra o que faria
 *   node apps/control-plane/scripts/stripe-setup.ts --apply    # cria o que falta
 *   unset STRIPE_SETUP_KEY STRIPE_SETUP_PROMO_CODE
 *
 * A chave precisa escrever em Products, Prices, Coupons e Promotion Codes: a chave secreta do sandbox, ou uma chave
 * restrita só para isto. Nunca a chave do serviço (`cp-stripe-secret-key`), que não tem essas permissões.
 *
 * O texto do código promocional é decidido na hora (variável STRIPE_SETUP_PROMO_CODE ou `--promo-code`, que fica no
 * histórico do shell) e nunca entra no repositório: ele é público, e quem o lesse queimaria os 5 resgates. A saída
 * mostra só os ids dos objetos e o que foi criado ou mantido.
 *
 * Opções:
 *   --apply                       grava (sem ela, simulação)
 *   --live                        aceita chave de produção (sem ela, só chave de teste)
 *   --promo-code=<texto>          o código promocional (prefira STRIPE_SETUP_PROMO_CODE)
 *   --transfer-lookup-key         se um preço existente divergir, cria um preço novo e move o `lookup_key` para ele
 *   --webhook-url=<url>           confere também o endpoint do webhook (abaixo): https://<host>/v1/stripe/webhook
 *   --webhook-secret-name=<nome>  o segredo do Secret Manager que recebe o segredo de assinatura (só na criação)
 *   --gcloud-project=<projeto>    o projeto do segredo, se não for o configurado no gcloud
 *
 * Preços são imutáveis: um preço existente que diverge do esperado (valor, moeda, intervalo, produto, inativo) não é
 * alterado; o script relata e para sem gravar nada. Trocar o preço é criar outro com `transfer_lookup_key`, e só com
 * `--transfer-lookup-key`. O mesmo vale para o cupom (sem saída automática: um cupom diferente com o mesmo id exige
 * decisão no Dashboard) e para um código promocional igual ligado a outro cupom.
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
 * eventos). A chave da Stripe precisa escrever em Webhook Endpoints.
 *
 *   node apps/control-plane/scripts/stripe-setup.ts --apply \
 *     --webhook-url=https://conta.veraxsistemas.com.br/v1/stripe/webhook \
 *     --webhook-secret-name=cp-stripe-webhook-secret --gcloud-project=<projeto-da-verax>
 *
 * Saída: 0 feito (ou simulado), 1 divergência (nada gravado), 2 uso ou configuração, 3 erro da Stripe, 4 o gcloud
 * falhou (nada criado na Stripe, ou o endpoint criado foi apagado).
 */
import { type ChildProcess, spawn, type SpawnOptions } from 'node:child_process';
import { parseArgs } from 'node:util';
import Stripe from 'stripe';

/** A mesma versão fixada do serviço (`src/stripe/stripe-client.ts`); o script não importa do `src` para rodar sem build. */
const STRIPE_API_VERSION = '2026-10-28.endive' satisfies Stripe.LatestApiVersion;

export const PRODUCT = { id: 'verax_control', name: 'Verax Control' } as const;

export const PLAN_PRICES = [
  {
    plan: 'essencial',
    lookupKey: 'verax_control_essencial_mensal',
    unitAmount: 249_000,
    nickname: 'Essencial mensal',
  },
  {
    plan: 'profissional',
    lookupKey: 'verax_control_profissional_mensal',
    unitAmount: 499_000,
    nickname: 'Profissional mensal',
  },
] as const;

export const FOUNDERS_COUPON = {
  id: 'verax_fundadores_30',
  name: 'Fundadores: 30% por 12 meses',
  percentOff: 30,
  durationInMonths: 12,
  maxRedemptions: 5,
} as const;

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

async function productStep(stripe: Stripe): Promise<Step> {
  const label = `produto ${PRODUCT.id}`;
  try {
    const product = await stripe.products.retrieve(PRODUCT.id);
    return { label, status: 'keep', existingId: product.id };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    label,
    status: 'create',
    plan: `"${PRODUCT.name}"`,
    create: async () => (await stripe.products.create({ id: PRODUCT.id, name: PRODUCT.name })).id,
  };
}

async function priceStep(
  stripe: Stripe,
  price: (typeof PLAN_PRICES)[number],
  transferLookupKey: boolean,
): Promise<Step> {
  const label = `preço ${price.lookupKey} (${brl(price.unitAmount)}/mês)`;
  const create = (transfer: boolean) => async () =>
    (
      await stripe.prices.create({
        product: PRODUCT.id,
        currency: 'brl',
        unit_amount: price.unitAmount,
        recurring: { interval: 'month', interval_count: 1 },
        lookup_key: price.lookupKey,
        ...(transfer ? { transfer_lookup_key: true } : {}),
        nickname: price.nickname,
        metadata: { plan: price.plan },
      })
    ).id;
  const [existing] = (await stripe.prices.list({ lookup_keys: [price.lookupKey], limit: 1 })).data;
  if (existing === undefined) return { label, status: 'create', plan: 'novo', create: create(false) };
  const productId = typeof existing.product === 'string' ? existing.product : existing.product.id;
  const problems = differences([
    ['active', true, existing.active],
    ['type', 'recurring', existing.type],
    ['currency', 'brl', existing.currency],
    ['unit_amount', price.unitAmount, existing.unit_amount],
    ['recurring.interval', 'month', existing.recurring?.interval],
    ['recurring.interval_count', 1, existing.recurring?.interval_count],
    ['product', PRODUCT.id, productId],
  ]);
  if (problems.length === 0) return { label, status: 'keep', existingId: existing.id };
  if (!transferLookupKey) return { label, status: 'conflict', existingId: existing.id, problems };
  return {
    label,
    status: 'create',
    existingId: existing.id,
    problems,
    plan: `novo, com o lookup_key transferido de ${existing.id}`,
    create: create(true),
  };
}

async function couponStep(stripe: Stripe): Promise<Step> {
  const coupon = FOUNDERS_COUPON;
  const label = `cupom ${coupon.id} (${coupon.percentOff}% por ${coupon.durationInMonths} meses, ${coupon.maxRedemptions} resgates)`;
  try {
    const existing = await stripe.coupons.retrieve(coupon.id);
    const problems = differences([
      ['percent_off', coupon.percentOff, existing.percent_off],
      ['duration', 'repeating', existing.duration],
      ['duration_in_months', coupon.durationInMonths, existing.duration_in_months],
      ['max_redemptions', coupon.maxRedemptions, existing.max_redemptions],
      ['valid', true, existing.valid],
    ]);
    return problems.length === 0
      ? { label, status: 'keep', existingId: existing.id }
      : { label, status: 'conflict', existingId: existing.id, problems };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return {
    label,
    status: 'create',
    plan: 'novo',
    create: async () =>
      (
        await stripe.coupons.create({
          id: coupon.id,
          name: coupon.name,
          percent_off: coupon.percentOff,
          duration: 'repeating',
          duration_in_months: coupon.durationInMonths,
          max_redemptions: coupon.maxRedemptions,
        })
      ).id,
  };
}

async function promotionCodeStep(stripe: Stripe, code: string): Promise<Step> {
  // O texto do código fica fora da saída: só o id do objeto aparece.
  const label = 'código promocional dos fundadores (texto omitido)';
  const existing = (await stripe.promotionCodes.list({ code, limit: 100 })).data.find(
    (promotion) => promotion.code.toLowerCase() === code.toLowerCase(),
  );
  if (existing !== undefined) {
    const coupon = existing.promotion.coupon;
    const couponId = typeof coupon === 'string' || coupon === null ? coupon : coupon.id;
    const problems = differences([
      ['cupom', FOUNDERS_COUPON.id, couponId],
      ['active', true, existing.active],
    ]);
    return problems.length === 0
      ? { label, status: 'keep', existingId: existing.id }
      : { label, status: 'conflict', existingId: existing.id, problems };
  }
  return {
    label,
    status: 'create',
    plan: `novo, no cupom ${FOUNDERS_COUPON.id}`,
    create: async () =>
      (
        await stripe.promotionCodes.create({
          promotion: { type: 'coupon', coupon: FOUNDERS_COUPON.id },
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
  out(
    "  read -rsp 'Código promocional dos fundadores: ' STRIPE_SETUP_PROMO_CODE && echo && export STRIPE_SETUP_PROMO_CODE",
  );
  out('  node apps/control-plane/scripts/stripe-setup.ts [--apply] [--live] [--transfer-lookup-key]');
  out(
    '      [--webhook-url=https://<host>/v1/stripe/webhook --webhook-secret-name=<segredo> [--gcloud-project=<id>]]',
  );
  out('  unset STRIPE_SETUP_KEY STRIPE_SETUP_PROMO_CODE');
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
  let args;
  try {
    args = parseArgs({
      args: [...io.argv],
      options: {
        apply: { type: 'boolean', default: false },
        live: { type: 'boolean', default: false },
        'promo-code': { type: 'string' },
        'transfer-lookup-key': { type: 'boolean', default: false },
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
    const steps: Step[] = [await productStep(stripe)];
    for (const price of PLAN_PRICES) steps.push(await priceStep(stripe, price, args['transfer-lookup-key']));
    steps.push(await couponStep(stripe));
    if (promoCode === undefined || promoCode === '') {
      out('código promocional: não informado (STRIPE_SETUP_PROMO_CODE), pulado');
    } else {
      steps.push(await promotionCodeStep(stripe, promoCode));
    }

    const conflicts = steps.filter((step) => step.status === 'conflict');
    if (conflicts.length > 0) {
      for (const step of conflicts) {
        out(`${step.label}: diverge em ${step.existingId ?? '?'} (${(step.problems ?? []).join('; ')})`);
      }
      out(
        'Nada foi gravado. Preços e cupons são imutáveis: para trocar um preço, rode com --transfer-lookup-key ' +
          '(cria um preço novo e move o lookup_key); cupom ou código promocional divergente se resolve no Dashboard.',
      );
      return EXIT.conflict;
    }

    for (const step of steps) {
      if (step.status === 'keep') {
        out(`${step.label}: mantido ${step.existingId ?? ''}`.trimEnd());
      } else if (!args.apply) {
        const diverges = step.problems === undefined ? '' : `; o atual diverge: ${step.problems.join('; ')}`;
        out(`${step.label}: criaria (${step.plan ?? 'novo'}${diverges})`);
      } else if (step.create !== undefined) {
        const id = await step.create();
        out(
          `${step.label}: criado ${id}${step.existingId === undefined ? '' : ` (o anterior ${step.existingId} continua; arquive-o no Dashboard se não tiver assinatura)`}`,
        );
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

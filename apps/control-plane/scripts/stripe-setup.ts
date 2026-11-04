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
 *   --apply                 grava (sem ela, simulação)
 *   --live                  aceita chave de produção (sem ela, só chave de teste)
 *   --promo-code=<texto>    o código promocional (prefira STRIPE_SETUP_PROMO_CODE)
 *   --transfer-lookup-key   se um preço existente divergir, cria um preço novo e move o `lookup_key` para ele
 *
 * Preços são imutáveis: um preço existente que diverge do esperado (valor, moeda, intervalo, produto, inativo) não é
 * alterado; o script relata e para sem gravar nada. Trocar o preço é criar outro com `transfer_lookup_key`, e só com
 * `--transfer-lookup-key`. O mesmo vale para o cupom (sem saída automática: um cupom diferente com o mesmo id exige
 * decisão no Dashboard) e para um código promocional igual ligado a outro cupom.
 *
 * Saída: 0 feito (ou simulado), 1 divergência (nada gravado), 2 uso ou configuração, 3 erro da Stripe.
 */
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

const KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9]{8,}$/;
/** A Stripe aceita letras e números no código promocional. */
const PROMO_CODE_PATTERN = /^[A-Za-z0-9]{3,40}$/;

const EXIT = { ok: 0, conflict: 1, usage: 2, stripe: 3 } as const;

export interface SetupIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  out: (line: string) => void;
  /** Só nos testes: a API da Stripe num servidor falso em 127.0.0.1. */
  stripeApi?: { host: string; port: number; protocol: 'http' | 'https' };
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

function usage(out: SetupIo['out']): void {
  out('Uso:');
  out("  read -rsp 'Chave da Stripe: ' STRIPE_SETUP_KEY && echo && export STRIPE_SETUP_KEY");
  out(
    "  read -rsp 'Código promocional dos fundadores: ' STRIPE_SETUP_PROMO_CODE && echo && export STRIPE_SETUP_PROMO_CODE",
  );
  out('  node apps/control-plane/scripts/stripe-setup.ts [--apply] [--live] [--transfer-lookup-key]');
  out('  unset STRIPE_SETUP_KEY STRIPE_SETUP_PROMO_CODE');
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
    return EXIT.ok;
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

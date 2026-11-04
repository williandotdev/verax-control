import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FOUNDERS_COUPON, main, PLAN_PRICES, PRODUCT } from '../scripts/stripe-setup.js';
import type { StripeApiOptions } from '../src/stripe/stripe-client.js';
import { FakeStripe, fakeStripeKey, formEntries } from './support/fake-stripe.js';

/**
 * O `stripe-setup` contra o servidor falso da Stripe: cria o catálogo, não duplica ao rodar de novo, para sem gravar
 * quando um preço diverge e nunca imprime a chave nem o texto do código promocional. A chave e o código são gerados
 * no teste: nenhum dos dois existe no repositório.
 */
describe('scripts/stripe-setup.ts (CP-03)', () => {
  const fake = new FakeStripe();
  let stripeApi: Required<StripeApiOptions>;
  const apiKey = fakeStripeKey('test', 'sk');
  const promoCode = `TESTE${randomBytes(4).toString('hex').toUpperCase()}`;

  async function run(
    argv: string[],
    env: Record<string, string | undefined> = {},
  ): Promise<{ code: number; output: string }> {
    const lines: string[] = [];
    const code = await main({
      argv,
      env: { STRIPE_SETUP_KEY: apiKey, STRIPE_SETUP_PROMO_CODE: promoCode, ...env },
      out: (line) => lines.push(line),
      stripeApi,
    });
    const output = lines.join('\n');
    // Em nenhuma saída, nem a chave nem o código.
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(apiKey.slice(-12));
    expect(output).not.toContain(promoCode);
    return { code, output };
  }

  beforeAll(async () => {
    stripeApi = await fake.start();
  });

  beforeEach(() => {
    fake.reset();
  });

  afterAll(async () => {
    await fake.stop();
  });

  it('simulação por padrão: lê, diz o que criaria e não grava nada', async () => {
    const { code, output } = await run([]);

    expect(code).toBe(0);
    expect(output).toContain('Simulação: nada é gravado');
    expect(output).toContain('produto verax_control: criaria');
    expect(output).toContain('preço verax_control_essencial_mensal (R$ 2.490,00/mês): criaria');
    expect(output).toContain('preço verax_control_profissional_mensal (R$ 4.990,00/mês): criaria');
    expect(output).toContain('cupom verax_fundadores_30 (30% por 12 meses, 5 resgates): criaria');
    expect(output).toContain('código promocional dos fundadores (texto omitido): criaria');
    expect(fake.writes()).toHaveLength(0);
  });

  it('--apply cria produto, preços, cupom e código com os parâmetros exatos; a chave vai só no cabeçalho', async () => {
    const { code, output } = await run(['--apply']);

    expect(code).toBe(0);
    expect(fake.writes().map((write) => write.path)).toEqual([
      '/v1/products',
      '/v1/prices',
      '/v1/prices',
      '/v1/coupons',
      '/v1/promotion_codes',
    ]);
    const [product, essencial, profissional, coupon, promotion] = fake.writes();
    expect(formEntries(product?.form ?? new URLSearchParams())).toEqual([
      ['id', 'verax_control'],
      ['name', 'Verax Control'],
    ]);
    for (const [write, price] of [
      [essencial, PLAN_PRICES[0]],
      [profissional, PLAN_PRICES[1]],
    ] as const) {
      expect(formEntries(write?.form ?? new URLSearchParams())).toEqual(
        formEntries(
          new URLSearchParams([
            ['product', PRODUCT.id],
            ['currency', 'brl'],
            ['unit_amount', String(price.unitAmount)],
            ['recurring[interval]', 'month'],
            ['recurring[interval_count]', '1'],
            ['lookup_key', price.lookupKey],
            ['nickname', price.nickname],
            ['metadata[plan]', price.plan],
          ]),
        ),
      );
    }
    expect(PLAN_PRICES.map((price) => price.unitAmount)).toEqual([249_000, 499_000]);
    expect(formEntries(coupon?.form ?? new URLSearchParams())).toEqual(
      formEntries(
        new URLSearchParams([
          ['id', FOUNDERS_COUPON.id],
          ['name', FOUNDERS_COUPON.name],
          ['percent_off', '30'],
          ['duration', 'repeating'],
          ['duration_in_months', '12'],
          ['max_redemptions', '5'],
        ]),
      ),
    );
    expect(formEntries(promotion?.form ?? new URLSearchParams())).toEqual(
      formEntries(
        new URLSearchParams([
          ['promotion[type]', 'coupon'],
          ['promotion[coupon]', FOUNDERS_COUPON.id],
          ['code', promoCode],
          ['active', 'true'],
        ]),
      ),
    );
    for (const request of fake.requests) {
      expect(request.headers['authorization']).toBe(`Bearer ${apiKey}`);
      expect(request.form.toString()).not.toContain(apiKey);
    }
    // A saída cita os ids criados.
    for (const id of [
      ...fake.prices.keys(),
      ...fake.promotionCodes.keys(),
      'verax_control',
      FOUNDERS_COUPON.id,
    ]) {
      expect(output).toContain(id);
    }
  });

  it('rodar de novo não muda nada: tudo é achado (preço pelo lookup_key) e mantido', async () => {
    await run(['--apply']);
    const writes = fake.writes().length;

    const { code, output } = await run(['--apply']);

    expect(code).toBe(0);
    expect(fake.writes()).toHaveLength(writes);
    expect(output.match(/: mantido /g)).toHaveLength(5);
    expect(fake.prices.size).toBe(2);
  });

  it('preço existente divergente: relata e para sem gravar nada; com --transfer-lookup-key, cria outro', async () => {
    fake.addPrice('verax_control_essencial_mensal', 199_000);

    const stopped = await run(['--apply']);

    expect(stopped.code).toBe(1);
    expect(stopped.output).toContain('unit_amount: esperado 249000, encontrado 199000');
    expect(stopped.output).toContain('Nada foi gravado');
    expect(fake.writes()).toHaveLength(0);

    const replaced = await run(['--apply', '--transfer-lookup-key']);

    expect(replaced.code).toBe(0);
    const [created] = fake.calls('POST', '/v1/prices');
    expect(created?.form.get('transfer_lookup_key')).toBe('true');
    expect(created?.form.get('unit_amount')).toBe('249000');
    const holders = [...fake.prices.values()].filter(
      (price) => price['lookup_key'] === 'verax_control_essencial_mensal',
    );
    expect(holders.map((price) => price['unit_amount'])).toEqual([249_000]);
  });

  it('cupom divergente ou código ligado a outro cupom: para sem gravar', async () => {
    fake.coupons.set(FOUNDERS_COUPON.id, {
      id: FOUNDERS_COUPON.id,
      object: 'coupon',
      percent_off: 50,
      duration: 'repeating',
      duration_in_months: 12,
      max_redemptions: 5,
      valid: true,
    });
    fake.promotionCodes.set('promo_fake_outro', {
      id: 'promo_fake_outro',
      object: 'promotion_code',
      active: true,
      code: promoCode.toLowerCase(),
      promotion: { type: 'coupon', coupon: 'outro_cupom' },
    });

    const { code, output } = await run(['--apply']);

    expect(code).toBe(1);
    expect(output).toContain('percent_off: esperado 30, encontrado 50');
    expect(output).toContain('cupom: esperado verax_fundadores_30, encontrado outro_cupom');
    expect(fake.writes()).toHaveLength(0);
  });

  it('chave ausente, inválida ou de produção sem --live: para antes de chamar a Stripe', async () => {
    expect((await run([], { STRIPE_SETUP_KEY: undefined })).code).toBe(2);
    expect((await run([], { STRIPE_SETUP_KEY: 'nao-e-chave' })).code).toBe(2);
    const liveKey = fakeStripeKey('live', 'sk');
    const live = await run(['--apply'], { STRIPE_SETUP_KEY: liveKey });
    expect(live.code).toBe(2);
    expect(live.output).toContain('--live');
    expect(live.output).not.toContain(liveKey);
    expect((await run(['--live'])).code).toBe(2);
    expect((await run(['--opcao-desconhecida'])).code).toBe(2);
    expect((await run([], { STRIPE_SETUP_PROMO_CODE: 'com espaço' })).code).toBe(2);
    expect(fake.requests).toHaveLength(0);
  });

  it('sem código promocional, cria o resto e avisa que pulou', async () => {
    const { code, output } = await run(['--apply'], { STRIPE_SETUP_PROMO_CODE: undefined });
    expect(code).toBe(0);
    expect(output).toContain('código promocional: não informado');
    expect(fake.calls('POST', '/v1/promotion_codes')).toHaveLength(0);
    expect(fake.calls('POST', '/v1/coupons')).toHaveLength(1);
  });

  it('erro da Stripe: sai com 3 citando tipo e status, nunca a mensagem', async () => {
    fake.failures.set('GET /v1/products/verax_control', {
      status: 401,
      type: 'invalid_request_error',
      message: `Invalid API Key provided: ${apiKey}`,
    });
    const { code, output } = await run([]);
    expect(code).toBe(3);
    // Tipo do erro no SDK, status e id da requisição na Stripe; a mensagem (que aqui repete a chave) fica de fora.
    expect(output).toMatch(/Erro da Stripe: StripeAuthenticationError 401 req_fake_\d+\./);
    expect(output).not.toContain('Invalid API Key');
  });
});

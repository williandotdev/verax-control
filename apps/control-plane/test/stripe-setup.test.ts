import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  childOptions,
  exitCodeOf,
  FOUNDERS_COUPON,
  type GcloudRunner,
  main,
  PLAN_PRICES,
  PRODUCT,
  WEBHOOK_EVENTS,
  WEBHOOK_PATH,
} from '../scripts/stripe-setup.js';
import { STRIPE_API_VERSION, type StripeApiOptions } from '../src/stripe/stripe-client.js';
import { WEBHOOK_PATH as APP_WEBHOOK_PATH } from '../src/webhook/raw-body.js';
import { HANDLED_EVENT_TYPES } from '../src/webhook/stripe-events.js';
import { FakeStripe, fakeStripeKey, formEntries } from './support/fake-stripe.js';

interface GcloudCall {
  args: readonly string[];
  input?: string;
}

/**
 * O `stripe-setup` contra o servidor falso da Stripe: cria o catálogo, não duplica ao rodar de novo, para sem gravar
 * quando um preço diverge e nunca imprime a chave nem o texto do código promocional. A chave e o código são gerados
 * no teste: nenhum dos dois existe no repositório. O endpoint do webhook (CP-04) usa um gcloud de mentira que grava
 * os argumentos e o stdin: o segredo de assinatura tem de ir só pelo stdin, nunca para a saída.
 */
describe('scripts/stripe-setup.ts (CP-03 e CP-04)', () => {
  const fake = new FakeStripe();
  let stripeApi: Required<StripeApiOptions>;
  const apiKey = fakeStripeKey('test', 'sk');
  const promoCode = `TESTE${randomBytes(4).toString('hex').toUpperCase()}`;
  const commands: GcloudCall[] = [];
  /** Códigos de saída das próximas chamadas ao gcloud, em ordem (sem nenhum, 0). */
  const exitCodes: number[] = [];
  const gcloud: GcloudRunner = (args, input) => {
    commands.push({ args: [...args], ...(input === undefined ? {} : { input }) });
    return Promise.resolve(exitCodes.shift() ?? 0);
  };

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
      gcloud,
    });
    const output = lines.join('\n');
    // Em nenhuma saída, nem a chave, nem o código, nem o segredo de assinatura do webhook.
    expect(output).not.toContain(apiKey);
    expect(output).not.toContain(apiKey.slice(-12));
    expect(output).not.toContain(promoCode);
    if (fake.lastWebhookSigningValue !== undefined) {
      expect(output).not.toContain(fake.lastWebhookSigningValue);
      expect(output).not.toContain(fake.lastWebhookSigningValue.slice(-12));
    }
    return { code, output };
  }

  beforeAll(async () => {
    stripeApi = await fake.start();
  });

  beforeEach(() => {
    fake.reset();
    commands.length = 0;
    exitCodes.length = 0;
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

  describe('endpoint do webhook (CP-04)', () => {
    const url = 'https://conta.veraxsistemas.com.br/v1/stripe/webhook';
    const vault = 'cp-stripe-webhook-secret';
    const webhookArgs = [`--webhook-url=${url}`, `--webhook-secret-name=${vault}`];

    function existingEndpoint(events: readonly string[], status = 'enabled'): string {
      const id = 'we_fake_existente';
      fake.webhookEndpoints.set(id, {
        id,
        object: 'webhook_endpoint',
        url,
        enabled_events: [...events],
        api_version: STRIPE_API_VERSION,
        status,
        livemode: false,
        metadata: {},
      });
      return id;
    }

    it('o processo filho recebe o valor só pelo stdin, sem shell; sem o executável, 127', async () => {
      const value = `whsec_${randomBytes(8).toString('hex')}`;
      const digest = createHash('sha256').update(value).digest('hex');
      // O filho (o próprio Node, com as mesmas opções do gcloud) confere o SHA-256 do stdin e sai 0 só se for o do
      // valor: o valor em si não vai em argumento.
      const check =
        "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>process.exit(" +
        "require('node:crypto').createHash('sha256').update(d).digest('hex')===process.argv[1]?0:3))";
      const node = (input: string): Promise<number> =>
        exitCodeOf(spawn(process.execPath, ['-e', check, digest], childOptions(input)), input);
      expect(childOptions(value)).toEqual({ shell: false, stdio: ['pipe', 'ignore', 'inherit'] });
      expect(childOptions()).toEqual({ shell: false, stdio: ['ignore', 'ignore', 'inherit'] });
      expect(await node(`${value}x`)).toBe(3);
      expect(await node(value)).toBe(0);
      expect(await exitCodeOf(spawn('comando-que-nao-existe-verax', [], childOptions()))).toBe(127);
    });

    it('os 13 eventos e o caminho são os mesmos do webhook do cp-public', () => {
      expect([...WEBHOOK_EVENTS]).toEqual([...HANDLED_EVENT_TYPES]);
      expect(WEBHOOK_EVENTS).toHaveLength(13);
      expect(WEBHOOK_PATH).toBe(APP_WEBHOOK_PATH);
    });

    it('simulação: diz que criaria, sem gravar nada nem chamar o gcloud', async () => {
      const { code, output } = await run(webhookArgs);
      expect(code).toBe(0);
      expect(output).toContain(
        `endpoint do webhook ${url}: criaria (13 eventos, api_version ${STRIPE_API_VERSION})`,
      );
      expect(fake.writes()).toHaveLength(0);
      expect(commands).toHaveLength(0);
    });

    it('cria com os 13 eventos; o segredo de assinatura vai só pelo stdin do gcloud, sem shell nem argumento', async () => {
      const { code, output } = await run(['--apply', ...webhookArgs, '--gcloud-project=demo-verax-cp']);

      expect(code).toBe(0);
      const [created] = fake.calls('POST', '/v1/webhook_endpoints');
      expect(formEntries(created?.form ?? new URLSearchParams())).toEqual(
        formEntries(
          new URLSearchParams([
            ['url', url],
            ...WEBHOOK_EVENTS.map((event, index): [string, string] => [`enabled_events[${index}]`, event]),
            ['api_version', STRIPE_API_VERSION],
            ['description', 'Verax Control: plano de controle (cp-public)'],
          ]),
        ),
      );
      const signing = fake.lastWebhookSigningValue;
      expect(signing).toMatch(/^whsec_/);
      expect(commands).toEqual([
        { args: ['secrets', 'describe', vault, '--project', 'demo-verax-cp'] },
        {
          args: ['secrets', 'versions', 'add', vault, '--data-file=-', '--project', 'demo-verax-cp'],
          input: signing,
        },
      ]);
      for (const call of commands) expect(call.args.join(' ')).not.toContain(signing);
      expect(output).toContain(`criado ${[...fake.webhookEndpoints.keys()][0] ?? '?'}`);
      expect(output).toContain(`nova versão de ${vault}`);
    });

    it('rodar de novo mantém o endpoint: nada gravado, nada no gcloud', async () => {
      await run(['--apply', ...webhookArgs]);
      const writes = fake.writes().length;
      commands.length = 0;

      const { code, output } = await run(['--apply', ...webhookArgs]);

      expect(code).toBe(0);
      expect(output).toContain(`endpoint do webhook ${url}: mantido`);
      expect(fake.writes()).toHaveLength(writes);
      expect(commands).toHaveLength(0);
    });

    it('endpoint existente com eventos a menos e desligado: acerta a lista e religa, sem mexer no segredo', async () => {
      const id = existingEndpoint(['invoice.paid', 'payment_intent.created'], 'disabled');

      const { code, output } = await run(['--apply', `--webhook-url=${url}`]);

      expect(code).toBe(0);
      const [updated] = fake.calls('POST', `/v1/webhook_endpoints/${id}`);
      expect(updated?.form.get('disabled')).toBe('false');
      expect(WEBHOOK_EVENTS.map((_, index) => updated?.form.get(`enabled_events[${index}]`))).toEqual([
        ...WEBHOOK_EVENTS,
      ]);
      expect(output).toContain('sobram payment_intent.created');
      expect(output).toContain('desligado');
      expect(fake.calls('POST', '/v1/webhook_endpoints')).toHaveLength(0);
      expect(commands).toHaveLength(0);
    });

    it('criar sem --webhook-secret-name: para sem criar (o segredo não teria para onde ir)', async () => {
      const { code, output } = await run(['--apply', `--webhook-url=${url}`]);
      expect(code).toBe(2);
      expect(output).toContain('--webhook-secret-name');
      expect(fake.calls('POST', '/v1/webhook_endpoints')).toHaveLength(0);
    });

    it('gcloud sem login ou sem o segredo: para antes de criar o endpoint', async () => {
      exitCodes.push(1);
      const { code, output } = await run(['--apply', ...webhookArgs]);
      expect(code).toBe(4);
      expect(output).toContain('nada foi criado na Stripe');
      expect(fake.calls('POST', '/v1/webhook_endpoints')).toHaveLength(0);
      expect(commands).toHaveLength(1);
    });

    it('o gcloud falha ao gravar a versão: o endpoint criado é apagado e o segredo não aparece', async () => {
      exitCodes.push(0, 1);
      const { code, output } = await run(['--apply', ...webhookArgs]);
      expect(code).toBe(4);
      const [created] = fake.calls('POST', '/v1/webhook_endpoints');
      expect(created).toBeDefined();
      expect(fake.webhookEndpoints.size).toBe(0);
      expect(fake.writes().filter((write) => write.method === 'DELETE')).toHaveLength(1);
      expect(output).toContain('foi apagado');
    });

    it('opções inválidas param antes de chamar a Stripe ou o gcloud', async () => {
      for (const argv of [
        ['--webhook-url=http://conta.veraxsistemas.com.br/v1/stripe/webhook'],
        ['--webhook-url=https://conta.veraxsistemas.com.br/outro'],
        [`--webhook-url=${url}?x=1`],
        ['--webhook-url=https://usuario@conta.veraxsistemas.com.br/v1/stripe/webhook'],
        ['--webhook-url=nao-e-url'],
        [`--webhook-url=${url}`, '--webhook-secret-name=com espaço'],
        [`--webhook-url=${url}`, '--gcloud-project=Projeto_Invalido'],
        [`--webhook-secret-name=${vault}`],
      ]) {
        expect((await run(['--apply', ...argv])).code, argv.join(' ')).toBe(2);
      }
      expect(fake.requests).toHaveLength(0);
      expect(commands).toHaveLength(0);
    });
  });
});

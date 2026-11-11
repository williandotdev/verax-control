import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  type Catalog,
  catalogSchema,
  childOptions,
  exitCodeOf,
  type GcloudRunner,
  main,
  WEBHOOK_EVENTS,
  WEBHOOK_PATH,
} from '../scripts/stripe-setup.js';
import { lookupKeysOf, priceTableSchema } from '../src/pricing/pricing.schema.js';
import { STRIPE_API_VERSION, type StripeApiOptions } from '../src/stripe/stripe-client.js';
import { WEBHOOK_PATH as APP_WEBHOOK_PATH } from '../src/webhook/raw-body.js';
import { HANDLED_EVENT_TYPES } from '../src/webhook/stripe-events.js';
import { FakeStripe, fakeStripeKey, formEntries } from './support/fake-stripe.js';
import { fictitiousPriceTable } from './support/pricing-fixtures.js';

interface GcloudCall {
  args: readonly string[];
  input?: string;
}

/** O exemplo do repositório (valores fictícios): é também o catálogo dos testes, copiado para fora do repositório. */
const EXAMPLE_PATH = fileURLToPath(new URL('../scripts/catalog.example.json', import.meta.url));
const EXAMPLE: Catalog = catalogSchema.parse(JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')));

/**
 * O `stripe-setup` contra o servidor falso da Stripe: lê o catálogo do arquivo (`--catalog`, valores FICTÍCIOS do
 * exemplo), cria um produto por componente e os preços da versão (mensais e a implantação avulsa) com os metadados,
 * o cupom só nos produtos mensais e o código promocional; não duplica ao rodar de novo; para sem gravar quando algo
 * diverge; e nunca imprime a chave nem o texto do código. A chave e o código são gerados no teste. O endpoint do
 * webhook (CP-04) usa um gcloud de mentira que grava os argumentos e o stdin: o segredo de assinatura tem de ir só
 * pelo stdin, nunca para a saída.
 */
describe('scripts/stripe-setup.ts (preço configurável e CP-04)', () => {
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
  /** Pasta temporária fora do repositório, como a do catálogo de verdade. */
  const outside = mkdtempSync(join(tmpdir(), 'vc-catalogo-'));
  const catalogPath = join(outside, 'catalogo.json');

  /** Grava o catálogo (um texto vai como está, para o teste do JSON quebrado). */
  function writeCatalog(catalog: unknown, path = catalogPath): string {
    writeFileSync(path, typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
    return path;
  }

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
    writeCatalog(EXAMPLE);
  });

  afterAll(async () => {
    await fake.stop();
    rmSync(outside, { recursive: true, force: true });
  });

  it('o exemplo do repositório segue a tabela fictícia dos testes: os mesmos componentes, variantes e valores', () => {
    const table = lookupKeysOf(priceTableSchema.parse(fictitiousPriceTable()));
    const fromTable = table
      .map((entry) => [entry.component, entry.variant, entry.amount, entry.recurring])
      .sort();
    const fromExample = EXAMPLE.prices
      .map((price) => [price.metadata.component, price.metadata.variant, price.unitAmount, price.recurring])
      .sort();
    expect(fromExample).toEqual(fromTable);
  });

  it('simulação por padrão: lê o catálogo, diz o que criaria e não grava nada', async () => {
    const { code, output } = await run([`--catalog=${catalogPath}`]);

    expect(code).toBe(0);
    expect(output).toContain('Simulação: nada é gravado');
    expect(output).toContain('Catálogo da tabela exemplo-v1: 6 produtos, 6 preços.');
    expect(output).toContain('produto vc_plataforma: criaria ("Verax Control: Plataforma")');
    expect(output).toContain('preço vc_base_v1 (R$ 1.000,00/mês): criaria (novo)');
    expect(output).toContain('preço vc_setup_v1 (R$ 5.000,00, avulso): criaria (novo)');
    expect(output).toContain('cupom vc_cupom_exemplo (10% por 3 meses, 2 resgates): criaria');
    expect(output).toContain('código promocional (texto omitido): criaria');
    expect(output).not.toContain('dentro do repositório');
    expect(fake.writes()).toHaveLength(0);
  });

  it('--apply cria produtos, preços (mensais e avulso, com os metadados), cupom e código com os parâmetros exatos', async () => {
    const { code, output } = await run([`--catalog=${catalogPath}`, '--apply']);

    expect(code).toBe(0);
    expect(fake.writes().map((write) => write.path)).toEqual([
      ...EXAMPLE.products.map(() => '/v1/products'),
      ...EXAMPLE.prices.map(() => '/v1/prices'),
      '/v1/coupons',
      '/v1/promotion_codes',
    ]);
    const [product] = fake.calls('POST', '/v1/products');
    expect(formEntries(product?.form ?? new URLSearchParams())).toEqual([
      ['id', 'vc_plataforma'],
      ['name', 'Verax Control: Plataforma'],
    ]);
    expect(formEntries(fake.calls('POST', '/v1/products')[1]?.form ?? new URLSearchParams())).toEqual([
      ['id', 'vc_gb_dia_adicional'],
      ['name', 'Plataforma: GB/dia adicional'],
      ['unit_label', 'GB/dia'],
    ]);
    const prices = fake.calls('POST', '/v1/prices');
    // Um preço mensal (valores fictícios do exemplo).
    expect(formEntries(prices[0]?.form ?? new URLSearchParams())).toEqual(
      formEntries(
        new URLSearchParams([
          ['product', 'vc_plataforma'],
          ['currency', 'brl'],
          ['unit_amount', '100000'],
          ['recurring[interval]', 'month'],
          ['recurring[interval_count]', '1'],
          ['lookup_key', 'vc_base_v1'],
          ['nickname', 'Plataforma (mensal)'],
          ['metadata[component]', 'base'],
          ['metadata[variant]', 'plataforma'],
          ['metadata[tableVersion]', 'exemplo-v1'],
        ]),
      ),
    );
    // A implantação: avulsa, sem `recurring`.
    expect(formEntries(prices.at(-1)?.form ?? new URLSearchParams())).toEqual(
      formEntries(
        new URLSearchParams([
          ['product', 'vc_implantacao'],
          ['currency', 'brl'],
          ['unit_amount', '500000'],
          ['lookup_key', 'vc_setup_v1'],
          ['nickname', 'Implantação do vCISO (uma vez)'],
          ['metadata[component]', 'setup'],
          ['metadata[variant]', 'vciso'],
          ['metadata[tableVersion]', 'exemplo-v1'],
        ]),
      ),
    );
    const [coupon] = fake.calls('POST', '/v1/coupons');
    expect(formEntries(coupon?.form ?? new URLSearchParams())).toEqual(
      formEntries(
        new URLSearchParams([
          ['id', 'vc_cupom_exemplo'],
          ['name', 'Cupom de exemplo'],
          ['percent_off', '10'],
          ['duration', 'repeating'],
          ['duration_in_months', '3'],
          ['max_redemptions', '2'],
          ...(EXAMPLE.coupon?.appliesToProducts ?? []).map((product, index): [string, string] => [
            `applies_to[products][${index}]`,
            product,
          ]),
        ]),
      ),
    );
    expect(coupon?.form.toString()).not.toContain('vc_implantacao');
    const [promotion] = fake.calls('POST', '/v1/promotion_codes');
    expect(formEntries(promotion?.form ?? new URLSearchParams())).toEqual(
      formEntries(
        new URLSearchParams([
          ['promotion[type]', 'coupon'],
          ['promotion[coupon]', 'vc_cupom_exemplo'],
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
      'vc_plataforma',
      'vc_cupom_exemplo',
    ]) {
      expect(output).toContain(id);
    }
  });

  it('rodar de novo não muda nada: tudo é achado (preço pelo lookup_key) e mantido', async () => {
    await run([`--catalog=${catalogPath}`, '--apply']);
    const writes = fake.writes().length;

    const { code, output } = await run([`--catalog=${catalogPath}`, '--apply']);

    expect(code).toBe(0);
    expect(fake.writes()).toHaveLength(writes);
    expect(output.match(/: mantido /g)).toHaveLength(EXAMPLE.products.length + EXAMPLE.prices.length + 2);
    expect(fake.prices.size).toBe(EXAMPLE.prices.length);
  });

  it('preço existente divergente (valor, tipo ou metadados): relata e para sem gravar nada', async () => {
    fake.addPrice('vc_base_v1', 90_000, {
      product: 'vc_plataforma',
      metadata: { component: 'base', variant: 'plataforma', tableVersion: 'exemplo-v1' },
    });
    fake.addPrice('vc_setup_v1', 500_000, {
      product: 'vc_implantacao',
      metadata: { component: 'setup', variant: 'vciso', tableVersion: 'exemplo-v1' },
    });
    fake.addPrice('vc_vciso_v1', 200_000, {
      product: 'vc_vciso',
      metadata: { component: 'service', variant: 'vciso', tableVersion: 'outra-versao' },
    });

    const { code, output } = await run([`--catalog=${catalogPath}`, '--apply']);

    expect(code).toBe(1);
    expect(output).toContain('unit_amount: esperado 100000, encontrado 90000');
    // A implantação existente foi cadastrada como mensal: o tipo e o intervalo divergem.
    expect(output).toContain('type: esperado one_time, encontrado recurring');
    expect(output).toContain('metadata.tableVersion: esperado exemplo-v1, encontrado outra-versao');
    expect(output).toContain('Nada foi gravado');
    expect(fake.writes()).toHaveLength(0);
  });

  it('cupom divergente (inclusive nos produtos) ou código ligado a outro cupom: para sem gravar', async () => {
    fake.coupons.set('vc_cupom_exemplo', {
      id: 'vc_cupom_exemplo',
      object: 'coupon',
      percent_off: 10,
      duration: 'repeating',
      duration_in_months: 3,
      max_redemptions: 2,
      valid: true,
    });
    fake.promotionCodes.set('promo_fake_outro', {
      id: 'promo_fake_outro',
      object: 'promotion_code',
      active: true,
      code: promoCode.toLowerCase(),
      promotion: { type: 'coupon', coupon: 'outro_cupom' },
    });

    const { code, output } = await run([`--catalog=${catalogPath}`, '--apply']);

    expect(code).toBe(1);
    // O cupom sem `applies_to` desconta tudo, inclusive a implantação.
    expect(output).toContain('applies_to.products: esperado');
    expect(output).toContain('encontrado todos');
    expect(output).toContain('cupom: esperado vc_cupom_exemplo, encontrado outro_cupom');
    expect(fake.writes()).toHaveLength(0);
  });

  it('catálogo ausente, ilegível ou inválido: para antes de chamar a Stripe, citando só caminhos e problemas', async () => {
    const coupon = EXAMPLE.coupon;
    const [first, ...rest] = EXAMPLE.prices;
    const cases: [string, string][] = [
      [join(outside, 'nao-existe.json'), 'não consegui ler'],
      [writeCatalog('{ isto não é json', join(outside, 'quebrado.json')), 'não é um JSON válido'],
      [
        writeCatalog({ ...EXAMPLE, prices: [...EXAMPLE.prices, first] }, join(outside, 'repetido.json')),
        'prices: lookup_key repetido',
      ],
      [
        writeCatalog(
          { ...EXAMPLE, prices: [{ ...first, product: 'vc_inexistente' }, ...rest] },
          join(outside, 'produto.json'),
        ),
        'prices.0.product: produto fora da lista de produtos',
      ],
      [
        writeCatalog(
          {
            ...EXAMPLE,
            coupon: {
              ...coupon,
              appliesToProducts: [...(coupon?.appliesToProducts ?? []), 'vc_implantacao'],
            },
          },
          join(outside, 'cupom.json'),
        ),
        'o cupom não pode descontar um produto avulso (implantação)',
      ],
      [writeCatalog({ ...EXAMPLE, desconto: 50 }, join(outside, 'campo.json')), '--catalog inválido'],
    ];
    for (const [path, message] of cases) {
      const { code, output } = await run([`--catalog=${path}`]);
      expect(code, message).toBe(2);
      expect(output, message).toContain(message);
    }
    const { coupon: _coupon, ...withoutCoupon } = EXAMPLE;
    const noCoupon = await run([`--catalog=${writeCatalog(withoutCoupon, join(outside, 'sem-cupom.json'))}`]);
    expect(noCoupon.code).toBe(2);
    expect(noCoupon.output).toContain('o catálogo não tem cupom');
    expect(fake.requests).toHaveLength(0);
  });

  it('sem cupom no catálogo e sem código, cria o resto e avisa que pulou', async () => {
    const { coupon: _coupon, ...withoutCoupon } = EXAMPLE;
    const path = writeCatalog(withoutCoupon, join(outside, 'sem-cupom-ok.json'));
    const { code, output } = await run([`--catalog=${path}`, '--apply'], {
      STRIPE_SETUP_PROMO_CODE: undefined,
    });
    expect(code).toBe(0);
    expect(output).toContain('cupom: o catálogo não tem, pulado');
    expect(fake.calls('POST', '/v1/coupons')).toHaveLength(0);
    expect(fake.calls('POST', '/v1/promotion_codes')).toHaveLength(0);
    expect(fake.calls('POST', '/v1/prices')).toHaveLength(EXAMPLE.prices.length);
  });

  it('o catálogo dentro do repositório (público) gera aviso: o de verdade fica fora dele', async () => {
    const { code, output } = await run([`--catalog=${EXAMPLE_PATH}`]);
    expect(code).toBe(0);
    expect(output).toContain('está dentro do repositório, que é público');
  });

  it('sem --catalog nem --webhook-url, chave ausente, inválida ou de produção sem --live: para antes da Stripe', async () => {
    expect((await run([])).code).toBe(2);
    const catalog = `--catalog=${catalogPath}`;
    expect((await run([catalog], { STRIPE_SETUP_KEY: undefined })).code).toBe(2);
    expect((await run([catalog], { STRIPE_SETUP_KEY: 'nao-e-chave' })).code).toBe(2);
    const liveKey = fakeStripeKey('live', 'sk');
    const live = await run([catalog, '--apply'], { STRIPE_SETUP_KEY: liveKey });
    expect(live.code).toBe(2);
    expect(live.output).toContain('--live');
    expect(live.output).not.toContain(liveKey);
    expect((await run([catalog, '--live'])).code).toBe(2);
    expect((await run([catalog, '--opcao-desconhecida'])).code).toBe(2);
    expect((await run([catalog, '--transfer-lookup-key'])).code).toBe(2);
    expect((await run([catalog], { STRIPE_SETUP_PROMO_CODE: 'com espaço' })).code).toBe(2);
    expect(fake.requests).toHaveLength(0);
  });

  it('erro da Stripe: sai com 3 citando tipo e status, nunca a mensagem', async () => {
    fake.failures.set('GET /v1/products/vc_plataforma', {
      status: 401,
      type: 'invalid_request_error',
      message: `Invalid API Key provided: ${apiKey}`,
    });
    const { code, output } = await run([`--catalog=${catalogPath}`]);
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

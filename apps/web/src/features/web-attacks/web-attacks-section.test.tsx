import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type AwsSource,
  type CloudAccount,
  WEB_OBSERVE_MS,
  webRouteCreateSchema,
  WEB_ROUTES_LIMIT,
  WEB_TRUSTED_LIMIT,
  webTrustedSourceCreateSchema,
} from '@verax/shared';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import { awsAccountFixture, onboardingFixture } from '@/test/aws-onboarding-fixtures';
import { refusal } from '@/test/aws-onboarding-harness';
import {
  authorizedAlbFixture,
  healthFixture,
  routeFixture,
  settingsFixture,
  trustedFixture,
  type WebLogsApi,
  webLogsApi,
  type WebLogsState,
  webSourceFixture,
} from '@/test/web-logs-harness';
import { dateInput } from './web-forms';
import { WebAttacksSection } from './web-attacks-section';

/** "Ataques web": o modo, a leitura, os limites, as rotas e as fontes confiáveis dos balanceadores autorizados. */

const server = setupServer();
beforeAll(() => server.listen());
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.useRealTimers();
  window.location.hash = '';
});
afterAll(() => server.close());

const userOf = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

function open(
  sources: AwsSource[],
  state: Partial<WebLogsState> = {},
  options: { canWrite?: boolean; account?: Partial<CloudAccount>; pageSize?: number } = {},
): WebLogsApi {
  const account = awsAccountFixture({
    connection: 'connected',
    ingestFrom: '2026-11-01',
    ...options.account,
  });
  const webLogs = webLogsApi(
    { sources: sources.map((source) => webSourceFixture(source)), ...state },
    options.pageSize,
  );
  server.use(...webLogs.handlers, ...createHandlers({ me: demoMe('admin_cliente') }));
  render(
    <QueryClientProvider client={createQueryClient()}>
      <WebAttacksSection
        account={account}
        onboarding={onboardingFixture(account.id, 'collecting', { sources })}
        canWrite={options.canWrite ?? true}
      />
    </QueryClientProvider>,
  );
  return webLogs;
}
const section = () => screen.findByRole('region', { name: 'Ataques web' });
const ended = () => settingsFixture({ observeUntil: iso(-HOUR) });
const toggle = (name: string) => screen.findByRole('button', { name: (text) => text.startsWith(name) });

describe('ataques web: quando a seção aparece', () => {
  it('sem balanceador autorizado, ou num nó que não os coleta: nada aparece e nada é pedido', async () => {
    const webLogs = open([
      authorizedAlbFixture('velho', 'authorized', { collectable: false, stateCode: 'not_collectable_yet' }),
      authorizedAlbFixture('retirado', 'revoked', {
        authorization: { authorizedAt: iso(-HOUR), authorizedBy: 'demo-ana', revokedAt: iso(-1) },
      }),
    ]);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.queryByRole('region', { name: 'Ataques web' })).not.toBeInTheDocument();
    expect(webLogs.calls).toEqual([]);
  });

  it('um balanceador só abre sozinho; com mais de um, cada quadro abre a pedido, e só aí a leitura dele é pedida', async () => {
    const user = userOf();
    const [a, b] = [authorizedAlbFixture('a-alb'), authorizedAlbFixture('b-alb')];
    const webLogs = open([a, b]);
    await section();
    expect(await toggle('a-alb')).toHaveAttribute('aria-expanded', 'false');
    expect(webLogs.calls.some((call) => call.path.endsWith('/health'))).toBe(false);
    await user.click(await toggle('b-alb'));
    expect(await screen.findByRole('region', { name: 'Modo do b-alb' })).toBeInTheDocument();
    expect(webLogs.calls.filter((call) => call.path.endsWith('/health')).map((call) => call.path)).toEqual([
      `sources/${b.id}/health`,
    ]);
    await user.click(await toggle('b-alb'));
    expect(screen.queryByRole('region', { name: 'Modo do b-alb' })).not.toBeInTheDocument();
  });

  it('o único já abre, fecha a pedido e continua fechado', async () => {
    const user = userOf();
    open([authorizedAlbFixture('unico')]);
    expect(await toggle('unico')).toHaveAttribute('aria-expanded', 'true');
    await user.click(await toggle('unico'));
    expect(await toggle('unico')).toHaveAttribute('aria-expanded', 'false');
  });

  it('o endereço apontado pela tabela abre o quadro dele', async () => {
    const [a, b] = [authorizedAlbFixture('a-alb'), authorizedAlbFixture('b-alb')];
    window.location.hash = `#ataques-web-${b.id}`;
    open([a, b]);
    await section();
    expect(await toggle('b-alb')).toHaveAttribute('aria-expanded', 'true');
    expect(await toggle('a-alb')).toHaveAttribute('aria-expanded', 'false');
    act(() => {
      window.location.hash = `#ataques-web-${a.id}`;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(await toggle('a-alb')).toHaveAttribute('aria-expanded', 'true');
  });

  it('lê todas as páginas: nenhum balanceador fica de fora', async () => {
    const sources = Array.from({ length: 3 }, (_, index) => authorizedAlbFixture(`alb-${index}`));
    // O painel pede 100 por página; o servidor desta conta tem 250.
    const extra = Array.from({ length: 247 }, (_, index) =>
      webSourceFixture(authorizedAlbFixture(`outro-${index}`), { name: `outro-${index}` }),
    );
    const last = sources.map((source) => webSourceFixture(source));
    const webLogs = open(sources, { sources: [...extra, ...last] });
    expect(await toggle('alb-2')).toBeInTheDocument();
    expect(webLogs.calls.filter((call) => call.path.startsWith('sources?')).map((call) => call.path)).toEqual(
      [1, 2, 3].map((page) => `sources?cloudAccountId=${awsAccountFixture().id}&page=${page}&pageSize=100`),
    );
  });
});

describe('ataques web: o modo', () => {
  const rules = [
    { ruleId: '990402', level: 7, findings: 9, firstSeenAt: iso(-20 * HOUR), lastSeenAt: iso(-HOUR) },
    { ruleId: '990405', level: 10, findings: 2, firstSeenAt: iso(-20 * HOUR), lastSeenAt: iso(-HOUR) },
    { ruleId: '990499', level: 4, findings: 1, firstSeenAt: iso(-20 * HOUR), lastSeenAt: iso(-HOUR) },
  ];
  const observation = { since: iso(-30 * HOUR), rules, truncated: false };

  it('dentro das 72 h: quanto falta, o que teria aberto (do mais grave), e o botão não vale', async () => {
    const source = authorizedAlbFixture('loja-alb');
    const settings = settingsFixture({ observeUntil: iso(WEB_OBSERVE_MS - 30 * HOUR - 30 * 60_000) });
    open([source], {
      sources: [webSourceFixture(source, { settings })],
      health: new Map([[source.id, healthFixture(source.id, { observation })]]),
    });
    const mode = await screen.findByRole('region', { name: 'Modo do loja-alb' });
    expect(within(mode).getByRole('status')).toHaveTextContent('Observando: faltam 41 h 30 min');
    expect(await within(mode).findByText('12 alertas teriam sido abertos')).toBeInTheDocument();
    const items = within(mode).getAllByRole('listitem');
    expect(items.map((item) => item.textContent?.slice(0, 40))).toEqual([
      expect.stringContaining('AltoForça bruta numa rota de login'),
      expect.stringContaining('MédioSondagem de caminhos sensíveis'),
      expect.stringContaining('BaixoRegra 990499'),
    ]);
    const button = within(mode).getByRole('button', { name: 'Começar a alertar: loja-alb' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('O botão libera no fim da observação.');
  });

  it('o relógio anda: no fim das 72 h, o botão libera sem recarregar', async () => {
    const source = authorizedAlbFixture('loja-alb');
    open([source], {
      sources: [webSourceFixture(source, { settings: settingsFixture({ observeUntil: iso(90_000) }) })],
    });
    const mode = await screen.findByRole('region', { name: 'Modo do loja-alb' });
    const button = within(mode).getByRole('button', { name: 'Começar a alertar: loja-alb' });
    expect(within(mode).getByRole('status')).toHaveTextContent('faltam 2 min');
    expect(button).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(2 * 60_000));
    expect(button).toBeEnabled();
    expect(within(mode).getByRole('status')).toHaveTextContent('a observação obrigatória terminou');
  });

  it('sem contagem ainda, e com contagem vazia: cada uma diz o que é', async () => {
    const source = authorizedAlbFixture('loja-alb');
    const webLogs = open([source], {
      health: new Map([[source.id, healthFixture(source.id, { observation: null })]]),
    });
    const mode = await screen.findByRole('region', { name: 'Modo do loja-alb' });
    expect(await within(mode).findByText(/Ainda sem contagem/)).toBeInTheDocument();
    webLogs.state.health.set(
      source.id,
      healthFixture(source.id, { observation: { ...observation, rules: [] } }),
    );
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(await within(mode).findByText(/nada teria virado alerta/)).toBeInTheDocument();
  });

  it('começar a alertar: a janela mostra o que teria aberto, Esc cancela, e o foco volta para o botão', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const webLogs = open([source], {
      sources: [webSourceFixture(source, { settings: ended() })],
      health: new Map([
        [source.id, healthFixture(source.id, { observation: { ...observation, truncated: true } })],
      ]),
    });
    const mode = await screen.findByRole('region', { name: 'Modo do loja-alb' });
    expect(within(mode).getByRole('status')).toHaveTextContent('a observação obrigatória terminou');
    await within(mode).findByText('pelo menos 12 alertas teriam sido abertos');
    const button = within(mode).getByRole('button', { name: 'Começar a alertar: loja-alb' });
    await user.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Começar a alertar: loja-alb' });
    expect(dialog).toHaveAccessibleDescription(/também mandam e-mail/);
    expect(within(dialog).getByText('pelo menos 12 alertas teriam sido abertos')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(button).toHaveFocus());
    expect(webLogs.writes()).toEqual([]);

    await user.click(button);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Começar a alertar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(webLogs.writes()).toEqual([
      { method: 'PATCH', path: `sources/${source.id}/settings`, body: { mode: 'alert' } },
    ]);
    expect(within(mode).getByRole('status')).toHaveTextContent('Alertando.');
    // O botão virou o contrário dele, no mesmo lugar, e o foco não se perde.
    await waitFor(() =>
      expect(within(mode).getByRole('button', { name: 'Voltar a observar: loja-alb' })).toHaveFocus(),
    );
    // Alertando, a contagem da observação sai da frente.
    expect(within(mode).queryByText('O que teria virado alerta')).not.toBeInTheDocument();
  });

  it('a recusa da API fica na janela, que continua aberta; voltar a observar também pede confirmação', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const webLogs = open([source], {
      sources: [webSourceFixture(source, { settings: settingsFixture({ mode: 'alert' }) })],
    });
    webLogs.on('PATCH', () => refusal(409, 'SOURCE_NOT_AUTHORIZED'));
    await user.click(await screen.findByRole('button', { name: 'Voltar a observar: loja-alb' }));
    const dialog = screen.getByRole('dialog', { name: 'Voltar a observar: loja-alb' });
    expect(dialog).toHaveAccessibleDescription(/deixa de abrir alerta/);
    await user.click(within(dialog).getByRole('button', { name: 'Voltar a observar' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('não está mais autorizado');
    expect(webLogs.writes()[0]?.body).toEqual({ mode: 'observe' });
    // Aberta de novo, a recusa anterior não aparece.
    await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
    await user.click(await screen.findByRole('button', { name: 'Voltar a observar: loja-alb' }));
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('o multiplicador: só um número dentro dos limites sai, e igual ao gravado não sai', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const webLogs = open([source]);
    const field = await screen.findByLabelText('Multiplicador dos limites (loja-alb)');
    expect(field).toHaveValue('1');
    const save = screen.getByRole('button', { name: 'Salvar multiplicador' });
    await user.click(save);
    await user.clear(field);
    await user.type(field, '11');
    await user.click(save);
    expect(field).toHaveAccessibleDescription(/Um número de 0,5 a 10/);
    expect(webLogs.writes()).toEqual([]);
    await user.clear(field);
    await user.type(field, '1,5{Enter}');
    await waitFor(() => expect(webLogs.writes()).toHaveLength(1));
    expect(webLogs.writes()[0]).toEqual({
      method: 'PATCH',
      path: `sources/${source.id}/settings`,
      body: { thresholdMultiplier: 1.5 },
    });
    expect(await screen.findByText('Salvo: vale na próxima leitura.')).toBeInTheDocument();
    expect(field).toHaveValue('1,5');
    expect(screen.getByText(/multiplicador alto esconde/)).toBeInTheDocument();
  });
});

describe('ataques web: a leitura', () => {
  it('as contagens, a lacuna com o intervalo, o aviso da CDN e o que as fontes confiáveis calaram', async () => {
    const source = authorizedAlbFixture('loja-alb', 'ingestion_error', {
      stateCode: 'web_gap',
      health: {
        lastSyncAt: iso(-60_000),
        lastEventAt: iso(-9 * 60_000),
        lastIngestedAt: iso(-60_000),
        lagSeconds: 840,
        eventsLast24h: 1,
        bytesLast24h: 1,
      },
    });
    const trusted = trustedFixture();
    open([source], {
      trusted: [trusted],
      health: new Map([
        [
          source.id,
          healthFixture(source.id, {
            objects: { read: 1_120, late: 1, quarantined: 2, gap: 38 },
            lines: { analysed: 980_112, malformed: 14, oversize: 1, foreign: 3 },
            gap: { from: '2026-11-23T10:00:00.000Z', to: '2026-11-23T13:00:00.000Z' },
            suppressed: [
              { trustedId: trusted.id, ruleId: '990402', clients: 1, lastSeenAt: iso(-12 * 60_000) },
              { trustedId: 'ja-removida', ruleId: '990405', clients: 2, lastSeenAt: iso(-12 * 60_000) },
            ],
            notes: ['behind_proxy', 'uma_nota_nova'],
          }),
        ],
      ]),
    });
    const region = await section();
    await within(region).findByText('Parte do log ficou sem leitura.');
    const value = (label: string) =>
      within(region).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? '';
    expect(value('Atraso')).toMatch(/^14 min/);
    expect(value('Linhas analisadas')).toMatch(/^980\.112/);
    expect(value('Arquivos lidos')).toMatch(/^1\.121.*1 deles chegou depois da hora/);
    expect(value('Arquivos recusados')).toMatch(/^2.*não são cobrados nem lidos de novo/);
    expect(value('Linhas fora do formato')).toMatch(/^14/);
    expect(value('Linhas grandes demais')).toMatch(/^1P/);
    expect(value('Linhas de outro balanceador')).toMatch(/^3/);
    expect(region).toHaveTextContent('38 arquivos com mais de um dia não foram analisados, do tráfego de');
    expect(region).toHaveTextContent('A maior parte das requisições chega por uma CDN ou um proxy.');
    expect(region).toHaveTextContent('Aviso da leitura: uma_nota_nova.');
    expect(region).toHaveTextContent('192.0.2.10/32: Sondagem de caminhos sensíveis');
    expect(region).toHaveTextContent('fonte confiável já removida');
    // O texto do estado, que manda olhar aqui, não se repete.
    expect(region).not.toHaveTextContent('O intervalo está em "Ataques web"');
    expect(within(region).getByText('Parte do log ficou sem leitura', { exact: true })).toBeInTheDocument();
  });

  it('o nó que não tem a rota da leitura (404): o resto funciona, sem erro', async () => {
    const source = authorizedAlbFixture('loja-alb');
    const webLogs = open([source]);
    webLogs.on(`GET sources/${source.id}/health`, () => refusal(404));
    const region = await section();
    await within(region).findByRole('region', { name: 'Modo do loja-alb' });
    await waitFor(() => expect(within(region).queryByText(/Carregando/)).not.toBeInTheDocument());
    expect(within(region).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(region).queryByText('Nas últimas 24 horas')).not.toBeInTheDocument();
  });

  it('os limites da detecção estão à vista', async () => {
    const user = userOf();
    open([authorizedAlbFixture('loja-alb')]);
    const region = await section();
    await user.click(await within(region).findByText('O que esta detecção não vê'));
    expect(region).toHaveTextContent('A AWS entrega o log pelo melhor esforço.');
    expect(region).toHaveTextContent('CDN ou proxy na frente.');
  });
});

describe('ataques web: as rotas declaradas', () => {
  const route = (source: AwsSource, overrides = {}) => routeFixture(source.id, overrides);

  it('declarar: o foco vai para o formulário, o erro fica no campo, e o pedido é o do contrato', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const webLogs = open([source]);
    const add = await screen.findByRole('button', { name: 'Declarar uma rota: loja-alb' });
    await user.click(add);
    const form = screen.getByRole('form', { name: 'Declarar uma rota' });
    expect(within(form).getByLabelText('O que é esta rota')).toHaveFocus();
    await user.type(within(form).getByLabelText('Caminho'), 'entrar');
    await user.clear(within(form).getByLabelText('Códigos de falha'));
    await user.type(within(form).getByLabelText('Códigos de falha'), '4xx');
    await user.click(within(form).getByRole('button', { name: 'Declarar rota' }));
    expect(within(form).getByLabelText('Caminho')).toHaveAccessibleDescription(/Caminho inválido/);
    expect(within(form).getByLabelText('Códigos de falha')).toHaveAccessibleDescription(/de 100 a 599/);
    expect(webLogs.writes()).toEqual([]);

    await user.clear(within(form).getByLabelText('Caminho'));
    await user.type(within(form).getByLabelText('Caminho'), '/API/*/Entrar');
    // Só o código errado já segura o pedido.
    await user.click(within(form).getByRole('button', { name: 'Declarar rota' }));
    expect(within(form).getByLabelText('Códigos de falha')).toHaveAccessibleDescription(/de 100 a 599/);
    expect(webLogs.writes()).toEqual([]);
    await user.clear(within(form).getByLabelText('Códigos de falha'));
    await user.type(within(form).getByLabelText('Códigos de falha'), '401, 200');
    await user.click(within(form).getByRole('button', { name: 'Declarar rota' }));
    expect(within(form).getByLabelText('Códigos de sucesso')).toHaveAccessibleDescription(
      /O mesmo código não pode ser falha e sucesso/,
    );
    await user.clear(within(form).getByLabelText('Códigos de falha'));
    await user.type(within(form).getByLabelText('Códigos de falha'), '401');
    await user.click(within(form).getByRole('button', { name: 'Declarar rota' }));
    await waitFor(() => expect(webLogs.writes()).toHaveLength(1));
    const [created] = webLogs.writes();
    expect(created).toMatchObject({ method: 'POST', path: `sources/${source.id}/routes` });
    expect(webRouteCreateSchema.safeParse(created?.body).success).toBe(true);
    expect(created?.body).toEqual({
      host: null,
      method: 'POST',
      path: '/api/*/entrar',
      kind: 'login',
      failureCodes: [401],
      successCodes: [200, 302],
      multiplier: 1,
    });
    expect(await screen.findByText('POST /api/*/entrar')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Declarar uma rota: loja-alb' })).toHaveFocus(),
    );
  });

  it('alterar só muda o que a API deixa; remover pede confirmação, e o foco não se perde', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const known = route(source);
    const webLogs = open([source], { routes: new Map([[source.id, [known]]]) });
    const name = 'POST loja.exemplo.com.br/entrar';
    await user.click(await screen.findByRole('button', { name: `Alterar a rota ${name}` }));
    const form = screen.getByRole('form', { name: `Alterar a rota ${name}` });
    expect(within(form).queryByLabelText('Caminho')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Método')).not.toBeInTheDocument();
    await user.selectOptions(within(form).getByLabelText('O que é esta rota'), 'mfa');
    await user.click(within(form).getByRole('button', { name: 'Salvar alteração' }));
    await waitFor(() => expect(webLogs.writes()).toHaveLength(1));
    expect(webLogs.writes()[0]).toEqual({
      method: 'PATCH',
      path: `sources/${source.id}/routes/${known.id}`,
      body: { kind: 'mfa', failureCodes: [401], successCodes: [200], multiplier: 1 },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: `Alterar a rota ${name}` })).toHaveFocus());

    await user.click(screen.getByRole('button', { name: `Remover a rota ${name}` }));
    const dialog = screen.getByRole('dialog', { name: 'Remover a rota declarada' });
    expect(dialog).toHaveAccessibleDescription(/fica na auditoria/);
    await user.click(within(dialog).getByRole('button', { name: 'Remover rota' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(webLogs.writes()[1]).toMatchObject({
      method: 'DELETE',
      path: `sources/${source.id}/routes/${known.id}`,
    });
    await waitFor(() => expect(screen.queryByText(name)).not.toBeInTheDocument());
    // O botão que abriu saiu com a linha: o foco vai para a lista, e não para o nada.
    await waitFor(() => expect(document.body).not.toHaveFocus());
  });

  it('no teto, não há como declarar outra, e a tela diz por quê', async () => {
    const source = authorizedAlbFixture('loja-alb');
    const routes = Array.from({ length: WEB_ROUTES_LIMIT }, (_, index) =>
      route(source, { path: `/entrar-${index}` }),
    );
    open([source], { routes: new Map([[source.id, routes]]) });
    expect(await screen.findByText('50 rotas declaradas de 50.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Declarar uma rota: loja-alb' })).toBeDisabled();
    expect(screen.getByText(/chegou ao limite de 50 rotas/)).toBeInTheDocument();
  });

  it('a recusa da API aparece no formulário, que continua com o que foi digitado', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const webLogs = open([source]);
    webLogs.on('POST', () => refusal(409, 'WEB_ROUTE_DUPLICATE'));
    await user.click(await screen.findByRole('button', { name: 'Declarar uma rota: loja-alb' }));
    const form = screen.getByRole('form', { name: 'Declarar uma rota' });
    await user.type(within(form).getByLabelText('Caminho'), '/entrar');
    await user.click(within(form).getByRole('button', { name: 'Declarar rota' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Esta rota já está declarada');
    expect(within(form).getByLabelText('Caminho')).toHaveValue('/entrar');
    await user.click(within(form).getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('form')).not.toBeInTheDocument();
  });
});

describe('ataques web: as fontes confiáveis', () => {
  it('incluir: faixa, validade e motivo são obrigatórios; o que nunca é calado está dito; e o pedido é o do contrato', async () => {
    const user = userOf();
    const [a, b] = [authorizedAlbFixture('a-alb'), authorizedAlbFixture('b-alb')];
    const webLogs = open([a, b]);
    await user.click(await screen.findByRole('button', { name: 'Incluir fonte confiável' }));
    const form = screen.getByRole('form', { name: 'Incluir fonte confiável' });
    expect(within(form).getByLabelText('Faixa de endereços')).toHaveFocus();
    expect(form).toHaveTextContent(
      'Nunca cala: caminho sensível respondido com conteúdo, falhas de login seguidas de sucesso (possível acesso indevido) e força bruta distribuída numa rota de login.',
    );
    const expires = within(form).getByLabelText('Vale até');
    expect(expires).toHaveAttribute('max', dateInput(new Date(Date.now() + 364 * 24 * HOUR)));
    await user.clear(expires);
    await user.type(within(form).getByLabelText('Faixa de endereços'), '192.0.2.1/24');
    await user.click(within(form).getByRole('button', { name: 'Incluir fonte confiável' }));
    expect(within(form).getByLabelText('Faixa de endereços')).toHaveAccessibleDescription(
      /com o endereço da rede/,
    );
    expect(expires).toHaveAccessibleDescription(/em até 365 dias\./);
    expect(within(form).getByLabelText('Motivo')).toHaveAccessibleDescription(/Preencha este campo/);
    expect(webLogs.writes()).toEqual([]);

    await user.clear(within(form).getByLabelText('Faixa de endereços'));
    await user.type(within(form).getByLabelText('Faixa de endereços'), '2001:0DB8:0:1::/64');
    await user.selectOptions(within(form).getByLabelText('Onde vale'), b.id);
    const day = dateInput(new Date(Date.now() + 30 * 24 * HOUR));
    await user.type(expires, day);
    await user.type(within(form).getByLabelText('Motivo'), 'Monitor do site');
    // Um proxy não cala nada: o aviso do que ele cala sai, e o que ele faz fica dito.
    await user.selectOptions(within(form).getByLabelText('O que é'), 'proxy');
    expect(form).not.toHaveTextContent('Nunca cala:');
    expect(form).toHaveTextContent('Não cala nada');
    await user.selectOptions(within(form).getByLabelText('O que é'), 'monitor');
    await user.click(within(form).getByRole('button', { name: 'Incluir fonte confiável' }));
    await waitFor(() => expect(webLogs.writes()).toHaveLength(1));
    const [created] = webLogs.writes();
    expect(webTrustedSourceCreateSchema.safeParse(created?.body).success).toBe(true);
    expect(created).toMatchObject({
      method: 'POST',
      path: 'trusted-sources',
      body: { sourceId: b.id, cidr: '2001:db8:0:1::/64', kind: 'monitor', reason: 'Monitor do site' },
    });
    const sent = new Date((created?.body as { expiresAt: string }).expiresAt);
    expect(dateInput(sent)).toBe(day);
    expect(await screen.findByText('2001:db8:0:1::/64')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Fontes confiáveis' })).toHaveTextContent('Só b-alb');
  });

  it('a vencida aparece como vencida e pode ser renovada; a de outra conta aparece pelo nome do balanceador', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const foreign = authorizedAlbFixture('outra-alb');
    const expired = trustedFixture({ cidr: '198.51.100.64/28', active: false, expiresAt: iso(-24 * HOUR) });
    const webLogs = open([source], {
      trusted: [expired, trustedFixture({ cidr: '203.0.113.8/29', sourceId: foreign.id })],
    });
    webLogs.on(`GET sources/${foreign.id}`, () =>
      Response.json(
        webSourceFixture(foreign, {
          cloudAccountId: '018f2c1e-0000-7000-8000-0000000c0bbb',
          accountId: '222222222222',
        }),
      ),
    );
    const list = await screen.findByRole('list', { name: 'Fontes confiáveis' });
    expect(list).toHaveTextContent('Vencida: não vale mais');
    expect(await within(list).findByText(/Só outra-alb \(conta 222222222222\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 fontes confiáveis de 200.*\(1 vencida\)/)).toBeInTheDocument();
    await user.click(
      within(list).getByRole('button', { name: 'Renovar a fonte confiável 198.51.100.64/28' }),
    );
    const form = screen.getByRole('form', { name: 'Alterar a fonte confiável 198.51.100.64/28' });
    expect(within(form).queryByLabelText('Faixa de endereços')).not.toBeInTheDocument();
    // A data vencida não passa: é preciso escolher outra.
    await user.click(within(form).getByRole('button', { name: 'Salvar alteração' }));
    expect(within(form).getByLabelText('Vale até')).toHaveAccessibleDescription(/Uma data a partir de hoje/);
    await user.clear(within(form).getByLabelText('Vale até'));
    await user.type(
      within(form).getByLabelText('Vale até'),
      dateInput(new Date(Date.now() + 10 * 24 * HOUR)),
    );
    await user.click(within(form).getByRole('button', { name: 'Salvar alteração' }));
    await waitFor(() => expect(webLogs.writes()).toHaveLength(1));
    expect(Object.keys(webLogs.writes()[0]?.body as object).sort()).toEqual(['expiresAt', 'kind', 'reason']);
  });

  it('remover pede confirmação; no teto, não há como incluir outra', async () => {
    const user = userOf();
    const source = authorizedAlbFixture('loja-alb');
    const trusted = Array.from({ length: WEB_TRUSTED_LIMIT }, (_, index) =>
      trustedFixture({ cidr: `198.51.${Math.floor(index / 250)}.${index % 250}/32` }),
    );
    const webLogs = open([source], { trusted });
    expect(await screen.findByRole('button', { name: 'Incluir fonte confiável' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Remover a fonte confiável 198.51.0.0/32' }));
    const dialog = screen.getByRole('dialog', { name: 'Remover a fonte confiável' });
    expect(dialog).toHaveAccessibleDescription(/volta a abrir alerta/);
    await user.click(within(dialog).getByRole('button', { name: 'Remover fonte confiável' }));
    await waitFor(() => expect(webLogs.writes()).toHaveLength(1));
    expect(webLogs.writes()[0]).toMatchObject({
      method: 'DELETE',
      path: `trusted-sources/${trusted[0]?.id}`,
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Incluir fonte confiável' })).toBeEnabled(),
    );
  });
});

describe('ataques web: quem só lê', () => {
  it.each([
    ['sem a permissão', { canWrite: false }],
    ['com o monitoramento desativado', { account: { status: 'inactive' as const } }],
  ])('%s: tudo à vista e nenhum controle de escrita', async (_name, options) => {
    const source = authorizedAlbFixture('loja-alb');
    open(
      [source],
      {
        sources: [webSourceFixture(source, { settings: settingsFixture({ thresholdMultiplier: 1.5 }) })],
        routes: new Map([[source.id, [routeFixture(source.id)]]]),
        trusted: [trustedFixture()],
      },
      options,
    );
    const region = await section();
    expect(await within(region).findByText('POST loja.exemplo.com.br/entrar')).toBeInTheDocument();
    expect(await within(region).findByText('192.0.2.10/32')).toBeInTheDocument();
    expect(region).toHaveTextContent('Multiplicador dos limites: 1,5.');
    expect(within(region).queryByRole('textbox')).not.toBeInTheDocument();
    // Só o botão que abre e fecha o quadro.
    expect(
      within(region)
        .getAllByRole('button')
        .map((button) => button.getAttribute('aria-expanded')),
    ).toEqual(['true']);
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AwsSource } from '@verax/shared';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import { awsAccountFixture, onboardingFixture } from '@/test/aws-onboarding-fixtures';
import { onboardingApi, renderAwsSection } from '@/test/aws-onboarding-harness';
import {
  albFixture,
  albLoggingFixture,
  type WebLogsApi,
  webLogsApi,
  webSourceFixture,
} from '@/test/web-logs-harness';
import { ALB_LOGGING_POLL_MS } from './web-logs-api';

/** O log de acesso do ALB ligado pelo painel: o botão, a confirmação, o andamento, a pilha a atualizar e o desligar. */

const server = setupServer();
beforeAll(() => server.listen());
beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
  vi.useRealTimers();
});
afterAll(() => server.close());

const userOf = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
const BUCKET = 'verax-control-reader-alblogsbucket-1a2b3c4d5e6f';

const withoutLogs = (name: string): AwsSource =>
  albFixture(name, {
    availability: 'no_destination',
    state: 'unavailable',
    loggingState: 'disabled',
    notes: ['aws_cost_alb_logs'],
    permission: 'unknown',
  });

function open(sources: AwsSource[], webLogs: WebLogsApi, canWrite = true) {
  const account = awsAccountFixture({ connection: 'connected', ingestFrom: '2026-11-01' });
  const onboarding = onboardingApi(account, onboardingFixture(account.id, 'awaiting_sources', { sources }));
  server.use(
    ...webLogs.handlers,
    ...onboarding.handlers,
    ...createHandlers({ me: demoMe(canWrite ? 'admin_cliente' : 'leitura') }),
  );
  renderAwsSection(account, canWrite);
}

const notEnabled = () => screen.findByRole('region', { name: /^Não habilitadas na AWS/ });

describe('o log do ALB ligado pelo painel', () => {
  it('o botão, a confirmação que diz o que muda, o pedido só com a confirmação e o andamento até o resultado', async () => {
    const user = userOf();
    const source = withoutLogs('site-alb');
    const webLogs = webLogsApi({ albLogging: new Map([[source.id, albLoggingFixture(source.id)]]) });
    open([source], webLogs);
    const region = await notEnabled();
    const button = await within(region).findByRole('button', { name: 'Ligar logs' });
    // O caminho de antes fica, recolhido, como alternativa.
    expect(
      within(region).getByText('Prefere fazer você mesmo? Os passos na sua conta AWS'),
    ).toBeInTheDocument();

    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Ligar o log de acesso do site-alb?' });
    expect(dialog).toHaveTextContent('Na sua conta AWS, o Verax muda só isto');
    expect(dialog).toHaveTextContent('Nenhuma outra configuração dele muda');
    expect(dialog).toHaveTextContent('bucket que a pilha da Verax criou');
    expect(dialog).toHaveTextContent('Tem custo na AWS');
    expect(dialog).toHaveTextContent('Para desfazer');
    expect(webLogs.writes()).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Ligar o log' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(webLogs.writes()).toEqual([
      { method: 'POST', path: `sources/${source.id}/access-logs/enable`, body: { confirm: true } },
    ]);
    expect(await within(region).findByRole('status')).toHaveTextContent('Ligando o log de acesso');
    expect(within(region).queryByRole('button', { name: 'Ligar logs' })).not.toBeInTheDocument();

    // O worker responde; a tela relê sozinha e mostra.
    webLogs.state.albLogging.set(
      source.id,
      albLoggingFixture(source.id, {
        lastAction: 'enable',
        status: 'enabled',
        completedAt: new Date().toISOString(),
        enabledByVerax: true,
        bucket: BUCKET,
        enabledAt: new Date().toISOString(),
        enabledBy: 'usuario-1',
        previous: { enabled: false, bucket: null, prefix: null },
      }),
    );
    await vi.advanceTimersByTimeAsync(ALB_LOGGING_POLL_MS + 100);
    expect(await within(region).findByText('Log de acesso ligado.')).toBeInTheDocument();
    expect(region).toHaveTextContent(BUCKET);
  });

  it('a pilha sem a opção: o motivo, "Atualize a pilha da Verax" com o arquivo, e o caminho manual recolhido', async () => {
    const source = withoutLogs('site-alb');
    const failed = albLoggingFixture(source.id, {
      lastAction: 'enable',
      status: 'failed',
      errorCode: 'stack_update_required',
      completedAt: new Date().toISOString(),
    });
    open([source], webLogsApi({ albLogging: new Map([[source.id, failed]]) }));
    const region = await notEnabled();
    expect(await within(region).findByText('Atualize a pilha da Verax')).toBeInTheDocument();
    expect(region).toHaveTextContent('ainda não deixa o Verax ligar o log');
    expect(region).toHaveTextContent('EnableAlbAccessLogs');
    await waitFor(() =>
      expect(within(region).getByRole('button', { name: 'Baixar o arquivo da pilha' })).toBeEnabled(),
    );
    expect(within(region).getByRole('button', { name: 'Ligar logs' })).toBeInTheDocument();
    expect(
      within(region).getByText('Prefere fazer você mesmo? Os passos na sua conta AWS'),
    ).toBeInTheDocument();
  });

  it('quem só lê não vê o botão; o nó de antes (sem a rota) mostra os passos de sempre', async () => {
    const source = withoutLogs('site-alb');
    open([source], webLogsApi({ albLogging: new Map([[source.id, albLoggingFixture(source.id)]]) }), false);
    const region = await notEnabled();
    expect(
      await within(region).findByText('Prefere fazer você mesmo? Os passos na sua conta AWS'),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Ligar logs' })).not.toBeInTheDocument();
  });

  it('o nó de antes: 404 sem código, e a tela é a de antes, sem botão', async () => {
    const source = withoutLogs('site-alb');
    open([source], webLogsApi());
    const region = await notEnabled();
    expect(await within(region).findByText('Como ligar o log de acesso do site-alb')).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Ligar logs' })).not.toBeInTheDocument();
  });

  it('desligar o que o Verax ligou, já entre os disponíveis', async () => {
    const user = userOf();
    const source = albFixture('site-alb');
    const webLogs = webLogsApi({
      sources: [webSourceFixture(source)],
      albLogging: new Map([
        [
          source.id,
          albLoggingFixture(source.id, {
            lastAction: 'enable',
            status: 'enabled',
            completedAt: new Date().toISOString(),
            enabledByVerax: true,
            bucket: BUCKET,
            enabledAt: new Date().toISOString(),
            enabledBy: 'usuario-1',
            previous: { enabled: false, bucket: null, prefix: null },
          }),
        ],
      ]),
    });
    open([source], webLogs);
    const region = await screen.findByRole('region', { name: /^Disponíveis para coletar/ });
    expect(await within(region).findByText(/Log de acesso ligado pelo Verax/)).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Desligar log' }));
    const dialog = await screen.findByRole('dialog', { name: 'Desligar o log de acesso do site-alb?' });
    expect(dialog).toHaveTextContent('Os arquivos já gravados ficam no bucket');
    await user.click(within(dialog).getByRole('button', { name: 'Desligar o log' }));
    await waitFor(() =>
      expect(webLogs.writes()).toEqual([
        { method: 'POST', path: `sources/${source.id}/access-logs/disable`, body: { confirm: true } },
      ]),
    );
    expect(await within(region).findByText('Desligando o log de acesso…')).toBeInTheDocument();
  });
});

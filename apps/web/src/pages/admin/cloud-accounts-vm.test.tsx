import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AWS_TEMPORARY_KEY_MESSAGE, GCP_KEY_NOT_SERVICE_ACCOUNT_MESSAGE } from '@verax/shared';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { api } from '@/lib/api';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { DEMO_ACCOUNTS, demoMe } from '@/mocks/fixtures';
import { createHandlers, type MockState } from '@/mocks/handlers';
import { routes } from '@/routes/router';

/** Os formulários são preenchidos por colagem, mas a suíte inteira em paralelo passa dos 5 s padrão. */
const FORM_TIMEOUT = 15_000;
/** As contas da demonstração (`account(1, ...)` e `account(4, ...)` em mocks/admin.ts). */
const DEMO_AWS_ALFA_ID = '018f2c1e-0000-7000-8000-0000000c0001';
const DEMO_GCP_ALFA_ID = '018f2c1e-0000-7000-8000-0000000c0004';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  api.resetCsrf();
});
afterAll(() => server.close());

/** Os corpos dos `PUT .../credential`, capturados antes do mock responder (o resolvedor sem resposta segue adiante). */
function captureCredentialBodies(): { bodies: unknown[]; handler: Parameters<typeof server.use>[number] } {
  const bodies: unknown[] = [];
  const handler = http.put(`${API_URL}/v1/cloud-accounts/:id/credential`, async ({ request }) => {
    bodies.push(await request.clone().json());
    return undefined;
  });
  return { bodies, handler };
}

function renderAt(path: string, state: MockState, overrides: Parameters<typeof server.use> = []) {
  server.use(...overrides, ...createHandlers(state));
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

// Chaves no formato da AWS e do Google, montadas aqui: nenhuma credencial real no repositório.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const random = (alphabet: string, length: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
    alphabet.charAt(byte % alphabet.length),
  ).join('');
const awsKeyId = (prefix = 'AKIA') => `${prefix}${random(BASE32, 16)}`;
const awsSecret = () => random('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/+', 40);
const pemBody = () =>
  Array.from({ length: 20 }, () =>
    random('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/', 64),
  );
function keyFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: DEMO_ACCOUNTS.alfaGcp,
    private_key_id: random('0123456789abcdef', 40),
    private_key: ['-----BEGIN PRIVATE KEY-----', ...pemBody(), '-----END PRIVATE KEY-----', ''].join('\n'),
    client_email: `verax-control-reader@${DEMO_ACCOUNTS.alfaGcp}.iam.gserviceaccount.com`,
    token_uri: 'https://oauth2.googleapis.com/token',
    ...overrides,
  });
}

describe('Contas cloud na VM própria do cliente: as chaves de leitura', () => {
  const vm: MockState = { me: demoMe('admin_cliente'), nodePlatform: 'vm' };

  it(
    'AWS: as políticas do usuário de leitura e o formulário da chave; o segredo zera no envio e só o ID volta',
    async () => {
      const user = userEvent.setup();
      const { bodies, handler } = captureCredentialBodies();
      renderAt(`/cadastros/contas?conta=${DEMO_AWS_ALFA_ID}`, vm, [handler]);
      const section = await screen.findByRole('region', {
        name: `Conectar a conta ${DEMO_ACCOUNTS.alfaProducao}`,
      });
      // Nada do papel sem chave: sem template, sem os valores da pilha.
      expect(within(section).queryByText(/Baixar o template/)).not.toBeInTheDocument();
      expect(within(section).getByText('verax-control-reader.json')).toBeInTheDocument();
      expect(within(section).getByText('verax-control-guardrails.json')).toBeInTheDocument();
      expect(section).toHaveTextContent(
        `arn:aws:iam::${DEMO_ACCOUNTS.alfaProducao}:user/verax/verax-control-reader`,
      );
      expect(section).toHaveTextContent('"Sid": "NuncaAmpliarOProprioAcesso"');

      const keyField = within(section).getByLabelText('ID da chave de acesso');
      const secretField = within(section).getByLabelText('Chave secreta');
      expect(secretField).toHaveAttribute('type', 'password');
      expect(secretField).toHaveAttribute('autocomplete', 'off');

      // A chave temporária é recusada antes de sair do navegador; os campos zeram.
      await user.click(keyField);
      await user.paste(awsKeyId('ASIA'));
      await user.click(secretField);
      await user.paste(awsSecret());
      await user.click(within(section).getByRole('button', { name: 'Guardar chave' }));
      expect(secretField).toHaveValue('');
      expect(secretField).toHaveAccessibleDescription(expect.stringContaining(AWS_TEMPORARY_KEY_MESSAGE));
      expect(bodies).toEqual([]);

      const keyId = awsKeyId();
      const secret = awsSecret();
      await user.click(keyField);
      await user.paste(` ${keyId}`);
      await user.click(secretField);
      await user.paste(`${secret}\n`);
      await user.click(within(section).getByRole('button', { name: 'Guardar chave' }));
      expect(keyField).toHaveValue('');
      expect(secretField).toHaveValue('');
      expect(
        await within(section).findByText(/Chave conferida na AWS e guardada no cofre do nó/),
      ).toHaveAttribute('role', 'status');
      expect(bodies).toEqual([{ kind: 'aws_access_key', accessKeyId: keyId, secretAccessKey: secret }]);
      expect(within(section).getByRole('group', { name: 'Chave de acesso guardada' })).toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain(secret);
      // O "Verificar" segue, no texto da chave.
      expect(section).toHaveTextContent(/Guardada a chave, clique em Verificar/);
    },
    FORM_TIMEOUT,
  );

  it(
    'GCP: os comandos no projeto do cliente e a chave JSON; só os quatro campos vão para a API',
    async () => {
      const user = userEvent.setup();
      const { bodies, handler } = captureCredentialBodies();
      renderAt(`/cadastros/contas?conta=${DEMO_GCP_ALFA_ID}`, vm, [handler]);
      const section = await screen.findByRole('region', {
        name: `Leitura do projeto ${DEMO_ACCOUNTS.alfaGcp}`,
      });
      expect(section).toHaveTextContent(
        `gcloud pubsub topics create verax-control-security --project=${DEMO_ACCOUNTS.alfaGcp}`,
      );
      expect(section).toHaveTextContent('roles/pubsub.subscriber');
      // Nada do sink para o tópico do nó.
      expect(within(section).queryByLabelText('Identidade do sink')).not.toBeInTheDocument();

      const field = within(section).getByLabelText('Chave da conta de serviço (JSON)');
      await user.click(field);
      await user.paste(keyFile({ type: 'authorized_user' }));
      await user.click(within(section).getByRole('button', { name: 'Guardar chave' }));
      expect(field).toHaveValue('');
      expect(field).toHaveAccessibleDescription(expect.stringContaining(GCP_KEY_NOT_SERVICE_ACCOUNT_MESSAGE));
      expect(bodies).toEqual([]);

      const file = keyFile();
      const parsed = JSON.parse(file) as Record<string, string>;
      await user.click(field);
      await user.paste(file);
      await user.click(within(section).getByRole('button', { name: 'Guardar chave' }));
      expect(field).toHaveValue('');
      await within(section).findByText(/Chave conferida no Google e guardada no cofre do nó/);
      expect(bodies).toEqual([
        {
          kind: 'gcp_service_account_key',
          projectId: parsed['project_id'],
          clientEmail: parsed['client_email'],
          privateKeyId: parsed['private_key_id'],
          privateKey: parsed['private_key'],
        },
      ]);
      expect(JSON.stringify(bodies)).not.toContain('token_uri');
      await waitFor(() =>
        expect(
          within(section).getByRole('group', { name: 'Chave da conta de serviço guardada' }),
        ).toBeInTheDocument(),
      );
      expect(document.body.innerHTML).not.toContain(parsed['private_key']?.split('\n')[2] ?? '');
    },
    FORM_TIMEOUT,
  );

  it('no nó da GCP, as instruções sem chave de sempre (o papel e o sink), sem formulário de chave', async () => {
    renderAt(`/cadastros/contas?conta=${DEMO_AWS_ALFA_ID}`, { me: demoMe('admin_cliente') });
    const section = await screen.findByRole('region', {
      name: `Conectar a conta ${DEMO_ACCOUNTS.alfaProducao}`,
    });
    expect(within(section).getByText(/Baixar o template/)).toBeInTheDocument();
    expect(within(section).queryByLabelText('Chave secreta')).not.toBeInTheDocument();
  });
});

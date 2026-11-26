import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api';
import type { NodeSyncSourceCode } from '@/lib/api-types';
import { formatDateTime } from '@/lib/format';
import { createFakeState, type FakeAdminState } from '@/mocks/fake-admin-api';
import {
  FAKE_EGRESS_IPS,
  FAKE_NODE_SERVICE_ACCOUNT_ID,
  FAKE_VAULT_FINGERPRINT,
  type FakeLogSource,
  fakeNode,
  simulateNodeSync,
} from '@/mocks/fake-log-sources';
import { server } from '@/mocks/server';
import { renderConsole } from '@/test/render';
import { LOG_SOURCE_ERRORS, logSourceErrorMessage, SOURCE_CODE_MESSAGES } from './log-source-labels';

const ACTIVE_ID = '01JC0000000000000000000D01';
const STALE_ID = '01JC0000000000000000000B01';
const NEVER_ID = '01JC0000000000000000000A01';
const CUSTOMER_ID = '01JC0000000000000000000E01';
const NOW = new Date('2026-11-22T12:00:00.000Z');
const OWNER = 'owner:responsavel@verax.example';

// Valores de formato, gerados por repetição: nenhuma chave de verdade (nem com cara de uma) no repositório.
const CLOUDFLARE_VALUE = 'demo'.repeat(10);
const AWS_KEY_ID = 'DEMO'.repeat(5);
const AWS_KEY_BODY = 'demo'.repeat(10);
const GCP_PEM = ['-----BEGIN', ' DEMO KEY-----\n', 'ZGVtbw=='.repeat(8), '\n-----END DEMO KEY-----\n'].join(
  '',
);

function stateAt(): FakeAdminState {
  return createFakeState({ now: () => NOW });
}

/** O cliente da VM própria (o E) com o nó sincronizado agora, com o cofre pronto. */
function vmState(): FakeAdminState {
  const state = stateAt();
  state.logSources.tenants.set(CUSTOMER_ID, { node: fakeNode('vm', NOW), generation: 0, sources: new Map() });
  return state;
}

async function logSources(): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: 'Fontes de log' });
  await within(region).findByRole('group', { name: 'Situação da sincronização' });
  return region;
}

type User = ReturnType<typeof renderConsole>['user'];

async function openSource(user: User, region: HTMLElement, title: string): Promise<HTMLElement> {
  await user.click(within(region).getByRole('button', { name: `Abrir a fonte ${title}` }));
  return within(region).findByRole('region', { name: title });
}

/** Tudo o que o cache das consultas guarda, em texto. */
function cachedText(client: ReturnType<typeof renderConsole>['client']): string {
  return JSON.stringify(
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );
}

function source(spec: FakeLogSource['spec'], patch: Partial<FakeLogSource> = {}): FakeLogSource {
  return {
    spec,
    state: 'active',
    revision: 1,
    credential: null,
    report: null,
    createdAt: NOW.toISOString(),
    createdBy: OWNER,
    updatedAt: NOW.toISOString(),
    updatedBy: OWNER,
    ...patch,
  };
}

/**
 * As fontes de log no detalhe do cliente, sobre a API simulada (`mocks/fake-log-sources.ts`): a situação do servidor
 * (nunca sincronizou, parado, sincronizado), a tabela com a situação e o motivo de cada fonte, o cadastro (AWS e
 * Cloudflare em todo lugar, GCP só na VM do cliente), a chave colada (que sai dos campos e nunca vai ao cache), a
 * alteração, a remoção com o subdomínio e o que mandar ao cliente. Nenhum dado real.
 */
describe('fontes de log', () => {
  it('nunca sincronizou (VM do cliente): o aviso da versão, sem fonte, e a chave desligada com o motivo', async () => {
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, stateAt());
    const region = await logSources();
    const situation = within(region).getByRole('group', { name: 'Situação da sincronização' });
    expect(situation).toHaveTextContent('O servidor do cliente ainda não se comunicou com a Verax');
    expect(situation).toHaveTextContent('node-v1.2.0');
    expect(situation).toHaveTextContent('Peça ao cliente para atualizar o servidor na VM dele.');
    expect(within(region).getByText(/Nenhuma fonte cadastrada pelo console/)).toBeInTheDocument();

    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    await user.selectOptions(within(form).getByLabelText('Provedor'), 'cloudflare');
    const token = within(form).getByLabelText('Token de API do Cloudflare');
    expect(token).toBeDisabled();
    expect(
      within(form).getByText(
        /O servidor do cliente ainda não sincronizou com a Verax: a chave só pode ser enviada/,
      ),
    ).toBeInTheDocument();
  });

  it('Cloudflare por OAuth: o cadastro não pede token e a fonte sem credencial diz que o cliente conecta', async () => {
    const state = stateAt();
    state.logSources.cloudflareOauth = true;
    const sync = state.logSources.tenants.get(ACTIVE_ID);
    if (sync === undefined) throw new Error('cliente de exemplo ausente');
    sync.sources.set(
      '00000000-0000-4000-8000-0000000000cf',
      source({ provider: 'cloudflare', accountId: 'd'.repeat(32) }),
    );
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    const detail = await openSource(user, region, `Cloudflare ${'d'.repeat(32)}`);
    expect(within(detail).getByText('Sem token: o cliente conecta no painel dele')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: 'Enviar chave…' })).not.toBeInTheDocument();

    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    await user.selectOptions(within(form).getByLabelText('Provedor'), 'cloudflare');
    expect(within(form).queryByLabelText('Token de API do Cloudflare')).not.toBeInTheDocument();
    expect(within(form).getByRole('note')).toHaveTextContent('não há token a colar');
  });

  it('nunca sincronizou (infraestrutura da Verax): o caminho é promover a versão', async () => {
    renderConsole(`/clientes/${NEVER_ID}`, stateAt());
    const region = await logSources();
    const situation = within(region).getByRole('group', { name: 'Situação da sincronização' });
    expect(situation).toHaveTextContent('Promova a versão para este cliente em Versões.');
    expect(within(situation).getByRole('link', { name: 'Versões' })).toHaveAttribute('href', '/versoes');
  });

  it('servidor parado há mais de 15 minutos, e a fonte que espera por ele', async () => {
    renderConsole(`/clientes/${STALE_ID}`, stateAt());
    const region = await logSources();
    const situation = within(region).getByRole('group', { name: 'Situação da sincronização' });
    expect(situation).toHaveTextContent('O servidor do cliente não se comunica há mais de 15 minutos');
    expect(situation).toHaveTextContent(
      `Última sincronização: ${formatDateTime(new Date(NOW.getTime() - 40 * 60_000).toISOString())}`,
    );
    const row = within(region).getByRole('row', { name: /Cloudflare/ });
    expect(row).toHaveTextContent('Pendente');
    expect(row).toHaveTextContent('O servidor aplica na próxima sincronização.');
    expect(row).toHaveTextContent('Nenhuma zona');
  });

  it('sincronizado: a versão, o cofre com a impressão digital para copiar, e cada fonte com a situação', async () => {
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, stateAt());
    const region = await logSources();
    const situation = within(region).getByRole('group', { name: 'Situação da sincronização' });
    expect(situation).toHaveTextContent('Servidor sincronizado');
    expect(within(region).getByText('1a2b3c4')).toBeInTheDocument();
    expect(within(region).getByText(/Pronto \(chave 1\)/)).toBeInTheDocument();
    expect(within(region).getByText('0f1e 0f1e 0f1e 0f1e…')).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Copiar: impressão digital completa' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(FAKE_VAULT_FINGERPRINT);
    expect(within(region).getByText('Copiado: impressão digital.')).toBeInTheDocument();

    const table = within(region).getByRole('table', { name: 'Fontes de log cadastradas pelo console' });
    const applied = within(table).getByRole('row', { name: /111111111111/ });
    expect(applied).toHaveTextContent('Aplicada');
    expect(applied).toHaveTextContent('2 regiões, 2 buckets');
    expect(applied).toHaveTextContent('Sem chave (papel de leitura)');
    expect(applied).toHaveTextContent('Conectada');
    expect(applied).toHaveTextContent('Lendo desde 21/11/2026');
    const panel = within(table).getByRole('row', { name: /222222222222/ });
    expect(panel).toHaveTextContent('Falhou');
    expect(panel).toHaveTextContent(
      'O cliente já cadastrou esta conta no painel dele; ela continua sendo dele.',
    );
    const cloudflare = within(table).getByRole('row', { name: /cf000000000000000000000000000001/ });
    expect(cloudflare).toHaveTextContent('Falhou');
    expect(cloudflare).toHaveTextContent('Token de API do Cloudflare, revisão 1');
    expect(cloudflare).toHaveTextContent('Recusada no servidor: A chave não alcança esta conta.');
    expect(within(table).getByRole('row', { name: /333333333333/ })).toHaveTextContent('Removida');

    // A fonte aberta: o motivo com o que fazer, e nenhuma ação na removida.
    const detail = await openSource(user, region, 'AWS 222222222222');
    expect(detail).toHaveTextContent(
      'O servidor não mexe nela. Para a Verax cuidar da conta, o cliente a remove no painel; depois, remova esta fonte e cadastre de novo.',
    );
    expect(within(detail).getByText('account_exists_panel')).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Abrir a fonte AWS 333333333333' }));
    const removed = await within(region).findByRole('region', { name: 'AWS 333333333333' });
    expect(within(removed).queryByRole('button', { name: 'Alterar…' })).not.toBeInTheDocument();
    expect(within(removed).queryByRole('button', { name: 'Remover…' })).not.toBeInTheDocument();
  });

  it('cada código do servidor tem a mensagem e o que fazer', async () => {
    const state = stateAt();
    const codes = Object.keys(SOURCE_CODE_MESSAGES) as NodeSyncSourceCode[];
    expect(codes).toHaveLength(19);
    const sources = new Map<string, FakeLogSource>();
    codes.forEach((code, index) => {
      const id = `00000000-0000-4000-8000-${(0xc000 + index).toString(16).padStart(12, '0')}`;
      sources.set(
        id,
        source(
          { provider: 'aws', accountId: String(400_000_000_000 + index), regions: ['sa-east-1'] },
          {
            report: {
              id,
              revision: 1,
              outcome: 'failed',
              code,
              credential: null,
              account: null,
              reportedAt: NOW.toISOString(),
            },
          },
        ),
      );
    });
    state.logSources.tenants.set(ACTIVE_ID, { node: fakeNode('gcp', NOW), generation: 1, sources });
    renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    for (const [index, code] of codes.entries()) {
      const account = String(400_000_000_000 + index);
      const row = within(region).getByRole('row', { name: (name) => name.includes(account) });
      expect(row).toHaveTextContent('Falhou');
      expect(row).toHaveTextContent(SOURCE_CODE_MESSAGES[code].message);
      expect(SOURCE_CODE_MESSAGES[code].action.length).toBeGreaterThan(10);
    }
  });

  it('a conta excluída pelo cliente no painel: o motivo e o caminho para cadastrar de novo', async () => {
    const state = stateAt();
    const id = '00000000-0000-4000-8000-00000000d001';
    const sources = new Map<string, FakeLogSource>([
      [
        id,
        source(
          { provider: 'aws', accountId: '111111111111', regions: ['sa-east-1'] },
          {
            report: {
              id,
              revision: 1,
              outcome: 'failed',
              code: 'deleted_in_panel',
              credential: null,
              account: null,
              reportedAt: NOW.toISOString(),
            },
          },
        ),
      ],
    ]);
    state.logSources.tenants.set(ACTIVE_ID, { node: fakeNode('gcp', NOW), generation: 1, sources });
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    const row = within(region).getByRole('row', { name: /111111111111/ });
    expect(row).toHaveTextContent('Falhou');
    expect(row).toHaveTextContent('Excluída pelo cliente no painel dele.');
    const detail = await openSource(user, region, 'AWS 111111111111');
    expect(detail).toHaveTextContent(
      'Para cadastrar de novo, altere a fonte aqui (nova revisão) ou peça ao cliente para conectar pelo painel.',
    );
    expect(within(detail).getByText('deleted_in_panel')).toBeInTheDocument();
    // A fonte continua ativa no console: dá para alterar (a revisão nova) ou remover.
    expect(within(detail).getByRole('button', { name: 'Alterar…' })).toBeEnabled();
  });

  it('cadastrar AWS no gerenciado: sem GCP na lista, sem chave, a conferência antes de mandar e a pilha para o cliente', async () => {
    const state = stateAt();
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    const provider = within(form).getByLabelText('Provedor');
    expect(
      within(provider)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Escolha o provedor', 'AWS', 'Cloudflare']);
    await user.selectOptions(provider, 'aws');
    expect(within(form).getByRole('note')).toHaveTextContent(
      'No ambiente da Verax, a AWS é lida pelo papel sem chave: não há chave a colar.',
    );
    // Os buckets digitados são só para as exceções: o resto o servidor descobre, e o cliente autoriza no painel.
    expect(form).toHaveTextContent(
      'Os buckets são só para as exceções. O servidor descobre sozinho os logs que a AWS grava em AWSLogs/<conta>/',
    );
    expect(form).toHaveTextContent('Cadastre aqui só o bucket fora desse padrão');

    // A conferência da tela: a conta com 12 dígitos e a região no formato.
    await user.type(within(form).getByLabelText('ID da conta AWS'), '4444');
    await user.type(within(form).getByLabelText('Regiões monitoradas'), 'sao-paulo');
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(await within(form).findByText('O ID da conta AWS tem 12 dígitos.')).toBeInTheDocument();
    expect(within(form).getByLabelText('ID da conta AWS')).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByLabelText('Regiões monitoradas')).toHaveAttribute('aria-invalid', 'true');
    expect(state.logSources.tenants.get(ACTIVE_ID)?.sources.size).toBe(4);

    await user.clear(within(form).getByLabelText('ID da conta AWS'));
    await user.type(within(form).getByLabelText('ID da conta AWS'), '444444444444');
    await user.clear(within(form).getByLabelText('Regiões monitoradas'));
    await user.type(
      within(form).getByLabelText('Regiões monitoradas'),
      'sa-east-1{enter}us-east-1, sa-east-1',
    );
    await user.type(
      within(form).getByLabelText('Bucket do CloudTrail (opcional)'),
      's3://cliente-demo-nova/',
    );
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));

    expect(
      await within(region).findByText(/^Fonte cadastrada\. O servidor do cliente a aplica/),
    ).toBeInTheDocument();
    const created = [...(state.logSources.tenants.get(ACTIVE_ID)?.sources.values() ?? [])].find(
      (item) => item.spec.accountId === '444444444444',
    );
    expect(created?.spec).toEqual({
      provider: 'aws',
      accountId: '444444444444',
      regions: ['sa-east-1', 'us-east-1'],
      buckets: { cloudtrail: 'cliente-demo-nova' },
    });
    const detail = await within(region).findByRole('region', { name: 'AWS 444444444444' });
    expect(within(detail).getByText('Pendente')).toBeInTheDocument();
    const stack = within(detail).getByRole('region', { name: 'Papel de leitura da AWS (CloudFormation)' });
    expect(within(stack).getByRole('link', { name: 'Baixar modelo' })).toHaveAttribute(
      'href',
      '/v1/admin/aws-reader/verax-control-reader.yaml',
    );
    expect(within(stack).getByRole('link', { name: /Abrir o CloudFormation/ })).toHaveAttribute(
      'href',
      'https://console.aws.amazon.com/cloudformation/home?region=sa-east-1#/stacks/create',
    );
  });

  it('a pilha da AWS: cada parâmetro com o botão de copiar, o comando e a mensagem para o cliente', async () => {
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, stateAt());
    const region = await logSources();
    const detail = await openSource(user, region, 'AWS 111111111111');
    const stack = within(detail).getByRole('region', { name: 'Papel de leitura da AWS (CloudFormation)' });
    expect(within(stack).queryByRole('note')).not.toBeInTheDocument();
    // Quem opera sabe que o caminho do cliente é o botão do painel, e que este bloco é o manual.
    expect(stack).toHaveTextContent(
      'O cliente conecta pelo painel dele: em Contas cloud, o botão “Conectar com AWS” baixa o modelo já preenchido e abre o CloudFormation.',
    );
    expect(stack).toHaveTextContent('O que está abaixo é o caminho manual');
    // As três autorizações do comando, explicadas numa linha.
    expect(stack).toHaveTextContent(
      'O comando leva as três autorizações ligadas: ReadAwsServiceLogs (os logs que a AWS grava no S3, em AWSLogs/), ReadSecurityFindings (os achados do GuardDuty, do Security Hub, do Inspector e do Access Analyzer) e ReadTaggedLogGroups (os grupos do CloudWatch Logs que o cliente marcar).',
    );
    const command = within(stack).getByLabelText('Comando da AWS CLI', { selector: 'pre' });
    for (const flag of ['ReadAwsServiceLogs=true', 'ReadSecurityFindings=true', 'ReadTaggedLogGroups=true']) {
      expect(command).toHaveTextContent(flag);
    }

    const copies: [string, string][] = [
      ['Nome da pilha', 'verax-control-reader'],
      ['Papel criado', 'arn:aws:iam::111111111111:role/verax/verax-control-reader'],
      ['NodeServiceAccountId', FAKE_NODE_SERVICE_ACCOUNT_ID],
      ['NodeEgressIps', FAKE_EGRESS_IPS.join(',')],
      ['Audience', 'https://control.veraxsistemas.com.br/aws-reader'],
      ['LogBucketArns', 'arn:aws:s3:::cliente-demo-trilha,arn:aws:s3:::cliente-demo-guardduty'],
    ];
    for (const [label, value] of copies) {
      await user.click(within(stack).getByRole('button', { name: `Copiar: ${label}` }));
      await expect(navigator.clipboard.readText()).resolves.toBe(value);
    }
    await user.click(within(stack).getByRole('button', { name: 'Copiar: Comando da AWS CLI' }));
    await expect(navigator.clipboard.readText()).resolves.toContain(
      'aws cloudformation deploy --stack-name verax-control-reader',
    );

    await user.click(within(stack).getByRole('button', { name: 'Copiar mensagem para o cliente' }));
    expect(within(stack).getByText('Copiado: mensagem para o cliente.')).toBeInTheDocument();
    const message = await navigator.clipboard.readText();
    expect(message).toMatch(/^Olá! Para o Verax Control ler os logs da conta AWS 111111111111/);
    expect(message).toContain('verax-control-reader.yaml');
    expect(message).toContain(
      '1. Abra o CloudFormation na região sa-east-1: https://console.aws.amazon.com/',
    );
    expect(message).toContain('3. Nome da pilha: verax-control-reader');
    expect(message).toContain(`   NodeServiceAccountId: ${FAKE_NODE_SERVICE_ACCOUNT_ID}`);
    expect(message).toContain(`   NodeEgressIps: ${FAKE_EGRESS_IPS.join(',')}`);
    expect(message).toContain('Ou, pela AWS CLI, na pasta do modelo:');
    // A mensagem começa pelo caminho do painel; a pilha à mão vem depois, com as três autorizações explicadas.
    expect(message).toContain(
      'O jeito mais simples é pelo painel do Verax Control: em Contas cloud, abra a conta 111111111111 e clique em "Conectar com AWS".',
    );
    expect(message).toContain('Se preferir criar a pilha à mão, pelo console da AWS:');
    expect(message).toContain(
      '   ReadAwsServiceLogs, ReadSecurityFindings e ReadTaggedLogGroups: as três autorizações',
    );
    expect(message).toContain('Nada é coletado até você autorizar cada fonte no painel.');
    expect(message.indexOf('pelo painel do Verax Control')).toBeLessThan(
      message.indexOf('1. Abra o CloudFormation'),
    );
  });

  it('a fonte da AWS sem bucket cadastrado: o parâmetro vazio diz que os logs em AWSLogs/ são descobertos pelo servidor', async () => {
    const state = stateAt();
    const sync = state.logSources.tenants.get(ACTIVE_ID);
    const source = [...(sync?.sources.values() ?? [])].find((item) => item.spec.accountId === '111111111111');
    if (source === undefined || source.spec.provider !== 'aws') throw new Error('fonte de exemplo ausente');
    source.spec = { ...source.spec, buckets: {} };
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const detail = await openSource(user, await logSources(), 'AWS 111111111111');
    const stack = within(detail).getByRole('region', { name: 'Papel de leitura da AWS (CloudFormation)' });
    expect(stack).toHaveTextContent(
      'LogBucketArnsVazio: nenhum bucket fora do padrão cadastrado. Os logs gravados em AWSLogs/ são descobertos pelo servidor.',
    );
  });

  it('a pilha com valores diferentes dos que o servidor informou: o aviso antes de mandar', async () => {
    const state = stateAt();
    const sync = state.logSources.tenants.get(ACTIVE_ID);
    if (sync === undefined || sync.node === null) throw new Error('cliente de exemplo ausente');
    sync.node = { ...sync.node, egressIps: ['198.51.100.7/32'], audience: 'https://outro.example/aws' };
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const detail = await openSource(user, await logSources(), 'AWS 111111111111');
    const stack = within(detail).getByRole('region', { name: 'Papel de leitura da AWS (CloudFormation)' });
    expect(within(stack).getByRole('note')).toHaveTextContent(
      'O servidor informou valores diferentes dos que a Verax conhece: os IPs de saída, o audience.',
    );
  });

  it('cadastrar Cloudflare com a chave: o token oculto, cifrado para o servidor, apagado dos campos e fora dos caches', async () => {
    const state = stateAt();
    const { user, client } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    await user.selectOptions(within(form).getByLabelText('Provedor'), 'cloudflare');
    await user.type(
      within(form).getByLabelText('ID da conta do Cloudflare'),
      'cf000000000000000000000000000009',
    );
    await user.type(within(form).getByLabelText('Zonas (opcional)'), 'Exemplo.com.br');
    const token = within(form).getByLabelText('Token de API do Cloudflare');
    expect(token).toHaveAttribute('type', 'password');
    expect(token).toHaveAttribute('autocomplete', 'off');
    expect(
      within(form).getByText('Opcional: o cliente também pode colar a chave no painel dele.'),
    ).toBeInTheDocument();

    // Curto demais: a API recusa no campo, e o campo volta vazio (cola-se de novo).
    await user.type(token, 'curto');
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(
      await within(form).findByText(/^Token do Cloudflare inválido: cole o valor completo/, {
        selector: 'p',
      }),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Token de API do Cloudflare')).toHaveValue('');

    await user.type(within(form).getByLabelText('Token de API do Cloudflare'), CLOUDFLARE_VALUE);
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(await within(region).findByText(/^Fonte cadastrada, com a chave cifrada/)).toBeInTheDocument();

    const created = [...(state.logSources.tenants.get(ACTIVE_ID)?.sources.values() ?? [])].find(
      (item) => item.spec.accountId === 'cf000000000000000000000000000009',
    );
    expect(created?.spec).toEqual({
      provider: 'cloudflare',
      accountId: 'cf000000000000000000000000000009',
      zones: ['exemplo.com.br'],
    });
    expect(created?.credential).toMatchObject({ kind: 'cloudflare_api_token', revision: 1 });
    expect(JSON.stringify(state.logSources)).not.toContain(CLOUDFLARE_VALUE);
    await waitFor(() => expect(cachedText(client)).toContain('cf000000000000000000000000000009'));
    expect(cachedText(client)).not.toContain(CLOUDFLARE_VALUE);
    expect(client.getMutationCache().getAll()).toEqual([]);
    expect(screen.queryByDisplayValue(CLOUDFLARE_VALUE)).not.toBeInTheDocument();

    // O bloco do Cloudflare: o link do token e os IPs para o filtro.
    const detail = within(region).getByRole('region', {
      name: 'Cloudflare cf000000000000000000000000000009',
    });
    const block = within(detail).getByRole('region', { name: 'Token de leitura do Cloudflare' });
    expect(within(block).getByRole('link', { name: /Criar o token no Cloudflare/ })).toHaveAttribute(
      'href',
      expect.stringMatching(/^https:\/\/dash\.cloudflare\.com\//),
    );
    await user.click(within(block).getByRole('button', { name: 'Copiar: IPs para o filtro do token' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(FAKE_EGRESS_IPS.join(', '));
    await user.click(within(block).getByRole('button', { name: 'Copiar mensagem para o cliente' }));
    await expect(navigator.clipboard.readText()).resolves.toContain(
      `3. Em "Filtro de endereço IP do cliente", permita só: ${FAKE_EGRESS_IPS.join(', ')}`,
    );
  });

  it('enviar chave a uma fonte que existe: a revisão nova, o servidor confere, e nada fica na tela nem no cache', async () => {
    const state = stateAt();
    const { user, client } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    const detail = await openSource(user, region, 'Cloudflare cf000000000000000000000000000001');
    expect(detail).toHaveTextContent(
      'Confira as permissões da chave e, no Cloudflare, o filtro de IP do token',
    );
    await user.click(within(detail).getByRole('button', { name: 'Enviar chave…' }));
    const form = within(detail).getByRole('form', {
      name: 'Enviar chave: Cloudflare cf000000000000000000000000000001',
    });

    // Sem nada colado: o problema no campo, sem chamar a API.
    await user.click(within(form).getByRole('button', { name: 'Enviar a chave' }));
    expect(await within(form).findByText('Cole o token de API.', { selector: 'p' })).toBeInTheDocument();

    await user.type(within(form).getByLabelText('Token de API do Cloudflare'), CLOUDFLARE_VALUE);
    await user.keyboard('{Enter}');
    expect(await within(region).findByText(/^Chave enviada \(revisão 2\)/)).toBeInTheDocument();
    const stored = state.logSources.tenants
      .get(ACTIVE_ID)
      ?.sources.get('00000000-0000-4000-8000-00000000a002');
    expect(stored?.credential).toMatchObject({ revision: 2, envelopeStored: true });
    expect(within(region).queryByRole('form')).not.toBeInTheDocument();
    expect(cachedText(client)).not.toContain(CLOUDFLARE_VALUE);
    expect(client.getMutationCache().getAll()).toEqual([]);

    // A próxima sincronização do servidor: a chave aplicada, e a fonte volta a "Aplicada".
    simulateNodeSync(state.logSources, ACTIVE_ID, NOW);
    await client.invalidateQueries({ queryKey: ['tenant', ACTIVE_ID, 'node-sync'] });
    const row = within(region).getByRole('row', { name: /cf000000000000000000000000000001/ });
    await waitFor(() => expect(row).toHaveTextContent('Aplicada'));
    expect(row).toHaveTextContent('Aplicada no servidor (revisão 2)');
    expect(row).toHaveTextContent('ID da chave terminando em …d3m0');
  });

  it('a chave que o cliente colou no painel aparece como dele', async () => {
    const state = stateAt();
    const sync = state.logSources.tenants.get(ACTIVE_ID);
    const cloudflare = sync?.sources.get('00000000-0000-4000-8000-00000000a002');
    if (cloudflare?.report === null || cloudflare?.report === undefined)
      throw new Error('fonte de exemplo ausente');
    cloudflare.report = {
      ...cloudflare.report,
      credential: {
        revision: null,
        outcome: 'applied',
        code: null,
        kind: 'cloudflare_api_token',
        keyIdSuffix: 'pa1n',
        expiresAt: null,
        verifiedAt: NOW.toISOString(),
      },
    };
    renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    const row = within(region).getByRole('row', { name: /cf000000000000000000000000000001/ });
    expect(row).toHaveTextContent('Chave colada pelo cliente no painel');
    expect(row).toHaveTextContent('ID da chave terminando em …pa1n');
  });

  it('GCP só na VM do cliente: o projeto, a chave do arquivo JSON (só os quatro campos saem) e as instruções', async () => {
    const state = vmState();
    const bodies: unknown[] = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && request.url.endsWith('/log-sources')) {
        void request
          .clone()
          .json()
          .then((body) => bodies.push(body));
      }
    });
    const { user, client } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const region = await logSources();
    expect(within(region).getByText('VM do cliente')).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    await user.selectOptions(within(form).getByLabelText('Provedor'), 'gcp');
    await user.type(within(form).getByLabelText('ID do projeto da GCP'), 'projeto-demo-1');
    await user.type(
      within(form).getByLabelText('Assinatura do Pub/Sub (opcional)'),
      'verax-control-security',
    );
    const file = within(form).getByLabelText('Arquivo JSON da chave da conta de serviço');
    expect(file.tagName).toBe('TEXTAREA');

    // Um arquivo que não é de conta de serviço: o motivo, sem repetir o conteúdo.
    await user.click(file);
    await user.paste(JSON.stringify({ type: 'authorized_user' }));
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(
      await within(form).findByText(/^Este arquivo não é a chave de uma conta de serviço/, { selector: 'p' }),
    ).toBeInTheDocument();

    const keyFile = JSON.stringify({
      type: 'service_account',
      project_id: 'projeto-demo-1',
      private_key_id: 'ab'.repeat(20),
      private_key: GCP_PEM,
      client_email: 'leitor-demo@projeto-demo-1.iam.gserviceaccount.com',
      client_id: '123',
      token_uri: 'https://oauth2.googleapis.com/token',
    });
    await user.clear(within(form).getByLabelText('Arquivo JSON da chave da conta de serviço'));
    await user.click(within(form).getByLabelText('Arquivo JSON da chave da conta de serviço'));
    await user.paste(keyFile);
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(await within(region).findByText(/^Fonte cadastrada, com a chave cifrada/)).toBeInTheDocument();

    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      spec: {
        provider: 'gcp',
        accountId: 'projeto-demo-1',
        pubsubSubscription: 'projects/projeto-demo-1/subscriptions/verax-control-security',
      },
      credential: {
        kind: 'gcp_service_account_key',
        projectId: 'projeto-demo-1',
        clientEmail: 'leitor-demo@projeto-demo-1.iam.gserviceaccount.com',
        privateKeyId: 'ab'.repeat(20),
        privateKey: GCP_PEM,
      },
    });
    expect(cachedText(client)).not.toContain('ZGVtbw==');
    expect(client.getMutationCache().getAll()).toEqual([]);

    const detail = within(region).getByRole('region', { name: 'GCP projeto-demo-1' });
    const block = within(detail).getByRole('region', {
      name: 'Conta de serviço de leitura da GCP (VM do cliente)',
    });
    await user.click(within(block).getByRole('button', { name: 'Copiar mensagem para o cliente' }));
    const message = await navigator.clipboard.readText();
    expect(message).toMatch(
      /^Olá! Para o Verax Control ler os eventos de segurança do projeto projeto-demo-1/,
    );
    expect(message).toContain('gcloud iam service-accounts keys create verax-control-reader.json');
    server.events.removeAllListeners();
  });

  it('AWS na VM do cliente: a chave de acesso nos dois campos, e o usuário IAM para o cliente criar', async () => {
    const state = vmState();
    const { user, client } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const region = await logSources();
    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    await user.selectOptions(within(form).getByLabelText('Provedor'), 'aws');
    await user.type(within(form).getByLabelText('ID da conta AWS'), '555555555555');
    await user.type(within(form).getByLabelText('Regiões monitoradas'), 'sa-east-1');
    // Pela metade: o que falta, no campo.
    await user.type(within(form).getByLabelText('ID da chave de acesso'), AWS_KEY_ID);
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(await within(form).findByText('Cole a chave secreta.', { selector: 'p' })).toBeInTheDocument();
    expect(within(form).getByLabelText('Chave secreta')).toHaveAttribute('type', 'password');

    await user.type(within(form).getByLabelText('Chave secreta'), AWS_KEY_BODY);
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(await within(region).findByText(/^Fonte cadastrada, com a chave cifrada/)).toBeInTheDocument();
    expect(cachedText(client)).not.toContain(AWS_KEY_BODY);
    expect(JSON.stringify(state.logSources)).not.toContain(AWS_KEY_BODY);

    const detail = within(region).getByRole('region', { name: 'AWS 555555555555' });
    expect(
      within(detail).queryByRole('region', { name: 'Papel de leitura da AWS (CloudFormation)' }),
    ).not.toBeInTheDocument();
    const block = within(detail).getByRole('region', { name: 'Usuário IAM de leitura (VM do cliente)' });
    await user.click(within(block).getByRole('button', { name: 'Copiar: Usuário IAM' }));
    await expect(navigator.clipboard.readText()).resolves.toBe(
      'arn:aws:iam::555555555555:user/verax/verax-control-reader',
    );
    await user.click(within(block).getByRole('button', { name: 'Copiar mensagem para o cliente' }));
    const message = await navigator.clipboard.readText();
    expect(message).toContain(
      '1. Salve as duas políticas do fim desta mensagem nos arquivos verax-control-reader.json',
    );
    expect(message).toContain('aws iam create-access-key --user-name verax-control-reader');
    expect(message).toContain(`só a partir do servidor de vocês (${FAKE_EGRESS_IPS.join(',')})`);
  });

  it('o servidor sem o cofre: os campos da chave desligados, com o motivo', async () => {
    const state = vmState();
    const sync = state.logSources.tenants.get(CUSTOMER_ID);
    if (sync === undefined || sync.node === null) throw new Error('cliente de exemplo ausente');
    sync.node = { ...sync.node, vaultReady: false, fingerprint: null, keyVersion: null };
    const { user } = renderConsole(`/clientes/${CUSTOMER_ID}`, state);
    const region = await logSources();
    expect(within(region).getByText('Sem o cofre: a chave não pode ser enviada daqui')).toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    await user.selectOptions(within(form).getByLabelText('Provedor'), 'aws');
    expect(within(form).getByLabelText('ID da chave de acesso')).toBeDisabled();
    expect(within(form).getByLabelText('Chave secreta')).toBeDisabled();
    expect(within(form).getByText(/está sem o cofre de credenciais pronto/)).toBeInTheDocument();
  });

  it('alterar: só os campos do provedor, a revisão nova, e nada mudou sem chamar a API', async () => {
    const state = stateAt();
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    const detail = await openSource(user, region, 'AWS 111111111111');
    await user.click(within(detail).getByRole('button', { name: 'Alterar…' }));
    const form = within(detail).getByRole('form', { name: 'Alterar AWS 111111111111' });
    expect(within(form).queryByLabelText('ID da conta AWS')).not.toBeInTheDocument();
    expect(within(form).queryByLabelText('Provedor')).not.toBeInTheDocument();
    expect(within(form).getByLabelText('Regiões monitoradas')).toHaveValue('sa-east-1\nus-east-1');

    await user.click(within(form).getByRole('button', { name: 'Gravar a alteração' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Nada mudou: altere um campo antes de gravar.',
    );

    await user.type(within(form).getByLabelText('Regiões monitoradas'), '{enter}us-west-2');
    await user.clear(within(form).getByLabelText('Bucket do GuardDuty (opcional)'));
    await user.click(within(form).getByRole('button', { name: 'Gravar a alteração' }));
    expect(await within(region).findByText(/^Fonte alterada \(revisão 3\)/)).toBeInTheDocument();
    const stored = state.logSources.tenants
      .get(ACTIVE_ID)
      ?.sources.get('00000000-0000-4000-8000-00000000a001');
    expect(stored?.revision).toBe(3);
    expect(stored?.spec).toEqual({
      provider: 'aws',
      accountId: '111111111111',
      regions: ['sa-east-1', 'us-east-1', 'us-west-2'],
      buckets: { cloudtrail: 'cliente-demo-trilha' },
    });
    const row = within(region).getByRole('row', { name: /111111111111/ });
    await waitFor(() => expect(row).toHaveTextContent('Pendente'));
    expect(row).toHaveTextContent('3 regiões, 1 bucket');
  });

  it('remover: o subdomínio digitado, o aviso de que o servidor para a coleta, e a fonte em "Removendo"', async () => {
    const state = stateAt();
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    const detail = await openSource(user, region, 'AWS 111111111111');
    await user.click(within(detail).getByRole('button', { name: 'Remover…' }));
    expect(detail).toHaveTextContent(
      'O servidor do cliente desativa a conta 111111111111 e para a coleta desta fonte na próxima sincronização.',
    );
    const confirm = within(detail).getByRole('button', { name: 'Confirmar: remover a fonte' });
    expect(confirm).toBeDisabled();
    await user.type(within(detail).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(confirm);
    expect(await within(region).findByText(/^Fonte removida\./)).toBeInTheDocument();
    expect(
      state.logSources.tenants.get(ACTIVE_ID)?.sources.get('00000000-0000-4000-8000-00000000a001')?.state,
    ).toBe('removed');
    const row = within(region).getByRole('row', { name: /111111111111/ });
    await waitFor(() => expect(row).toHaveTextContent('Removendo'));
    expect(row).toHaveTextContent('O servidor desativa a conta na próxima sincronização.');

    simulateNodeSync(state.logSources, ACTIVE_ID, NOW);
    await user.click(within(region).getByRole('button', { name: 'Fechar a fonte AWS 111111111111' }));
    expect(within(region).queryByRole('region', { name: 'AWS 111111111111' })).not.toBeInTheDocument();
  });

  it('as recusas da API: a conta repetida no campo, o limite de operações e o subdomínio errado', async () => {
    const state = stateAt();
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    await user.click(within(region).getByRole('button', { name: 'Cadastrar fonte…' }));
    const form = within(region).getByRole('form', { name: 'Cadastrar fonte de log' });
    await user.selectOptions(within(form).getByLabelText('Provedor'), 'aws');
    await user.type(within(form).getByLabelText('ID da conta AWS'), '111111111111');
    await user.type(within(form).getByLabelText('Regiões monitoradas'), 'sa-east-1');
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(await within(form).findByText(LOG_SOURCE_ERRORS['source_exists'] ?? '')).toBeInTheDocument();
    expect(within(form).getByLabelText('ID da conta AWS')).toHaveAttribute('aria-invalid', 'true');

    state.logSources.rateLimited = true;
    await user.clear(within(form).getByLabelText('ID da conta AWS'));
    await user.type(within(form).getByLabelText('ID da conta AWS'), '666666666666');
    await user.click(within(form).getByRole('button', { name: 'Cadastrar a fonte' }));
    expect(
      await within(form).findByText(/^Muitas operações em pouco tempo \(o limite é de 20 por hora\)/),
    ).toBeInTheDocument();
    state.logSources.rateLimited = false;

    const detail = await openSource(user, region, 'AWS 111111111111');
    await user.click(within(detail).getByRole('button', { name: 'Remover…' }));
    // A API confere de novo: um subdomínio que muda entre a tela e o pedido é recusado.
    server.use(
      http.post('*/v1/admin/tenants/:id/log-sources/:sourceId/remove', () =>
        HttpResponse.json(
          {
            message: 'O subdomínio não confere com o do cliente: nada mudou.',
            code: 'confirmation_mismatch',
            details: { issues: [{ path: 'confirmSlug', message: 'Digite o subdomínio.' }] },
          },
          { status: 400 },
        ),
      ),
    );
    await user.type(within(detail).getByLabelText(/Digite o subdomínio/), 'contrato-ativo');
    await user.click(within(detail).getByRole('button', { name: 'Confirmar: remover a fonte' }));
    expect(await within(detail).findByRole('alert')).toHaveTextContent(
      'O subdomínio não confere com o do cliente: nada mudou.',
    );
  });

  it('cada código de recusa da API tem a mensagem em português', () => {
    const codes = [
      'source_exists',
      'source_limit',
      'source_removed',
      'no_change',
      'placement_unsupported',
      'not_allowed',
      'node_not_synced',
      'vault_disabled',
      'platform_mismatch',
      'vault_key_invalid',
      'gcp_unsupported_managed',
      'credential_kind_not_allowed',
      'cloudflare_oauth_only',
      'credential_provider_mismatch',
      'confirmation_mismatch',
      'rate_limited',
      'invalid_request',
    ];
    for (const code of codes) {
      const message = logSourceErrorMessage(new ApiError(409, 'texto da API', code));
      expect(message).toBe(LOG_SOURCE_ERRORS[code]);
      expect(message).not.toBe('texto da API');
    }
    expect(logSourceErrorMessage(new ApiError(409, 'texto da API', 'outro_codigo'))).toBe('texto da API');
  });

  it('o contrato terminado: as fontes só para consulta', async () => {
    const state = stateAt();
    const tenant = state.tenants.tenants.get(ACTIVE_ID);
    if (tenant === undefined) throw new Error('cliente de exemplo ausente');
    state.tenants.tenants.set(ACTIVE_ID, { ...tenant, state: 'canceled' });
    const { user } = renderConsole(`/clientes/${ACTIVE_ID}`, state);
    const region = await logSources();
    expect(
      within(region).getByText('O contrato terminou: as fontes ficam só para consulta.'),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('button', { name: 'Cadastrar fonte…' })).not.toBeInTheDocument();
    const detail = await openSource(user, region, 'AWS 111111111111');
    expect(within(detail).queryByRole('button', { name: 'Alterar…' })).not.toBeInTheDocument();
  });
});

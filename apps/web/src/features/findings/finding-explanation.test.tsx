import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import {
  extractFindingChange,
  type FindingChange,
  type FindingChangeContext,
  findingChangeContextSchema,
  type FindingDetail,
  findingDetailSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import { FindingDetailView } from './finding-detail';

/**
 * "O que aconteceu" no detalhe do alerta: a explicação em português pela alteração da API, com o antes e o depois; pelo evento
 * bruto num nó de antes (404); só pelos campos sem nenhum dos dois; nada para o alerta que não é de mudança na conta; e tudo
 * como texto, nunca HTML.
 */

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ID = '018f2c1e-0000-7000-8000-000000009001';
const PREVIOUS_ID = '018f2c1e-0000-7000-8000-000000009000';
const AT = '2026-11-24T12:00:00.000Z';
const ACCOUNT = '111111111111';
const LAMBDA = `arn:aws:sts::${ACCOUNT}:assumed-role/waf-auto-block-role-x1y2/waf-auto-block`;

/** O `data.aws` de um UpdateIPSet de uma função Lambda, como o Wazuh o grava. */
const ipSetEvent = (addresses: string[]) => ({
  source: 'cloudtrail',
  eventSource: 'wafv2.amazonaws.com',
  eventName: 'UpdateIPSet',
  awsRegion: 'us-east-1',
  userAgent: 'Boto3/1.34.0 exec-env/AWS_Lambda_python3.12',
  userIdentity: { type: 'AssumedRole', arn: LAMBDA, accountId: ACCOUNT },
  requestParameters: { name: 'blocked-ips', scope: 'REGIONAL', id: 'ipset-0001', addresses, lockToken: 'x' },
});

const changeOf = (addresses: string[]): FindingChange => {
  const change = extractFindingChange(ipSetEvent(addresses));
  if (change === null) throw new Error('alteração esperada');
  return change;
};

const finding = (overrides: Partial<FindingDetail> = {}): FindingDetail =>
  findingDetailSchema.parse({
    id: ID,
    accountId: ACCOUNT,
    occurredAt: AT,
    severity: 'medium',
    status: 'new',
    title: 'Regras do WAF alteradas',
    source: 'cloudtrail',
    eventName: 'UpdateIPSet',
    region: 'us-east-1',
    resource: null,
    actor: { user: LAMBDA, type: 'AssumedRole', accessKeyId: null, ip: '198.51.100.20' },
    mitreTactics: ['Defense Evasion'],
    incidentId: null,
    commentCount: 0,
    ruleId: '100323',
    ruleLevel: 7,
    mitreTechniques: ['T1562'],
    comments: [],
    rawEvent: null,
    ...overrides,
  });

function open(reply: FindingChangeContext | Response, item = finding()) {
  server.use(
    http.get(`${API_URL}/v1/findings/:id/change`, () =>
      reply instanceof Response ? reply.clone() : HttpResponse.json(findingChangeContextSchema.parse(reply)),
    ),
    ...createHandlers({ me: demoMe('leitura') }),
  );
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <FindingDetailView finding={item} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const section = () => screen.findByRole('region', { name: 'O que aconteceu' });
const notFound = () => HttpResponse.json({ statusCode: 404, message: 'Not Found' }, { status: 404 });

describe('O que aconteceu', () => {
  it('lista de IPs do WAF por uma automação: quem, o quê, antes e depois, por que importa, o que conferir e a exceção', async () => {
    open({
      change: changeOf(['203.0.113.7/32', '203.0.113.8/32', '203.0.113.9/32', '198.51.100.1/32']),
      previous: {
        findingId: PREVIOUS_ID,
        occurredAt: '2026-11-23T12:00:00.000Z',
        change: changeOf(['198.51.100.1/32', '198.51.100.2/32']),
      },
      repeats: { days: 30, count: 14 },
    });
    const inside = await section();
    expect(inside).toHaveTextContent(
      'Uma automação (função Lambda waf-auto-block) alterou a lista de IPs "blocked-ips" (id ipset-0001) do WAF. Incluiu 3 endereços e retirou 1 endereço.',
    );
    expect(within(inside).getByRole('heading', { name: 'Antes e depois' })).toBeInTheDocument();
    const added = within(inside).getByRole('list', { name: 'Incluídos (3)' });
    expect(
      within(added)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['203.0.113.7', '203.0.113.8', '203.0.113.9']);
    const removed = within(inside).getByRole('list', { name: 'Retirados (1)' });
    expect(removed).toHaveTextContent('198.51.100.2');
    expect(inside).toHaveTextContent('Estado anterior registrado em');
    expect(inside).toHaveTextContent('Por que importa: As listas de IPs do WAF');
    expect(inside).toHaveTextContent('O que conferir: Veja se os endereços incluídos');
    expect(within(inside).getByRole('note')).toHaveTextContent(
      'Esta mesma automação gerou 14 alertas desta regra nos últimos 30 dias.',
    );
    // A seção vem antes dos campos do alerta.
    const fields = screen.getByText('Quando', { selector: 'dt' });
    expect(inside.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('sem o estado anterior: diz que ele não está disponível e mostra a lista de agora, com teto', async () => {
    const many = Array.from({ length: 25 }, (_, index) => `203.0.113.${index + 1}/32`);
    open({ change: changeOf(many), previous: null, repeats: { days: 30, count: 1 } });
    const inside = await section();
    expect(inside).toHaveTextContent(
      'O estado anterior não está disponível (não há alerta anterior deste objeto); a lista agora tem 25 endereços.',
    );
    const now = within(inside).getByRole('list', { name: 'Endereços agora (25)' });
    expect(within(now).getAllByRole('listitem')).toHaveLength(21);
    expect(now).toHaveTextContent('e mais 5');
    expect(within(inside).queryByRole('note')).toBeNull();
  });

  it('nó de antes (404): explica pelo evento bruto do detalhe', async () => {
    open(notFound(), finding({ rawEvent: { data: { aws: ipSetEvent(['203.0.113.7/32']) } } }));
    const inside = await section();
    expect(inside).toHaveTextContent('Uma automação (função Lambda waf-auto-block) alterou a lista de IPs');
    expect(inside).toHaveTextContent('a lista agora tem 1 endereço.');
  });

  it('sem a alteração e sem o evento bruto: explica pelos campos e avisa', async () => {
    open(notFound(), finding({ eventName: 'DeleteRuleGroup' }));
    const inside = await section();
    expect(inside).toHaveTextContent('apagou o grupo de regras do WAF.');
    expect(inside).toHaveTextContent('Os detalhes da alteração não estão disponíveis para este alerta');
  });

  it('alerta que não é de mudança na conta (agente) não tem a seção', async () => {
    open(
      { change: null, previous: null, repeats: { days: 30, count: 0 } },
      finding({ source: 'wazuh_agent', accountId: 'agent:001', ruleId: '5710', eventName: 'sshd' }),
    );
    await screen.findByText('Quando', { selector: 'dt' });
    // Dá tempo à consulta da alteração.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole('region', { name: 'O que aconteceu' })).toBeNull();
  });

  it('o que veio do log é texto, nunca HTML', async () => {
    const hostile = `arn:aws:sts::${ACCOUNT}:assumed-role/papel/<img src=x onerror=alert(1)>`;
    open(
      { change: changeOf(['203.0.113.7/32']), previous: null, repeats: { days: 30, count: 0 } },
      finding({ actor: { user: hostile, type: 'AssumedRole', accessKeyId: null, ip: null } }),
    );
    const inside = await section();
    expect(inside).toHaveTextContent('função Lambda <img src=x onerror=alert(1)>');
    expect(inside.querySelector('img')).toBeNull();
  });
});

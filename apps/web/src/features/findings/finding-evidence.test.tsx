import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type FindingDetail,
  findingDetailSchema,
  type FindingEvidence,
  findingEvidenceSchema,
  type FindingWebEvidence,
  findingWebEvidenceSchema,
} from '@verax/shared';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { MemoryRouter } from 'react-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { demoMe } from '@/mocks/fixtures';
import { createHandlers } from '@/mocks/handlers';
import { FindingDetailView } from './finding-detail';

/** A evidência de um ataque web no detalhe do alerta: só texto, do schema estrito, com o que se sabe e o que não se sabe. */

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ID = '018f2c1e-0000-7000-8000-000000001001';
const AT = '2026-11-24T12:00:00.000Z';

const finding = (overrides: Partial<FindingDetail> = {}): FindingDetail =>
  findingDetailSchema.parse({
    id: ID,
    accountId: '111111111111',
    occurredAt: AT,
    severity: 'high',
    status: 'new',
    title: 'Força bruta numa rota de login por um mesmo endereço',
    source: 'alb',
    eventName: '40 falhas em 42 tentativas de login em 15 min',
    region: 'sa-east-1',
    resource: 'alb:app/loja/0123456789abcdef',
    actor: { user: null, type: null, accessKeyId: null, ip: '203.0.113.7' },
    mitreTactics: ['Credential Access'],
    incidentId: null,
    commentCount: 0,
    ruleId: '990405',
    ruleLevel: 10,
    mitreTechniques: ['T1110'],
    comments: [],
    rawEvent: null,
    ...overrides,
  });

const evidence = (overrides: Partial<FindingWebEvidence> = {}): FindingWebEvidence =>
  findingWebEvidenceSchema.parse({
    version: 1,
    ruleId: '990405',
    windowFrom: '2026-11-24T11:45:00.000Z',
    windowTo: AT,
    firstSeenAt: '2026-11-24T11:00:00.000Z',
    lastSeenAt: AT,
    client: '203.0.113.7',
    clientClass: 'direct',
    host: 'loja.exemplo.com.br',
    route: '/lojas/*/entrar',
    routeKind: 'login',
    routeSemantics: 'declared',
    counters: {
      requests: 1_200,
      blocked: 300,
      errors: 0,
      toolRequests: 0,
      probes: 0,
      distinctPaths: 0,
      attempts: 42,
      failures: 40,
      successes: 2,
      clients: 0,
      answered: 0,
    },
    blockedPercent: 25,
    statuses: [
      { status: '401', count: 40 },
      { status: '-', count: 2 },
    ],
    probeFamilies: ['env', 'familia_nova'],
    routes: [{ path: '/clientes/{num}/entrar', count: 42 }],
    clients: [],
    userAgents: {
      families: ['sqlmap', 'empty', 'familia_nova'],
      sample: 'sqlmap/1.8 <script>alert(1)</script>',
    },
    samples: [{ at: AT, method: 'POST', path: '/clientes/{num}/entrar', status: 401, bytes: 1_212 }],
    pointers: [
      {
        objectKey:
          'AWSLogs/111111111111/elasticloadbalancing/sa-east-1/2026/11/24/<img src=x onerror=alert(1)>.log.gz',
        minute: AT,
      },
    ],
    truncated: false,
    notes: ['valid_account_possible', 'nota_nova'],
    ...overrides,
  });

function open(reply: FindingEvidence | Response, item = finding()) {
  const requests: string[] = [];
  server.use(
    http.get(`${API_URL}/v1/findings/:id/evidence`, ({ params }) => {
      requests.push(String(params['id']));
      return reply instanceof Response
        ? reply.clone()
        : HttpResponse.json(findingEvidenceSchema.parse(reply));
    }),
    ...createHandlers({ me: demoMe('leitura') }),
  );
  const view = render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>
        <FindingDetailView finding={item} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, requests };
}
const region = () => screen.findByRole('region', { name: 'Evidência' });
const value = (inside: HTMLElement, label: string) =>
  within(inside).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent;

describe('a evidência de um alerta dos logs do ALB', () => {
  it('o que aconteceu, as contagens, as respostas, os caminhos e onde estão as linhas originais', async () => {
    open({ evidence: evidence(), samplesPurgedAt: null });
    const inside = await region();
    await within(inside).findByText('Contagens da janela');
    expect(inside).toHaveTextContent('Um mesmo endereço tentou entrar muitas vezes na mesma rota de login.');
    expect(value(inside, 'Endereço')).toBe('203.0.113.7');
    expect(value(inside, 'Host')).toBe('loja.exemplo.com.br');
    expect(value(inside, 'Rota')).toBe('/lojas/*/entrarlogin, declarada por você');
    expect(value(inside, 'Requisições')).toBe('1.200');
    expect(value(inside, 'Barradas pelo WAF')).toBe('300 (25%)');
    expect(value(inside, 'Falhas de login')).toBe('40');
    // O zero não aparece: a regra não conta aquilo.
    expect(within(inside).queryByText('Sondas a caminhos sensíveis')).not.toBeInTheDocument();
    // Conexão direta é o comum: só a que não é tem a origem dita.
    expect(within(inside).queryByText('Origem')).not.toBeInTheDocument();
    const statuses = within(inside).getByRole('list', { name: 'Requisições por código de resposta' });
    expect(
      within(statuses)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['40140', 'Sem resposta2']);
    expect(within(inside).getByRole('list', { name: 'Famílias de caminhos sensíveis' })).toHaveTextContent(
      'Arquivos .envfamilia_nova',
    );
    expect(within(inside).getByRole('list', { name: 'Famílias de User-Agent' })).toHaveTextContent(
      'sqlmapSem User-Agentfamilia_nova',
    );
    expect(within(inside).getByRole('list', { name: 'Amostras das requisições' })).toHaveTextContent(
      'POST /clientes/{num}/entrar',
    );
    expect(inside).toHaveTextContent('resposta 401 · 1.212 bytes');
    expect(inside).toHaveTextContent('Abra no seu S3 o arquivo abaixo');
    expect(inside).toHaveTextContent('A parte depois de ? nunca é guardada.');
    expect(inside).toHaveTextContent('O uso de uma conta válida é uma possibilidade, não uma constatação.');
    expect(inside).toHaveTextContent('Observação do servidor: nota_nova.');
  });

  it('nada do que veio da internet vira HTML nem link', async () => {
    const { container } = open({ evidence: evidence(), samplesPurgedAt: null });
    const inside = await region();
    await within(inside).findByText('Contagens da janela');
    expect(inside).toHaveTextContent('<script>alert(1)</script>');
    expect(inside).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(container.querySelector('script, img')).toBeNull();
    expect(inside.querySelector('a')).toBeNull();
    for (const element of container.querySelectorAll('*')) {
      expect([...element.attributes].some((attribute) => attribute.name.startsWith('on'))).toBe(false);
    }
  });

  it('a chave do arquivo é copiada inteira', async () => {
    const user = userEvent.setup();
    const copied = vi.spyOn(navigator.clipboard, 'writeText');
    open({ evidence: evidence(), samplesPurgedAt: null });
    await user.click(await screen.findByRole('button', { name: /^Copiar a chave do arquivo do minuto de/ }));
    expect(copied).toHaveBeenCalledWith(evidence().pointers[0]?.objectKey);
    expect(await screen.findByText('Copiada')).toBeInTheDocument();
  });

  it('o ataque distribuído: os endereços, quantos são ao todo, e as contagens como piso', async () => {
    const clients = Array.from({ length: 20 }, (_, index) => ({
      client: `198.51.100.${index}`,
      requests: 30,
      count: 20 - Math.floor(index / 4),
    }));
    open({
      evidence: evidence({
        ruleId: '990407',
        client: null,
        clientClass: null,
        clients,
        counters: { ...evidence().counters, clients: 212 },
        truncated: true,
        notes: ['counts_are_floor'],
      }),
      samplesPurgedAt: null,
    });
    const inside = await region();
    const list = await within(inside).findByRole('list', { name: 'Endereços, do mais ativo ao menos ativo' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(20);
    expect(list).toHaveTextContent('198.51.100.020 de 30 requisições');
    expect(within(inside).getByRole('heading', { name: 'Endereços (20 de 212)' })).toBeInTheDocument();
    expect(value(inside, 'Falhas de login')).toBe('pelo menos 40');
    expect(within(inside).queryByText('Endereço')).not.toBeInTheDocument();
  });

  it('atrás de uma CDN: a origem no lugar do endereço', async () => {
    open({
      evidence: evidence({ client: null, clientClass: 'cloudfront', notes: ['client_not_direct'] }),
      samplesPurgedAt: null,
    });
    const inside = await region();
    await within(inside).findByText('Contagens da janela');
    expect(value(inside, 'Origem')).toBe('CloudFront');
    expect(inside).toHaveTextContent('nenhum visitante é apontado');
  });

  it('as amostras que expiraram: as contagens continuam, e a tela diz o que saiu e onde está o original', async () => {
    open({
      evidence: evidence({ samples: [], pointers: [], userAgents: { families: ['sqlmap'], sample: null } }),
      samplesPurgedAt: '2026-12-24T12:00:00.000Z',
    });
    const inside = await region();
    const note = await within(inside).findByRole('note');
    expect(note).toHaveTextContent(/expiraram em 24\/12\/2026/);
    expect(note).toHaveTextContent('elas ficam 30 dias');
    expect(note).toHaveTextContent('seguem no seu S3');
    expect(value(inside, 'Falhas de login')).toBe('40');
    expect(within(inside).queryByRole('list', { name: 'Amostras das requisições' })).not.toBeInTheDocument();
  });

  it('a regra que a tela não conhece mostra o resto, sem inventar explicação', async () => {
    open({ evidence: evidence({ ruleId: '990499', routeKind: 'tipo_novo' }), samplesPurgedAt: null });
    const inside = await region();
    await within(inside).findByText('Contagens da janela');
    expect(inside).not.toHaveTextContent('Um mesmo endereço tentou entrar');
    expect(value(inside, 'Rota')).toBe('/lojas/*/entrardeclarada por você');
  });
});

describe('quando não há evidência', () => {
  it('o nó de antes (404): o alerta aparece inteiro, sem a seção e sem erro', async () => {
    const { requests } = open(HttpResponse.json({ statusCode: 404, message: 'x' }, { status: 404 }));
    await waitFor(() => expect(requests).toEqual([ID]));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Evidência' })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Regra (logs de acesso do ALB)')).toBeInTheDocument();
  });

  it('o alerta sem evidência guardada diz onde estão as linhas', async () => {
    open({ evidence: null, samplesPurgedAt: null });
    expect(await region()).toHaveTextContent('Carregando a evidência');
    expect(await screen.findByText(/Este alerta não tem evidência guardada/)).toBeInTheDocument();
  });

  it('a falha aparece com a saída; a resposta fora do contrato, também', async () => {
    open(HttpResponse.json({ evidence: { ...evidence(), client: '<b>x</b>' }, samplesPurgedAt: null }));
    const inside = await region();
    expect(await within(inside).findByRole('alert')).toHaveTextContent(
      'O servidor respondeu algo inesperado',
    );
    expect(within(inside).getByRole('button', { name: 'Tentar de novo' })).toBeInTheDocument();
    expect(inside.querySelector('b')).toBeNull();
  });

  it('o alerta de outra fonte não pede a evidência, e mostra o evento bruto de sempre', async () => {
    const { requests } = open(
      { evidence: null, samplesPurgedAt: null },
      finding({ source: 'waf', ruleId: '80410' }),
    );
    expect(screen.getByText('Evento bruto')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests).toEqual([]);
    expect(screen.queryByRole('region', { name: 'Evidência' })).not.toBeInTheDocument();
  });

  it('o alerta do ALB não oferece o evento bruto, que não existe', async () => {
    open({ evidence: evidence(), samplesPurgedAt: null });
    await region();
    expect(screen.queryByText('Evento bruto')).not.toBeInTheDocument();
  });
});

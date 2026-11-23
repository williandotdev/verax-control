import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { type AwsOnboarding, type CloudAccount } from '@verax/shared';
import { http, HttpResponse, type RequestHandler } from 'msw';
import { AwsOnboardingSection } from '@/features/admin/aws-onboarding-section';
import { API_URL } from '@/lib/env';
import { createQueryClient } from '@/lib/query-client';
import { readerTemplateHandler } from './aws-reader-template';

/**
 * A API do onboarding da AWS nos testes da tela: o teste diz o estado que a leitura devolve e o que cada escrita
 * responde, e confere os pedidos que chegaram. Nada de regra aqui (a imitação com regras é `mocks/aws-onboarding.ts`):
 * a tela é testada contra respostas exatas, uma por estado.
 */

/** As escritas do onboarding, pelo fim do caminho. */
export type OnboardingRoute = 'connect' | 'discovery' | 'authorize' | 'revoke' | 'retry' | 'verify';

export interface OnboardingCall {
  route: OnboardingRoute;
  /** O ID da fonte, nas rotas de uma fonte. */
  sourceId: string | null;
  body: unknown;
}

type Reply = AwsOnboarding | Response;

export interface OnboardingApi {
  handlers: RequestHandler[];
  calls: OnboardingCall[];
  /** Quantas vezes o estado foi lido. */
  reads: () => number;
  /** O que a leitura (e a escrita sem resposta própria) devolve a partir de agora. */
  set: (onboarding: AwsOnboarding) => void;
  /** A resposta de uma escrita: o estado novo (que passa a ser o da leitura) ou uma recusa. */
  on: (route: OnboardingRoute, reply: (call: OnboardingCall) => Reply | Promise<Reply>) => void;
}

/** Uma recusa da API, com o status e o código. */
export function refusal(status: number, code?: string, message = 'mensagem da API'): Response {
  return HttpResponse.json({ statusCode: status, message, ...(code ? { code } : {}) }, { status });
}

function routeOf(pathname: string): { route: OnboardingRoute; sourceId: string | null } | null {
  const rest = pathname.split('/aws/')[1] ?? '';
  if (rest === 'connect' || rest === 'discovery' || rest === 'verify') return { route: rest, sourceId: null };
  if (rest === 'sources/authorize') return { route: 'authorize', sourceId: null };
  const [prefix, sourceId, action] = rest.split('/');
  if (prefix === 'sources' && sourceId && (action === 'revoke' || action === 'retry')) {
    return { route: action, sourceId };
  }
  return null;
}

export function onboardingApi(account: CloudAccount, initial: AwsOnboarding): OnboardingApi {
  let current = initial;
  let reads = 0;
  const calls: OnboardingCall[] = [];
  const replies = new Map<OnboardingRoute, (call: OnboardingCall) => Reply | Promise<Reply>>();
  const base = `${API_URL}/v1/cloud-accounts/${account.id}/aws`;
  const handlers = [
    readerTemplateHandler(),
    http.get(`${base}/onboarding`, () => {
      reads += 1;
      return HttpResponse.json(current);
    }),
    http.post(`${base}/*`, async ({ request }) => {
      const matched = routeOf(new URL(request.url).pathname);
      if (matched === null) return HttpResponse.json({ statusCode: 404, message: 'rota' }, { status: 404 });
      const call: OnboardingCall = { ...matched, body: await request.json().catch(() => undefined) };
      calls.push(call);
      const reply = await replies.get(matched.route)?.(call);
      if (reply instanceof Response) return reply;
      if (reply !== undefined) current = reply;
      // O "Verificar" responde com a conta; as demais, com o estado do onboarding.
      if (matched.route === 'verify') {
        return HttpResponse.json({ ...account, checkRequestedAt: new Date().toISOString() }, { status: 202 });
      }
      return HttpResponse.json(current);
    }),
  ];
  return {
    handlers,
    calls,
    reads: () => reads,
    set: (onboarding) => {
      current = onboarding;
    },
    on: (route, reply) => {
      replies.set(route, reply);
    },
  };
}

/** A seção da conta AWS sozinha, com o cliente de consultas do painel. */
export function renderAwsSection(account: CloudAccount, canWrite = true) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <AwsOnboardingSection account={account} canWrite={canWrite} />
    </QueryClientProvider>,
  );
}

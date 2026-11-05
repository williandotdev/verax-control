import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { STSClient } from '@aws-sdk/client-sts';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClient } from '../inventory/fake-aws.js';
import { buildPinoOptions } from '../../src/common/logger/logger.options.js';
import { REDACTED, scrubString } from '../../src/common/logger/sanitize.js';
import {
  AwsConnectionError,
  checkNodeIdentity,
  fetchGoogleIdToken,
  GOOGLE_IDENTITY_URL,
  googleIdTokenSubject,
  reportNodeIdentity,
  SESSION_REFRESH_MARGIN_MS,
  WebIdentityCredentials,
} from '../../src/aws/web-identity.js';

// Valores fictícios: conta de documentação da AWS, ID de conta de serviço inventado e audience de exemplo.
const ACCOUNT = '111122223333';
const SERVICE_ACCOUNT = '123456789012345678901';
const AUDIENCE = 'https://aws.verax.example/reader';
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/verax/verax-control-reader`;
const HOUR = 60 * 60 * 1000;

/** Um token com a forma do do Google (montado na hora: nenhum JWT fica escrito no código). */
function googleToken(sub = SERVICE_ACCOUNT): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iss: 'https://accounts.google.com', aud: AUDIENCE, azp: sub, sub })}.${randomBytes(48).toString('base64url')}`;
}

/** Uma sessão fictícia da AWS, com segredos novos a cada chamada. */
function session(expiration: Date) {
  return {
    AccessKeyId: 'ASIAEXEMPLO000000000',
    SecretAccessKey: randomBytes(30).toString('base64'),
    SessionToken: randomBytes(96).toString('base64'),
    Expiration: expiration,
  };
}

function awsError(name: string, status = 403): Error {
  const error = Object.assign(new Error(`${name}: detalhe da AWS que não pode ir para o log`), {
    $metadata: { httpStatusCode: status },
  });
  error.name = name;
  return error;
}

/** Logger que guarda as linhas como o pino do worker as escreveria (com a limpeza). */
function capturedLogger() {
  const lines: string[] = [];
  const logger = pino(buildPinoOptions({ LOG_LEVEL: 'debug' }), {
    write: (line: string) => {
      lines.push(line);
    },
  });
  return { logger, text: () => lines.join('') };
}

describe('token do Google pelo metadata (PR-V5)', () => {
  it('pede o token para o audience do nó, em format=standard, com o cabeçalho do metadata', async () => {
    const token = googleToken();
    const requests: { url: string; headers: Headers; redirect?: string }[] = [];
    const fake: typeof fetch = (input, init) => {
      requests.push({
        url: typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        headers: new Headers(init?.headers),
        ...(init?.redirect !== undefined && { redirect: init.redirect }),
      });
      return Promise.resolve(new Response(`${token}\n`));
    };
    expect(await fetchGoogleIdToken(AUDIENCE, undefined, { fetch: fake })).toBe(token);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_IDENTITY_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({ audience: AUDIENCE, format: 'standard' });
    expect(requests[0]?.headers.get('Metadata-Flavor')).toBe('Google');
    expect(requests[0]?.redirect).toBe('error');
  });

  it('metadata fora, lento, com erro ou com resposta fora do formato: metadata_unavailable, que pode passar', async () => {
    const cases: [string, typeof fetch][] = [
      ['rede', () => Promise.reject(new TypeError('fetch failed'))],
      ['404', () => Promise.resolve(new Response('não', { status: 404 }))],
      ['texto qualquer', () => Promise.resolve(new Response('<html>portal cativo</html>'))],
      ['token grande demais', () => Promise.resolve(new Response(`a.${'b'.repeat(9000)}.c`))],
      [
        'lento (3 s no nó; 30 ms aqui)',
        (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
          }),
      ],
    ];
    for (const [label, fake] of cases) {
      const failure = await fetchGoogleIdToken(AUDIENCE, undefined, { fetch: fake, timeoutMs: 30 }).catch(
        (error: unknown) => error,
      );
      expect(failure, label).toBeInstanceOf(AwsConnectionError);
      expect(failure, label).toMatchObject({ code: 'metadata_unavailable', retryable: true });
    }
  });

  it('audience fora do formato: recusado sem chamar o metadata', async () => {
    let called = false;
    const fake: typeof fetch = () => {
      called = true;
      return Promise.resolve(new Response(googleToken()));
    };
    await expect(
      fetchGoogleIdToken('http://aws.verax.example/reader', undefined, { fetch: fake }),
    ).rejects.toMatchObject({ code: 'metadata_unavailable', retryable: false });
    expect(called).toBe(false);
  });

  it('a parada do worker passa adiante como cancelamento, não como erro da conexão', async () => {
    const controller = new AbortController();
    const fake: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
      });
    const pending = fetchGoogleIdToken(AUDIENCE, controller.signal, { fetch: fake });
    controller.abort(new DOMException('o worker está parando', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('identidade do nó na partida do worker (PR-V5)', () => {
  it('lê o sub do token sem rede; um token estranho dá null', () => {
    expect(googleIdTokenSubject(googleToken())).toBe(SERVICE_ACCOUNT);
    expect(googleIdTokenSubject('a.b.c')).toBeNull();
    expect(googleIdTokenSubject('só-uma-parte')).toBeNull();
    const noSub = `${Buffer.from('{}').toString('base64url')}.${Buffer.from('{"aud":"x"}').toString('base64url')}.x`;
    expect(googleIdTokenSubject(noSub)).toBeNull();
  });

  it('confere o sub com o NODE_SA_UNIQUE_ID e loga o resultado, nunca o token', async () => {
    const token = googleToken('109876543210987654321');
    const { logger, text } = capturedLogger();

    const mismatch = await checkNodeIdentity(SERVICE_ACCOUNT, () => Promise.resolve(token));
    expect(mismatch).toEqual({
      status: 'mismatch',
      expected: SERVICE_ACCOUNT,
      actual: '109876543210987654321',
    });
    reportNodeIdentity(mismatch, logger);
    expect(text()).toContain('"level":50');
    expect(text()).toContain('não é da conta de serviço do NODE_SA_UNIQUE_ID');
    expect(text()).toContain('"googleSubject":"109876543210987654321"');

    const ok = await checkNodeIdentity(SERVICE_ACCOUNT, () => Promise.resolve(googleToken()));
    expect(ok).toEqual({ status: 'ok' });
    reportNodeIdentity(ok, logger);

    const unavailable = await checkNodeIdentity(SERVICE_ACCOUNT, () =>
      Promise.reject(new AwsConnectionError('metadata_unavailable', true)),
    );
    expect(unavailable).toEqual({ status: 'unavailable', code: 'metadata_unavailable' });
    reportNodeIdentity(unavailable, logger);

    expect(text()).not.toContain(token);
    expect(text()).not.toContain(token.split('.')[2]);
    expect(text()).not.toContain('eyJ');
  });
});

describe('sessão no papel de leitura sem chave (PR-V5)', () => {
  function setup({
    answer,
    now = () => new Date('2026-11-04T12:00:00.000Z'),
  }: { answer?: (region: string) => unknown; now?: () => Date } = {}) {
    const tokens: string[] = [];
    const idToken = () => {
      const token = googleToken();
      tokens.push(token);
      return Promise.resolve(token);
    };
    const regions: string[] = [];
    const stsCalls: { region: string; input: Record<string, unknown> }[] = [];
    const sts = (region: string) => {
      regions.push(region);
      const fake = fakeClient<STSClient>({
        AssumeRoleWithWebIdentityCommand: (input) => {
          stsCalls.push({ region, input });
          return answer?.(region) ?? { Credentials: session(new Date(now().getTime() + HOUR)) };
        },
      });
      return fake.client;
    };
    const { logger, text } = capturedLogger();
    const credentials = new WebIdentityCredentials({ audience: AUDIENCE, idToken, sts, now, logger });
    return { credentials, tokens, stsCalls, regions, text };
  }

  it('troca o token do nó pelo papel derivado da conta, por 1 hora, no STS da região da conta', async () => {
    const { credentials, tokens, stsCalls } = setup();
    const result = await credentials.session(ACCOUNT, 'sa-east-1');
    expect(stsCalls).toEqual([
      {
        region: 'sa-east-1',
        input: {
          RoleArn: ROLE_ARN,
          RoleSessionName: 'verax-control-worker',
          WebIdentityToken: tokens[0],
          DurationSeconds: 3600,
        },
      },
    ]);
    expect(result.regionFallback).toBe(false);
    expect(result.stsRegion).toBe('sa-east-1');
    expect(result.credentials.identity().accessKeyId).toBe('ASIAEXEMPLO000000000');
    // O provedor para os clientes do SDK (PR-14') devolve a mesma sessão, sem entrar de novo.
    expect(await credentials.credentialsFor(ACCOUNT, 'sa-east-1')()).toEqual(result.credentials.identity());
    expect(stsCalls).toHaveLength(1);
  });

  it('guarda a sessão até faltarem 5 min; pedidos ao mesmo tempo dividem uma entrada só', async () => {
    let clock = new Date('2026-11-04T12:00:00.000Z');
    const { credentials, stsCalls, tokens } = setup({ now: () => clock });
    await Promise.all([
      credentials.session(ACCOUNT, 'sa-east-1'),
      credentials.session(ACCOUNT, 'sa-east-1'),
      credentials.session(ACCOUNT, 'us-east-1'),
    ]);
    expect(stsCalls).toHaveLength(1);
    clock = new Date(clock.getTime() + HOUR - SESSION_REFRESH_MARGIN_MS - 1000);
    await credentials.session(ACCOUNT, 'sa-east-1');
    expect(stsCalls).toHaveLength(1);
    clock = new Date(clock.getTime() + 2000);
    await credentials.session(ACCOUNT, 'sa-east-1');
    expect(stsCalls).toHaveLength(2);
    // Um token novo do metadata a cada entrada no papel.
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
    // Outra conta, outra sessão.
    await credentials.session('444455556666', 'sa-east-1');
    expect(stsCalls).toHaveLength(3);
  });

  it('as credenciais não viram JSON nem texto de log; o segredo e o token são ocultados enquanto valem', async () => {
    let clock = new Date('2026-11-04T12:00:00.000Z');
    const { credentials } = setup({ now: () => clock });
    const first = (await credentials.session(ACCOUNT, 'sa-east-1')).credentials;
    const { secretAccessKey, sessionToken } = first.identity();
    expect(JSON.stringify({ first })).not.toContain(secretAccessKey);
    expect(inspect({ first }, { depth: 5 })).not.toContain(secretAccessKey);
    expect(scrubString(`falhou: ${secretAccessKey} e ${sessionToken}`)).toBe(
      `falhou: ${REDACTED} e ${REDACTED}`,
    );
    // Trocada a sessão, a anterior deixa de ser segredo vivo (o conjunto não cresce a cada hora).
    clock = new Date(clock.getTime() + HOUR);
    const second = (await credentials.session(ACCOUNT, 'sa-east-1')).credentials.identity();
    expect(scrubString(secretAccessKey)).toBe(secretAccessKey);
    expect(scrubString(second.secretAccessKey)).toBe(REDACTED);
    credentials.forget(ACCOUNT);
    expect(scrubString(second.secretAccessKey)).toBe(second.secretAccessKey);
  });

  it('cada falha do STS vira o código da conta, sem a mensagem da AWS', async () => {
    const cases: [unknown, string, boolean][] = [
      [awsError('AccessDenied'), 'trust_denied', true],
      [awsError('InvalidIdentityTokenException', 400), 'token_invalid', false],
      [awsError('ExpiredTokenException', 400), 'token_invalid', false],
      [awsError('IDPRejectedClaimException'), 'token_invalid', false],
      [awsError('IDPCommunicationErrorException', 400), 'idp_unavailable', true],
      [awsError('Throttling', 400), 'aws_unavailable', true],
      [awsError('InternalFailure', 500), 'aws_unavailable', true],
      [Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }), 'aws_unavailable', true],
      [awsError('ValidationError', 400), 'check_unavailable', true],
    ];
    for (const [error, code, retryable] of cases) {
      const { credentials } = setup({
        answer: () => {
          throw error;
        },
      });
      const failure = await credentials.session(ACCOUNT, 'sa-east-1').catch((caught: unknown) => caught);
      expect(failure, code).toBeInstanceOf(AwsConnectionError);
      expect(failure, code).toMatchObject({ code, retryable });
      expect((failure as Error).message).not.toContain('detalhe');
    }
    const { credentials } = setup({
      answer: () => ({ Credentials: { AccessKeyId: 'ASIAEXEMPLO000000000' } }),
    });
    await expect(credentials.session(ACCOUNT, 'sa-east-1')).rejects.toMatchObject({
      code: 'aws_unavailable',
      retryable: true,
    });
  });

  it('STS da região desligado (RegionDisabled): repete em us-east-1 com o mesmo token, marca a sessão e avisa', async () => {
    const { credentials, stsCalls, tokens, text } = setup({
      answer: (region) => {
        if (region === 'sa-east-1') throw awsError('RegionDisabledException');
        return undefined;
      },
    });
    const result = await credentials.session(ACCOUNT, 'sa-east-1');
    expect(stsCalls.map((call) => call.region)).toEqual(['sa-east-1', 'us-east-1']);
    expect(tokens).toHaveLength(1);
    expect(stsCalls[1]?.input.WebIdentityToken).toBe(tokens[0]);
    expect(result).toMatchObject({ stsRegion: 'us-east-1', regionFallback: true });
    expect(text()).toContain('STS da região desligado');
    expect(text()).toContain('"stsRegion":"sa-east-1"');
    expect(text()).not.toContain(ACCOUNT);
    expect(text()).not.toContain(tokens[0]);
  });

  it('na conta de us-east-1, RegionDisabled não tem segunda tentativa: region_disabled', async () => {
    const { credentials, stsCalls } = setup({
      answer: () => {
        throw awsError('RegionDisabledException');
      },
    });
    await expect(credentials.session(ACCOUNT, 'us-east-1')).rejects.toMatchObject({
      code: 'region_disabled',
    });
    expect(stsCalls).toHaveLength(1);
  });

  it('o metadata fora não chega ao STS', async () => {
    const stsCalls: unknown[] = [];
    const credentials = new WebIdentityCredentials({
      audience: AUDIENCE,
      idToken: () => Promise.reject(new AwsConnectionError('metadata_unavailable', true)),
      sts: () =>
        fakeClient<STSClient>({
          AssumeRoleWithWebIdentityCommand: (input) => stsCalls.push(input),
        }).client,
    });
    await expect(credentials.session(ACCOUNT, 'sa-east-1')).rejects.toMatchObject({
      code: 'metadata_unavailable',
    });
    expect(stsCalls).toEqual([]);
  });
});

/**
 * O SDK de verdade contra um STS falso na própria máquina: a troca sai sem assinatura (nenhuma credencial da AWS é
 * procurada), com os campos certos, e o `RegionDisabledException` do STS da região leva à segunda tentativa.
 */
describe('AssumeRoleWithWebIdentity pelo SDK, contra um STS falso (PR-V5)', () => {
  interface Seen {
    authorization: string | undefined;
    body: URLSearchParams;
  }
  const seen: Record<string, Seen[]> = { 'sa-east-1': [], 'us-east-1': [] };
  const servers: Record<string, Server> = {};
  const expiration = '2026-11-04T13:00:00Z';
  const secret = randomBytes(30).toString('base64');

  const success = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <SubjectFromWebIdentityToken>${SERVICE_ACCOUNT}</SubjectFromWebIdentityToken>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::${ACCOUNT}:assumed-role/verax-control-reader/verax-control-worker</Arn>
      <AssumedRoleId>AROAEXEMPLO0000000000:verax-control-worker</AssumedRoleId>
    </AssumedRoleUser>
    <Credentials>
      <SessionToken>token-de-sessao-do-sts-falso-0000000000</SessionToken>
      <SecretAccessKey>${secret}</SecretAccessKey>
      <Expiration>${expiration}</Expiration>
      <AccessKeyId>ASIAEXEMPLO000000000</AccessKeyId>
    </Credentials>
    <Provider>accounts.google.com</Provider>
    <Audience>${SERVICE_ACCOUNT}</Audience>
  </AssumeRoleWithWebIdentityResult>
  <ResponseMetadata><RequestId>00000000-0000-4000-8000-000000000001</RequestId></ResponseMetadata>
</AssumeRoleWithWebIdentityResponse>`;
  const regionDisabled = `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <Error><Type>Sender</Type><Code>RegionDisabledException</Code><Message>STS is not activated in this region for account:${ACCOUNT}.</Message></Error>
  <RequestId>00000000-0000-4000-8000-000000000002</RequestId>
</ErrorResponse>`;

  async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }

  beforeAll(async () => {
    for (const region of ['sa-east-1', 'us-east-1']) {
      const server = createServer((request, response) => {
        void readBody(request).then((body) => {
          seen[region]?.push({
            authorization: request.headers.authorization,
            body: new URLSearchParams(body),
          });
          const disabled = region === 'sa-east-1';
          response.writeHead(disabled ? 403 : 200, { 'content-type': 'text/xml' });
          response.end(disabled ? regionDisabled : success);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers[region] = server;
    }
  });

  afterAll(async () => {
    for (const server of Object.values(servers)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('a troca vai sem assinatura, com o papel e a sessão do worker, e cai para us-east-1 no RegionDisabled', async () => {
    const token = googleToken();
    let credentialLookups = 0;
    const credentials = new WebIdentityCredentials({
      audience: AUDIENCE,
      idToken: () => Promise.resolve(token),
      now: () => new Date('2026-11-04T12:00:00.000Z'),
      sts: (region) =>
        new STSClient({
          region,
          endpoint: `http://127.0.0.1:${(servers[region]?.address() as AddressInfo).port}`,
          maxAttempts: 1,
          credentials: () => {
            credentialLookups += 1;
            return Promise.reject(new Error('a troca não deveria procurar credencial'));
          },
        }),
    });
    const result = await credentials.session(ACCOUNT, 'sa-east-1');
    expect(credentialLookups).toBe(0);
    expect(result).toMatchObject({ stsRegion: 'us-east-1', regionFallback: true });
    expect(result.credentials.identity()).toEqual({
      accessKeyId: 'ASIAEXEMPLO000000000',
      secretAccessKey: secret,
      sessionToken: 'token-de-sessao-do-sts-falso-0000000000',
      expiration: new Date(expiration),
    });
    for (const region of ['sa-east-1', 'us-east-1']) {
      expect(seen[region]).toHaveLength(1);
      const request = seen[region]?.[0];
      expect(request?.authorization).toBeUndefined();
      expect(Object.fromEntries(request?.body ?? [])).toMatchObject({
        Action: 'AssumeRoleWithWebIdentity',
        RoleArn: ROLE_ARN,
        RoleSessionName: 'verax-control-worker',
        WebIdentityToken: token,
        DurationSeconds: '3600',
      });
    }
  });
});

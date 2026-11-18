import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../common/http/api-error.js';
import { type AdminSecretSource, SecretUnavailableError } from './admin-secrets.js';
import {
  AdminTurnstile,
  CONSOLE_LOGIN_ACTION,
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TOKEN_MAX_LENGTH,
  type TurnstileFetch,
  turnstileTokenOf,
} from './turnstile.js';

/** Gerada a cada execução: nenhuma chave fixa no repositório. */
const SECRET = `segredo-de-teste-${Math.random().toString(36).slice(2)}`;
const TOKEN = 'token-do-widget-de-teste';
/** Chave de site de teste da Cloudflare: o hostname do siteverify não é conferido. */
const TEST_SITE_KEY = '1x00000000000000000000AA';
/** No formato de uma chave real (`0x…`), sem ser uma: liga a conferência do hostname e da action. */
const REAL_SHAPED_SITE_KEY = '0x0000000000000000000000AA';
const CONSOLE_HOST = 'admin.example.com';

interface SetupOptions {
  siteKey?: string | undefined;
  secret?: string | undefined;
  secretFails?: boolean;
  nodeEnv?: 'production' | 'test';
}

function setup(response: (init: RequestInit) => Promise<Response>, options: SetupOptions = {}) {
  const fetchImpl = vi.fn<TurnstileFetch>((_input, init) => response(init));
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const secretReads = vi.fn(() =>
    options.secretFails === true
      ? Promise.reject(new SecretUnavailableError())
      : Promise.resolve('secret' in options ? options.secret : SECRET),
  );
  const secrets: AdminSecretSource = {
    totpKey: () => Promise.resolve(undefined),
    ssoSigningKey: () => Promise.resolve(undefined),
    turnstileSecretKey: secretReads,
  };
  const turnstile = new AdminTurnstile(
    {
      ADMIN_TURNSTILE_SITE_KEY: 'siteKey' in options ? options.siteKey : TEST_SITE_KEY,
      ADMIN_CONSOLE_HOSTNAME: CONSOLE_HOST,
      NODE_ENV: options.nodeEnv ?? 'test',
    },
    secrets,
    fetchImpl,
    logger as unknown as PinoLogger,
  );
  const logged = () =>
    JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls, ...logger.info.mock.calls]);
  return { turnstile, fetchImpl, logger, logged, secretReads };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );

const ok = () =>
  json({ success: true, 'error-codes': [], hostname: CONSOLE_HOST, action: CONSOLE_LOGIN_ACTION });

async function refusal(promise: Promise<void>): Promise<{ status: number; code: string | undefined }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return { status: error.getStatus(), code: error.code };
    throw error;
  }
  throw new Error('esperava a recusa');
}

describe('Turnstile do login do console', () => {
  it('sem a chave do site: desligado, nada conferido, nem a rede nem o cofre', async () => {
    const { turnstile, fetchImpl, secretReads } = setup(ok, { siteKey: undefined });
    expect(turnstile.enabled).toBe(false);
    expect(turnstile.siteKey).toBeNull();
    await expect(turnstile.assertLogin(undefined, undefined)).resolves.toBeUndefined();
    turnstile.onApplicationBootstrap();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(secretReads).not.toHaveBeenCalled();
  });

  it('em produção sem a chave do site, a partida avisa que o login está sem o desafio', () => {
    const { turnstile, logger } = setup(ok, { siteKey: undefined, nodeEnv: 'production' });
    turnstile.onApplicationBootstrap();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin_turnstile_disabled' }),
      expect.any(String),
    );
  });

  it('sucesso: manda chave, token e IP ao siteverify, com prazo e sem seguir redirecionamento', async () => {
    const { turnstile, fetchImpl } = setup(ok);
    await expect(turnstile.assertLogin(TOKEN, '203.0.113.9')).resolves.toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(TURNSTILE_SITEVERIFY_URL);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      secret: SECRET,
      response: TOKEN,
      remoteip: '203.0.113.9',
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.redirect).toBe('error');
  });

  it('sem IP conhecido, o campo remoteip não vai', async () => {
    const { turnstile, fetchImpl } = setup(ok);
    expect(await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('ok');
    expect(JSON.parse(fetchImpl.mock.calls[0]?.[1].body as string)).not.toHaveProperty('remoteip');
  });

  it('sem token (ou vazio): 400 turnstile_required, sem ir à rede', async () => {
    const { turnstile, fetchImpl } = setup(ok);
    expect(await refusal(turnstile.assertLogin(undefined, undefined))).toEqual({
      status: 400,
      code: 'turnstile_required',
    });
    expect(await refusal(turnstile.assertLogin('', undefined))).toEqual({
      status: 400,
      code: 'turnstile_required',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('o header: um valor só; lista ou vazio vale como ausente', () => {
    expect(turnstileTokenOf(TOKEN)).toBe(TOKEN);
    expect(turnstileTokenOf(undefined)).toBeUndefined();
    expect(turnstileTokenOf('')).toBeUndefined();
    expect(turnstileTokenOf([TOKEN, TOKEN])).toBeUndefined();
  });

  it('token acima do limite: recusado sem ir à rede, e o token não vai para o log', async () => {
    const { turnstile, fetchImpl, logged } = setup(ok);
    const token = 'x'.repeat(TURNSTILE_TOKEN_MAX_LENGTH + 1);
    expect(await refusal(turnstile.assertLogin(token, undefined))).toEqual({
      status: 400,
      code: 'turnstile_failed',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logged()).not.toContain(token);
  });

  it('recusa da Cloudflare: 400 turnstile_failed, só os códigos de erro no log (nem token, nem chave)', async () => {
    const { turnstile, logged } = setup(() =>
      json({ success: false, 'error-codes': ['timeout-or-duplicate'], hostname: CONSOLE_HOST }),
    );
    expect(await refusal(turnstile.assertLogin(TOKEN, undefined))).toEqual({
      status: 400,
      code: 'turnstile_failed',
    });
    expect(logged()).toContain('timeout-or-duplicate');
    expect(logged()).not.toContain(TOKEN);
    expect(logged()).not.toContain(SECRET);
  });

  describe('hostname e action com uma chave real', () => {
    it('o domínio do console e a action do login: passa', async () => {
      const { turnstile } = setup(ok, { siteKey: REAL_SHAPED_SITE_KEY });
      expect(await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('ok');
    });

    it.each([
      ['o painel (mesmo widget)', 'veraxsistemas.com.br'],
      ['outro site', 'outro.example'],
      ['subdomínio do console', `x.${CONSOLE_HOST}`],
      ['sem hostname', undefined],
    ])('%s: 400 turnstile_failed, com o motivo e sem o token no log', async (_label, hostname) => {
      const { turnstile, logged } = setup(
        () =>
          json({ success: true, action: CONSOLE_LOGIN_ACTION, ...(hostname !== undefined && { hostname }) }),
        { siteKey: REAL_SHAPED_SITE_KEY },
      );
      expect(await refusal(turnstile.assertLogin(TOKEN, undefined))).toEqual({
        status: 400,
        code: 'turnstile_failed',
      });
      expect(logged()).toContain('hostname-mismatch');
      expect(logged()).not.toContain(TOKEN);
    });

    it.each([['login'], ['password-reset'], [''], [undefined]])(
      'token resolvido com a action %j: recusado',
      async (action) => {
        const { turnstile, logged } = setup(
          () => json({ success: true, hostname: CONSOLE_HOST, ...(action !== undefined && { action }) }),
          { siteKey: REAL_SHAPED_SITE_KEY },
        );
        expect(await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('failed');
        expect(logged()).toContain('action-mismatch');
      },
    );
  });

  describe('com a chave de teste da Cloudflare', () => {
    it('qualquer hostname e action vazia passam (a Cloudflare responde com valores fictícios)', async () => {
      const { turnstile } = setup(() => json({ success: true, hostname: 'example.com', action: '' }));
      expect(await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('ok');
    });

    it('uma action de outro formulário continua recusada', async () => {
      const { turnstile } = setup(() => json({ success: true, hostname: 'example.com', action: 'login' }));
      expect(await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('failed');
    });
  });

  describe('fecha a porta (503 turnstile_unavailable) quando não dá para conferir', () => {
    it('prazo esgotado (o AbortSignal do fetch): 503, com só o nome do erro no log', async () => {
      const { turnstile, logged } = setup(
        (init) =>
          new Promise<Response>((_resolve, reject) => {
            const abort = () =>
              reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
            init.signal?.addEventListener('abort', abort);
            // O prazo de verdade é de 5 s; aqui o fetch "estoura" na hora, como o AbortSignal.timeout faria.
            abort();
          }),
      );
      expect(await refusal(turnstile.assertLogin(TOKEN, undefined))).toEqual({
        status: 503,
        code: 'turnstile_unavailable',
      });
      expect(logged()).toContain('TimeoutError');
      expect(logged()).not.toContain(TOKEN);
      expect(logged()).not.toContain(SECRET);
    });

    it('erro de rede, resposta 5xx ou fora do formato: 503', async () => {
      const network = setup(() => Promise.reject(new TypeError('fetch failed')));
      expect(await network.turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('unavailable');
      const server = setup(() => json({ error: 'x' }, 500));
      expect(await server.turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('unavailable');
      const garbage = setup(() => Promise.resolve(new Response('<html>', { status: 200 })));
      expect(await garbage.turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('unavailable');
      const shape = setup(() => json({ success: 'sim' }));
      expect(await shape.turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('unavailable');
    });

    it('cofre vazio (a chave do site sem a secreta): 503, sem ir à rede, e o motivo no log', async () => {
      const { turnstile, fetchImpl, logger, secretReads } = setup(ok, { secret: undefined });
      expect(await refusal(turnstile.assertLogin(TOKEN, undefined))).toEqual({
        status: 503,
        code: 'turnstile_unavailable',
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'admin_turnstile_secret_missing' }),
        expect.any(String),
      );
      // Vazio não fica guardado: gravar uma versão vale sem reiniciar.
      await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION);
      expect(secretReads).toHaveBeenCalledTimes(2);
    });

    it('cofre fora do ar: 503', async () => {
      const { turnstile, fetchImpl } = setup(ok, { secretFails: true });
      expect(await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION)).toBe('unavailable');
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  it('a chave secreta é lida uma vez e guardada', async () => {
    const { turnstile, secretReads } = setup(ok);
    await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION);
    await turnstile.verify(TOKEN, undefined, CONSOLE_LOGIN_ACTION);
    expect(secretReads).toHaveBeenCalledOnce();
  });

  it('na partida, com o Turnstile ligado e o cofre vazio, o erro sai no log (o serviço sobe)', async () => {
    const { turnstile, logger } = setup(ok, { secret: undefined, nodeEnv: 'production' });
    turnstile.onApplicationBootstrap();
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'admin_turnstile_secret_missing' }),
        expect.any(String),
      ),
    );
  });
});

import { HttpStatus, Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../common/config/config.module.js';
import { REAL_TURNSTILE_SITE_KEY_PREFIX } from '../../common/config/env.schema.js';
import { ApiError } from '../../common/http/api-error.js';
import { ADMIN_SECRETS, type AdminSecretSource, SecretUnavailableError } from './admin-secrets.js';

/**
 * Cloudflare Turnstile no login do console (o único formulário público do cp-admin que recebe a senha): o widget gera
 * um token no navegador, a tela o manda neste header, e o cp-admin o confere no siteverify da Cloudflare antes de olhar
 * a senha. O mesmo desenho do painel (`apps/api/src/auth/turnstile.ts`), com duas diferenças: a chave secreta vem do
 * cofre `cp-admin-turnstile-secret-key` (lida pela API do Secret Manager, como as outras chaves do console), e quem liga
 * é a chave do site (`ADMIN_TURNSTILE_SITE_KEY`). Sem ela, nada é conferido e o login segue como sempre.
 */
export const TURNSTILE_TOKEN_HEADER = 'x-turnstile-token';

/**
 * A `action` com que o console desenha o widget do login. O siteverify devolve a `action` do token: um token resolvido
 * no login do painel (`login`), que usa o mesmo widget, não vale aqui.
 */
export const CONSOLE_LOGIN_ACTION = 'console-login';

/** Endpoint oficial de validação do token. Fixo: a chave secreta vai no corpo, e não há por que mandá-la a outro lugar. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** O siteverify responde em bem menos que isso; passou, o login é recusado (fecha, não abre). */
export const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 5_000;

/** Tamanho máximo do token do widget, pela documentação da Cloudflare. Maior que isso nem vai ao siteverify. */
export const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

/** O `fetch` do siteverify: o global em produção; nos testes, um dublê (nada sai para a rede). */
export const ADMIN_TURNSTILE_FETCH = Symbol('ADMIN_TURNSTILE_FETCH');
export type TurnstileFetch = (input: string, init: RequestInit) => Promise<Response>;

export type TurnstileOutcome = 'ok' | 'required' | 'failed' | 'unavailable';

/** As mensagens da tela: genéricas, o motivo fica só no log. */
export const TURNSTILE_REQUIRED_MESSAGE = 'Conclua a verificação de segurança e tente de novo.';
export const TURNSTILE_FAILED_MESSAGE = 'A verificação de segurança não foi aceita. Tente de novo.';

/** Resposta do siteverify (entrada externa: validada antes de decidir). Os campos a mais são descartados. */
const siteverifyResponse = z.object({
  success: z.boolean(),
  'error-codes': z.array(z.string().max(100)).max(20).default([]),
  hostname: z.string().max(253).optional(),
  action: z.string().max(100).optional(),
});

/** Só o nome e o código do erro de rede: a mensagem poderia trazer a URL ou o corpo da requisição. */
function errorKind(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'unknown' };
  const cause = error.cause as { code?: unknown } | undefined;
  return { name: error.name, ...(typeof cause?.code === 'string' ? { code: cause.code } : {}) };
}

/** O token do header: um valor só; repetido (lista) ou vazio vale como ausente. */
export function turnstileTokenOf(header: string | string[] | undefined): string | undefined {
  return typeof header === 'string' && header !== '' ? header : undefined;
}

/**
 * O verificador do console. Ligado só com `ADMIN_TURNSTILE_SITE_KEY`; ligado, toda falha fecha a porta: sem token ou
 * com token recusado, 400; siteverify fora do ar, fora do prazo ou cofre vazio, 503. A chave e o token nunca saem
 * daqui: nem no log, nem na mensagem de erro.
 *
 * Logs: `admin_turnstile_failed` (com o motivo: `missing-token`, `token-too-long`, os `error-codes` da Cloudflare,
 * `action-mismatch` ou `hostname-mismatch`), `admin_turnstile_unavailable`, `admin_turnstile_secret_missing` e, em
 * produção sem a chave do site, `admin_turnstile_disabled` na partida.
 */
@Injectable()
export class AdminTurnstile implements OnApplicationBootstrap {
  /** A chave do site (pública), para as telas; `null` com o Turnstile desligado. */
  readonly siteKey: string | null;
  private readonly realKey: boolean;
  private readonly expectedHostname: string | undefined;
  private readonly production: boolean;
  private secretCache: string | undefined;

  constructor(
    @Inject(APP_CONFIG)
    config: Pick<AppConfig, 'ADMIN_TURNSTILE_SITE_KEY' | 'ADMIN_CONSOLE_HOSTNAME' | 'NODE_ENV'>,
    @Inject(ADMIN_SECRETS) private readonly secrets: AdminSecretSource,
    @Inject(ADMIN_TURNSTILE_FETCH) private readonly fetchImpl: TurnstileFetch,
    @InjectPinoLogger(AdminTurnstile.name) private readonly logger: PinoLogger,
  ) {
    this.siteKey = config.ADMIN_TURNSTILE_SITE_KEY ?? null;
    // Com uma chave real, o token só vale se foi resolvido no console (o schema exige o domínio junto). As de teste
    // (`1x…`, `2x…`, `3x…`) respondem com um hostname fictício, e a conferência não se aplica.
    this.realKey = this.siteKey?.startsWith(REAL_TURNSTILE_SITE_KEY_PREFIX) === true;
    this.expectedHostname = config.ADMIN_CONSOLE_HOSTNAME?.toLowerCase();
    this.production = config.NODE_ENV === 'production';
  }

  get enabled(): boolean {
    return this.siteKey !== null;
  }

  /**
   * O aviso da partida, sem segurar o serviço: em produção sem a chave do site, o login segue sem o desafio; com ela, a
   * chave secreta é lida já, e o cofre vazio sai no log (o login responde 503 até alguém gravar uma versão).
   */
  onApplicationBootstrap(): void {
    if (!this.enabled) {
      if (this.production) {
        this.logger.warn(
          { event: 'admin_turnstile_disabled' },
          'Turnstile desligado: login do console sem o desafio (defina ADMIN_TURNSTILE_SITE_KEY e grave cp-admin-turnstile-secret-key)',
        );
      }
      return;
    }
    void this.secret().catch(() => undefined);
  }

  /**
   * Confere o token do widget do login e lança a recusa (`ApiError`) quando não passa. Desligado, não faz nada. O
   * `remoteIp` é o `req.ip` pela regra do app (`common/http/client-ip.ts`).
   */
  async assertLogin(token: string | undefined, remoteIp: string | undefined): Promise<void> {
    if (!this.enabled) return;
    const outcome = await this.verify(token, remoteIp, CONSOLE_LOGIN_ACTION);
    switch (outcome) {
      case 'ok':
        return;
      case 'required':
        throw new ApiError(HttpStatus.BAD_REQUEST, TURNSTILE_REQUIRED_MESSAGE, 'turnstile_required');
      case 'failed':
        throw new ApiError(HttpStatus.BAD_REQUEST, TURNSTILE_FAILED_MESSAGE, 'turnstile_failed');
      case 'unavailable':
        throw new ApiError(HttpStatus.SERVICE_UNAVAILABLE, 'Console indisponível', 'turnstile_unavailable');
    }
  }

  /** Confere o token no siteverify. Nunca lança: cada saída vira uma resposta em `assertLogin`. */
  async verify(
    token: string | undefined,
    remoteIp: string | undefined,
    expectedAction: string,
  ): Promise<TurnstileOutcome> {
    if (token === undefined || token.length === 0) {
      this.refused('missing-token');
      return 'required';
    }
    if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
      this.refused('token-too-long');
      return 'failed';
    }
    let secret: string | undefined;
    try {
      secret = await this.secret();
    } catch {
      this.logger.error(
        { event: 'admin_turnstile_unavailable', reason: 'secret-unavailable' },
        'cofre da chave secreta do Turnstile indisponível',
      );
      return 'unavailable';
    }
    // Cofre vazio (o motivo já saiu no log): fecha.
    if (typeof secret !== 'string') return 'unavailable';

    let response: Response;
    try {
      response = await this.fetchImpl(TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ secret, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
        signal: AbortSignal.timeout(TURNSTILE_SITEVERIFY_TIMEOUT_MS),
        // A chave secreta vai no corpo: nenhum redirecionamento a leva a outro lugar (cai no `catch`: 503).
        redirect: 'error',
      });
    } catch (error) {
      this.logger.error(
        { event: 'admin_turnstile_unavailable', error: errorKind(error) },
        'siteverify do Turnstile fora do ar',
      );
      return 'unavailable';
    }
    if (!response.ok) {
      this.logger.error(
        { event: 'admin_turnstile_unavailable', status: response.status },
        'siteverify do Turnstile respondeu com erro',
      );
      return 'unavailable';
    }
    const parsed = siteverifyResponse.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      this.logger.error(
        { event: 'admin_turnstile_unavailable', reason: 'invalid-response' },
        'siteverify do Turnstile fora do formato',
      );
      return 'unavailable';
    }
    const { success, action, hostname } = parsed.data;
    if (!success) {
      this.refused('rejected', { errorCodes: parsed.data['error-codes'] });
      return 'failed';
    }
    // Token de outro formulário (a `action` vem do widget que o gerou). Com uma chave real a Cloudflare sempre devolve a
    // `action`; com as de teste ela pode vir vazia.
    const actionOk = this.realKey ? action === expectedAction : !action || action === expectedAction;
    if (!actionOk) {
      this.refused('action-mismatch', { action, expectedAction });
      return 'failed';
    }
    // Token resolvido fora do console (o painel ou outro site com a mesma chave).
    if (this.realKey && hostname?.toLowerCase() !== this.expectedHostname) {
      this.refused('hostname-mismatch', { hostname, expectedHostname: this.expectedHostname });
      return 'failed';
    }
    return 'ok';
  }

  /** A chave secreta, lida uma vez (guardada só quando existe: gravar uma versão vale sem reiniciar). */
  private async secret(): Promise<string | undefined> {
    if (this.secretCache !== undefined) return this.secretCache;
    let value: string | undefined;
    try {
      value = await this.secrets.turnstileSecretKey();
    } catch (error) {
      if (error instanceof SecretUnavailableError) throw error;
      throw new SecretUnavailableError();
    }
    if (value === undefined) {
      this.logger.error(
        { event: 'admin_turnstile_secret_missing' },
        'Turnstile ligado (ADMIN_TURNSTILE_SITE_KEY) sem a chave secreta no cofre cp-admin-turnstile-secret-key: o login do console responde 503',
      );
      return undefined;
    }
    this.secretCache = value;
    return value;
  }

  private refused(reason: string, details: Record<string, unknown> = {}): void {
    this.logger.warn({ event: 'admin_turnstile_failed', reason, ...details }, 'token do Turnstile recusado');
  }
}
